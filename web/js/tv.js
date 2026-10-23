// The TV: screens, focus engine, player. The user drives it with the remote;
// Couch Pilot drives it with exactly the same primitives (focus, press, type),
// so everything the agent does is visible on screen.

import { TITLES, byId, HERO_ORDER, CONTINUE_ORDER, subtitleOf, fmtTime } from './catalog.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" class="ico"><path d="M9 6l6 6-6 6"/></svg>';

const CAPTIONS = {
  harbor: ['— The tide brought it in last night.', '— Then someone wanted it found.', '— Check the old customs house.', '— Nobody has used that pier in years.'],
  ember: ['— Wait for me!', '— She went north, past the burning gates.', '— I raised her. She will know me.'],
  pampas: ['[cheerful music]', '— Just one more jump!', '— Oops…', '[birds chirping]'],
  moon: ['[gentle music]', '— Good morning, little meadow!', '[leaves rustling]'],
  cosmic: ['[soft music]', 'Our blue planet, seen from far away.', 'Every light you see is a world.'],
  dune: ['[wind]', '— Follow the song, and the dunes will lead you home.'],
  steel: ['— Forty years, and you still owe me a coffee.', '— The machines remember everything.'],
  brigade: ['— Eyes on the north tower.', '— Hold your fire.'],
};

export class TV {
  constructor() {
    this.stage = $('#stage');
    this.screenEl = $('#screen');
    this.ring = $('#focusRing');
    this.video = $('#video');
    this.state = {
      screen: 'home',
      heroIndex: 0,
      detailId: null,
      detailSeason: 1,
      volume: 18,
      muted: false,
      subtitles: null,
      kids: false,
      playing: null, // { titleId, season, episode, position, duration }
      paused: false,
      rented: {},
      timers: [], // { id, kind, label, fireAt }
      searchQuery: '',
      clockMinutes: 21 * 60 + 12,
    };
    this.focused = null;
    this.listeners = new Set();
    this.memory = null;
  }

  init(memory) {
    this.memory = memory;
    this.fit();
    window.addEventListener('resize', () => this.fit());
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => this.navigate(b.dataset.nav)));
    $$('[data-player]').forEach((b) => b.addEventListener('click', () => this.playerAction(b.dataset.player)));
    $$('[data-lang]').forEach((b) => b.addEventListener('click', () => this.setSubtitles(b.dataset.lang || null, { fromMenu: true })));
    this.navigate('home');
    this.tickClock();
    setInterval(() => this.heroAutoAdvance(), 9000);
    setInterval(() => this.updateProgress(), 500);
    // never leave the focus ring on an element that has disappeared
    setInterval(() => {
      if (this.focused && !this.focused.isConnected) {
        this.ring.classList.remove('on');
        const fallback = $('#player').hidden ? $('[data-focus]', this.screenEl) : $('[data-player="toggle"]');
        if (fallback && !document.body.classList.contains('piloting')) this.setFocus(fallback);
      }
    }, 250);
    this.renderChips();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    this.scale = s;
    this.stage.style.transform = `translate(${(window.innerWidth - 1920 * s) / 2}px, ${(window.innerHeight - 1080 * s) / 2}px) scale(${s})`;
    if (this.focused) this.placeRing(this.focused);
  }

  snapshot() {
    const s = this.state;
    return {
      screen: s.screen,
      detailId: s.detailId,
      volume: s.volume,
      muted: s.muted,
      subtitles: s.subtitles,
      kidsMode: s.kids,
      nowPlaying: s.playing ? { ...s.playing, title: byId[s.playing.titleId].name, paused: s.paused } : null,
      rented: Object.keys(s.rented),
      timers: s.timers.map((t) => ({ kind: t.kind, label: t.label })),
      clock: this.clockText(),
    };
  }

  // ---------------------------------------------------------------- clock / timers
  clockText(mins = this.state.clockMinutes) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${ap}`;
  }
  tickClock() {
    $('#clock').textContent = this.clockText();
    clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => this.advanceClock(1), 60000);
  }
  advanceClock(minutes) {
    for (let i = 0; i < minutes; i++) {
      this.state.clockMinutes = (this.state.clockMinutes + 1) % (24 * 60);
      const now = this.state.clockMinutes;
      for (const t of [...this.state.timers]) {
        if (t.kind === 'sleep' && t.fireAt - now === 1) this.emit('timer-warning', t);
        if (t.fireAt === now) this.fireTimer(t);
      }
    }
    $('#clock').textContent = this.clockText();
  }
  addTimer({ kind, at, inMinutes, message }) {
    const now = this.state.clockMinutes;
    const fireAt = at ? at.h * 60 + at.m : (now + inMinutes) % (24 * 60);
    const label = kind === 'reminder' ? `Reminder ${this.clockText(fireAt)}` : kind === 'sleep' && this.state.kids ? `Stops at ${this.clockText(fireAt)}` : `Off at ${this.clockText(fireAt)}`;
    this.state.timers = this.state.timers.filter((t) => t.kind !== kind);
    const t = { id: Math.random().toString(36).slice(2), kind, fireAt, label, message };
    this.state.timers.push(t);
    this.renderChips();
    return t;
  }
  cancelTimer(kind) {
    this.state.timers = this.state.timers.filter((t) => t.kind !== kind);
    this.renderChips();
  }
  fireTimer(t) {
    this.state.timers = this.state.timers.filter((x) => x !== t);
    this.renderChips();
    this.emit('timer', t);
  }
  renderChips() {
    const chips = [];
    if (this.state.kids) chips.push('<div class="chip kids"><i></i>Kids mode</div>');
    for (const t of this.state.timers) chips.push(`<div class="chip"><i></i>${t.label}</div>`);
    $('#chips').innerHTML = chips.join('');
  }

  // ---------------------------------------------------------------- focus engine
  focusables() {
    const scope = !$('#player').hidden ? $('#player') : document;
    return $$('[data-focus]', scope).filter((el) => {
      if (el.closest('[hidden]')) return false;
      if (el.closest('#pilot') && !document.body.classList.contains('piloting')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }
  rectOf(el) {
    const r = el.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const s = this.scale || 1;
    return { x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s };
  }
  placeRing(el) {
    const r = this.rectOf(el);
    const pad = el.classList.contains('tab') || el.classList.contains('season') ? 2 : 0;
    const t = `translate(${r.x - pad}px, ${r.y - pad}px)`;
    this.ring.style.setProperty('--ring-t', t);
    this.ring.style.transform = t;
    this.ring.style.width = `${r.w + pad * 2}px`;
    this.ring.style.height = `${r.h + pad * 2}px`;
    const br = parseFloat(getComputedStyle(el).borderRadius) || 20;
    this.ring.style.borderRadius = `${Math.min(br + 4, (r.h + pad * 2) / 2)}px`;
    // the panel lives outside the shrinking TV, so ring coordinates are relative to the stage
    this.ring.style.zIndex = el.closest('#pilot') ? 90 : 50;
  }
  setFocus(el, { by = 'user' } = {}) {
    if (!el) return;
    if (this.focused) this.focused.classList.remove('focused');
    this.focused = el;
    el.classList.add('focused');
    // the ring is positioned in stage space; move it to the stage root so it can sit above the panel
    if (this.ring.parentElement !== this.stage) this.stage.appendChild(this.ring);
    this.ring.classList.add('on');
    this.ring.classList.toggle('agent', by === 'agent');
    this.placeRing(el);
    if (el.dataset.hero !== undefined) this.showHero(Number(el.dataset.hero));
    this.emit('focus', el);
  }
  async pressFocused({ by = 'user' } = {}) {
    if (!this.focused) return;
    this.ring.classList.remove('press');
    void this.ring.offsetWidth;
    this.ring.classList.add('press');
    if (by === 'agent') await sleep(180);
    this.focused.click();
  }
  move(dir) {
    const items = this.focusables();
    if (!this.focused || !items.includes(this.focused)) return this.setFocus(items[0]);
    const a = this.rectOf(this.focused);
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === this.focused) continue;
      const b = this.rectOf(el);
      const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const dx = bc.x - ac.x;
      const dy = bc.y - ac.y;
      const ok = (dir === 'left' && dx < -4) || (dir === 'right' && dx > 4) || (dir === 'up' && dy < -4) || (dir === 'down' && dy > 4);
      if (!ok) continue;
      const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = main + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this.setFocus(best);
  }

  // Agent-visible helpers: glide the focus ring through intermediate items.
  async agentFocus(el, { via = [], dwell = 300 } = {}) {
    for (const v of via) {
      this.setFocus(v, { by: 'agent' });
      await sleep(dwell * 0.75);
    }
    this.setFocus(el, { by: 'agent' });
    await sleep(dwell);
  }
  async agentPress(el, opts) {
    await this.agentFocus(el, opts);
    await this.pressFocused({ by: 'agent' });
    await sleep(320);
  }

  // ---------------------------------------------------------------- screens
  setTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === name));
  }
  navigate(name, opts = {}) {
    if (!$('#player').hidden) this.closePlayer();
    this.state.screen = name;
    this.setTab(['home', 'mylist', 'discover', 'shop'].includes(name) ? name : null);
    $('#searchPill').classList.toggle('typing', name === 'search');
    const render = {
      home: () => this.renderHome(),
      mylist: () => this.renderGrid('mylist'),
      discover: () => this.renderGrid('discover'),
      shop: () => this.renderGrid('shop'),
      search: () => this.renderSearch(opts.query || ''),
      detail: () => this.renderDetail(opts.titleId, opts.season),
    }[name];
    render();
    this.emit('screen', name);
    if (!opts.keepFocus) {
      const first = $('[data-focus]', this.screenEl);
      if (first && this.focused?.closest('#screen') == null && this.focused?.closest('#pilot') == null) {
        // keep focus on the nav pill the user pressed; otherwise drop into content
      }
      if (first && (!this.focused || !document.contains(this.focused))) this.setFocus(first);
    }
  }

  cardHTML(t, { prog, badge, sub, attrs = '' } = {}) {
    const p = prog ? Math.min(100, Math.max(4, (prog.position / ((t.episodeMinutes || t.minutes) * 60)) * 100)) : 0;
    return `<button class="card" data-focus data-title="${t.id}" ${attrs} style="background-image:url('${t.art}')">
      ${badge || ''}
      <div class="card-info"><div class="card-title">${t.name}</div><div class="card-sub">${sub || subtitleOf(t)}</div></div>
      ${prog && prog.position > 0 ? `<div class="card-progress"><b style="width:${p}%"></b></div>` : ''}
    </button>`;
  }

  renderHome() {
    const heroes = HERO_ORDER.map((id) => byId[id]);
    const cont = (this.state.kids ? TITLES.filter((t) => t.kids).map((t) => t.id) : CONTINUE_ORDER).map((id) => byId[id]);
    const mem = this.memory.progress;
    this.screenEl.innerHTML = `
      <div class="hero" id="hero"></div>
      <div class="dots">${heroes.map((_, i) => `<i data-dot="${i}"></i>`).join('')}</div>
      <div class="row-head">${this.state.kids ? 'Kids corner' : 'Continue Watching'} <span class="chev">${CHEV}</span></div>
      <div class="row">${cont.map((t) => {
        const prog = mem[t.id];
        const sub = prog && prog.season ? `S${prog.season} · E${prog.episode} • ${t.creator}` : subtitleOf(t);
        return this.cardHTML(t, { prog, sub });
      }).join('')}</div>`;
    this.screenEl.style.animation = 'none'; void this.screenEl.offsetWidth; this.screenEl.style.animation = '';
    this.showHero(this.state.heroIndex);
    $$('.row .card', this.screenEl).forEach((c) => c.addEventListener('click', () => this.openTitle(c.dataset.title)));
  }
  showHero(i) {
    const hero = $('#hero');
    if (!hero) return;
    const ids = HERO_ORDER;
    const n = ids.length;
    i = ((i % n) + n) % n;
    if (this.state.heroIndex === i && hero.childElementCount) return;
    this.state.heroIndex = i;
    const t = byId[ids[i]];
    const prev = byId[ids[(i - 1 + n) % n]];
    const next = byId[ids[(i + 1) % n]];
    const prog = this.memory.progress[t.id];
    const resume = prog && prog.position > 0;
    hero.innerHTML = `
      <div class="hero-card prev" style="background-image:url('${prev.still || prev.art}')"></div>
      <div class="hero-card center" style="background-image:url('${t.art}')">
        <div class="hero-info">
          <div class="hero-title">${t.name}</div>
          <div class="hero-sub">${subtitleOf(t)}</div>
          <div class="hero-actions">
            <button class="btn light" data-focus data-hero="${i}" data-act="play"><span class="dot">${PLAY_ICON}</span>${t.price && !this.state.rented[t.id] ? `Rent $${t.price.toFixed(2)}` : resume ? 'Resume' : 'Play'}</button>
            <button class="btn" data-focus data-hero="${i}" data-act="info"><span class="dot light">i</span>More Info</button>
          </div>
        </div>
      </div>
      <div class="hero-card next" style="background-image:url('${next.art}')">
        <div class="next-info"><div class="hero-title">${next.name}</div><div class="hero-sub">${subtitleOf(next)}</div></div>
      </div>`;
    $$('.dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    $('#ambientImg').style.backgroundImage = `url('${t.art}')`;
    $$('[data-act]', hero).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.act === 'info' || t.price) this.openTitle(t.id);
      else this.play({ titleId: t.id, ...(prog || {}) });
    }));
    if (this.focused && !document.contains(this.focused)) {
      const same = $(`[data-act="${this.focused.dataset.act || 'play'}"]`, hero);
      if (same) { this.focused = same; same.classList.add('focused'); this.placeRing(same); }
    }
  }
  heroAutoAdvance() {
    if (this.state.screen !== 'home' || document.body.classList.contains('piloting')) return;
    if (this.focused && this.focused.dataset.hero !== undefined) return;
    this.showHero(this.state.heroIndex + 1);
  }

  myListIds() {
    if (this.state.kids) return TITLES.filter((t) => t.kids).map((t) => t.id);
    const inProgress = Object.keys(this.memory.progress).filter((id) => !byId[id].kids);
    return [...new Set([...inProgress, 'brigade', 'steel', ...Object.keys(this.state.rented)])];
  }
  renderGrid(kind) {
    const mem = this.memory.progress;
    let ids;
    let title;
    let sub;
    if (kind === 'mylist') {
      ids = this.myListIds();
      title = this.state.kids ? 'Kids corner' : 'My List';
      sub = this.state.kids ? 'Only shows for all ages · volume limited' : 'Your shows and films, right where you left them';
    } else if (kind === 'shop') {
      ids = TITLES.filter((t) => t.price).map((t) => t.id).concat(['steel', 'snow', 'cosmic']);
      title = 'Shop';
      sub = 'New releases to rent · Couch Pilot always asks before paying';
    } else {
      ids = TITLES.map((t) => t.id).filter((id) => !this.state.kids || byId[id].kids);
      title = 'Discover';
      sub = 'Picked for your household';
    }
    this.screenEl.innerHTML = `<div class="grid-screen">
      <div class="screen-title">${title}</div><div class="screen-sub">${sub}</div>
      <div class="grid">${ids.map((id) => {
        const t = byId[id];
        const prog = mem[id];
        let badge = '';
        if (kind === 'shop' && t.price) badge = this.state.rented[id] ? '<div class="badge owned">Rented</div>' : `<div class="badge price">$${t.price.toFixed(2)}</div>`;
        else if (kind === 'shop') badge = '<div class="badge">Included</div>';
        const s = prog && prog.season ? `S${prog.season} · E${prog.episode} • ${t.creator}` : subtitleOf(t);
        return this.cardHTML(t, { prog, badge, sub: s });
      }).join('')}</div>
      ${kind === 'mylist' ? '<div class="memory-note">Couch Pilot remembers where you stopped. You can see and erase this anytime.</div>' : ''}
    </div>`;
    $$('.card', this.screenEl).forEach((c) => c.addEventListener('click', () => this.openTitle(c.dataset.title)));
  }

  renderSearch(query) {
    this.state.searchQuery = query;
    const keys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    this.screenEl.innerHTML = `<div class="search-screen">
      <div>
        <div class="search-field"><svg viewBox="0 0 24 24" class="ico"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg><span id="sq">${query}</span><i class="caret"></i></div>
        <div class="keyboard">${keys.map((k) => `<button class="key-btn" data-focus data-key="${k}">${k}</button>`).join('')}
          <button class="key-btn wide" data-focus data-key=" ">Space</button><button class="key-btn wide" data-focus data-key="DEL">Delete</button></div>
      </div>
      <div><div class="results-title" id="resultsTitle"></div><div class="results" id="results"></div></div>
    </div>`;
    $$('.key-btn', this.screenEl).forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.key;
      this.typeQuery(k === 'DEL' ? this.state.searchQuery.slice(0, -1) : this.state.searchQuery + k.toLowerCase());
    }));
    this.typeQuery(query);
  }
  typeQuery(q) {
    this.state.searchQuery = q;
    const sq = $('#sq');
    if (!sq) return;
    sq.textContent = q.replace(/\b\w/g, (c) => c.toUpperCase());
    const ql = q.toLowerCase().trim();
    const res = ql ? TITLES.filter((t) => t.name.toLowerCase().includes(ql) || t.genres.some((g) => g.startsWith(ql))).filter((t) => !this.state.kids || t.kids) : [];
    $('#resultsTitle').textContent = ql ? `${res.length} result${res.length === 1 ? '' : 's'}` : 'Start typing, or just ask Couch Pilot';
    $('#results').innerHTML = res.slice(0, 4).map((t) => this.cardHTML(t)).join('');
    $$('#results .card').forEach((c) => c.addEventListener('click', () => this.openTitle(c.dataset.title)));
  }

  openTitle(id, season) {
    this.state.detailId = id;
    this.navigate('detail', { titleId: id, season });
  }
  renderDetail(id, season) {
    const t = byId[id];
    const prog = this.memory.progress[id];
    const s = season || prog?.season || 1;
    this.state.detailSeason = s;
    const resume = prog && prog.position > 0;
    const needsRent = t.price && !this.state.rented[id];
    const meta = t.kind === 'series' ? `${t.seasons.length} season${t.seasons.length > 1 ? 's' : ''}` : `${Math.floor(t.minutes / 60)} h ${t.minutes % 60} min`;
    let eps = '';
    if (t.kind === 'series') {
      const n = t.seasons.find((x) => x.number === s)?.episodes || 0;
      eps = `<div class="seasons">${t.seasons.map((x) => `<button class="season ${x.number === s ? 'active' : ''}" data-focus data-season="${x.number}">Season ${x.number}</button>`).join('')}</div>
      <div class="episodes" id="episodes">${Array.from({ length: n }, (_, k) => {
        const e = k + 1;
        const here = prog && prog.season === s && prog.episode === e;
        const pp = here ? Math.max(4, (prog.position / (t.episodeMinutes * 60)) * 100) : prog && (prog.season > s || (prog.season === s && e < prog.episode)) ? 100 : 0;
        return `<button class="episode" data-focus data-ep="${e}" style="background-image:url('${k % 2 && t.still ? t.still : t.art}');background-position:${(k * 17) % 100}% 50%">
          <div class="ep-n">Episode ${e}</div><div class="ep-t">${t.episodeMinutes} min${here ? ` · ${fmtTime(prog.position)} left off` : ''}</div>
          ${pp ? `<div class="card-progress"><b style="width:${pp}%"></b></div>` : ''}</button>`;
      }).join('')}</div>`;
    }
    this.screenEl.innerHTML = `<div class="detail">
      <div class="detail-bg" style="background-image:url('${t.art}')"></div>
      <div class="detail-info">
        <div class="detail-title">${t.name}</div>
        <div class="detail-meta"><span>${t.creator}</span>•<span>${t.year}</span>•<span>${meta}</span><span class="tag">${t.rating}</span>${t.audioDescription ? '<span class="tag">AD</span>' : ''}</div>
        <div class="detail-blurb">${t.blurb}</div>
        <div class="hero-actions">
          <button class="btn light" data-focus data-detail="play"><span class="dot">${PLAY_ICON}</span>${needsRent ? `Rent $${t.price.toFixed(2)}` : resume ? (prog.season ? `Resume S${prog.season} · E${prog.episode}` : `Resume ${fmtTime(prog.position)}`) : 'Play'}</button>
          <button class="btn" data-focus data-detail="list"><span class="dot light">+</span>My List</button>
        </div>
      </div>
      ${eps}
    </div>`;
    $('#ambientImg').style.backgroundImage = `url('${t.art}')`;
    $('[data-detail="play"]', this.screenEl).addEventListener('click', () => {
      if (needsRent) this.emit('rent-request', { titleId: id });
      else this.play({ titleId: id, ...(prog || {}) });
    });
    $$('[data-season]', this.screenEl).forEach((b) => b.addEventListener('click', () => {
      this.renderDetail(id, Number(b.dataset.season));
      this.setFocus($(`[data-season="${b.dataset.season}"]`, this.screenEl));
    }));
    $$('[data-ep]', this.screenEl).forEach((b) => b.addEventListener('click', () => {
      const e = Number(b.dataset.ep);
      const here = prog && prog.season === s && prog.episode === e;
      this.play({ titleId: id, season: s, episode: e, position: here ? prog.position : 0 });
    }));
  }
  episodeEl(n) { return $(`[data-ep="${n}"]`, this.screenEl); }
  scrollEpisodesTo(n) {
    const row = $('#episodes');
    if (!row) return;
    const shift = Math.max(0, (n - 4) * 316);
    $$('.episode', row).forEach((e) => { e.style.transition = 'transform .45s cubic-bezier(.22,.8,.24,1)'; e.style.transform = `translateX(${-shift}px)`; });
  }

  // ---------------------------------------------------------------- player
  play({ titleId, season = null, episode = null, position = 0 }) {
    const t = byId[titleId];
    const duration = (t.episodeMinutes || t.minutes) * 60;
    this.state.playing = { titleId, season, episode, position, duration, startedAt: performance.now() };
    this.state.paused = false;
    this.memory.lastSession = { titleId, volume: this.state.volume, subtitles: this.state.subtitles };
    const p = $('#player');
    p.hidden = false;
    p.classList.remove('clean');
    document.body.classList.add('playing');
    $('#playerTitle').textContent = t.name;
    $('#playerSub').textContent = season ? `Season ${season} · Episode ${episode}` : `${t.creator} • ${t.year}`;
    const v = this.video;
    const webm = t.video.replace(/\.mp4$/, '.webm');
    v.innerHTML = `<source src="${webm}" type="video/webm"><source src="${t.video}" type="video/mp4">`;
    v.muted = true; // the demo stays silent; real volume is shown by the HUD
    v.load();
    v.play().catch(() => {});
    this.updateProgress();
    if (position > 0) this.flashChip(`Resuming at ${fmtTime(position)}`);
    this.setFocus($('[data-player="toggle"]'));
    clearTimeout(this._cleanTimer);
    this._cleanTimer = setTimeout(() => this.cleanPlayer(), 6000);
    this.renderCaptions();
    this.emit('play', this.state.playing);
  }
  cleanPlayer() {
    if ($('#player').hidden || !$('#subsMenu').hidden) return;
    $('#player').classList.add('clean');
    this.ring.classList.remove('on');
  }
  wakePlayerUi() {
    $('#player').classList.remove('clean');
    this.ring.classList.add('on');
    clearTimeout(this._cleanTimer);
    this._cleanTimer = setTimeout(() => this.cleanPlayer(), 6000);
  }
  closePlayer() {
    $('#player').hidden = true;
    $('#subsMenu').hidden = true;
    document.body.classList.remove('playing');
    this.video.pause();
    if (this.state.playing) {
      const pl = this.state.playing;
      const pos = this.currentPosition();
      this.memory.progress[pl.titleId] = { ...(this.memory.progress[pl.titleId] || {}), season: pl.season, episode: pl.episode, position: pos, watchedAt: 'today' };
    }
    this.state.playing = null;
  }
  currentPosition() {
    const pl = this.state.playing;
    if (!pl) return 0;
    if (this.state.paused) return pl.position;
    return Math.min(pl.duration, pl.position + (performance.now() - pl.startedAt) / 1000);
  }
  updateProgress() {
    const pl = this.state.playing;
    if (!pl) return;
    const pos = this.currentPosition();
    const pct = (pos / pl.duration) * 100;
    $('#progressFill').style.width = `${pct}%`;
    $('#progressKnob').style.left = `${pct}%`;
    $('#tNow').textContent = fmtTime(pos);
    $('#tEnd').textContent = `-${fmtTime(pl.duration - pos)}`;
  }
  seek(delta) {
    const pl = this.state.playing;
    if (!pl) return false;
    const pos = Math.max(0, Math.min(pl.duration - 1, this.currentPosition() + delta));
    pl.position = pos;
    pl.startedAt = performance.now();
    try { this.video.currentTime = Math.max(0, (this.video.currentTime || 0) + delta) % (this.video.duration || 60); } catch (e) { /* ignore */ }
    this.wakePlayerUi();
    this.updateProgress();
    this.flashChip(delta < 0 ? `Back ${-delta} s` : `Forward ${delta} s`);
    return true;
  }
  pause() {
    const pl = this.state.playing;
    if (!pl || this.state.paused) return;
    pl.position = this.currentPosition();
    this.state.paused = true;
    this.video.pause();
    this.wakePlayerUi();
  }
  resumePlayback() {
    const pl = this.state.playing;
    if (!pl || !this.state.paused) return;
    pl.startedAt = performance.now();
    this.state.paused = false;
    this.video.play().catch(() => {});
  }
  playerAction(a) {
    this.wakePlayerUi();
    if (a === 'toggle') (this.state.paused ? this.resumePlayback() : this.pause());
    if (a === 'back10') this.seek(-10);
    if (a === 'fwd10') this.seek(10);
    if (a === 'subs') this.toggleSubsMenu();
  }
  toggleSubsMenu(open) {
    const m = $('#subsMenu');
    m.hidden = open === undefined ? !m.hidden : !open;
    $$('.subs-opt').forEach((o) => o.classList.toggle('on', (o.dataset.lang || null) === this.state.subtitles));
    if (!m.hidden) this.wakePlayerUi();
  }
  setSubtitles(language, { fromMenu = false } = {}) {
    this.state.subtitles = language;
    $$('.subs-opt').forEach((o) => o.classList.toggle('on', (o.dataset.lang || null) === language));
    if (fromMenu) setTimeout(() => this.toggleSubsMenu(false), 350);
    this.renderCaptions();
  }
  renderCaptions() {
    clearInterval(this._capTimer);
    const box = $('#captions');
    const pl = this.state.playing;
    if (!pl || !this.state.subtitles) { box.hidden = true; return; }
    const lines = CAPTIONS[pl.titleId] || ['…'];
    const fr = { '— The tide brought it in last night.': '— La marée l’a ramené cette nuit.', '— Then someone wanted it found.': '— Alors quelqu’un voulait qu’on le trouve.', '— Check the old customs house.': '— Vérifiez la vieille douane.', '— Nobody has used that pier in years.': '— Personne n’utilise ce quai depuis des années.', '— Wait for me!': '— Attends-moi !', '— She went north, past the burning gates.': '— Elle est partie au nord, après les portes en feu.', '— I raised her. She will know me.': '— Je l’ai élevée. Elle me reconnaîtra.' };
    let i = 0;
    const show = () => {
      let l = lines[i % lines.length];
      if (this.state.subtitles === 'French') l = fr[l] || l;
      $('#captionText').textContent = l;
      box.hidden = false;
      i++;
    };
    show();
    this._capTimer = setInterval(show, 3200);
  }
  flashChip(text) {
    const c = $('#resumeChip');
    c.textContent = text;
    c.hidden = false;
    c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
    clearTimeout(this._chipTimer);
    this._chipTimer = setTimeout(() => { c.hidden = true; }, 3200);
  }

  // ---------------------------------------------------------------- volume
  async setVolume(level, { animate = true } = {}) {
    const hud = $('#volumeHud');
    hud.hidden = false;
    hud.style.animation = 'none'; void hud.offsetWidth; hud.style.animation = '';
    const target = Math.max(0, Math.min(100, Math.round(level)));
    const step = target > this.state.volume ? 1 : -1;
    while (animate && this.state.volume !== target) {
      this.state.volume += step;
      this.renderVolume();
      await sleep(Math.abs(target - this.state.volume) > 6 ? 28 : 55);
    }
    this.state.volume = target;
    this.state.muted = false;
    this.renderVolume();
    clearTimeout(this._volTimer);
    this._volTimer = setTimeout(() => { hud.hidden = true; }, 2600);
  }
  renderVolume() {
    $('#volFill').style.height = `${this.state.volume}%`;
    $('#volNum').textContent = this.state.muted ? 'Mute' : this.state.volume;
  }

  setKids(on) {
    this.state.kids = on;
    document.body.classList.toggle('kids', on);
    this.renderChips();
  }

  powerOff() {
    this.closePlayer();
    $('#standby').hidden = false;
  }
  wake() {
    $('#standby').hidden = true;
  }
}
