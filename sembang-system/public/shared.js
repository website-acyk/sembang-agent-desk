// Shared by the browser app and the server (api/_lib imports this file).

export const LANG = { en: 'English', zh: '中文', ms: 'Bahasa Melayu' };
export const LSHORT = { en: 'EN', zh: '中文', ms: 'BM' };

/** Malaysian numbers to E.164: 012-345 6789 / 60123456789 / 123456789 -> +60123456789 */
export function normPhone(p) {
  let d = String(p ?? '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d[0] === '+') d = d.slice(1);
  if (d.startsWith('60')) return '+' + d;
  if (d[0] === '0') return '+6' + d;
  if (d[0] === '1' && d.length >= 9 && d.length <= 10) return '+60' + d;
  return '+' + d;
}
export const isMobile = (p) => /^\+601\d{8,9}$/.test(p);
export const isLand = (p) => /^\+60[3-9]\d{7,8}$/.test(p);
export function showPhone(p) {
  if (!isMobile(p)) return p || '';
  const d = p.slice(3);
  return '+60 ' + d.slice(0, 2) + '-' + d.slice(2, 5) + ' ' + d.slice(5);
}

/** Guess only from clear signals: Chinese characters or common Malay name parts. */
export function guessLang(name) {
  if (/[㐀-鿿]/.test(name || '')) return 'zh';
  if (/\b(bin|binti|bt|muhammad|mohd|ahmad|nur|nurul|siti|abdul|aisyah|faiz|faizal|hafiz|aziz|ismail|azman|huda)\b/i.test(name || '')) return 'ms';
  return 'en';
}

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * Fill a template.
 * {key} is replaced by its value. Text inside [ ] is kept only when every {key}
 * inside it has a value, so "Hi[ {name}], ..." becomes "Hi, ..." when there is no name.
 */
export function fill(text, vals) {
  let out = String(text || '').replace(/\[([^\[\]]*)\]/g, (m, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    return keys.every((k) => has(vals[k])) ? inner : '';
  });
  out = out.replace(/\{(\w+)\}/g, (m, k) => (has(vals[k]) ? String(vals[k]).trim() : ''));
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?，。！？])/g, '$1').replace(/([,，])\s*([.。])/g, '$2').trim();
}

/** Values for templates from a lead/call, its project, and the agent. */
export function templateValues({ lead = {}, project = null, agent = {}, promiseDue = null }) {
  const prof = lead.profile || {};
  const price = project?.price ? String(project.price).split(/[–-]/)[0].trim() : '';
  const promo = project?.promotion ? project.promotion.charAt(0).toLowerCase() + project.promotion.slice(1) : '';
  return {
    name: lead.name || '',
    agent_name: (agent.name || '').split(' ')[0],
    agency: agent.agency || '',
    project: project?.name || '',
    unit_type: prof.unit && prof.unit !== '-' ? prof.unit : '',
    viewing_slots: agent.prefs?.slots || '',
    price,
    promo,
    promise_time: promiseDue
      ? new Date(promiseDue).toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })
      : '',
    budget: prof.budget || '',
  };
}
