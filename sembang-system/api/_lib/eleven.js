import crypto from 'node:crypto';
import { need } from './db.js';

const BASE = 'https://api.elevenlabs.io';
async function call(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { 'xi-api-key': need('ELEVENLABS_API_KEY'), ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) {
    const msg = body?.detail?.message || (Array.isArray(body?.detail) ? body.detail.map((d) => d.msg).join('; ') : body?.detail) || text;
    throw new Error(`ElevenLabs ${r.status}: ${msg}`);
  }
  return body;
}

/** Place one outbound call through the SIP trunk (your fixed +60 number). */
export async function outboundCall({ to, prompt, firstMessage, language, voiceId, vars }) {
  return call('/v1/convai/sip-trunk/outbound-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: need('ELEVENLABS_AGENT_ID'),
      agent_phone_number_id: need('ELEVENLABS_PHONE_NUMBER_ID'),
      to_number: to,
      conversation_initiation_client_data: {
        dynamic_variables: vars,
        conversation_config_override: {
          agent: { prompt: { prompt }, first_message: firstMessage, language },
          tts: { voice_id: voiceId },
        },
      },
      telephony_call_config: { ringing_timeout_secs: 30 },
    }),
  }); // -> { success, message, conversation_id, sip_call_id }
}

/** Instant voice clone from the agent's recordings. Returns voice_id. */
export async function cloneVoice({ name, files }) {
  const form = new FormData();
  form.append('name', name);
  form.append('remove_background_noise', 'true');
  form.append('description', 'Sembang agent voice. Used only for this agent\'s own lead calls.');
  for (const f of files) form.append('files', new Blob([f.bytes], { type: f.type || 'audio/webm' }), f.name);
  const r = await call('/v1/voices/add', { method: 'POST', body: form });
  return r.voice_id;
}
export async function deleteVoice(voiceId) {
  if (!voiceId) return;
  try { await call(`/v1/voices/${voiceId}`, { method: 'DELETE' }); } catch (e) { console.warn('delete voice', e.message); }
}

/**
 * Verify the ElevenLabs-Signature header: "t=<unix>,v0=<hex hmac-sha256 of `${t}.${rawBody}`>".
 * Rejects anything older than 30 minutes.
 */
export function verifyWebhook(rawBody, header) {
  const secret = need('ELEVENLABS_WEBHOOK_SECRET');
  if (!header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t), v0 = parts.v0;
  if (!t || !v0) return false;
  if (Math.abs(Date.now() / 1000 - t) > 30 * 60) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return want.length === v0.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v0));
}
