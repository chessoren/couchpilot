// Alexa+ (simulated) — the conversational side.
//
// A real MCP client (official SDK, Streamable HTTP) that connects to the
// Couch Pilot MCP server exactly like an Alexa+ integration would, decides
// which tool to call for each user turn, and phrases the answer.
// "Alexa+ understands. Couch Pilot acts."

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function createAlexaSim({ port }) {
  let client = null;
  let pending = null; // last needs_input result

  async function connect() {
    if (client) return client;
    const c = new Client({ name: 'alexa-plus-simulator', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    client = c;
    return c;
  }

  function reply(result) {
    if (!result) return 'Hmm, the TV did not answer.';
    if (result.status === 'tv-offline') return "I can't reach your TV right now.";
    if (result.status === 'needs_input') {
      pending = result;
      if (result.kind === 'confirm') return result.question;
      return `${result.question} ${result.options.map((o, i) => `${i + 1}, ${o.label}`).join('. ')}.`;
    }
    pending = null;
    if (result.status === 'done') return result.say || 'Done.';
    if (result.status === 'declined') return "Okay, nothing was charged.";
    if (result.status === 'stopped') return "Okay, stopping. You're in control.";
    if (result.status === 'refuse' || result.status === 'unknown' || result.status === 'problem') return result.say;
    if (result.state) {
      const s = result.state;
      if (s.nowPlaying) return `${s.nowPlaying.title} is playing, volume ${s.volume}.`;
      return `The TV is on ${s.screen}, volume ${s.volume}.`;
    }
    return 'Done.';
  }

  async function turn(text) {
    const c = await connect();
    const t = String(text || '').toLowerCase().trim();
    let name;
    let args;
    if (/^(stop|wait|cancel|hold on)\b/.test(t)) { name = 'couchpilot_stop'; args = {}; }
    else if (pending) { name = 'couchpilot_answer'; args = { answer: text }; }
    else if (/what('s| is) (on|playing)|what am i watching/.test(t)) { name = 'tv_get_state'; args = {}; }
    else { name = 'couchpilot_run_goal'; args = { goal: text }; }

    const request = { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args } };
    const t0 = Date.now();
    const res = await c.callTool({ name, arguments: args });
    const result = res.structuredContent || JSON.parse(res.content?.[0]?.text || '{}');
    return {
      say: reply(result),
      mcp: { request, ms: Date.now() - t0, result: { status: result.status, kind: result.kind, question: result.question, done: result.done } },
      tools: (await c.listTools()).tools.map((x) => x.name),
    };
  }

  return { turn };
}
