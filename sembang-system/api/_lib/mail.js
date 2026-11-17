import nodemailer from 'nodemailer';
import { need } from './db.js';
import { alertLink } from './links.js';
import { fmtMY } from './time.js';
import { LANG, fill, showPhone, templateValues } from '../../public/shared.js';

let tx;
const transport = () => (tx ||= nodemailer.createTransport({ service: 'gmail', auth: { user: need('GMAIL_USER'), pass: need('GMAIL_APP_PASSWORD') } }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WHY = { viewing: 'wants a viewing', price: 'is asking about price', brochure: 'asked for the floor plan', loan: 'is asking about loans' };

const btn = (href, label, bg, fg = '#fff') =>
  `<a href="${href}" style="display:inline-block;background:${bg};color:${fg};text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;margin:0 6px 8px 0">${label}</a>`;

/** Hot lead email to the AGENT (never to the lead). */
export async function sendHotLeadAlert({ agent, call, project, templates }) {
  const to = agent.alert_email; if (!to) return;
  const p = call.profile || {};
  const sit = ['viewing', 'price', 'brochure'].includes(call.situation) ? call.situation : 'viewing';
  const t = templates.find((x) => x.situation === sit && x.lang === call.lang) || templates.find((x) => x.situation === sit && x.lang === 'en');
  const msg = t ? fill(t.body, templateValues({ lead: call, project, agent, promiseDue: call.promise_due })) : '';
  const row = (k, v) => v ? `<tr><td style="color:#5a6a63;padding:3px 14px 3px 0">${k}</td><td style="padding:3px 0">${esc(v)}</td></tr>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#13201b;max-width:600px">
  <p style="font-size:13px;color:#a16207;background:#fbf1d6;padding:8px 12px;border-radius:8px">
   The AI told ${esc(call.name || 'the lead')} you will WhatsApp them by <b>${fmtMY(call.promise_due)}</b> (${agent.prefs?.promise || 30} min).</p>
  ${call.quote ? `<p style="border-left:3px solid #c2410c;background:#fde7da;padding:8px 12px;font-style:italic">“${esc(call.quote)}”</p>` : ''}
  <table style="font-size:14px;margin:8px 0 14px">${row('Phone', showPhone(call.phone))}${row('Language', LANG[call.lang])}${row('Project', project?.name)}
   ${row('Budget', p.budget)}${row('Unit type', p.unit)}${row('Purpose', p.purpose)}${row('Timeline', p.timeline)}${row('Loan', p.loan)}${row('Lead score', call.score != null ? call.score + '/100' : '')}</table>
  ${call.summary ? `<p>${esc(call.summary)}</p>` : ''}
  ${msg ? `<p style="color:#5a6a63;margin-bottom:4px">Ready-to-send WhatsApp:</p><div style="background:#f3f6f5;border:1px solid #d6e0db;border-radius:10px;padding:12px;white-space:pre-wrap">${esc(msg)}</div>` : ''}
  <p style="margin-top:16px">${btn(alertLink(call.id, 'accept'), 'Accept &amp; send WhatsApp', '#0b7a5c')}${btn(`${need('APP_URL')}/?call=${call.id}#alerts`, 'Edit message first', '#e9efec', '#13201b')}${btn(alertLink(call.id, 'reject'), 'Reject', '#ffffff', '#b91c1c')}</p>
  <p><a href="${need('APP_URL')}/?open=${call.id}#history" style="color:#0b7a5c">View the transcript</a></p>
  <p style="font-size:12px;color:#5a6a63">Sent by Sembang to you only. The lead does not receive this email.</p></div>`;
  await transport().sendMail({
    from: `Sembang Alerts <${need('GMAIL_USER')}>`, to,
    subject: `🔥 Hot lead: ${call.name || showPhone(call.phone)} ${WHY[call.situation] || 'is interested'}${project ? ' · ' + project.name : ''}`,
    html,
  });
}

/** Reminder before the promised reply time runs out. */
export async function sendReminder({ agent, call, project }) {
  if (!agent.alert_email) return;
  const mins = Math.max(0, Math.round((new Date(call.promise_due) - Date.now()) / 60000));
  await transport().sendMail({
    from: `Sembang Alerts <${need('GMAIL_USER')}>`, to: agent.alert_email,
    subject: `⏰ ${mins} min left to reply to ${call.name || showPhone(call.phone)}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px">
      <p>You promised ${esc(call.name || 'this lead')} a WhatsApp by <b>${fmtMY(call.promise_due)}</b>${project ? ` about ${esc(project.name)}` : ''}.</p>
      <p>${btn(alertLink(call.id, 'accept'), 'Accept &amp; send WhatsApp', '#0b7a5c')}${btn(alertLink(call.id, 'reject'), 'Reject', '#ffffff', '#b91c1c')}</p></div>`,
  });
}
