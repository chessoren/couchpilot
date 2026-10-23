// Cloud planner on Amazon Bedrock (Converse API + tool use).
//
// The TV always has the on-device planner (web/js/planner.js). When AWS
// credentials are configured, the server asks a Bedrock model to turn the
// sentence into a plan instead: better at free-form phrasing and new routines.
// The model can only propose steps from the allow-listed action set, and the
// guardrails are re-applied in code (enforceGuardrails) before anything runs.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { TITLES } from '../web/js/catalog.js';
import { ACTIONS, enforceGuardrails, planGoal } from '../web/js/planner.js';

export const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

// Opt-in: COUCHPILOT_PLANNER=bedrock (uses the standard AWS credential chain).
// After an authentication/access error the cloud planner switches itself off
// for 10 minutes, so the TV never waits on a planner that cannot answer.
let disabledUntil = 0;
export function bedrockConfigured() {
  return process.env.COUCHPILOT_PLANNER === 'bedrock' && Date.now() > disabledUntil;
}
export function bedrockFailed(err) {
  if (/token|credential|AccessDenied|Unrecognized|not authorized|subscription/i.test(`${err?.name} ${err?.message}`)) {
    disabledUntil = Date.now() + 10 * 60 * 1000;
  }
}

let client = null;
function getClient() {
  client ||= new BedrockRuntimeClient({ region: REGION });
  return client;
}

const PLAN_TOOL = {
  toolSpec: {
    name: 'submit_plan',
    description: 'Submit the plan Couch Pilot will execute on the TV.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['plan', 'clarify', 'refuse', 'unknown'] },
          say: { type: 'string', description: 'One short, calm sentence to say aloud. No jargon.' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string', description: 'title id' }, maxItems: 3 },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: Object.keys(ACTIONS) },
                args: { type: 'object' },
                label: { type: 'string', description: 'What the step does, for the user, max 6 words' },
              },
              required: ['action', 'args', 'label'],
            },
          },
        },
        required: ['type', 'say'],
      },
    },
  },
};

function systemPrompt(context) {
  return `You are Couch Pilot, the self-driving remote on a Fire TV. Turn the user's goal into a complete plan of TV actions.
Rules:
- One goal can need many steps; include all of them, in a natural order.
- For a title: navigate {tab:"mylist"|"shop", kids:boolean} -> open_title {titleId, season} -> play {titleId, season, episode, position (seconds)}.
- Resume from the household progress when the user says resume / where I left off.
- Paid titles need a rent {titleId, price} step before play. Never skip it.
- Kids titles: start with set_kids_mode {on:true, maxVolume:15}, keep volume <= 15, add schedule {kind:"sleep", inMinutes:30}.
- set_volume {level}, set_subtitles {language|null}, seek {delta}, schedule {kind:"reminder", at:{h,m}} or {kind:"sleep", inMinutes}.
- If two or more titles fit and the user did not say which, return type "clarify" with up to 3 option title ids and a short question.
- Passwords, PIN codes, payment details, parental controls: return type "refuse".
- Labels are short and plain ("Turn the volume up to 30"). Never invent titles.
Allowed actions and trust levels: ${JSON.stringify(ACTIONS)}
Catalog: ${JSON.stringify(TITLES.map(({ id, name, kind, genres, kids, price, seasons }) => ({ id, name, kind, genres, kids: !!kids, price: price ?? null, seasons })))}
Household memory: ${JSON.stringify(context.memory)}
TV state: ${JSON.stringify(context.state)}`;
}

export async function planWithBedrock(utterance, context) {
  const t0 = Date.now();
  // Stop and safety refusals never leave the device.
  const local = planGoal(utterance, context);
  if (local.type === 'stop' || local.type === 'refuse') return { ...local, ms: Date.now() - t0 };

  const res = await getClient().send(new ConverseCommand({
    modelId: BEDROCK_MODEL_ID,
    system: [{ text: systemPrompt(context) }],
    messages: [{ role: 'user', content: [{ text: utterance }] }],
    toolConfig: { tools: [PLAN_TOOL], toolChoice: { tool: { name: 'submit_plan' } } },
    inferenceConfig: { maxTokens: 1200, temperature: 0 },
  }));
  const block = res.output?.message?.content?.find((c) => c.toolUse);
  const out = block?.toolUse?.input;
  if (!out?.type) throw new Error('Bedrock returned no plan');

  const base = { utterance, planner: 'bedrock', model: BEDROCK_MODEL_ID, ms: Date.now() - t0 };
  if (out.type === 'clarify') {
    const options = (out.options || []).map((id) => TITLES.find((t) => t.id === id)).filter(Boolean)
      .map((t) => ({ titleId: t.id, label: t.name, sub: `${t.creator} • ${t.year}`, art: t.art }));
    if (options.length < 2) return { ...local, ms: Date.now() - t0 };
    return { ...base, type: 'clarify', question: out.question || 'Which one?', say: out.say, options, pending: { utterance } };
  }
  return enforceGuardrails({ ...base, type: out.type, say: out.say, steps: out.steps || [] });
}
