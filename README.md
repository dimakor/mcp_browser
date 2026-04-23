# Geoblock-Bypassing MCP Proxy Server

This is an MCP (Model Context Protocol) server running Puppeteer over SSE (Server-Sent Events) to act as a transparent proxy for Google Antigravity. It is designed to be deployed on a VPS (like cloud.ru) to naturally bypass geoblocks while exposing remote browser controls to the LLM.

## Setup Instructions (Ubuntu VPS)

### 1. Install System Dependencies
Update your package list and install Node.js, Caddy, and Puppeteer dependencies:
```bash
sudo apt update
sudo apt install -y curl software-properties-common

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Puppeteer system dependencies (Chromium requires these)
sudo apt install -y libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi-dev libxtst6 libnss3 libcups2 libxss1 libxrandr2 libasound2 libpangocairo-1.0-0 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0

# Install Caddy (for reverse proxy / SSL)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 2. Install Project Dependencies
Clone this repository to your VPS (e.g., in `/home/ubuntu/mcp_browser`), then install the Node packages:
```bash
cd /home/ubuntu/mcp_browser
npm install
npm run build
```

### 3. Configuration
1. Copy the `.env.example` file to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` to set your super secret `API_KEY`.
3. Edit the `Caddyfile`. Replace `yourdomain.com:9443` with your actual domain or VPS IP address. Note that if you use an IP address, Caddy will use a self-signed certificate.

### 4. Setup Systemd Service
To ensure the proxy runs in the background and restarts automatically:
1. Edit `mcp-proxy.service` and ensure the `User=` and `WorkingDirectory=` match your setup.
2. Copy the service file to systemd:
   ```bash
   sudo cp mcp-proxy.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable mcp-proxy
   sudo systemctl start mcp-proxy
   ```
3. Check the status: `sudo systemctl status mcp-proxy`

### 5. Setup Caddy Reverse Proxy
1. Copy your customized Caddyfile to Caddy's configuration directory:
   ```bash
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo systemctl restart caddy
   ```

## Connecting Google Antigravity
Configure Antigravity to connect to your remote server using the SSE transport.

- **SSE Endpoint**: `https://yourdomain.com:9443/mcp/sse`
- **Messages Endpoint**: `https://yourdomain.com:9443/mcp/messages`
- Ensure you configure the transport to pass the HTTP Header: `Authorization: Bearer <YOUR_API_KEY>`
