import { db } from './db.js';

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
export async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}
export async function jsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = typeof req.body === 'string' ? req.body : await rawBody(req);
  return raw ? JSON.parse(raw) : {};
}
/** Returns the signed-in agent row, or sends 401 and returns null. */
export async function requireAgent(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { send(res, 401, { error: 'Please sign in again.' }); return null; }
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) { send(res, 401, { error: 'Your session expired. Please sign in again.' }); return null; }
  const { data: agent } = await db().from('agents').select('*').eq('id', data.user.id).single();
  if (!agent) { send(res, 403, { error: 'Agent profile not found.' }); return null; }
  return agent;
}
/** Wrap a handler: only allow given methods, turn thrown errors into JSON. */
export function handler(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
    try { await fn(req, res); }
    catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message || 'Something went wrong' }); }
  };
}
