import { db, need } from './_lib/db.js';
import { handler } from './_lib/http.js';
import { checkLink } from './_lib/links.js';
import { fill, templateValues } from '../public/shared.js';

const go = (res, url) => { res.statusCode = 302; res.setHeader('Location', url); res.end(); };

// The Accept / Reject buttons in the alert email land here.
// Accept: marks the lead as replied and opens WhatsApp with the message filled in.
// Reject: opens the app so the agent can pick a reason and where the lead goes.
export default handler(['GET'], async (req, res) => {
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const app = need('APP_URL');
  if (!checkLink(q)) return go(res, `${app}/?expired=1#alerts`);
  if (q.a === 'reject') return go(res, `${app}/?reject=${q.c}#alerts`);

  const { data: call } = await db().from('calls').select('*').eq('id', q.c).single();
  if (!call) return go(res, `${app}/#alerts`);
  const { data: agent } = await db().from('agents').select('*').eq('id', call.owner_id).single();
  const { data: project } = call.project_id ? await db().from('projects').select('*').eq('id', call.project_id).maybeSingle() : { data: null };
  const { data: templates } = await db().from('templates').select('*').eq('owner_id', call.owner_id);
  const sit = ['viewing', 'price', 'brochure'].includes(call.situation) ? call.situation : 'viewing';
  const t = templates.find((x) => x.situation === sit && x.lang === call.lang) || templates.find((x) => x.situation === sit && x.lang === 'en');
  const text = t ? fill(t.body, templateValues({ lead: call, project, agent, promiseDue: call.promise_due })) : '';

  if (call.alert !== 'accepted') {
    await db().from('calls').update({
      alert: 'accepted', replied_at: new Date().toISOString(), col: call.col === 'hot' ? 'follow' : call.col,
      next_step: 'WhatsApp sent. Waiting for the lead to reply.',
    }).eq('id', call.id);
  }
  go(res, `https://wa.me/${call.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`);
});
