import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGoal, enforceGuardrails } from '../web/js/planner.js';
import { defaultMemory } from '../web/js/catalog.js';

const ctx = (state = {}) => ({ memory: defaultMemory(), state: { volume: 18, ...state } });
const actions = (p) => p.steps.map((s) => s.action);

test('demo 1: one sentence becomes a four-step plan', () => {
  const p = planGoal('Resume my detective show where I left off, and turn it up.', ctx());
  assert.equal(p.type, 'plan');
  assert.deepEqual(actions(p), ['navigate', 'open_title', 'play', 'set_volume']);
  assert.equal(p.steps[2].args.episode, 5);
  assert.equal(p.steps[2].args.position, 23 * 60 + 12);
  assert.equal(p.steps[3].args.level, 30);
});

test('demo 2: ambiguous request asks one question, then plans with limits', () => {
  const q = planGoal('Put on something for the kids', ctx());
  assert.equal(q.type, 'clarify');
  assert.equal(q.options.length, 2);
  const p = planGoal(q.pending.utterance, ctx(), { forceTitleId: q.options[0].titleId });
  assert.ok(actions(p).includes('set_kids_mode'));
  assert.ok(p.steps.find((s) => s.action === 'set_volume').args.level <= 15);
  assert.equal(p.steps.find((s) => s.action === 'schedule').args.inMinutes, 30);
});

test('demo 3: Movie night routine expands into a full evening', () => {
  const p = planGoal('Movie night', ctx());
  assert.equal(p.routine, 'Movie night');
  assert.deepEqual(actions(p), ['navigate', 'open_title', 'play', 'set_subtitles', 'set_volume', 'schedule']);
  assert.deepEqual(p.steps[5].args.at, { h: 23, m: 0 });
});

test('demo 4: renting always needs confirmation; stop is recognised', () => {
  const p = planGoal('Rent Dune Song', ctx());
  assert.equal(p.steps.find((s) => s.action === 'rent').risk, 'confirm');
  assert.equal(planGoal('Stop', ctx()).type, 'stop');
  assert.equal(planGoal('wait!', ctx()).type, 'stop');
});

test('guardrails: forbidden requests are refused, unknown actions dropped', () => {
  assert.equal(planGoal('enter my PIN code', ctx()).type, 'refuse');
  assert.equal(planGoal('turn off parental controls', ctx()).type, 'refuse');
  const p = enforceGuardrails({ type: 'plan', steps: [{ action: 'format_disk', args: {}, label: 'x' }, { action: 'rent', args: { titleId: 'dune', price: 3.99 }, label: 'Rent', risk: 'free' }] });
  assert.deepEqual(actions(p), ['rent']);
  assert.equal(p.steps[0].risk, 'confirm', 'an LLM cannot downgrade a risk level');
});

test('kids mode: grown-up titles are refused by voice', () => {
  assert.equal(planGoal('Movie night', ctx({ kidsMode: true })).type, 'refuse');
});

test('everyday commands', () => {
  assert.deepEqual(actions(planGoal('Go back 30 seconds and turn on subtitles', ctx())), ['seek', 'set_subtitles']);
  assert.equal(planGoal('Turn everything off in 10 minutes', ctx()).steps[0].args.inMinutes, 10);
  assert.equal(planGoal('Find me a documentary about space under an hour', ctx()).steps[1].args.titleId, 'cosmic');
});
