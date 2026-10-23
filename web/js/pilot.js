// Couch Pilot: listen -> understand -> show the plan -> drive the TV -> confirm.
// The executor uses the same primitives as the remote (focus, press, type),
// so the user watches the TV drive itself, and can take over at any moment.

import { byId, TITLES } from './catalog.js';
import { planGoal, enforceGuardrails, clockLabel } from './planner.js';
import { sleep } from './tv.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

class Stopped extends Error {}

export class Pilot {
  constructor(tv, { speak, planRemote } = {}) {
    this.tv = tv;
    this.speakFn = speak || (() => {});
    this.planRemote = planRemote; // optional cloud planner (Amazon Bedrock via the Couch Pilot server)
    this.busy = false;
    this.abort = null;
    this.waiting = null; // { kind: 'clarify'|'confirm', resolve, options }
    this.history = [];
    this.listeners = new Set();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); this.log(type, data); }
  log(type, data) {
    const entry = { t: Math.round(performance.now()), type, data };
    (window.__couchPilotLog ||= []).push(entry);
  }

  ctx() {
    return { memory: this.tv.memory, state: this.tv.snapshot() };
  }

  // ------------------------------------------------------------------ panel UI
  open() { document.body.classList.add('piloting'); this.refocusSoon(); }
  close() {
    document.body.classList.remove('piloting');
    this.refocusSoon();
  }
  refocusSoon() {
    setTimeout(() => this.tv.focused && document.contains(this.tv.focused) && this.tv.placeRing(this.tv.focused), 720);
  }
  status(text, kind = '') {
    const s = $('#pilotStatus');
    s.textContent = text;
    s.className = `pilot-status ${kind}`;
  }
  heard(text) { $('#pilotHeard').textContent = text || ''; }
  say(text, { big = false, speak = true } = {}) {
    const el = $('#pilotSay');
    el.textContent = text || '';
    el.classList.toggle('big', big);
    if (speak && text) this.speakFn(text);
    this.emit('say', text);
  }
  renderSteps(steps) {
    $('#pilotChoices').innerHTML = '';
    $('#pilotSteps').innerHTML = steps.map((s, i) => `
      <li class="step" data-i="${i}" style="animation-delay:${i * 90}ms">
        <span class="num">${i + 1}</span><span class="label">${s.label}</span><span class="state"></span>
      </li>`).join('');
  }
  stepState(i, state, word) {
    const li = $(`.step[data-i="${i}"]`);
    if (!li) return;
    li.className = `step ${state}`;
    li.style.animationDelay = '0ms';
    const num = $('.num', li);
    if (state === 'done') num.textContent = '✓';
    if (state === 'wait') num.textContent = '?';
    $('.state', li).textContent = word ?? { active: 'Now', done: 'Done', skipped: 'Skipped', wait: 'Your call', failed: 'Retry' }[state] ?? '';
  }
  plannerBadge(plan) {
    $('#pilotPlanner').textContent = plan?.planner ? `Planned ${plan.planner === 'bedrock' ? `in the cloud · Amazon Bedrock (${plan.model || 'model'})` : 'on this TV'} · ${plan.ms ?? 0} ms` : '';
  }
  bubble(main, sub = '', ms = 4200) {
    const b = $('#bubble');
    $('#bubbleMain').textContent = main;
    $('#bubbleSub').textContent = sub;
    b.hidden = false;
    b.classList.remove('out');
    clearTimeout(this._bubbleT);
    this._bubbleT = setTimeout(() => { b.classList.add('out'); setTimeout(() => { b.hidden = true; }, 500); }, ms);
  }

  // ------------------------------------------------------------------ entry point
  async handle(utterance, { source = 'voice' } = {}) {
    const text = String(utterance || '').trim();
    if (!text) return { status: 'ignored' };

    // While waiting for an answer, short replies answer the question.
    if (this.waiting) {
      const ans = this.parseAnswer(text);
      if (ans !== null) { this.waiting.resolve(ans); return { status: 'answered' }; }
    }
    const quick = planGoal(text, this.ctx());
    if (quick.type === 'stop') { this.stop('voice'); return { status: 'stopped' }; }
    if (this.busy) { this.stop('new-request'); await sleep(400); }

    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.open();
    this.heard(text);
    this.say('');
    $('#pilotSteps').innerHTML = '';
    $('#pilotChoices').innerHTML = '';
    this.status('Thinking', 'live');
    this.emit('heard', { text, source });

    try {
      let plan = await this.makePlan(text);
      this.plannerBadge(plan);
      if (signal.aborted) throw new Stopped();

      if (plan.type === 'clarify') {
        const choice = await this.askChoice(plan);
        if (signal.aborted) throw new Stopped();
        const t0 = performance.now();
        plan = planGoal(plan.pending.utterance, this.ctx(), { forceTitleId: choice });
        plan.ms = Math.round(performance.now() - t0);
        this.plannerBadge(plan);
      }
      if (plan.type === 'refuse' || plan.type === 'unknown' || plan.type === 'problem') {
        this.status(plan.type === 'refuse' ? 'Not allowed' : 'Need help', 'wait');
        this.say(plan.say, { big: true });
        this.emit('result', plan);
        await sleep(3800);
        this.finish(false);
        return { status: plan.type, say: plan.say };
      }
      const result = await this.execute(plan, signal);
      return result;
    } catch (e) {
      if (e instanceof Stopped || signal.aborted) return { status: 'stopped', say: "Okay, stopping. You're in control." };
      console.error(e);
      this.say("Something went wrong on my side. You're in control.", { big: true });
      this.finish(false);
      return { status: 'error', error: String(e) };
    }
  }

  async makePlan(text) {
    const t0 = performance.now();
    if (this.planRemote) {
      try {
        const remote = await this.planRemote(text, this.ctx());
        if (remote && remote.type) {
          const plan = enforceGuardrails(remote);
          plan.ms = Math.round(performance.now() - t0);
          return plan;
        }
      } catch (e) { /* fall back to the on-device planner */ }
    }
    const plan = planGoal(text, this.ctx());
    plan.ms = Math.round(performance.now() - t0);
    await sleep(450); // let the "Thinking" state be readable
    return plan;
  }

  // ------------------------------------------------------------------ questions
  parseAnswer(text) {
    const t = text.toLowerCase();
    const w = this.waiting;
    if (w.kind === 'confirm') {
      if (/\b(yes|yeah|yep|sure|go ahead|ok(ay)?|do it|confirm|oui)\b/.test(t)) return true;
      if (/\b(no|nope|don'?t|cancel|stop|non)\b/.test(t)) return false;
      return null;
    }
    if (w.kind === 'clarify') {
      const idx = /\b(first|1|one|la 1|la première)\b/.test(t) ? 0 : /\b(second|2|two|la 2|la deuxième)\b/.test(t) ? 1 : /\b(third|3|three)\b/.test(t) ? 2 : -1;
      if (idx >= 0 && w.options[idx]) return w.options[idx].titleId;
      const named = w.options.find((o) => t.includes(o.label.toLowerCase()) || o.label.toLowerCase().split(' ').some((x) => x.length > 3 && t.includes(x)));
      if (named) return named.titleId;
      return null;
    }
    return null;
  }
  askChoice(plan) {
    this.status('Your call', 'wait');
    this.say(plan.question, { big: true, speak: false });
    this.speakFn(plan.say);
    $('#pilotSteps').innerHTML = '';
    const box = $('#pilotChoices');
    box.innerHTML = plan.options.map((o, i) => `
      <button class="choice" data-focus data-choice="${o.titleId}" style="animation-delay:${i * 90}ms">
        <span class="cn">${i + 1}</span><span class="ca" style="background-image:url('${o.art}')"></span>
        <span><div class="ct">${o.label}</div><div class="cs">${o.sub}</div></span>
      </button>`).join('');
    $('#pilotFoot').innerHTML = 'Say <b>“the first one”</b>, or use <span class="key">◀ ▶</span><span class="key">OK</span>';
    this.emit('clarify', { question: plan.question, options: plan.options });
    return new Promise((resolve, reject) => {
      const done = (v) => { this.waiting = null; this.resetFoot(); resolve(v); };
      this.waiting = { kind: 'clarify', options: plan.options, resolve: done, reject };
      $$('[data-choice]', box).forEach((b) => b.addEventListener('click', () => done(b.dataset.choice)));
      setTimeout(() => this.tv.setFocus($('[data-choice]', box)), 450);
      this.abort.signal.addEventListener('abort', () => { this.waiting = null; reject(new Stopped()); });
    });
  }
  askConfirm(question, signal) {
    this.status('Your call', 'wait');
    this.say(question, { big: true });
    const box = $('#pilotChoices');
    box.innerHTML = `
      <button class="choice yesno" data-focus data-yes="1"><span class="cn">✓</span><span><div class="ct">Yes, go ahead</div></span></button>
      <button class="choice yesno" data-focus data-yes="0"><span class="cn">✕</span><span><div class="ct">No, thanks</div></span></button>`;
    $('#pilotFoot').innerHTML = 'Say <b>“yes”</b> or <b>“no”</b>, or press <span class="key">OK</span>';
    this.emit('confirm', { question });
    return new Promise((resolve, reject) => {
      const done = (v) => { this.waiting = null; box.innerHTML = ''; this.resetFoot(); resolve(v); };
      this.waiting = { kind: 'confirm', resolve: done, reject };
      $$('[data-yes]', box).forEach((b) => b.addEventListener('click', () => done(b.dataset.yes === '1')));
      // Default focus is "No": an accidental OK never spends money.
      setTimeout(() => this.tv.setFocus($('[data-yes="0"]', box)), 400);
      signal.addEventListener('abort', () => { this.waiting = null; reject(new Stopped()); });
    });
  }
  resetFoot() {
    $('#pilotFoot').innerHTML = '<span class="key">Back</span> or say <b>“Stop”</b> to take over';
  }

  // ------------------------------------------------------------------ execution
  async execute(plan, signal) {
    this.renderSteps(plan.steps);
    this.status('Driving', 'live');
    this.say(plan.say);
    this.emit('plan', plan);
    await this.wait(1100, signal);

    const done = [];
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      this.stepState(i, 'active');
      this.emit('step', { i, step, state: 'active' });
      let attempts = 0;
      for (;;) {
        try {
          if (step.risk === 'confirm') {
            this.stepState(i, 'wait');
            const q = this.confirmQuestion(step);
            const yes = await this.askConfirm(q, signal);
            if (!yes) {
              this.stepState(i, 'skipped', 'Declined');
              for (let k = i + 1; k < plan.steps.length; k++) this.stepState(k, 'skipped');
              this.status('Stopped', 'wait');
              this.say(step.action === 'rent' ? "Okay, nothing was charged. You're in control." : "Okay, I won't. You're in control.", { big: true });
              this.emit('result', { status: 'declined', step: step.label });
              await this.wait(3200, signal).catch(() => {});
              this.finish(false);
              return { status: 'declined', done };
            }
            this.status('Driving', 'live');
            this.stepState(i, 'active');
          }
          await this.runStep(step, signal);
          break;
        } catch (e) {
          if (e instanceof Stopped || signal.aborted) throw new Stopped();
          attempts += 1;
          console.warn('step failed', step, e);
          if (attempts >= 2) {
            this.stepState(i, 'failed', 'Failed');
            this.status('Need help', 'wait');
            this.say(`I couldn't ${step.label.toLowerCase()}. You're in control.`, { big: true });
            this.emit('result', { status: 'failed', step: step.label });
            await sleep(3000);
            this.finish(false);
            return { status: 'failed', failedStep: step.label, done };
          }
          this.stepState(i, 'failed', 'Retrying');
          await this.wait(600, signal);
        }
      }
      this.stepState(i, 'done');
      this.emit('step', { i, step, state: 'done' });
      done.push(step.label);
      await this.wait(260, signal);
    }

    // Done: announce in one sentence, then get out of the way.
    this.status('Done', '');
    const vol = plan.steps.find((s) => s.action === 'set_volume');
    const rem = plan.steps.find((s) => s.action === 'schedule');
    const extra = [vol ? `Volume at ${vol.args.level}.` : '', rem ? (rem.args.kind === 'reminder' ? `Reminder at ${rem.args.at ? clockLabel(rem.args.at) : `+${rem.args.inMinutes} min`}.` : `Stops in ${rem.args.inMinutes ?? ''} min.`) : ''].filter(Boolean).join(' ');
    const playing = plan.steps.some((s) => s.action === 'play');
    const finalLine = playing ? 'All set. Enjoy.' : 'Done.';
    this.say(finalLine, { big: true });
    this.emit('result', { status: 'done', done, say: finalLine });
    await this.wait(1500, signal).catch(() => {});
    this.finish(true);
    this.bubble(playing ? 'All set. Enjoy.' : 'Done.', extra);
    return { status: 'done', done, say: `${finalLine} ${extra}`.trim() };
  }

  confirmQuestion(step) {
    if (step.action === 'rent') return `This rental costs $${Number(step.args.price).toFixed(2)}. Should I go ahead?`;
    if (step.action === 'power_off') return 'Turn the TV off now?';
    return `${step.label}. Should I go ahead?`;
  }

  async wait(ms, signal) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (signal?.aborted) throw new Stopped();
      await sleep(Math.min(60, end - performance.now()));
    }
  }

  async runStep(step, signal) {
    const tv = this.tv;
    const a = step.args || {};
    const W = (ms) => this.wait(ms, signal);
    const press = async (el, via) => {
      if (!el) throw new Error(`target not found for ${step.action}`);
      if (signal.aborted) throw new Stopped();
      await tv.agentFocus(el, { via: via || [] });
      if (signal.aborted) throw new Stopped();
      await tv.pressFocused({ by: 'agent' });
      await W(380);
    };
    switch (step.action) {
      case 'navigate': {
        if (a.kids && !tv.state.kids) tv.setKids(true);
        const tabs = $$('.nav-pill .tab');
        const target = $(`.nav-pill [data-nav="${a.tab}"]`) || $('#searchPill');
        const from = tv.focused && tabs.includes(tv.focused) ? tabs.indexOf(tv.focused) : 0;
        const to = tabs.indexOf(target);
        const via = to > from ? tabs.slice(from, to) : tabs.slice(to + 1, from + 1).reverse();
        await press(target, via);
        return;
      }
      case 'open_title': {
        const t = byId[a.titleId];
        let card = $(`#screen .card[data-title="${a.titleId}"]`);
        if (!card) {
          // Not on screen: use search, typing like a person would.
          await press($('#searchPill'));
          const name = t.name.replace(/^The /, '');
          const word = name.split(' ')[0].toUpperCase();
          for (const ch of word) {
            const key = $(`[data-key="${ch}"]`);
            if (key) { key.classList.add('hit'); tv.setFocus(key, { by: 'agent' }); }
            tv.typeQuery(tv.state.searchQuery + ch.toLowerCase());
            await W(170);
            key?.classList.remove('hit');
          }
          await W(300);
          card = $(`#results .card[data-title="${a.titleId}"]`);
        }
        const cards = $$('#screen .card');
        const via = cards.slice(0, Math.max(0, cards.indexOf(card)));
        await press(card, via.slice(-3));
        await W(350);
        if (a.season && t.kind === 'series') {
          const pill = $(`[data-season="${a.season}"]`);
          if (pill && !pill.classList.contains('active')) await press(pill);
          else if (pill) { await tv.agentFocus(pill); await W(200); }
        }
        return;
      }
      case 'rent': {
        tv.state.rented[a.titleId] = true;
        tv.flashChip(`Rented “${byId[a.titleId].name}” · simulated, no real payment`);
        await W(700);
        return;
      }
      case 'play': {
        const t = byId[a.titleId];
        if (tv.state.screen !== 'detail' || tv.state.detailId !== a.titleId) tv.openTitle(a.titleId, a.season);
        await W(250);
        if (t.kind === 'series' && a.episode) {
          tv.scrollEpisodesTo(a.episode);
          const eps = $$('.episode');
          const el = tv.episodeEl(a.episode);
          const idx = eps.indexOf(el);
          await tv.agentFocus(el, { via: eps.slice(Math.max(0, idx - 3), idx), dwell: 320 });
          await tv.pressFocused({ by: 'agent' });
          // Clicking an episode starts it at its saved position; force the planned one.
          tv.play({ titleId: a.titleId, season: a.season, episode: a.episode, position: a.position || 0 });
        } else {
          await press($('[data-detail="play"]'));
          tv.play({ titleId: a.titleId, position: a.position || 0 });
        }
        await W(900);
        return;
      }
      case 'set_volume':
        await tv.setVolume(a.level);
        await W(250);
        return;
      case 'mute':
        tv.state.muted = true;
        tv.renderVolume();
        $('#volumeHud').hidden = false;
        return;
      case 'set_subtitles': {
        if (tv.state.playing) {
          tv.wakePlayerUi();
          await press($('#subsBtn'));
          const opt = $(`.subs-opt[data-lang="${a.language || ''}"]`) || $('.subs-opt[data-lang=""]');
          await press(opt);
          await W(300);
          tv.cleanPlayer();
        } else {
          tv.setSubtitles(a.language);
          tv.memory.preferences.subtitles = a.language || tv.memory.preferences.subtitles;
        }
        return;
      }
      case 'seek':
        if (!tv.seek(a.delta)) throw new Error('nothing is playing');
        await W(600);
        return;
      case 'pause':
        tv.pause();
        await W(300);
        return;
      case 'resume_playback':
        tv.resumePlayback();
        await W(300);
        return;
      case 'set_kids_mode':
        tv.setKids(!!a.on);
        if (a.on) tv.memory.preferences.kidsMaxVolume = a.maxVolume ?? tv.memory.preferences.kidsMaxVolume;
        await W(500);
        return;
      case 'schedule':
        tv.addTimer(a);
        await W(500);
        return;
      case 'home':
        await press($('.nav-pill [data-nav="home"]'));
        return;
      case 'power_off':
        tv.powerOff();
        return;
      default:
        throw new Error(`unknown action ${step.action}`);
    }
  }

  // ------------------------------------------------------------------ hand-over
  stop(reason = 'user') {
    if (!this.busy && !this.waiting) return false;
    const signal = this.abort;
    this.abort?.abort();
    this.waiting = null;
    $$('.step').forEach((li) => { if (!li.classList.contains('done')) li.className = 'step skipped'; });
    $('#pilotChoices').innerHTML = '';
    this.status('Stopped', 'wait');
    this.say("Okay, stopping. You're in control.", { big: true });
    this.emit('stopped', { reason });
    this.busy = false;
    setTimeout(() => { if (!this.busy && this.abort === signal) this.finish(false); }, 2600);
    return true;
  }
  finish() {
    this.busy = false;
    this.close();
    this.resetFoot();
    setTimeout(() => {
      if (this.busy) return;
      this.heard('');
      this.say('', { speak: false });
      $('#pilotSteps').innerHTML = '';
      $('#pilotChoices').innerHTML = '';
      this.status('Ready');
    }, 800);
  }

  // Timers raised by the TV clock
  onTimer(t) {
    if (t.kind === 'reminder') {
      this.bubble(t.message || 'Reminder', 'Couch Pilot', 6000);
      this.speakFn(t.message);
    } else if (t.kind === 'sleep') {
      if (this.tv.state.kids) {
        this.tv.closePlayer();
        this.tv.navigate('home');
        this.bubble('Time is up for today.', 'Kids playback stopped', 6000);
        this.speakFn('Time is up for today.');
      } else {
        this.tv.powerOff();
      }
    }
  }
  onTimerWarning(t) {
    if (t.kind !== 'sleep') return;
    const line = this.tv.state.kids ? 'One more minute, then it stops.' : 'Turning off in one minute. Say wait to cancel.';
    this.bubble(line, 'Say “wait” to cancel', 6000);
    this.speakFn(line);
    this.pendingSleep = t;
  }
}

export function allTitlesForPrompt() {
  return TITLES.map((t) => ({ id: t.id, name: t.name, kind: t.kind, genres: t.genres, kids: !!t.kids, price: t.price || null, seasons: t.seasons || null }));
}
