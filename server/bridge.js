// TV bridge: the Couch Pilot server talks to the TV app over Server-Sent Events
// (commands down) and plain HTTP POST (results up). Every MCP tool call becomes
// a visible, interruptible action on the TV.

import { randomUUID } from 'node:crypto';

export class TvBridge {
  constructor() {
    this.clients = new Set(); // SSE responses
    this.pending = new Map(); // id -> { resolve, timer }
    this.lastState = null;
  }

  attach(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': couch pilot bridge\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  get connected() {
    return this.clients.size > 0;
  }

  send(kind, payload = {}, { timeoutMs = 90000 } = {}) {
    if (!this.connected) {
      return Promise.resolve({
        status: 'tv-offline',
        message: 'No TV is connected. Open the Couch Pilot app on the Fire TV (or http://localhost:8787 in a browser).',
      });
    }
    const id = randomUUID();
    const msg = `data: ${JSON.stringify({ id, kind, payload })}\n\n`;
    for (const c of this.clients) c.write(msg);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 'timeout', message: 'The TV did not answer in time.' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  receive({ id, result }) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (result?.state) this.lastState = result.state;
    p.resolve(result);
    return true;
  }
}
