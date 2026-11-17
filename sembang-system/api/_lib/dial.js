import { db, ok } from './db.js';
import { outboundCall } from './eleven.js';
import { buildPrompt, buildOpening, pickVoice } from './prompt.js';

/**
 * Create the call record, then ask ElevenLabs to dial.
 * The call result arrives later at /api/webhooks/elevenlabs.
 */
export async function placeCall({ agent, lead, campaign = null, project = null, kind = 'campaign' }) {
  const templates = ok(await db().from('templates').select('situation,lang,body').eq('owner_id', agent.id));
  const call = ok(await db().from('calls').insert({
    owner_id: agent.id, lead_id: lead.id || null, campaign_id: campaign?.id || null, project_id: project?.id || null,
    kind, name: lead.name, phone: lead.phone, lang: lead.lang, status: 'dialing', col: 'noanswer',
  }).select().single());

  try {
    const r = await outboundCall({
      to: lead.phone,
      prompt: buildPrompt({ agent, lead, project, maxMin: campaign?.max_len_min || 1 }),
      firstMessage: buildOpening({ agent, lead, project, templates }),
      language: lead.lang,
      voiceId: pickVoice(agent, lead.lang),
      vars: { call_id: call.id, lead_name: lead.name || '', agent_name: agent.name || '', project: project?.name || '' },
    });
    if (!r.success || !r.conversation_id) throw new Error(r.message || 'Call was not started');
    await db().from('calls').update({ conversation_id: r.conversation_id }).eq('id', call.id);
    return { ...call, conversation_id: r.conversation_id };
  } catch (e) {
    await db().from('calls').update({ status: 'failed', summary: `Could not start the call: ${e.message}`, ended_at: new Date().toISOString() }).eq('id', call.id);
    throw e;
  }
}
