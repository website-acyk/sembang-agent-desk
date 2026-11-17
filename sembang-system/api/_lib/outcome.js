import { db, ok } from './db.js';
import { intoHours } from './time.js';

/** A lead did not pick up (or call failed): retry later, or stop after the last attempt. */
export async function leadNoAnswer(leadId, reason, { final = false, hours = [9, 21] } = {}) {
  if (!leadId) return;
  const lead = ok(await db().from('leads').select('id,attempts,campaign_id').eq('id', leadId).maybeSingle());
  if (!lead) return;
  const camp = lead.campaign_id ? ok(await db().from('campaigns').select('attempts,retry_min').eq('id', lead.campaign_id).maybeSingle()) : null;
  if (!final && camp && lead.attempts < camp.attempts) {
    const next = intoHours(new Date(Date.now() + camp.retry_min * 60000), hours[0], hours[1]);
    await db().from('leads').update({ status: 'retry', next_attempt_at: next.toISOString(), last_result: reason }).eq('id', leadId);
  } else {
    await db().from('leads').update({ status: 'done', last_result: reason }).eq('id', leadId);
  }
}
