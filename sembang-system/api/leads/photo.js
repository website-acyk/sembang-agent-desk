import { db, ok } from '../_lib/db.js';
import { handler, jsonBody, requireAgent, send } from '../_lib/http.js';
import { extractLeads } from '../_lib/claude.js';

// Reads names and numbers from a photo of a lead list or a business card.
export default handler(['POST'], async (req, res) => {
  const agent = await requireAgent(req, res); if (!agent) return;
  const { path } = await jsonBody(req);
  if (!path || !path.startsWith(agent.id + '/')) return send(res, 400, { error: 'Upload the photo first.' });
  const blob = ok(await db().storage.from('lead-photos').download(path));
  const leads = await extractLeads([{ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || 'image/jpeg' }]);
  send(res, 200, { leads });
});
