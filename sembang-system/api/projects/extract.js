import { db, ok } from '../_lib/db.js';
import { handler, jsonBody, requireAgent, send } from '../_lib/http.js';
import { extractProject } from '../_lib/claude.js';

// Reads every uploaded sales-kit file of a project and auto-fills its fact card.
export default handler(['POST'], async (req, res) => {
  const agent = await requireAgent(req, res); if (!agent) return;
  const { project_id } = await jsonBody(req);
  const p = ok(await db().from('projects').select('*').eq('id', project_id).eq('owner_id', agent.id).single());
  if (!p.docs?.length) return send(res, 400, { error: 'Upload a sales kit PDF first.' });
  await db().from('projects').update({ status: 'reading', error: null }).eq('id', p.id);
  try {
    const files = [];
    for (const d of p.docs.slice(0, 3)) {
      const blob = ok(await db().storage.from('sales-kits').download(d.path));
      files.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || (d.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg') });
    }
    const f = await extractProject(files);
    const keys = ['developer', 'location', 'price', 'sizes', 'tenure', 'completion', 'facilities', 'promotion', 'extra'];
    const upd = { status: 'needs_check' };
    for (const k of keys) upd[k] = typeof f[k] === 'string' ? f[k].trim() : Array.isArray(f[k]) ? f[k].join('\n') : '';
    if (f.name && (!p.name || p.name === 'New project' || p.name === p.docs[0]?.name.replace(/\.[^.]+$/, ''))) upd.name = String(f.name).trim();
    const out = ok(await db().from('projects').update(upd).eq('id', p.id).select().single());
    send(res, 200, { project: out });
  } catch (e) {
    await db().from('projects').update({ status: 'error', error: e.message }).eq('id', p.id);
    throw e;
  }
});
