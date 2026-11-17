import crypto from 'node:crypto';
import { need } from './db.js';

// Signed links for the Accept / Reject buttons in alert emails (valid 7 days, no login needed).
const sig = (s) => crypto.createHmac('sha256', need('LINK_SECRET')).update(s).digest('base64url');

export function alertLink(callId, action) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const s = sig(`${callId}.${action}.${exp}`);
  return `${need('APP_URL')}/api/alert-link?c=${callId}&a=${action}&e=${exp}&s=${s}`;
}
export function checkLink({ c, a, e, s }) {
  if (!c || !a || !e || !s) return false;
  if (Date.now() > Number(e)) return false;
  const want = sig(`${c}.${a}.${e}`);
  return want.length === s.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s));
}
