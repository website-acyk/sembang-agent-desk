import { handler, send } from './_lib/http.js';

// Public settings the browser needs. Only the anon key is shared, never secrets.
export default handler(['GET'], async (req, res) => {
  const voices = (process.env.AI_VOICES || '').split(';').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [id, label] = s.split('|'); return { id: id.trim(), label: (label || id).trim() }; });
  send(res, 200, {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    number: process.env.SIP_PHONE_NUMBER || '',
    aiVoices: voices,
    defaultVoice: process.env.DEFAULT_AI_VOICE_ID || voices[0]?.id || '',
  });
});
