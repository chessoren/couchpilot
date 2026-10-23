// End-to-end check: a real MCP client drives a real TV page (headless Chromium).
// Usage: npm start (in another terminal), then: node tests/e2e-mcp.mjs [screenshotPrefix]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.COUCHPILOT_URL || 'http://localhost:8787';
const shots = process.argv[2];
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${BASE}/?fresh&mute`);
await page.waitForTimeout(1500);

const client = new Client({ name: 'couchpilot-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log('tools:', tools.join(', '));

let failures = 0;
const expect = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
const shot = async (n) => shots && page.screenshot({ path: `${shots}-${n}.png` });

let r = await call('couchpilot_run_goal', { goal: 'Resume my detective show where I left off, and turn it up.' });
expect(r.status === 'done' && r.state.nowPlaying?.title === 'Harbor Investigations' && r.state.volume === 30, 'demo 1: one sentence -> resumed S2E5, volume 30');

r = await call('couchpilot_run_goal', { goal: 'Put on something for the kids' });
expect(r.status === 'needs_input' && r.kind === 'clarify' && r.options.length === 2, 'demo 2: asks one question with 2 choices');
await shot('clarify');
r = await call('couchpilot_answer', { answer: 'the first one' });
expect(r.status === 'done' && r.state.kidsMode && r.state.volume <= 15 && r.state.timers.some((t) => /Stops/.test(t.label)), 'demo 2: kids mode, volume <= 15, 30 min timer');

r = await call('couchpilot_run_goal', { goal: 'Movie night' });
expect(r.status === 'refuse', 'kids mode: grown-up content is refused by voice');
await page.goto(`${BASE}/?fresh&mute`); // a grown-up resets the TV
await page.waitForTimeout(1500);
r = await call('couchpilot_run_goal', { goal: 'Movie night' });
expect(r.status === 'done' && r.state.subtitles === 'English' && r.state.timers.some((t) => /Reminder/.test(t.label)), 'demo 3: routine -> film, subtitles, volume, reminder');

r = await call('couchpilot_run_goal', { goal: 'Rent Dune Song' });
expect(r.status === 'needs_input' && r.kind === 'confirm' && /\$3\.99/.test(r.question), 'demo 4: rental asks for a yes with the price');
await shot('confirm');
r = await call('couchpilot_answer', { answer: 'no' });
expect(r.status === 'declined' && !r.state.rented.includes('dune'), 'demo 4: "no" -> nothing charged');

const running = call('couchpilot_run_goal', { goal: 'Find me a documentary about space under an hour' });
await page.waitForTimeout(2500);
const s = await call('couchpilot_stop');
const after = await running;
expect(s.status === 'stopped' && after.status === 'stopped', 'demo 4: Stop interrupts a running plan and hands control back');
await shot('stopped');

r = await call('couchpilot_run_goal', { goal: 'Type my password 1234' });
expect(r.status === 'refuse', 'guardrail: passwords are refused');

r = await call('tv_set_volume', { level: 22 });
expect(r.status === 'done' && r.state.volume === 22, 'primitive: tv_set_volume');

const res = await client.readResource({ uri: 'couchpilot://guardrails' });
expect(JSON.parse(res.contents[0].text).actions.rent === 'confirm', 'resource: guardrails exposed');

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
