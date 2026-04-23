import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import puppeteer, { Browser, Page } from 'puppeteer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

dotenv.config();

const PORT = process.env.PORT || 8000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is not set!');
  process.exit(1);
}

// Global browser state
let browser: Browser | null = null;
let page: Page | null = null;

async function getPage(): Promise<Page> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      ]
    });
  }
  if (!page) {
    const pages = await browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Mask headless browser fingerprint
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    // Remove navigator.webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }
  return page;
}

// Initialize the MCP Server
const mcpServer = new McpServer({
  name: 'mcp-proxy-puppeteer',
  version: '1.0.0',
});

// Tool: Navigate
mcpServer.tool('puppeteer_navigate', 'Navigate to a specific URL',
  { url: z.string().url() },
  async ({ url }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: 'networkidle2' });
    return {
      content: [{ type: 'text', text: `Navigated to ${url}` }]
    };
  }
);

// Tool: Screenshot
mcpServer.tool('puppeteer_screenshot', 'Take a screenshot of the current page',
  {},
  async () => {
    const p = await getPage();
    const screenshot = await p.screenshot({ encoding: 'base64' });
    return {
      content: [{
        type: 'image',
        data: screenshot as string,
        mimeType: 'image/png'
      }]
    };
  }
);

// Tool: Click
mcpServer.tool('puppeteer_click', 'Click an element matching the CSS selector',
  { selector: z.string() },
  async ({ selector }) => {
    const p = await getPage();
    await p.click(selector);
    return {
      content: [{ type: 'text', text: `Clicked element: ${selector}` }]
    };
  }
);

// Tool: Fill
mcpServer.tool('puppeteer_fill', 'Fill an input element with text',
  { selector: z.string(), text: z.string() },
  async ({ selector, text }) => {
    const p = await getPage();
    await p.type(selector, text);
    return {
      content: [{ type: 'text', text: `Filled element ${selector} with text` }]
    };
  }
);

// Tool: Evaluate
mcpServer.tool('puppeteer_evaluate', 'Execute JavaScript on the page and return the result',
  { script: z.string() },
  async ({ script }) => {
    const p = await getPage();
    const result = await p.evaluate(script);
    return {
      content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }]
    };
  }
);

// Tool: Get Page Content
mcpServer.tool('puppeteer_content', 'Get the raw text content of the page body',
  {},
  async () => {
    const p = await getPage();
    const content = await p.evaluate(() => document.body.innerText);
    return {
      content: [{ type: 'text', text: content }]
    };
  }
);

// Setup Express App
const app = express();
app.use(cors());

// Authentication Middleware
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = req.query.token;

  let providedKey = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7);
  } else if (token) {
    providedKey = token as string;
  }

  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Invalid API Key.' });
  }
  next();
};

// We need a global transport variable to connect the two endpoints
let transport: SSEServerTransport;

// Endpoint 1: Establish SSE connection
app.get('/mcp/sse', authMiddleware, async (req, res) => {
  transport = new SSEServerTransport('/mcp/messages', res);
  await mcpServer.connect(transport);
});

// Endpoint 2: Receive messages from client
app.post('/mcp/messages', authMiddleware, async (req, res) => {
  if (!transport) {
    return res.status(400).json({ error: 'SSE connection not established' });
  }
  await transport.handlePostMessage(req, res);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`MCP Puppeteer Proxy Server running on port ${PORT}`);
  console.log(`Requires API_KEY for access to /mcp/sse and /mcp/messages`);
});
