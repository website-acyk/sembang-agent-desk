import { db, ok } from '../_lib/db.js';
import { rawBody, send } from '../_lib/http.js';
import { verifyWebhook } from '../_lib/eleven.js';
import { sendHotLeadAlert } from '../_lib/mail.js';
import { leadNoAnswer } from '../_lib/outcome.js';
import { fmtMY, intoHours } from '../_lib/time.js';

// ElevenLabs sends the result of every call here: the transcript and the AI's analysis.
// Audio is never requested or stored.
export default async function webhook(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const raw = await rawBody(req);
  if (!verifyWebhook(raw, req.headers['elevenlabs-signature'])) return send(res, 401, { error: 'bad signature' });
  try {
    const body = JSON.parse(raw);
    if (body.type === 'post_call_transcription') await onTranscript(body.data);
    else if (body.type === 'call_initiation_failure') await onFailure(body.data);
    send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message }); // ElevenLabs retries on 5xx
  }
}

async function findCall(d) {
  if (d.conversation_id) {
    const { data } = await db().from('calls').select('*').eq('conversation_id', d.conversation_id).maybeSingle();
    if (data) return data;
  }
  const id = d.conversation_initiation_client_data?.dynamic_variables?.call_id;
  if (id) { const { data } = await db().from('calls').select('*').eq('id', id).maybeSingle(); return data; }
  return null;
}

async function onFailure(d) {
  const call = await findCall(d); if (!call || call.ended_at) return;
  const reason = d.failure_reason || 'unknown';
  const status = reason === 'busy' ? 'busy' : reason === 'no-answer' ? 'no_answer' : 'failed';
  const agent = ok(await db().from('agents').select('prefs').eq('id', call.owner_id).single());
  await db().from('calls').update({
    status, col: 'noanswer', ended_at: new Date().toISOString(), conversation_id: call.conversation_id || d.conversation_id,
    summary: status === 'busy' ? 'Line busy.' : status === 'no_answer' ? 'No answer.' : 'The call could not be connected.',
  }).eq('id', call.id);
  await leadNoAnswer(call.lead_id, reason, { hours: [agent.prefs?.hours_start ?? 9, agent.prefs?.hours_end ?? 21] });
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : null);

async function onTranscript(d) {
  const call = await findCall(d); if (!call || call.ended_at) return; // already handled (webhook retry)
  const dc = d.analysis?.data_collection_results || {};
  const v = (k) => { const x = dc[k]; const val = x && typeof x === 'object' && 'value' in x ? x.value : x; return val === '' || val === undefined ? null : val; };
  const transcript = (d.transcript || []).filter((t) => t.message).map((t) => [t.role === 'agent' ? 'ai' : 'lead', t.message]);
  const spoke = transcript.some((t) => t[0] === 'lead');
  const outcome = v('outcome') || (spoke ? 'conversation' : 'no_response');
  const agent = ok(await db().from('agents').select('*').eq('id', call.owner_id).single());
  const hours = [agent.prefs?.hours_start ?? 9, agent.prefs?.hours_end ?? 21];
  const now = new Date();
  const upd = { transcript, duration_s: Math.round(d.metadata?.call_duration_secs || 0), ended_at: now.toISOString(), conversation_id: call.conversation_id || d.conversation_id, summary: d.analysis?.transcript_summary || null };

  if (outcome === 'voicemail' || (!spoke && outcome !== 'conversation')) {
    const vm = outcome === 'voicemail';
    Object.assign(upd, { status: vm ? 'voicemail' : 'no_answer', col: 'noanswer', summary: vm ? 'Reached voicemail. Not called again.' : 'Picked up but nobody spoke.' });
    await db().from('calls').update(upd).eq('id', call.id);
    return leadNoAnswer(call.lead_id, outcome, { final: vm, hours });
  }

  const score = Number.isFinite(Number(v('lead_score'))) ? Math.max(0, Math.min(100, Math.round(Number(v('lead_score'))))) : null;
  Object.assign(upd, {
    status: 'answered', score, interest: cap(v('interest_level')), situation: v('hot_reason'),
    quote: v('key_quote'), objections: v('objections'), next_step: v('next_step'), viewing: !!v('viewing_agreed'),
    profile: { budget: v('budget'), unit: v('unit_type'), purpose: v('purpose'), timeline: v('timeline'), loan: v('loan_status') },
  });
  let leadUpdate = { status: 'done', last_result: outcome };

  if (v('do_not_call') === true || outcome === 'do_not_call') {
    upd.col = 'others'; upd.next_step = 'Added to your do-not-call list.';
    await db().from('dnc').upsert({ owner_id: call.owner_id, phone: call.phone, reason: 'Asked not to be called again' });
  } else if (v('is_hot_lead') === true) {
    upd.col = 'hot'; upd.alert = 'pending';
    upd.promise_due = new Date(now.getTime() + (agent.prefs?.promise || 30) * 60000).toISOString();
  } else {
    const cb = v('callback_time_iso') ? new Date(v('callback_time_iso')) : null;
    if (cb && !isNaN(cb) && cb > now && cb - now < 14 * 864e5 && call.lead_id && call.campaign_id) {
      const at = intoHours(cb, hours[0], hours[1]);
      upd.col = 'follow'; upd.next_step = `AI calls back ${fmtMY(at)}`;
      leadUpdate = { status: 'callback', next_attempt_at: at.toISOString(), last_result: 'callback' };
    } else {
      upd.col = ['High', 'Medium'].includes(upd.interest) ? 'follow' : 'others';
    }
  }
  if (call.kind === 'test' && upd.col !== 'hot') upd.col = 'others';
  const saved = ok(await db().from('calls').update(upd).eq('id', call.id).select().single());
  if (call.lead_id) await db().from('leads').update(leadUpdate).eq('id', call.lead_id);

  if (saved.col === 'hot') {
    const project = saved.project_id ? ok(await db().from('projects').select('*').eq('id', saved.project_id).maybeSingle()) : null;
    const templates = ok(await db().from('templates').select('*').eq('owner_id', call.owner_id));
    await sendHotLeadAlert({ agent, call: saved, project, templates });
    await db().from('calls').update({ alert_sent_at: new Date().toISOString() }).eq('id', call.id);
  }
}
