// All calling-hours logic is in Malaysia time.
export const TZ = 'Asia/Kuala_Lumpur';
const MY_OFFSET_MIN = 8 * 60; // Malaysia has no daylight saving

export function myHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(d)) % 24;
}
/** Move a time into the calling window [start, end) in Malaysia time. */
export function intoHours(date, start = 9, end = 21) {
  const t = new Date(date);
  const local = new Date(t.getTime() + MY_OFFSET_MIN * 60000); // shift so UTC getters read Malaysia time
  const h = local.getUTCHours();
  if (h >= start && h < end) return t;
  if (h >= end) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(start, 0, 0, 0);
  return new Date(local.getTime() - MY_OFFSET_MIN * 60000);
}
export const inHours = (d, start, end) => { const h = myHour(d); return h >= start && h < end; };
export const fmtMY = (d) => new Date(d).toLocaleString('en-MY', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
