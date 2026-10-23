// Couch Pilot MCP server (MCP spec 2025-11-25, Streamable HTTP transport).
//
// This is how Alexa+ gets "hands" on the TV: an Alexa+ agent (or any MCP
// client) calls these tools, and Couch Pilot executes them on the Fire TV,
// visibly, step by step, under the same guardrails as a voice request.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TITLES } from '../web/js/catalog.js';
import { ACTIONS } from '../web/js/planner.js';

const INSTRUCTIONS = `Couch Pilot drives a Fire TV on the user's behalf.
Prefer couchpilot_run_goal with the user's whole request in one sentence: Couch Pilot plans
all the steps, shows the plan on the TV, and executes it visibly.
If a result has status "needs_input", ask the user the question (read the numbered options aloud)
and pass the answer to couchpilot_answer. Never answer a "confirm" question on the user's behalf:
rentals, purchases and powering off always need the user's own "yes".
If the user says stop, wait or cancel, call couchpilot_stop immediately.`;

function asText(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result?.status === 'error' || result?.status === 'tv-offline',
  };
}

export function createMcpServer(bridge) {
  const server = new McpServer(
    { name: 'couch-pilot', title: 'Couch Pilot — the self-driving remote', version: '1.0.0' },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );

  server.registerTool(
    'couchpilot_run_goal',
    {
      title: 'Drive the TV toward a goal',
      description:
        'Give Couch Pilot a complete goal in natural language (e.g. "resume my detective show where I left off and turn it up", "movie night", "put on something for the kids"). ' +
        'It plans every step, shows the plan on the TV and executes it visibly. Returns when done, or with status "needs_input" when the user must choose or confirm.',
      inputSchema: { goal: z.string().min(1).describe("The user's request, in their own words") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ goal }) => asText(await bridge.send('goal', { goal })),
  );

  server.registerTool(
    'couchpilot_answer',
    {
      title: 'Answer a question asked on the TV',
      description: 'Answer the pending clarification ("the first one", "Pampas Pals") or confirmation ("yes"/"no") that Couch Pilot is showing on the TV. Only pass the user\'s own answer.',
      inputSchema: { answer: z.string().min(1).describe('The user\'s answer, e.g. "the first one", "yes", "no"') },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ answer }) => asText(await bridge.send('answer', { answer })),
  );

  server.registerTool(
    'couchpilot_stop',
    {
      title: 'Stop and hand control back',
      description: 'Immediately stop whatever Couch Pilot is doing on the TV and hand control back to the user.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => asText(await bridge.send('stop', {}, { timeoutMs: 8000 })),
  );

  server.registerTool(
    'tv_get_state',
    {
      title: 'What is on the TV right now',
      description: 'Current screen, what is playing and where, volume, subtitles, kids mode, rentals and timers.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => asText(await bridge.send('state', {}, { timeoutMs: 8000 })),
  );

  // Fine-grained primitives, for agents that want to plan for themselves.
  // They go through the same executor and the same guardrails as a goal.
  const primitive = (name, title, description, inputSchema, toArgs, annotations = {}) =>
    server.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: false, ...annotations } }, async (input) => {
      const { action, args, label } = toArgs(input);
      return asText(await bridge.send('action', { action, args, label }));
    });

  const titleIds = TITLES.map((t) => t.id);
  primitive('tv_play_title', 'Play a title', 'Find a title and play it (resumes where the household left off unless a position is given).',
    {
      titleId: z.enum(titleIds),
      season: z.number().int().positive().optional(),
      episode: z.number().int().positive().optional(),
      positionSeconds: z.number().min(0).optional(),
    },
    ({ titleId, season, episode, positionSeconds }) => ({ action: 'play', args: { titleId, season: season ?? null, episode: episode ?? null, position: positionSeconds ?? 0 }, label: `Play ${TITLES.find((t) => t.id === titleId).name}` }));
  primitive('tv_set_volume', 'Set the volume', 'Set the TV volume (0-100). Kids mode caps it.',
    { level: z.number().int().min(0).max(100) },
    ({ level }) => ({ action: 'set_volume', args: { level }, label: `Set the volume to ${level}` }), { idempotentHint: true });
  primitive('tv_set_subtitles', 'Subtitles', 'Turn subtitles on in a language, or off (language omitted).',
    { language: z.enum(['English', 'French', 'Spanish']).optional() },
    ({ language }) => ({ action: 'set_subtitles', args: { language: language ?? null }, label: language ? `Turn on ${language} subtitles` : 'Turn subtitles off' }), { idempotentHint: true });
  primitive('tv_seek', 'Seek', 'Jump backward (negative) or forward (positive) by a number of seconds.',
    { deltaSeconds: z.number().int().min(-3600).max(3600) },
    ({ deltaSeconds }) => ({ action: 'seek', args: { delta: deltaSeconds }, label: deltaSeconds < 0 ? `Go back ${-deltaSeconds} seconds` : `Skip ahead ${deltaSeconds} seconds` }));
  primitive('tv_navigate', 'Open a section', 'Open a section of the TV app.',
    { tab: z.enum(['home', 'mylist', 'discover', 'shop', 'search']) },
    ({ tab }) => ({ action: 'navigate', args: { tab }, label: `Open ${tab === 'mylist' ? 'My List' : tab}` }), { readOnlyHint: true });
  primitive('tv_schedule', 'Reminder or sleep timer', 'Schedule a spoken reminder, or a sleep timer that turns the TV off (warns one minute before).',
    { kind: z.enum(['reminder', 'sleep']), inMinutes: z.number().int().min(1).max(600), message: z.string().optional() },
    ({ kind, inMinutes, message }) => ({ action: 'schedule', args: { kind, inMinutes, message: message || `${inMinutes} minutes are up, as you asked.` }, label: kind === 'reminder' ? `Remind you in ${inMinutes} minutes` : `Turn off in ${inMinutes} minutes` }));
  primitive('tv_rent_title', 'Rent a title (asks the user first)', 'Rent a paid title. ALWAYS shows the price on the TV and waits for the user\'s own "yes" (returns needs_input). Simulated in this demo: no real payment.',
    { titleId: z.enum(TITLES.filter((t) => t.price).map((t) => t.id)) },
    ({ titleId }) => {
      const t = TITLES.find((x) => x.id === titleId);
      return { action: 'rent', args: { titleId, price: t.price }, label: `Rent “${t.name}” for $${t.price.toFixed(2)}` };
    }, { destructiveHint: true });

  server.registerResource(
    'catalog',
    'couchpilot://catalog',
    { title: 'TV catalog', description: 'Titles available on this TV (fictional demo catalog).', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(TITLES.map(({ id, name, kind, genres, kids, price, seasons, minutes, episodeMinutes }) => ({ id, name, kind, genres, kids: !!kids, price: price ?? null, seasons, minutes, episodeMinutes })), null, 2) }],
    }),
  );
  server.registerResource(
    'guardrails',
    'couchpilot://guardrails',
    { title: 'Trust levels', description: 'Which actions Couch Pilot does alone, which need a yes, which are forbidden.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ actions: ACTIONS, forbidden: ['passwords and PIN codes', 'payment details', 'parental controls', 'disabling any safety setting'] }, null, 2) }],
    }),
  );

  return server;
}
