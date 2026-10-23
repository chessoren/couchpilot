// Couch Pilot planner: one sentence in, one complete plan out.
//
// This module is isomorphic (browser + Node). It is the on-device planner the
// TV always has, and the safety net when the cloud planner (Amazon Bedrock,
// see server/bedrock.js) is unavailable. Both planners emit the same plan
// format, and every plan goes through `enforceGuardrails` before execution.

import { TITLES, byId, findTitles, fmtTime } from './catalog.js';

// ---------------------------------------------------------------------------
// Action registry: what the agent is allowed to do, and at which trust level.
//   free     -> the agent acts on its own, showing every step
//   confirm  -> the agent must get a clear "yes" (money, irreversible, power)
//   forbidden-> the agent refuses and hands control back
// ---------------------------------------------------------------------------
export const ACTIONS = {
  navigate: 'free', // { tab: home|mylist|discover|shop|search, kids? }
  open_title: 'free', // { titleId, season? }
  play: 'free', // { titleId, season?, episode?, position? }
  pause: 'free',
  resume_playback: 'free',
  seek: 'free', // { delta }
  set_volume: 'free', // { level }
  mute: 'free',
  set_subtitles: 'free', // { language | null }
  set_kids_mode: 'free', // { on, maxVolume }
  schedule: 'free', // { kind: reminder|sleep, at?, inMinutes?, message }
  home: 'free',
  rent: 'confirm', // { titleId, price }
  power_off: 'confirm',
};
export const FORBIDDEN_PATTERNS = [
  /pass ?word|passcode|pin code|\bpin\b/,
  /credit card|card number|payment (code|details|method)|cvv/,
  /parental control|child lock|age (limit|restriction)s? off|disable .*(safety|lock|restriction)/,
];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  first: 1, second: 2, third: 3,
};

function norm(text) {
  let t = ` ${String(text || '').toLowerCase()} `
    .replace(/[“”"!?.]/g, ' ')
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ');
  for (const [w, n] of Object.entries(NUMBER_WORDS)) {
    t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  }
  return t;
}

function splitClauses(t) {
  return t
    .split(/,|;|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function parseClock(t) {
  if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
  const m = t.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').replace(' ', '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 12 && h >= 5) h += 12; // "at 11" in the evening means 11 PM
  return { h: h % 24, m: min };
}

export function clockLabel({ h, m }) {
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`;
}

function parseDuration(t) {
  const m = t.match(/\bin (\d+) ?(minutes?|mins?|hours?|h)\b/) || t.match(/\bafter (\d+) ?(minutes?|mins?|hours?)\b/) || t.match(/\bfor (\d+) ?(minutes?|mins?|hours?)\b/);
  if (!m) return null;
  return /^h/.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
}

// ---------------------------------------------------------------------------
// Target resolution: which title does the user mean?
// ---------------------------------------------------------------------------
function resolveTarget(t, ctx) {
  const mem = ctx.memory;
  const explicit = findTitles(t);
  if (explicit.length) return { titles: explicit, reason: 'name' };

  if (/\b(kids?|children|cartoons?|little ones|grandkids)\b/.test(t)) {
    return { titles: TITLES.filter((x) => x.kids), reason: 'kids', ask: 'Which one for the kids?' };
  }
  if (/\b(film|movie)\b.*\b(yesterday|last night|last time)\b|\b(yesterday's|last) (film|movie)\b/.test(t)) {
    const inProgress = TITLES.filter((x) => x.kind === 'movie' && mem.progress[x.id]);
    return { titles: inProgress.slice(0, 1), reason: 'yesterday-movie' };
  }
  const genreWords = {
    detective: ['detective', 'crime', 'police', 'cop', 'mystery', 'investigation'],
    documentary: ['documentary', 'doc', 'nature'],
    space: ['space', 'planet', 'stars'],
    'science fiction': ['sci-fi', 'science fiction', 'robot'],
    fantasy: ['fantasy', 'dragon'],
  };
  for (const [genre, words] of Object.entries(genreWords)) {
    if (words.some((w) => new RegExp(`\\b${w}s?\\b`).test(t))) {
      let titles = TITLES.filter((x) => x.genres.includes(genre));
      if (/\bunder (an|1) hour|less than (an|1) hour|short\b/.test(t)) {
        titles = titles.filter((x) => (x.minutes || x.episodeMinutes) <= 60);
      }
      // "my detective show" -> prefer what the household is already watching
      const mine = titles.filter((x) => mem.progress[x.id]);
      if (/\b(my|our|where i|where we|left off|resume|continue)\b/.test(t) && mine.length) {
        return { titles: mine, reason: genre, ask: `Which ${genre} show?` };
      }
      return { titles: titles.slice(0, 3), reason: genre, ask: 'Which one would you like?' };
    }
  }
  if (/\b(my|our) (show|series|program|programme)\b|\bwhere (i|we) left off\b/.test(t)) {
    const last = mem.lastSession && byId[mem.lastSession.titleId];
    if (last) return { titles: [last], reason: 'last-session' };
  }
  return null;
}

function playStepsFor(title, t, ctx, { forceStart = false } = {}) {
  const mem = ctx.memory;
  const prog = mem.progress[title.id];
  const steps = [];
  const kids = !!title.kids;

  steps.push({
    action: 'navigate',
    args: { tab: title.price ? 'shop' : 'mylist', kids },
    label: title.price ? 'Open the shop' : kids ? 'Open the kids corner' : title.kind === 'movie' ? 'Open your films' : 'Open your shows',
  });

  let season = null;
  let episode = null;
  let position = 0;
  const sm = t.match(/\bseason (\d+)/);
  const em = t.match(/\bepisode (\d+)/);
  if (title.kind === 'series') {
    if (sm || em) {
      season = Number(sm ? sm[1] : prog?.season || 1);
      episode = Number(em ? em[1] : 1);
    } else if (/\bnext episode\b/.test(t) && prog) {
      season = prog.season;
      episode = prog.episode + 1;
    } else if (prog && !forceStart) {
      season = prog.season;
      episode = prog.episode;
      position = prog.position;
      if (kids && position === 0) episode = prog.episode;
    } else {
      season = 1;
      episode = 1;
    }
  } else if (prog && !forceStart && !/\bfrom the (start|beginning)\b/.test(t)) {
    position = prog.position;
  }

  steps.push({
    action: 'open_title',
    args: { titleId: title.id, season },
    label: season ? `Find “${title.name}”, season ${season}` : `Find “${title.name}”`,
  });

  if (title.price && !ctx.state?.rented?.[title.id]) {
    steps.push({
      action: 'rent',
      args: { titleId: title.id, price: title.price },
      label: `Rent “${title.name}” for $${title.price.toFixed(2)}`,
    });
  }

  let playLabel;
  if (season) {
    playLabel = position > 0
      ? `Resume episode ${episode} at ${Math.round(position / 60)} minutes`
      : `Play episode ${episode}`;
  } else {
    playLabel = position > 0 ? `Resume where you stopped (${fmtTime(position)})` : 'Start the film';
  }
  steps.push({ action: 'play', args: { titleId: title.id, season, episode, position }, label: playLabel });
  return steps;
}

function settingSteps(c, ctx, flags) {
  const steps = [];
  const prefs = ctx.memory.preferences;
  const cur = ctx.state?.volume ?? 20;

  // Volume
  let m;
  if ((m = c.match(/\b(?:volume|sound)\b[^\d]*(\d{1,3})\b/) || c.match(/\b(\d{1,3}) ?%? (?:volume|sound)\b/))) {
    const level = Math.min(100, Number(m[1]));
    steps.push({ action: 'set_volume', args: { level }, label: `Set the volume to ${level}` });
  } else if (/\b(turn|crank|bring|put) (it|the (sound|volume)|this) up\b|\blouder\b|\b(volume|sound) up\b|\bup a bit\b|\bturn up\b/.test(c)) {
    const level = Math.min(60, Math.max(prefs.volume, cur + 10));
    steps.push({ action: 'set_volume', args: { level }, label: `Turn the volume up to ${level}` });
  } else if (/\b(turn|bring|put) (it|the (sound|volume)|this) down\b|\bquieter\b|\b(volume|sound) down\b|\bturn down\b|\blower\b/.test(c)) {
    const level = Math.max(5, cur - 10);
    steps.push({ action: 'set_volume', args: { level }, label: `Turn the volume down to ${level}` });
  } else if (/\bmute\b/.test(c)) {
    steps.push({ action: 'mute', args: {}, label: 'Mute the sound' });
  }

  // Subtitles
  if (/\b(subtitles?|captions?|subs)\b/.test(c)) {
    if (/\b(off|no|remove|hide|disable)\b/.test(c)) {
      steps.push({ action: 'set_subtitles', args: { language: null }, label: 'Turn subtitles off' });
    } else {
      const lang = (c.match(/\b(english|french|spanish|german|italian)\b/) || [])[1];
      const language = lang ? lang[0].toUpperCase() + lang.slice(1) : prefs.subtitles;
      steps.push({ action: 'set_subtitles', args: { language }, label: `Turn on ${language} subtitles` });
    }
  }

  // Seek
  if ((m = c.match(/\b(?:go |jump |skip )?back (\d+) ?(seconds?|secs?|minutes?|mins?)\b/) || c.match(/\brewind (\d+) ?(seconds?|minutes?)/))) {
    const sec = Number(m[1]) * (/^m/.test(m[2]) ? 60 : 1);
    steps.push({ action: 'seek', args: { delta: -sec }, label: `Go back ${m[1]} ${/^m/.test(m[2]) ? 'minutes' : 'seconds'}` });
  } else if ((m = c.match(/\b(?:skip|go|jump|fast) (?:ahead|forward) (\d+) ?(seconds?|secs?|minutes?|mins?)\b/))) {
    const sec = Number(m[1]) * (/^m/.test(m[2]) ? 60 : 1);
    steps.push({ action: 'seek', args: { delta: sec }, label: `Skip ahead ${m[1]} ${/^m/.test(m[2]) ? 'minutes' : 'seconds'}` });
  }

  // Pause / resume playback
  if (/^(pause|pause it|hold it)$/.test(c)) steps.push({ action: 'pause', args: {}, label: 'Pause' });

  // Reminders and sleep timers
  const clock = parseClock(c);
  const mins = parseDuration(c);
  if (/\b(remind|warn|tell|ping|alert|let me know|notify)\b/.test(c) && (clock || mins)) {
    steps.push(clock
      ? { action: 'schedule', args: { kind: 'reminder', at: clock, message: `It's ${clockLabel(clock)}, as you asked.` }, label: `Remind you at ${clockLabel(clock)}` }
      : { action: 'schedule', args: { kind: 'reminder', inMinutes: mins, message: `${mins} minutes are up, as you asked.` }, label: `Remind you in ${mins} minutes` });
  } else if (/\b(turn (it |everything |the tv )?off|switch (it )?off|shut (it )?(down|off)|power off|stop|cut)\b/.test(c) && (mins || clock)) {
    steps.push(mins
      ? { action: 'schedule', args: { kind: 'sleep', inMinutes: mins }, label: flags.kids ? `Stop playback in ${mins} minutes` : `Turn off in ${mins} minutes` }
      : { action: 'schedule', args: { kind: 'sleep', at: clock }, label: `Turn off at ${clockLabel(clock)}` });
  } else if (/\b(turn (the tv |it |everything )?off|switch off the tv|power off|shut down)\b/.test(c) && !mins && !clock) {
    steps.push({ action: 'power_off', args: {}, label: 'Turn the TV off' });
  }
  return steps;
}

const PLAY_VERBS = /\b(resume|continue|put on|play|watch|start|launch|open|show me|pick up|find me|find|get me|i want|something)\b|\bleft off\b/;
const RENT_VERBS = /\b(rent|buy|purchase)\b/;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export function planGoal(utterance, ctx, opts = {}) {
  const t = norm(utterance);
  const trimmed = t.trim();
  const base = { utterance: String(utterance || '').trim(), planner: 'on-device' };

  if (!trimmed) return { ...base, type: 'unknown', say: "Sorry, I didn't catch that. Could you say it again?" };

  if (/^(stop|wait|cancel|hold on|never ?mind|enough|arr[eê]te|attends)\b/.test(trimmed)) {
    return { ...base, type: 'stop', say: "Okay, stopping. You're in control." };
  }
  if (FORBIDDEN_PATTERNS.some((re) => re.test(trimmed))) {
    return {
      ...base,
      type: 'refuse',
      say: "For your safety, that's one thing I can't do for you. Please do it yourself in Settings.",
    };
  }

  // Named routines expand into a full sentence, then go through the same planner.
  const routines = [
    { re: /\bmovie night\b|\bfilm night\b|\bcinema night\b/, name: 'Movie night', expand: (x) => {
      const clock = parseClock(x);
      const at = clock ? clockLabel(clock).toLowerCase().replace(' ', '') : '11pm';
      return `resume the movie from yesterday, subtitles, volume ${ctx.memory.preferences.volume}, remind me at ${at}`;
    } },
    { re: /\bkids? mode\b|\bkids? time\b/, name: 'Kids mode', expand: (x) => {
      const mins = parseDuration(x) || 30;
      return `put on something for the kids, stop in ${mins} minutes`;
    } },
    { re: /\b(quiet|calm|night) mode\b/, name: 'Quiet mode', expand: () => 'volume 10, subtitles on' },
    { re: /\b(same|like) (as )?yesterday\b|\bas usual\b/, name: 'Same as yesterday', expand: () => {
      const last = byId[ctx.memory.lastSession?.titleId] || byId.harbor;
      return `resume ${last.name}, volume ${ctx.memory.lastSession?.volume ?? ctx.memory.preferences.volume}`;
    } },
  ];
  let routine = null;
  let work = t;
  for (const r of routines) {
    if (r.re.test(t)) {
      routine = r.name;
      const rest = t.replace(r.re, ' ');
      work = norm(`${r.expand(t)}, ${rest}`);
      break;
    }
  }

  const clauses = splitClauses(work);
  const wantsMedia = PLAY_VERBS.test(work) || RENT_VERBS.test(work);
  let steps = [];
  const flags = { kids: false };
  let mediaTitle = null;

  // 1) What to watch (at most one title per goal)
  if (wantsMedia) {
    let target = opts.forceTitleId ? { titles: [byId[opts.forceTitleId]], reason: 'chosen' } : resolveTarget(work, ctx);
    if (target && target.titles.length > 1) {
      return {
        ...base,
        type: 'clarify',
        routine,
        question: target.ask || 'Which one?',
        say: `${target.ask || 'Which one?'} ${target.titles.map((x, i) => `${i + 1}: ${x.name}`).join('. ')}.`,
        options: target.titles.slice(0, 3).map((x) => ({ titleId: x.id, label: x.name, sub: `${x.creator} • ${x.year}`, art: x.art })),
        pending: { utterance: base.utterance },
      };
    }
    if (target && ctx.state?.kidsMode) {
      target.titles = target.titles.filter((x) => x.kids);
      if (!target.titles.length) {
        return { ...base, type: 'refuse', say: "That one isn't for kids mode. A grown-up can switch kids mode off from the remote." };
      }
    }
    if (target && target.titles.length === 1) {
      mediaTitle = target.titles[0];
      flags.kids = !!mediaTitle.kids;
      if (flags.kids) {
        steps.push({ action: 'set_kids_mode', args: { on: true, maxVolume: ctx.memory.preferences.kidsMaxVolume }, label: 'Switch to kids mode' });
      }
      steps.push(...playStepsFor(mediaTitle, work, ctx));
    } else if (!target && RENT_VERBS.test(work)) {
      return { ...base, type: 'problem', say: "I couldn't find that title. Here's what's new in the shop.", suggest: TITLES.filter((x) => x.price).map((x) => x.id) };
    } else if (!target && /\b(resume|continue|play)\b/.test(trimmed) && ctx.state?.paused) {
      steps.push({ action: 'resume_playback', args: {}, label: 'Resume playback' });
    }
  }

  // 2) Settings, schedules and other one-shot actions, in the order spoken
  for (const c of clauses) steps.push(...settingSteps(c, ctx, flags));

  // Kids mode keeps the volume under the household limit
  if (flags.kids) {
    const limit = ctx.memory.preferences.kidsMaxVolume;
    const vol = steps.find((s) => s.action === 'set_volume');
    if (vol) {
      vol.args.level = Math.min(vol.args.level, limit);
      vol.label = `Keep the volume at ${vol.args.level}`;
    } else {
      steps.push({ action: 'set_volume', args: { level: limit }, label: `Limit the volume to ${limit}` });
    }
  }

  // Kids content follows the household time limit set by a parent
  if (flags.kids && !steps.some((s) => s.action === 'schedule' && s.args.kind === 'sleep')) {
    const mins = ctx.memory.preferences.kidsTimeLimit || 30;
    steps.push({ action: 'schedule', args: { kind: 'sleep', inMinutes: mins }, label: `Stop playback in ${mins} minutes` });
  }

  // De-duplicate identical actions (e.g. two volume clauses -> keep the last)
  const keyOf = (s) => (['set_volume', 'set_subtitles'].includes(s.action) ? s.action : s.action === 'schedule' ? `schedule:${s.args.kind}` : null);
  const seen = new Map();
  steps.forEach((s, i) => {
    const k = keyOf(s);
    if (k) seen.set(k, i);
  });
  steps = steps.filter((s, i) => !keyOf(s) || seen.get(keyOf(s)) === i);

  if (!steps.length) {
    return { ...base, type: 'unknown', say: "Sorry, I didn't catch that. Could you say it again?" };
  }

  return enforceGuardrails({ ...base, type: 'plan', routine, steps, say: summarize(steps, mediaTitle, routine) });
}

export function summarize(steps, title, routine) {
  const parts = [];
  const play = steps.find((s) => s.action === 'play');
  if (play && title) {
    const ep = play.args.episode ? `, episode ${play.args.episode}` : '';
    parts.push(`${play.args.position > 0 ? 'Resuming' : 'Starting'} ${title.name}${ep}${ep ? ',' : ''}`);
  }
  for (const s of steps) {
    if (s.action === 'set_volume') parts.push(/up/.test(s.label) ? 'turning the volume up' : /down/.test(s.label) ? 'turning the volume down' : `volume at ${s.args.level}`);
    if (s.action === 'set_subtitles') parts.push(s.args.language ? 'subtitles on' : 'subtitles off');
    if (s.action === 'schedule' && s.args.kind === 'reminder') parts.push(`a reminder at ${s.args.at ? clockLabel(s.args.at) : `${s.args.inMinutes} minutes`}`);
    if (s.action === 'schedule' && s.args.kind === 'sleep') parts.push(s.args.inMinutes ? `stopping in ${s.args.inMinutes} minutes` : 'a sleep timer');
    if (s.action === 'seek') parts.push(s.args.delta < 0 ? `going back ${-s.args.delta} seconds` : `skipping ahead`);
    if (s.action === 'rent') parts.push('I will ask before paying');
    if (s.action === 'power_off') parts.push('turning the TV off, once you confirm');
    if (s.action === 'mute') parts.push('muting the sound');
    if (s.action === 'pause') parts.push('pausing');
    if (s.action === 'resume_playback') parts.push('resuming playback');
  }
  if (!parts.length) parts.push('On it');
  let sentence = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  sentence = sentence.replace(/,, /g, ', ').replace(/, and /g, ' and ').replace(/,( and)/, ',$1');
  if (play && parts.length > 1 && play.args.episode) sentence = sentence.replace(/(episode \d+),? (?!and)/, '$1, ');
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  return routine ? `${routine}. ${sentence}.` : `${sentence}.`;
}

// Guardrails are enforced in code, whatever planner produced the plan
// (on-device rules or a cloud LLM). An LLM can never downgrade a risk level.
export function enforceGuardrails(plan) {
  if (plan.type !== 'plan') return plan;
  const steps = [];
  for (const s of plan.steps || []) {
    if (!(s.action in ACTIONS)) continue; // unknown action -> dropped
    if (FORBIDDEN_PATTERNS.some((re) => re.test(`${s.label} ${JSON.stringify(s.args || {})}`.toLowerCase()))) {
      return { ...plan, type: 'refuse', steps: [], say: "For your safety, that's one thing I can't do for you. Please do it yourself in Settings." };
    }
    steps.push({ ...s, args: s.args || {}, risk: ACTIONS[s.action] });
  }
  if (!steps.length) return { ...plan, type: 'unknown', say: "Sorry, I didn't catch that. Could you say it again?" };
  return { ...plan, steps };
}

export function describeActionsForLLM() {
  return Object.entries(ACTIONS).map(([name, risk]) => `${name} (${risk})`).join(', ');
}
