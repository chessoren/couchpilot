// Couch Pilot app entry: wires the TV, the agent, the Alexa+ (simulated) voice
// layer, the remote control, and the link to the Couch Pilot server (MCP bridge).

import { TV, sleep } from './tv.js';
import { Pilot } from './pilot.js';
import { defaultMemory } from './catalog.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const android = window.CouchPilotAndroid; // present inside the Fire OS app

// ---------------------------------------------------------------- memory (visible + erasable)
function loadMemory() {
  try {
    const raw = !params.has('fresh') && localStorage.getItem('couchpilot.memory');
    if (raw) return { ...defaultMemory(), ...JSON.parse(raw) };
  } catch (e) { /* storage may be unavailable */ }
  return defaultMemory();
}
function saveMemory(mem) {
  try { localStorage.setItem('couchpilot.memory', JSON.stringify(mem)); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- voice output
function speak(text) {
  if (!text || params.has('mute')) return;
  if (android?.speak) { android.speak(text); return; }
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.98;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- server link (optional)
const server = { online: false, bedrock: false };
async function probeServer() {
  if (location.protocol === 'file:' || params.has('offline')) return;
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (!r.ok) return;
    const h = await r.json();
    server.online = true;
    server.bedrock = !!h.bedrock;
  } catch (e) { /* standalone mode */ }
}
async function planRemote(text, ctx) {
  if (!server.online || !server.bedrock) return null;
  const r = await fetch('api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ utterance: text, context: { state: ctx.state, memory: ctx.memory } }),
  });
  if (!r.ok) return null;
  return r.json();
}

const tv = new TV();
const memory = loadMemory();
tv.init(memory);
const pilot = new Pilot(tv, { speak, planRemote });

tv.on((type, data) => {
  if (type === 'timer') pilot.onTimer(data);
  if (type === 'timer-warning') pilot.onTimerWarning(data);
  if (type === 'rent-request') pilot.handle(`rent ${data.titleId === 'dune' ? 'Dune Song' : data.titleId}`, { source: 'remote' });
  if (type === 'play' || type === 'screen') { saveMemory(memory); pushState(); }
});
pilot.on((type) => { if (type === 'result' || type === 'stopped') pushState(); });

// ---------------------------------------------------------------- Alexa+ (simulated) voice bar
const voice = {
  open: false,
  rec: null,
  show(label = "I'm listening…") {
    this.open = true;
    $('#voicebar').hidden = false;
    $('#voicebar').classList.remove('idle');
    $('#voiceLabel').textContent = label;
    $('#voiceTranscript').textContent = '';
  },
  hide(delay = 0) {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      this.open = false;
      $('#voicebar').hidden = true;
      $('#voiceInput').hidden = true;
      $('#voiceInput').value = '';
    }, delay);
  },
  transcript(text) { $('#voiceTranscript').textContent = text; },
  async submit(text) {
    $('#voicebar').classList.add('idle');
    $('#voiceLabel').textContent = 'Couch Pilot';
    this.transcript(text);
    this.hide(900);
    return pilot.handle(text, { source: 'voice' });
  },
  start() {
    pilot.emit('listening', {});
    this.show();
    if (android?.startListening) { android.startListening(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && !params.has('typed')) {
      try {
        const rec = new SR();
        rec.lang = 'en-US';
        rec.interimResults = true;
        rec.onresult = (e) => {
          const r = e.results[e.results.length - 1];
          this.transcript(r[0].transcript);
          if (r.isFinal) this.submit(r[0].transcript);
        };
        rec.onerror = () => this.typed();
        rec.start();
        this.rec = rec;
        return;
      } catch (e) { /* fall through to typing */ }
    }
    this.typed();
  },
  typed() {
    const input = $('#voiceInput');
    $('#voiceLabel').textContent = 'Type what you would say, then press Enter';
    input.hidden = false;
    setTimeout(() => input.focus(), 50);
  },
};
$('#voiceInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && e.target.value.trim()) voice.submit(e.target.value.trim());
  if (e.key === 'Escape') voice.hide();
});

// Used by the Fire OS app (Android SpeechRecognizer) and by the demo recorder.
async function simulateVoice(text, { wordMs = 230 } = {}) {
  voice.show();
  pilot.emit('listening', { simulated: true });
  await sleep(500);
  const words = text.split(' ');
  for (let i = 1; i <= words.length; i++) {
    voice.transcript(words.slice(0, i).join(' '));
    await sleep(wordMs);
  }
  await sleep(250);
  return voice.submit(text);
}

// ---------------------------------------------------------------- remote control
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
function back() {
  if (pilot.busy || pilot.waiting) { pilot.stop('back'); return; }
  if (voice.open) { voice.hide(); return; }
  if (!$('#standby').hidden) return;
  if (!document.querySelector('#subsMenu').hidden) { tv.toggleSubsMenu(false); return; }
  if (!document.querySelector('#player').hidden) {
    const id = tv.state.playing?.titleId;
    tv.closePlayer();
    if (id) tv.openTitle(id);
    return;
  }
  if (tv.state.screen !== 'home') tv.navigate('home');
}
// Optional on-screen remote indicator (?showkeys), used for demos and recordings.
const KEY_GLYPH = { ArrowUp: '▲', ArrowDown: '▼', ArrowLeft: '◀', ArrowRight: '▶', Enter: 'OK', Escape: 'Back', Backspace: 'Back', m: '☰ Mic', M: '☰ Mic' };
let pressCount = 0;
function showKey(k) {
  if (!params.has('showkeys') || !KEY_GLYPH[k]) return;
  pressCount += 1;
  let el = document.getElementById('remoteToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'remoteToast';
    el.className = 'remote-toast';
    document.getElementById('stage').appendChild(el);
  }
  el.innerHTML = `<span class="rt-label">Remote</span><span class="key big">${KEY_GLYPH[k]}</span>${params.has('count') ? `<span class="rt-count">${pressCount} presses</span>` : ''}`;
  el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
  clearTimeout(showKey.t);
  showKey.t = setTimeout(() => el.classList.remove('hit'), 1600);
}
document.addEventListener('keydown', (e) => {
  if (e.target === $('#voiceInput')) return;
  showKey(e.key);
  const k = e.key;
  if (!$('#standby').hidden) { if (k === 'Enter') tv.wake(); return; }
  if (k === 'm' || k === 'M' || k === 'ContextMenu' || k === 'F2' || k === '/') { e.preventDefault(); voice.start(); return; }
  if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') { e.preventDefault(); back(); return; }
  if (k === 'MediaPlayPause' || k === ' ') { e.preventDefault(); if (tv.state.playing) tv.playerAction('toggle'); return; }
  if (k === 't' || k === 'T') { tv.advanceClock(e.shiftKey ? 30 : 1); return; } // demo: fast-forward the clock
  // Touching the remote while the agent drives hands control back instantly.
  if (pilot.busy && !pilot.waiting && (KEYMAP[k] || k === 'Enter')) { e.preventDefault(); pilot.stop('remote'); return; }
  if (KEYMAP[k]) {
    e.preventDefault();
    if (!$('#player').hidden) tv.wakePlayerUi();
    if (pilot.waiting) {
      const choices = [...document.querySelectorAll('#pilotChoices [data-focus]')];
      const i = choices.indexOf(tv.focused);
      const d = k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1;
      tv.setFocus(choices[Math.max(0, Math.min(choices.length - 1, i + d))]);
      return;
    }
    tv.move(KEYMAP[k]);
    return;
  }
  if (k === 'Enter') { e.preventDefault(); if (!$('#player').hidden && $('#player').classList.contains('clean')) { tv.wakePlayerUi(); return; } tv.pressFocused(); }
});
document.addEventListener('mousemove', () => {}, { passive: true });

// ---------------------------------------------------------------- server bridge (MCP <-> TV)
let pushTimer = null;
function pushState() {
  if (!server.online) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch('api/tv/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tv.snapshot()) }).catch(() => {});
  }, 150);
}
let currentRun = null;
function nextQuestion() {
  return new Promise((resolve) => {
    const off = pilot.on((type, data) => {
      if (type === 'clarify' || type === 'confirm') {
        off();
        // give the panel a moment to render before reporting back
        setTimeout(() => resolve({ status: 'needs_input', kind: type, ...data, state: tv.snapshot() }), 300);
      }
    });
  });
}
async function untilDoneOrQuestion() {
  const r = await Promise.race([currentRun, nextQuestion()]);
  return r.status === 'needs_input' ? r : { ...r, state: tv.snapshot() };
}
async function runCommand(cmd) {
  const { kind, payload = {} } = cmd;
  if (kind === 'goal') {
    voice.show('Alexa+ → Couch Pilot');
    voice.transcript(payload.goal);
    await sleep(700);
    voice.hide(200);
    currentRun = pilot.handle(payload.goal, { source: 'mcp' });
    return untilDoneOrQuestion();
  }
  if (kind === 'answer') {
    if (!pilot.waiting) return { status: 'nothing-to-answer', state: tv.snapshot() };
    const v = pilot.parseAnswer(String(payload.answer));
    if (v === null) return { status: 'not-understood', hint: pilot.waiting.kind === 'confirm' ? 'Answer yes or no.' : 'Answer with the number or the name of a choice.' };
    pilot.waiting.resolve(v);
    return currentRun ? untilDoneOrQuestion() : { status: 'answered', state: tv.snapshot() };
  }
  if (kind === 'stop') return { status: pilot.stop('mcp') ? 'stopped' : 'idle', state: tv.snapshot() };
  if (kind === 'state') return { status: 'ok', state: tv.snapshot(), waitingFor: pilot.waiting ? pilot.waiting.kind : null };
  if (kind === 'action') {
    // A single primitive, still executed visibly and still under guardrails.
    const step = { action: payload.action, args: payload.args || {}, label: payload.label || payload.action.replace(/_/g, ' ') };
    currentRun = pilot.handle(`__action__ ${JSON.stringify(step)}`, { source: 'mcp' });
    return untilDoneOrQuestion();
  }
  return { status: 'unknown-command' };
}
function connectBridge() {
  if (!server.online || !window.EventSource) return;
  const es = new EventSource('api/tv/events');
  es.onmessage = async (ev) => {
    let cmd;
    try { cmd = JSON.parse(ev.data); } catch (e) { return; }
    if (!cmd?.id) return;
    let result;
    // goals run long (questions, confirmations); answer/stop must not wait behind them
    try { result = await runCommand(cmd); } catch (e) { result = { status: 'error', error: String(e) }; }
    fetch('api/tv/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: cmd.id, result }) }).catch(() => {});
  };
  es.onopen = () => pushState();
}

// A single MCP primitive ("__action__ {...}") becomes a one-step plan.
const origHandle = pilot.handle.bind(pilot);
pilot.handle = async (text, opts) => {
  if (String(text).startsWith('__action__ ')) {
    const step = JSON.parse(String(text).slice(11));
    const { enforceGuardrails } = await import('./planner.js');
    const plan = enforceGuardrails({ type: 'plan', utterance: step.label, steps: [step], say: `${step.label[0].toUpperCase()}${step.label.slice(1)}.`, planner: 'mcp' });
    if (plan.type !== 'plan') { pilot.open(); pilot.say(plan.say, { big: true }); setTimeout(() => pilot.finish(), 3000); return { status: plan.type, say: plan.say }; }
    pilot.busy = true;
    pilot.abort = new AbortController();
    pilot.open();
    pilot.heard('');
    pilot.plannerBadge({ planner: 'mcp', ms: 0 });
    try { return await pilot.execute(plan, pilot.abort.signal); } catch (e) { return { status: 'stopped' }; }
  }
  return origHandle(text, opts);
};

// ---------------------------------------------------------------- public hooks
window.couchPilot = {
  tv,
  pilot,
  ask: (text) => pilot.handle(text, { source: 'api' }),
  simulateVoice,
  stop: () => pilot.stop('api'),
  back,
  key: (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k })),
  advanceClock: (m) => tv.advanceClock(m),
  onVoiceResult: (text, final) => { voice.show(); voice.transcript(text); if (final) voice.submit(text); },
  onVoiceError: () => voice.typed(),
  forget: () => { localStorage.removeItem('couchpilot.memory'); location.reload(); },
  server,
};

probeServer().then(() => {
  connectBridge();
  pilot.plannerBadge(null);
  document.documentElement.dataset.server = server.online ? (server.bedrock ? 'bedrock' : 'online') : 'standalone';
});
