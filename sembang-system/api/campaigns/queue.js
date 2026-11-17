import { db, ok } from '../_lib/db.js';
import { handler, jsonBody, requireAgent, send } from '../_lib/http.js';
import { isLand, isMobile, normPhone } from '../../public/shared.js';

const DAY = 864e5;

// Saves the reviewed lead list as a campaign. Checks are repeated on the server.
export default handler(['POST'], async (req, res) => {
  const agent = await requireAgent(req, res); if (!agent) return;
  const b = await jsonBody(req);
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 200) : [];
  if (!rows.length) return send(res, 400, { error: 'No leads to call.' });
  if (b.project_id) ok(await db().from('projects').select('id').eq('id', b.project_id).eq('owner_id', agent.id).single());

  const dnc = new Set(ok(await db().from('dnc').select('phone').eq('owner_id', agent.id)).map((r) => r.phone));
  const reached = new Set(b.skip_reached === false ? [] :
    ok(await db().from('calls').select('phone').eq('owner_id', agent.id).eq('status', 'answered')
      .gte('started_at', new Date(Date.now() - 30 * DAY).toISOString())).map((r) => r.phone));

  const seen = new Set(), keep = [], skipped = { invalid: 0, dnc: 0, duplicate: 0, recent: 0 };
  for (const r of rows) {
    const phone = normPhone(r.phone);
    if (!isMobile(phone) && !isLand(phone)) { skipped.invalid++; continue; }
    if (dnc.has(phone)) { skipped.dnc++; continue; }
    if (seen.has(phone)) { skipped.duplicate++; continue; }
    if (reached.has(phone)) { skipped.recent++; continue; }
    seen.add(phone);
    keep.push({ name: String(r.name || '').slice(0, 120), phone, lang: ['en', 'zh', 'ms'].includes(r.lang) ? r.lang : 'en', notes: String(r.notes || '').slice(0, 500), source: r.source || 'paste' });
  }
  if (!keep.length) return send(res, 400, { error: 'Every lead was skipped (invalid, do-not-call, duplicate or called recently).', skipped });

  const start = b.start_at ? new Date(b.start_at) : new Date();
  const camp = ok(await db().from('campaigns').insert({
    owner_id: agent.id, project_id: b.project_id || null,
    name: String(b.name || `Campaign ${start.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}`).slice(0, 120),
    tag: b.tag || null, start_at: start.toISOString(),
    gap_min: clamp(b.gap_min, 1, 60, 2), attempts: clamp(b.attempts, 1, 5, 2),
    retry_min: clamp(b.retry_min, 15, 1440, 120), max_len_min: clamp(b.max_len_min, 1, 3, 1),
  }).select().single());
  ok(await db().from('leads').insert(keep.map((l) => ({ ...l, owner_id: agent.id, campaign_id: camp.id }))));
  send(res, 200, { campaign: camp, queued: keep.length, skipped });
});
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
