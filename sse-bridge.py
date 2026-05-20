import asyncio
import os
import sys
import httpx
from mcp.client.sse import sse_client
from mcp.server.stdio import stdio_server

async def bridge(sse_read, sse_write):
    print("Connected! Bridging stdio to remote server.", file=sys.stderr)
    
    # Expose local stdio transport
    async with stdio_server() as (stdio_read, stdio_write):
        
        # Pump messages from local stdio (Antigravity) -> remote server
        async def pump_up():
            try:
                async for message in stdio_read:
                    await sse_write.send(message)
            except Exception as e:
                print(f"Error in pump_up: {e}", file=sys.stderr)
        
        # Pump messages from remote server -> local stdio (Antigravity)
        async def pump_down():
            try:
                async for message in sse_read:
                    await stdio_write.send(message)
            except Exception as e:
                print(f"Error in pump_down: {e}", file=sys.stderr)
        
        # Run both pumps concurrently
        await asyncio.gather(pump_up(), pump_down())

async def main():
    url = os.environ.get("PROXY_SSE_URL")
    api_key = os.environ.get("API_KEY")
    
    if not url or not api_key:
        print("ERROR: PROXY_SSE_URL and API_KEY environment variables are required.", file=sys.stderr)
        sys.exit(1)
        
    verify_ssl = os.environ.get("NODE_TLS_REJECT_UNAUTHORIZED") != "0"
    
    # Ignore self-signed certificate warnings if requested
    if not verify_ssl:
        from mcp.shared._httpx_utils import MCP_DEFAULT_TIMEOUT, MCP_DEFAULT_SSE_READ_TIMEOUT
        
        def custom_client_factory(headers=None, timeout=None, auth=None):
            kwargs = {"follow_redirects": True, "verify": False}
            if timeout is None:
                kwargs["timeout"] = httpx.Timeout(MCP_DEFAULT_TIMEOUT, read=MCP_DEFAULT_SSE_READ_TIMEOUT)
            else:
                kwargs["timeout"] = timeout
            if headers is not None:
                kwargs["headers"] = headers
            if auth is not None:
                kwargs["auth"] = auth
            return httpx.AsyncClient(**kwargs)
            
        client_kwargs = {"httpx_client_factory": custom_client_factory}
    else:
        client_kwargs = {}
        
    headers = {"Authorization": f"Bearer {api_key}"}
    
    # Auto-detect transport: Standard SSE vs. Streamable HTTP
    is_streamable = False
    print(f"Probing remote server at {url} to detect transport protocol...", file=sys.stderr)
    try:
        # Perform a lightweight streaming GET probe to retrieve headers only
        async with httpx.AsyncClient(verify=verify_ssl, headers=headers) as probe_client:
            async with probe_client.stream("GET", url, timeout=10.0) as response:
                content_type = response.headers.get("content-type", "")
                if "application/json" in content_type:
                    is_streamable = True
                elif "text/event-stream" in content_type:
                    is_streamable = False
                elif response.status_code in (400, 405, 406):
                    is_streamable = True
    except Exception as e:
        print(f"Transport detection probe failed: {e}. Falling back to URL heuristics.", file=sys.stderr)
        if "/sse" not in url:
            is_streamable = True

    if is_streamable:
        print("Auto-detected Streamable HTTP protocol. Connecting...", file=sys.stderr)
        from mcp.client.streamable_http import streamable_http_client
        if "httpx_client_factory" in client_kwargs:
            httpx_client = client_kwargs["httpx_client_factory"](headers=headers, timeout=httpx.Timeout(120, read=600))
        else:
            httpx_client = httpx.AsyncClient(headers=headers, verify=verify_ssl, timeout=httpx.Timeout(120, read=600))
            
        async with httpx_client as client:
            async with streamable_http_client(url, http_client=client) as (sse_read, sse_write, _):
                await bridge(sse_read, sse_write)
    else:
        print("Auto-detected Standard SSE protocol. Connecting...", file=sys.stderr)
        async with sse_client(url, headers=headers, timeout=120, sse_read_timeout=600, **client_kwargs) as (sse_read, sse_write):
            await bridge(sse_read, sse_write)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"Bridge error: {e}", file=sys.stderr)
        sys.exit(1)
