// One-time setup of ElevenLabs: imports your SIP number, creates the results webhook and the calling agent.
// Run:  node --env-file=.env scripts/setup-elevenlabs.mjs
// Then copy the printed IDs into .env and your Vercel environment variables.

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('Set ELEVENLABS_API_KEY in .env first.'); process.exit(1); }
const env = process.env;

async function api(path, body) {
  const r = await fetch('https://api.elevenlabs.io' + path, { method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t}`);
  return JSON.parse(t);
}
const s = (description, extra = {}) => ({ type: 'string', description, ...extra });

const DATA = {
  outcome: s('How the call went.', { enum: ['conversation', 'voicemail', 'no_response', 'wrong_number', 'do_not_call'] }),
  interest_level: s('How interested the person is in buying or renting property.', { enum: ['high', 'medium', 'low', 'none'] }),
  is_hot_lead: { type: 'boolean', description: 'True if the person asked for a viewing, wanted to negotiate price, asked for a floor plan or brochure, or asked about loans, and the assistant promised the agent would WhatsApp them.' },
  hot_reason: s('Main reason they are hot.', { enum: ['viewing', 'price', 'brochure', 'loan', 'other'] }),
  key_quote: s("The person's most telling sentence, word for word, in the language they said it. If not English, add an English translation in brackets."),
  budget: s('Budget mentioned, e.g. "RM 600k – 700k". Empty if not mentioned.'),
  unit_type: s('Unit type or rooms wanted, e.g. "3-room". Empty if not mentioned.'),
  purpose: s('Own stay, investment, or both. Empty if not mentioned.'),
  timeline: s('When they plan to buy. Empty if not mentioned.'),
  loan_status: s('Loan status: pre-approved, applied, not yet, cash buyer. Empty if not mentioned.'),
  objections: s('Concerns raised (price, location, timing...). Empty if none.'),
  next_step: s('One short suggested next step for the agent.'),
  callback_time_iso: s('If they asked to be called back at a specific time, that time as ISO 8601 with +08:00 offset (Malaysia). Empty otherwise.'),
  do_not_call: { type: 'boolean', description: 'True if they asked not to be called again.' },
  viewing_agreed: { type: 'boolean', description: 'True if they agreed to view the property.' },
  lead_score: { type: 'integer', description: '0-100 likelihood this lead buys soon, based on interest, budget fit, timeline and loan readiness.' },
};

const out = {};
let phoneId = env.ELEVENLABS_PHONE_NUMBER_ID;
if (!phoneId) {
  if (!env.SIP_PHONE_NUMBER || !env.SIP_ADDRESS) throw new Error('Set SIP_PHONE_NUMBER and SIP_ADDRESS (from your SIP provider) in .env first.');
  const r = await api('/v1/convai/phone-numbers', {
    phone_number: env.SIP_PHONE_NUMBER, label: 'Sembang fixed number', provider: 'sip_trunk',
    outbound_trunk_config: {
      address: env.SIP_ADDRESS, transport: env.SIP_TRANSPORT || 'auto', media_encryption: 'allowed',
      ...(env.SIP_USERNAME ? { credentials: { username: env.SIP_USERNAME, password: env.SIP_PASSWORD || undefined } } : {}),
    },
  });
  phoneId = out.ELEVENLABS_PHONE_NUMBER_ID = r.phone_number_id;
}

let webhookId = env.ELEVENLABS_WEBHOOK_ID;
if (!webhookId) {
  if (!env.APP_URL) throw new Error('Set APP_URL (your Vercel address) in .env first.');
  const r = await api('/v1/workspace/webhooks', { settings: { auth_type: 'hmac', name: 'Sembang call results', webhook_url: `${env.APP_URL}/api/webhooks/elevenlabs` } });
  webhookId = out.ELEVENLABS_WEBHOOK_ID = r.webhook_id;
  if (r.webhook_secret) out.ELEVENLABS_WEBHOOK_SECRET = r.webhook_secret;
}

if (!env.ELEVENLABS_AGENT_ID) {
  const r = await api('/v1/convai/agents/create', {
    name: 'Sembang caller',
    conversation_config: {
      agent: { first_message: 'Hi, is now a good time to talk?', language: 'en', prompt: { prompt: 'Instructions are sent with every call.', llm: env.ELEVENLABS_LLM || 'claude-haiku-5-5' } },
      tts: { model_id: env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5', voice_id: env.DEFAULT_AI_VOICE_ID || 'cjVigY5qzO86Huf0OWal' },
    },
    platform_settings: {
      data_collection: DATA,
      overrides: { conversation_config_override: { agent: { first_message: true, language: true, prompt: { prompt: true } }, tts: { voice_id: true } } },
      workspace_overrides: { webhooks: { post_call_webhook_id: webhookId, events: ['transcript', 'call_initiation_failure'] } },
    },
  });
  out.ELEVENLABS_AGENT_ID = r.agent_id;
  if (phoneId) {
    // assign the number to the agent (also possible in the dashboard)
    await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${phoneId}`, { method: 'PATCH', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: r.agent_id }) }).catch(() => {});
  }
}

console.log('\nAdd these to .env and to Vercel > Settings > Environment Variables:\n');
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
console.log(`
Then finish in the ElevenLabs dashboard (Agents > Sembang caller):
 1. Tools: turn on "End call", "Detect language" and "Voicemail detection".
 2. Languages: add Chinese and Malay as additional languages.
 3. Advanced: set maximum conversation duration to 180 seconds.
 4. Security: check that overrides for first message, language, prompt and voice are enabled.
 5. Webhooks: confirm the post-call webhook is on, with "transcript" and "call initiation failure" events. Leave audio OFF.
`);
