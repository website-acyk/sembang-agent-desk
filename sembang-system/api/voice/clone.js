import { db, ok } from '../_lib/db.js';
import { handler, jsonBody, requireAgent, send } from '../_lib/http.js';
import { cloneVoice, deleteVoice } from '../_lib/eleven.js';

const LANGS = ['en', 'zh', 'ms'];

// POST: make (or remake) the agent's own voice for one language from their recordings.
// DELETE: delete all of the agent's voice clones and recordings.
export default handler(['POST', 'DELETE'], async (req, res) => {
  const agent = await requireAgent(req, res); if (!agent) return;
  const voices = { ...(agent.voices || {}) };

  if (req.method === 'DELETE') {
    const paths = [];
    for (const l of LANGS) { await deleteVoice(voices[l]?.voice_id); paths.push(...(voices[l]?.files || [])); voices[l] = { mode: 'ai' }; }
    if (paths.length) await db().storage.from('voice-samples').remove(paths);
    ok(await db().from('agents').update({ voices, consent_at: null }).eq('id', agent.id));
    return send(res, 200, { voices });
  }

  const { lang, paths = [], secs, quality } = await jsonBody(req);
  if (!LANGS.includes(lang)) return send(res, 400, { error: 'Unknown language.' });
  if (!agent.consent_at) return send(res, 400, { error: 'Tick the consent box first.' });
  if (!paths.length || paths.some((p) => !p.startsWith(agent.id + '/'))) return send(res, 400, { error: 'Record or upload your voice first.' });

  const files = [];
  for (const p of paths.slice(0, 5)) {
    const blob = ok(await db().storage.from('voice-samples').download(p));
    files.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || 'audio/webm', name: p.split('/').pop() });
  }
  const old = voices[lang]?.voice_id;
  const voice_id = await cloneVoice({ name: `${agent.name || 'Agent'} (${lang}) ${agent.id.slice(0, 6)}`, files });
  await deleteVoice(old);
  voices[lang] = { mode: 'own', voice_id, files: paths, secs, quality, created_at: new Date().toISOString() };
  ok(await db().from('agents').update({ voices }).eq('id', agent.id));
  send(res, 200, { voices });
});
