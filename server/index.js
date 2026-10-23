// Couch Pilot server
//   /            the TV app (open it on the Fire TV, the Fire TV simulator or any browser)
//   /alexa       Alexa+ (simulated) companion: talks to Couch Pilot through MCP
//   /mcp         MCP server, spec 2025-11-25, Streamable HTTP (stateless)
//   /api/*       TV bridge (SSE + POST), cloud planner (Amazon Bedrock)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { TvBridge } from './bridge.js';
import { createMcpServer } from './mcp.js';
import { bedrockConfigured, bedrockFailed, planWithBedrock, BEDROCK_MODEL_ID } from './bedrock.js';
import { createAlexaSim } from './alexa-sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.json': 'application/json',
};

const bridge = new TvBridge();
const alexa = createAlexaSim({ port: PORT });

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname === '/alexa' ? '/alexa.html' : pathname;
  p = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      // Video seeking needs range requests.
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = Number(s);
      const end = e ? Number(e) : st.size - 1;
      const data = (await readFile(file)).subarray(start, end + 1);
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': data.length });
      return res.end(data);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

async function handleMcp(req, res) {
  // Stateless Streamable HTTP: one server + transport per request.
  const server = createMcpServer(bridge);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  const body = req.method === 'POST' ? await readJson(req) : undefined;
  await transport.handleRequest(req, res, body);
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization, last-event-id',
      });
      return res.end();
    }
    if (path === '/mcp') return await handleMcp(req, res);
    if (path === '/api/health') {
      return json(res, 200, { ok: true, tvConnected: bridge.connected, bedrock: bedrockConfigured(), model: bedrockConfigured() ? BEDROCK_MODEL_ID : null, mcpProtocol: LATEST_PROTOCOL_VERSION });
    }
    if (path === '/api/tv/events') return bridge.attach(req, res);
    if (path === '/api/tv/result' && req.method === 'POST') return json(res, 200, { ok: bridge.receive(await readJson(req)) });
    if (path === '/api/tv/state' && req.method === 'POST') { bridge.lastState = await readJson(req); return json(res, 200, { ok: true }); }
    if (path === '/api/plan' && req.method === 'POST') {
      const { utterance, context } = await readJson(req);
      if (!bedrockConfigured()) return json(res, 200, { type: null });
      try {
        return json(res, 200, await planWithBedrock(utterance, context));
      } catch (e) {
        bedrockFailed(e);
        console.warn('[bedrock] falling back to on-device planner:', e.message);
        return json(res, 200, { type: null, error: e.message });
      }
    }
    if (path === '/api/alexa' && req.method === 'POST') {
      const { text } = await readJson(req);
      return json(res, 200, await alexa.turn(text));
    }
    if (req.method === 'GET') return await serveStatic(req, res, path);
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Couch Pilot is running\n`);
  console.log(`  TV app          http://localhost:${PORT}/`);
  console.log(`  Alexa+ (sim)    http://localhost:${PORT}/alexa`);
  console.log(`  MCP endpoint    http://localhost:${PORT}/mcp   (Streamable HTTP, protocol ${LATEST_PROTOCOL_VERSION})`);
  console.log(`  Cloud planner   ${bedrockConfigured() ? `Amazon Bedrock · ${BEDROCK_MODEL_ID}` : 'on-device (set COUCHPILOT_PLANNER=bedrock + AWS credentials to plan with Amazon Bedrock)'}\n`);
});
