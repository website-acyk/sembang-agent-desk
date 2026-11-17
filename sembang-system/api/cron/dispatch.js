import { db, need, ok } from '../_lib/db.js';
import { handler, send } from '../_lib/http.js';
import { placeCall } from '../_lib/dial.js';
import { sendReminder } from '../_lib/mail.js';
import { leadNoAnswer } from '../_lib/outcome.js';
import { inHours } from '../_lib/time.js';

// Runs every minute (Supabase pg_cron). Places due calls, sends reminder emails, tidies stuck calls.
export default handler(['GET', 'POST'], async (req, res) => {
  if ((req.headers.authorization || '') !== `Bearer ${need('CRON_SECRET')}`) return send(res, 401, { error: 'unauthorized' });
  const now = new Date(), iso = now.toISOString();
  const out = { dialed: 0, reminders: 0, stale: 0, finished: 0, errors: [] };
  const agents = new Map(), projects = new Map();
  const getAgent = async (id) => { if (!agents.has(id)) agents.set(id, ok(await db().from('agents').select('*').eq('id', id).single())); return agents.get(id); };
  const getProject = async (id) => { if (!id) return null; if (!projects.has(id)) projects.set(id, ok(await db().from('projects').select('*').eq('id', id).maybeSingle())); return projects.get(id); };
  const hoursOf = (a) => [a.prefs?.hours_start ?? 9, a.prefs?.hours_end ?? 21];

  // 1. Calls stuck in "dialing" for 30+ minutes (no result came back)
  const stale = ok(await db().from('calls').select('id,lead_id,owner_id').eq('status', 'dialing').lt('started_at', new Date(now - 30 * 60000).toISOString()));
  for (const c of stale) {
    await db().from('calls').update({ status: 'failed', col: 'noanswer', summary: 'No result received for this call.', ended_at: iso }).eq('id', c.id);
    await leadNoAnswer(c.lead_id, 'unknown', { hours: hoursOf(await getAgent(c.owner_id)) });
    out.stale++;
  }

  // 2. Reminder emails before the promised reply time
  const hot = ok(await db().from('calls').select('*').eq('col', 'hot').eq('alert', 'pending').is('reminded_at', null).not('promise_due', 'is', null));
  for (const c of hot) {
    const a = await getAgent(c.owner_id);
    if (new Date(c.promise_due) - (a.prefs?.remind ?? 10) * 60000 > now) continue;
    try { await sendReminder({ agent: a, call: c, project: await getProject(c.project_id) }); out.reminders++; }
    catch (e) { out.errors.push(`reminder ${c.id}: ${e.message}`); }
    await db().from('calls').update({ reminded_at: iso }).eq('id', c.id);
  }

  // 3. Dial the next lead of each campaign that is due
  const { count: active } = await db().from('calls').select('id', { count: 'exact', head: true }).eq('status', 'dialing');
  let room = Number(process.env.MAX_CONCURRENT_CALLS || 5) - (active || 0);
  const camps = ok(await db().from('campaigns').select('*').in('status', ['queued', 'running']).lte('start_at', iso)
    .or(`next_call_at.is.null,next_call_at.lte.${iso}`).order('next_call_at', { ascending: true, nullsFirst: true }).limit(50));
  for (const c of camps) {
    if (room <= 0) break;
    const a = await getAgent(c.owner_id);
    const [hs, he] = hoursOf(a);
    if (!inHours(now, hs, he)) continue;
    const [lead] = ok(await db().from('leads').select('*').eq('campaign_id', c.id).in('status', ['pending', 'retry', 'callback'])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${iso}`).order('next_attempt_at', { ascending: true, nullsFirst: true }).order('created_at').limit(1));
    if (!lead) {
      const { count } = await db().from('leads').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).in('status', ['pending', 'retry', 'callback', 'calling']);
      if (!count) { await db().from('campaigns').update({ status: 'done' }).eq('id', c.id); out.finished++; }
      continue;
    }
    // claim the lead so two runs never dial it twice
    const claimed = ok(await db().from('leads').update({ status: 'calling', attempts: lead.attempts + 1 }).eq('id', lead.id).eq('status', lead.status).select('id'));
    if (!claimed.length) continue;
    await db().from('campaigns').update({ status: 'running', next_call_at: new Date(now.getTime() + c.gap_min * 60000).toISOString() }).eq('id', c.id);
    try {
      await placeCall({ agent: a, lead: { ...lead, attempts: lead.attempts + 1 }, campaign: c, project: await getProject(c.project_id), kind: lead.status === 'callback' ? 'callback' : 'campaign' });
      out.dialed++; room--;
    } catch (e) {
      out.errors.push(`lead ${lead.id}: ${e.message}`);
      await leadNoAnswer(lead.id, 'failed', { hours: [hs, he] });
    }
  }
  send(res, 200, out);
});
