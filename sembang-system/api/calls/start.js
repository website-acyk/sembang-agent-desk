import { db, ok } from '../_lib/db.js';
import { handler, jsonBody, requireAgent, send } from '../_lib/http.js';
import { placeCall } from '../_lib/dial.js';
import { isMobile, normPhone } from '../../public/shared.js';

// mode "test": ring the agent's own mobile so they hear what leads hear.
// mode "again": the AI calls an existing lead again now.
export default handler(['POST'], async (req, res) => {
  const agent = await requireAgent(req, res); if (!agent) return;
  const { mode, lang = 'en', project_id, call_id } = await jsonBody(req);

  if (mode === 'test') {
    const phone = normPhone(agent.mobile);
    if (!isMobile(phone)) return send(res, 400, { error: 'Add your mobile number in Preferences first.' });
    const project = project_id ? ok(await db().from('projects').select('*').eq('id', project_id).eq('owner_id', agent.id).maybeSingle()) : null;
    const call = await placeCall({ agent, lead: { name: (agent.name || '').split(' ')[0], phone, lang, notes: 'This is a test call to the agent themselves.' }, project, kind: 'test' });
    return send(res, 200, { call });
  }
  if (mode === 'again') {
    const prev = ok(await db().from('calls').select('*').eq('id', call_id).eq('owner_id', agent.id).single());
    const lead = prev.lead_id ? ok(await db().from('leads').select('*').eq('id', prev.lead_id).maybeSingle()) : null;
    const project = prev.project_id ? ok(await db().from('projects').select('*').eq('id', prev.project_id).maybeSingle()) : null;
    const call = await placeCall({ agent, lead: lead || { name: prev.name, phone: prev.phone, lang: prev.lang, notes: prev.summary }, project, kind: 'again' });
    return send(res, 200, { call });
  }
  send(res, 400, { error: 'Unknown mode.' });
});
