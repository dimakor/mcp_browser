import express, { Request, Response as ExpressResponse, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import puppeteer, { Browser, Page } from 'puppeteer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { TextDecoder } from 'util';
import { z } from 'zod';

dotenv.config();

const PORT = readEnvNumber('PORT', 8000, 1, 65535);
const API_KEY = process.env.API_KEY;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

const PROXY_TIMEOUT_MS = readEnvNumber('PROXY_TIMEOUT_MS', 45_000, 1_000, 180_000);
const PROXY_FETCH_MAX_BYTES = readEnvNumber('PROXY_FETCH_MAX_BYTES', 2_000_000, 1, 50_000_000);
const PROXY_DOWNLOAD_MAX_BYTES = readEnvNumber('PROXY_DOWNLOAD_MAX_BYTES', 8_000_000, 1, 100_000_000);
const PROXY_MAX_CHARS = readEnvNumber('PROXY_MAX_CHARS', 60_000, 1_000, 500_000);
const PROXY_LINK_LIMIT = readEnvNumber('PROXY_LINK_LIMIT', 200, 1, 2_000);
const PROXY_BLOCK_PRIVATE_NETWORKS = process.env.PROXY_BLOCK_PRIVATE_NETWORKS !== 'false';
const ALLOWED_HOST_PATTERNS = parseHostPatterns(process.env.PROXY_ALLOWED_HOSTS);

const waitUntilSchema = z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']);
const DOCUMENT_KEYWORDS = [
  'api',
  'swagger',
  'openapi',
  'developer',
  'developers',
  'dev',
  'docs',
  'doc',
  'pdf',
  'download',
  'integration',
  'spec',
  'schema',
  'json',
  'xml',
  'yaml',
  'yml',
  'dokument',
  'razrabot',
  'integrac',
  'dokumentac',
  'dokumentats',
  'razrabotch',
  'razrab',
  'api-doc',
  'apidoc',
  'lk-api',
  'lichnyj-kabinet',
  'документ',
  'документац',
  'разработ',
  'интеграц',
  'спецификац',
  'скачать',
  'личный кабинет',
];

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is not set!');
  process.exit(1);
}

type WaitUntil = z.infer<typeof waitUntilSchema>;
type FetchFormat = 'auto' | 'text' | 'base64' | 'metadata';

type LinkInfo = {
  text: string;
  href: string;
};

type PageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  textTruncated: boolean;
  links: LinkInfo[];
};

// Shared browser process; each MCP session gets its own page.
let browser: Browser | null = null;

function readEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseHostPatterns(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => normalizeHostname(item.trim()))
    .filter(Boolean);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function normalizeUrlInput(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// URLs are supported, got ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new Error('Credentials in URLs are not supported.');
  }

  return url;
}

async function requireProxyUrl(rawUrl: string): Promise<URL> {
  const url = normalizeUrlInput(rawUrl);
  const host = normalizeHostname(url.hostname);

  if (!isAllowedHost(host)) {
    throw new Error(
      `Host "${host}" is not allowed by PROXY_ALLOWED_HOSTS. ` +
        'Update PROXY_ALLOWED_HOSTS or leave it empty to allow public HTTP(S) hosts.'
    );
  }

  if (!PROXY_BLOCK_PRIVATE_NETWORKS) {
    return url;
  }

  if (isBlockedHostname(host)) {
    throw new Error(`Refusing to proxy private or local host "${host}".`);
  }

  if (!isIP(host)) {
    try {
      const addresses = await lookup(host, { all: true, verbatim: false });
      const blockedAddress = addresses.find((address) => isBlockedHostname(address.address));
      if (blockedAddress) {
        throw new Error(
          `Refusing to proxy "${host}" because it resolves to private address ${blockedAddress.address}.`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing to proxy')) {
        throw error;
      }
      // Let Chromium/fetch report normal DNS errors later. The DNS preflight is only a safety net.
    }
  }

  return url;
}

function isAllowedHost(host: string): boolean {
  if (ALLOWED_HOST_PATTERNS.length === 0) {
    return true;
  }

  return ALLOWED_HOST_PATTERNS.some((pattern) => {
    if (pattern === '*') {
      return true;
    }

    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix);
    }

    if (pattern.startsWith('.')) {
      return host === pattern.slice(1) || host.endsWith(pattern);
    }

    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (host === 'metadata.google.internal') {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isBlockedIPv4(host);
  }
  if (ipVersion === 6) {
    return isBlockedIPv6(host);
  }

  return !host.includes('.');
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIPv6(address: string): boolean {
  const host = normalizeHostname(address);
  if (host === '::' || host === '::1') {
    return true;
  }

  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  if (host.startsWith('::ffff:')) {
    return isBlockedIPv4(host.slice('::ffff:'.length));
  }

  return false;
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser;
  }

  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=ru-RU',
      `--user-agent=${USER_AGENT}`,
    ],
  });

  return browser;
}

async function createConfiguredPage(): Promise<Page> {
  const currentBrowser = await getBrowser();
  const page = await currentBrowser.newPage();

  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1920, height: 1080 });
  page.setDefaultTimeout(PROXY_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PROXY_TIMEOUT_MS);
  await page.setExtraHTTPHeaders({
    'Accept-Language': ACCEPT_LANGUAGE,
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  return page;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: text.slice(0, maxChars), truncated: true };
}

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const selected = new Set([
    'content-type',
    'content-length',
    'last-modified',
    'etag',
    'location',
    'cache-control',
  ]);
  const result: Record<string, string> = {};

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (selected.has(lowerKey)) {
      result[lowerKey] = value;
    }
  });

  return result;
}

function isTextLikeContent(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('yaml') ||
    normalized.includes('javascript') ||
    normalized.includes('x-www-form-urlencoded') ||
    normalized.includes('openapi')
  );
}

function isKnownBinaryContent(contentType: string, buffer: Buffer): boolean {
  const normalized = contentType.toLowerCase();
  if (
    normalized.includes('application/pdf') ||
    normalized.includes('application/zip') ||
    normalized.includes('application/octet-stream') ||
    normalized.includes('application/msword') ||
    normalized.includes('officedocument') ||
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/')
  ) {
    return true;
  }

  const signature = buffer.subarray(0, 8).toString('latin1');
  return (
    signature.startsWith('%PDF-') ||
    signature.startsWith('PK\u0003\u0004') ||
    signature.startsWith('\u0089PNG') ||
    signature.startsWith('\u00ff\u00d8\u00ff') ||
    signature.startsWith('GIF87a') ||
    signature.startsWith('GIF89a') ||
    signature.startsWith('Rar!') ||
    signature.startsWith('7z\u00bc\u00af\u0027\u001c')
  );
}

function looksTextLike(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let controlChars = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }

    const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedWhitespace) {
      controlChars += 1;
    }
  }

  return controlChars / sample.length < 0.05;
}

function decodeBuffer(buffer: Buffer, contentType: string): string {
  const charsetMatch = contentType.match(/charset\s*=\s*["']?([^;"']+)/i);
  const charset = charsetMatch?.[1]?.trim() || 'utf-8';

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      buffer: buffer.subarray(0, maxBytes),
      truncated: buffer.length > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = maxBytes - received;
    if (value.length > remaining) {
      chunks.push(Buffer.from(value.subarray(0, Math.max(remaining, 0))));
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(Buffer.from(value));
    received += value.length;

    if (received >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  return { buffer: Buffer.concat(chunks), truncated };
}

async function fetchThroughProxy(
  url: URL,
  format: FetchFormat,
  maxBytes: number,
  maxChars: number
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': ACCEPT_LANGUAGE,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    const metadata = {
      requestedUrl: url.toString(),
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType,
      headers: pickResponseHeaders(response.headers),
    };

    if (format === 'metadata') {
      return metadata;
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      return {
        ...metadata,
        bytesRead: 0,
        truncated: true,
        error: `Response declares ${contentLength} bytes, which exceeds maxBytes=${maxBytes}.`,
      };
    }

    const { buffer, truncated } = await readResponseBody(response, maxBytes);
    const textLike =
      !isKnownBinaryContent(contentType, buffer) && (isTextLikeContent(contentType) || looksTextLike(buffer));

    if (format === 'base64' || (format === 'auto' && !textLike)) {
      return {
        ...metadata,
        encoding: 'base64',
        bytesRead: buffer.length,
        truncated,
        base64: buffer.toString('base64'),
      };
    }

    const decoded = decodeBuffer(buffer, contentType);
    const truncatedText = truncateText(decoded, maxChars);
    return {
      ...metadata,
      encoding: 'text',
      bytesRead: buffer.length,
      bodyTruncated: truncated,
      textTruncated: truncatedText.truncated,
      text: truncatedText.text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 800;
      const maxScroll = 20_000;
      let total = 0;

      const timer = window.setInterval(() => {
        const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        window.scrollBy(0, distance);
        total += distance;

        if (total >= Math.min(scrollHeight, maxScroll) || window.innerHeight + window.scrollY >= scrollHeight) {
          window.clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);

      window.setTimeout(() => {
        window.clearInterval(timer);
        window.scrollTo(0, 0);
        resolve();
      }, 4_000);
    });
  });
}

async function readRenderedPage(
  page: Page,
  url: URL,
  options: {
    waitUntil: WaitUntil;
    maxChars: number;
    linkLimit: number;
    scroll: boolean;
  }
): Promise<PageSnapshot> {
  await page.goto(url.toString(), {
    waitUntil: options.waitUntil,
    timeout: PROXY_TIMEOUT_MS,
  });

  if (options.scroll) {
    try {
      await autoScroll(page);
    } catch {
      // Some pages block scripted scrolling; the initial rendered text is still useful.
    }
  }

  const snapshot = await page.evaluate((limit) => {
    const normalizeText = (value: string | null | undefined) =>
      (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);

    const seen = new Set<string>();
    const links: LinkInfo[] = [];
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));

    for (const anchor of anchors) {
      if (!anchor.href || seen.has(anchor.href)) {
        continue;
      }

      seen.add(anchor.href);
      links.push({
        text: normalizeText(anchor.textContent || anchor.getAttribute('aria-label') || anchor.title),
        href: anchor.href,
      });

      if (links.length >= limit) {
        break;
      }
    }

    return {
      finalUrl: window.location.href,
      title: document.title || '',
      text: document.body?.innerText || '',
      links,
    };
  }, options.linkLimit);

  const truncatedText = truncateText(snapshot.text, options.maxChars);
  return {
    requestedUrl: url.toString(),
    finalUrl: snapshot.finalUrl,
    title: snapshot.title,
    text: truncatedText.text,
    textTruncated: truncatedText.truncated,
    links: snapshot.links,
  };
}

function filterLinks(
  links: LinkInfo[],
  baseUrl: URL,
  options: {
    query?: string;
    extensions?: string[];
    includeExternal: boolean;
    maxLinks: number;
  }
): LinkInfo[] {
  const query = options.query?.trim().toLowerCase();
  const extensions = (options.extensions || [])
    .map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);

  return links
    .filter((link) => {
      let linkUrl: URL;
      try {
        linkUrl = new URL(link.href, baseUrl);
      } catch {
        return false;
      }

      if (!options.includeExternal && !isSameSite(linkUrl.hostname, baseUrl.hostname)) {
        return false;
      }

      const haystack = `${link.href} ${link.text}`.toLowerCase();
      const pathname = linkUrl.pathname.toLowerCase();
      const matchesQuery = query ? haystack.includes(query) : true;
      const matchesExtension =
        extensions.length === 0
          ? true
          : extensions.some((extension) => pathname.endsWith(`.${extension}`) || haystack.includes(`.${extension}?`));
      const matchesDocumentHints =
        query || extensions.length > 0 ? true : DOCUMENT_KEYWORDS.some((keyword) => haystack.includes(keyword));

      return matchesQuery && matchesExtension && matchesDocumentHints;
    })
    .slice(0, options.maxLinks);
}

function isSameSite(candidateHostname: string, baseHostname: string): boolean {
  const candidate = normalizeHostname(candidateHostname);
  const base = normalizeHostname(baseHostname);
  if (candidate === base || candidate.endsWith(`.${base}`)) {
    return true;
  }

  const baseParts = base.split('.');
  if (baseParts.length < 2) {
    return false;
  }

  const baseSite = baseParts.slice(-2).join('.');
  return candidate === baseSite || candidate.endsWith(`.${baseSite}`);
}

// Factory: register all tools on a given McpServer instance.
function registerTools(server: McpServer): () => Promise<void> {
  let page: Page | null = null;

  async function getSessionPage(): Promise<Page> {
    if (!page || page.isClosed()) {
      page = await createConfiguredPage();
    }

    return page;
  }

  server.tool(
    'proxy_fetch',
    'Fetch a public HTTP(S) URL from the VPS network location. Use for .ru/Russia-only docs, APIs, JSON, XML, and static pages.',
    {
      url: z.string().min(1),
      format: z.enum(['auto', 'text', 'base64', 'metadata']).optional(),
      maxBytes: z.number().int().positive().max(50_000_000).optional(),
      maxChars: z.number().int().positive().max(500_000).optional(),
    },
    async ({ url, format, maxBytes, maxChars }) => {
      const target = await requireProxyUrl(url);
      const result = await fetchThroughProxy(
        target,
        format || 'auto',
        maxBytes || PROXY_FETCH_MAX_BYTES,
        maxChars || PROXY_MAX_CHARS
      );
      return jsonResult(result);
    }
  );

  server.tool(
    'proxy_read_page',
    'Render a public HTTP(S) page in Chromium on the VPS and return visible text plus links. Use for JavaScript-heavy .ru/Russia-only pages.',
    {
      url: z.string().min(1),
      waitUntil: waitUntilSchema.optional(),
      maxChars: z.number().int().positive().max(500_000).optional(),
      includeLinks: z.boolean().optional(),
      linkLimit: z.number().int().positive().max(2_000).optional(),
      scroll: z.boolean().optional(),
    },
    async ({ url, waitUntil, maxChars, includeLinks, linkLimit, scroll }) => {
      const target = await requireProxyUrl(url);
      const p = await getSessionPage();
      const snapshot = await readRenderedPage(p, target, {
        waitUntil: waitUntil || 'networkidle2',
        maxChars: maxChars || PROXY_MAX_CHARS,
        linkLimit: linkLimit || PROXY_LINK_LIMIT,
        scroll: scroll !== false,
      });

      if (includeLinks === false) {
        return jsonResult({ ...snapshot, links: undefined });
      }

      return jsonResult(snapshot);
    }
  );

  server.tool(
    'proxy_find_links',
    'Render a page through the VPS and find likely documentation/download/API links. Useful for transport-company docs.',
    {
      url: z.string().min(1),
      query: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      includeExternal: z.boolean().optional(),
      maxLinks: z.number().int().positive().max(500).optional(),
      waitUntil: waitUntilSchema.optional(),
    },
    async ({ url, query, extensions, includeExternal, maxLinks, waitUntil }) => {
      const target = await requireProxyUrl(url);
      const p = await getSessionPage();
      const snapshot = await readRenderedPage(p, target, {
        waitUntil: waitUntil || 'networkidle2',
        maxChars: 1_000,
        linkLimit: Math.min((maxLinks || 100) * 10, 2_000),
        scroll: true,
      });

      return jsonResult({
        requestedUrl: snapshot.requestedUrl,
        finalUrl: snapshot.finalUrl,
        title: snapshot.title,
        links: filterLinks(snapshot.links, new URL(snapshot.finalUrl), {
          query,
          extensions,
          includeExternal: includeExternal !== false,
          maxLinks: maxLinks || 100,
        }),
      });
    }
  );

  server.tool(
    'proxy_download',
    'Download a public document or binary file through the VPS and return base64 plus metadata.',
    {
      url: z.string().min(1),
      maxBytes: z.number().int().positive().max(100_000_000).optional(),
    },
    async ({ url, maxBytes }) => {
      const target = await requireProxyUrl(url);
      const result = await fetchThroughProxy(target, 'base64', maxBytes || PROXY_DOWNLOAD_MAX_BYTES, PROXY_MAX_CHARS);
      return jsonResult(result);
    }
  );

  server.tool(
    'puppeteer_navigate',
    'Navigate the session browser to a specific public HTTP(S) URL',
    { url: z.string().min(1) },
    async ({ url }) => {
      const target = await requireProxyUrl(url);
      const p = await getSessionPage();
      await p.goto(target.toString(), { waitUntil: 'networkidle2', timeout: PROXY_TIMEOUT_MS });
      return textResult(`Navigated to ${p.url()}`);
    }
  );

  server.tool('puppeteer_screenshot', 'Take a screenshot of the current page', {}, async () => {
    const p = await getSessionPage();
    const screenshot = await p.screenshot({ encoding: 'base64' });
    return {
      content: [
        {
          type: 'image' as const,
          data: screenshot as string,
          mimeType: 'image/png',
        },
      ],
    };
  });

  server.tool(
    'puppeteer_click',
    'Click an element matching the CSS selector',
    { selector: z.string() },
    async ({ selector }) => {
      const p = await getSessionPage();
      await p.click(selector);
      return textResult(`Clicked element: ${selector}`);
    }
  );

  server.tool(
    'puppeteer_fill',
    'Fill an input element with text',
    { selector: z.string(), text: z.string() },
    async ({ selector, text }) => {
      const p = await getSessionPage();
      await p.type(selector, text);
      return textResult(`Filled element ${selector} with text`);
    }
  );

  server.tool(
    'puppeteer_evaluate',
    'Execute JavaScript on the current page and return the result',
    { script: z.string() },
    async ({ script }) => {
      const p = await getSessionPage();
      const result = await p.evaluate(script);
      return textResult(`Result: ${JSON.stringify(result)}`);
    }
  );

  server.tool('puppeteer_content', 'Get the raw text content of the current page body', {}, async () => {
    const p = await getSessionPage();
    const content = await p.evaluate(() => document.body.innerText);
    return textResult(content);
  });

  return async () => {
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
    page = null;
  };
}

// Active sessions: sessionId -> { transport, mcpServer, cleanup }
const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer; cleanup: () => Promise<void> }>();

// Setup Express App
const app = express();
app.use(cors());

// Authentication Middleware
const authMiddleware = (req: Request, res: ExpressResponse, next: NextFunction) => {
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size,
    privateNetworkBlocking: PROXY_BLOCK_PRIVATE_NETWORKS,
    allowedHosts: ALLOWED_HOST_PATTERNS.length === 0 ? 'public-http-hosts' : ALLOWED_HOST_PATTERNS,
  });
});

// Endpoint 1: Establish SSE connection (one per client)
app.get('/mcp/sse', authMiddleware, async (_req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const sessionId = transport.sessionId;

  // Create a fresh MCP server for this session.
  const server = new McpServer({
    name: 'mcp-proxy-puppeteer',
    version: '1.1.0',
  });
  const cleanup = registerTools(server);

  sessions.set(sessionId, { transport, server, cleanup });
  console.log(`[+] Session ${sessionId} connected (${sessions.size} active)`);

  // Clean up when the client disconnects.
  res.on('close', () => {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (session) {
      void session.cleanup();
    }
    console.log(`[-] Session ${sessionId} disconnected (${sessions.size} active)`);
  });

  await server.connect(transport);
});

// Endpoint 2: Receive messages from client (routed by sessionId)
app.post('/mcp/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(400).json({ error: 'No active SSE session for this sessionId' });
  }

  await session.transport.handlePostMessage(req, res);
});

async function shutdown(): Promise<void> {
  await Promise.all(Array.from(sessions.values()).map((session) => session.cleanup().catch(() => undefined)));
  sessions.clear();

  if (browser) {
    await browser.close().catch(() => undefined);
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});

app.listen(PORT, () => {
  console.log(`MCP Puppeteer Proxy Server running on port ${PORT}`);
  console.log('Supports multiple simultaneous MCP sessions with isolated browser pages');
  console.log('Requires API_KEY for access to /mcp/sse and /mcp/messages');
  console.log('Proxy tools: proxy_fetch, proxy_read_page, proxy_find_links, proxy_download');
});
