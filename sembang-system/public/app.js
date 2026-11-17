import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { LANG, LSHORT, fill, guessLang, isLand, isMobile, normPhone, showPhone, templateValues } from './shared.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN = 60000, DAY = 864e5;
const LANGS = ['en', 'zh', 'ms'];

let sb, CFG, session;
const S = { me: null, projects: [], calls: [], campaigns: [], progress: {}, templates: [], dnc: [] };
const UI = { tab: 'paste', filter: 'all', sel: new Set(), mapRows: null, map: null, mailSel: null, histQ: '', histCamp: '', tplSit: 'opening', samples: {}, busy: {} };

/* ---------------- boot ---------------- */
async function boot() {
  CFG = await fetch('/api/config').then((r) => r.json());
  if (!CFG.supabaseUrl) { document.body.innerHTML = '<p style="padding:24px">The server is missing SUPABASE_URL. See the setup guide.</p>'; return; }
  sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  ({ data: { session } } = await sb.auth.getSession());
  sb.auth.onAuthStateChange((_e, s) => { const was = !!session; session = s; if (!!s !== was) start(); });
  start();
}
async function start() {
  if (!session) { $('#app').hidden = true; $('#loginWrap').hidden = false; renderLogin(); return; }
  $('#loginWrap').hidden = true; $('#app').hidden = false;
  await loadAll();
  render();
  handleParams();
  clearInterval(start.poll);
  start.poll = setInterval(async () => { await loadCalls(); if (!layer && !document.activeElement?.matches('input,textarea,select')) render(); }, 30000);
}
function handleParams() {
  const q = new URLSearchParams(location.search);
  if (q.get('expired')) toast('That email link has expired. Use the buttons here instead.');
  if (q.get('reject')) openLayer('reject', q.get('reject'));
  else if (q.get('call')) { UI.mailSel = q.get('call'); render(); openLayer('compose', q.get('call'), true); }
  else if (q.get('open')) openLayer('drawer', q.get('open'));
  if (q.toString()) history.replaceState(null, '', '/' + location.hash);
}

/* ---------------- data ---------------- */
const uid = () => session.user.id;
async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
async function loadAll() {
  const [me, projects, campaigns, templates, dnc] = await Promise.all([
    q(sb.from('agents').select('*').eq('id', uid()).single()),
    q(sb.from('projects').select('*').order('created_at')),
    q(sb.from('campaigns').select('*').order('created_at', { ascending: false }).limit(30)),
    q(sb.from('templates').select('*')),
    q(sb.from('dnc').select('*').order('created_at', { ascending: false })),
  ]);
  Object.assign(S, { me, projects, campaigns, templates, dnc });
  await Promise.all([loadCalls(), loadProgress()]);
}
async function loadCalls() { S.calls = await q(sb.from('calls').select('*').eq('archived', false).order('started_at', { ascending: false }).limit(500)); }
async function loadProgress() {
  const ids = S.campaigns.map((c) => c.id); S.progress = {};
  if (!ids.length) return;
  const rows = await q(sb.from('leads').select('campaign_id,status').in('campaign_id', ids));
  for (const r of rows) { const p = (S.progress[r.campaign_id] ||= { total: 0, done: 0 }); p.total++; if (r.status === 'done' || r.status === 'skipped') p.done++; }
}
async function api(path, body, method = 'POST') {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
async function upload(bucket, file, sub = '') {
  const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_');
  const path = `${uid()}/${sub ? sub + '/' : ''}${Date.now()}-${safe}`;
  await q(sb.storage.from(bucket).upload(path, file, { contentType: file.type || undefined, upsert: false }));
  return path;
}
async function saveMe(patch) { Object.assign(S.me, patch); await q(sb.from('agents').update(patch).eq('id', uid())); }
const prefs = () => ({ promise: 30, remind: 10, hours_start: 9, hours_end: 21, slots: '', team: [], ...(S.me?.prefs || {}) });
const proj = (id) => S.projects.find((p) => p.id === id) || null;

/* ---------------- helpers ---------------- */
function toast(m) { const el = $('#toast'); el.textContent = m; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 4000); }
const fail = (e) => { console.error(e); toast(e.message || String(e)); };
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + fmtTime(ms);
const t = (d) => new Date(d).getTime();
function dueText(c) {
  if (!c.promise_due || c.alert !== 'pending') return '';
  const m = Math.round((t(c.promise_due) - Date.now()) / MIN);
  if (m < 0) return `<span class="due late">Overdue ${-m} min</span>`;
  return `<span class="due ${m <= prefs().remind ? 'soon' : 'fine'}">Reply due in ${m} min</span>`;
}
const pending = () => S.calls.filter((c) => c.col === 'hot' && c.alert === 'pending');
function pickTpl(sit, lang) { return S.templates.find((x) => x.situation === sit && x.lang === lang) || S.templates.find((x) => x.situation === sit && x.lang === 'en'); }
const fillFor = (body, c) => fill(body, templateValues({ lead: c, project: proj(c.project_id), agent: S.me, promiseDue: c.promise_due }));
const firstName = () => (S.me?.name || '').split(' ')[0] || 'there';

/* ---------------- login ---------------- */
function renderLogin(mode = 'in') {
  $('#login').innerHTML = `<div class="brand" style="color:var(--fg)"><div class="brand-mark"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg></div><span>Sembang</span></div>
  <h1>${mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
  <form id="loginForm" class="grid2" style="grid-template-columns:minmax(0,1fr)">
   <label class="f">Email<input class="in" id="lgEmail" type="email" autocomplete="email" required></label>
   <label class="f">Password<input class="in" id="lgPass" type="password" minlength="8" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" required></label>
   <button class="btn pri" type="submit">${mode === 'in' ? 'Sign in' : 'Create account'}</button></form>
  <button class="btn ghost" data-act="loginmode" data-m="${mode === 'in' ? 'up' : 'in'}">${mode === 'in' ? 'New agent? Create an account' : 'Already have an account? Sign in'}</button>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#lgEmail').value.trim(), password = $('#lgPass').value;
    const r = mode === 'in' ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password });
    if (r.error) return toast(r.error.message);
    if (mode === 'up' && !r.data.session) toast('Check your email to confirm your account, then sign in.');
  };
}

/* ---------------- nav ---------------- */
const ICON = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  projects: '<path d="M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01"/>',
  campaign: '<path d="M12 3v12M7 8l5-5 5 5M4 17v3h16v-3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  alerts: '<path d="M4 6h16v12H4zM4 7l8 6 8-6"/>',
  templates: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  preferences: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};
const NAV = [['Workspace', [['overview', 'Today'], ['alerts', 'Hot lead alerts'], ['history', 'Call history']]], ['Set up', [['campaign', 'New campaign'], ['voice', 'Voice Studio'], ['projects', 'Projects'], ['templates', 'Messages'], ['preferences', 'Preferences']]]];
const route = () => { const h = location.hash.slice(1); return ICON[h] ? h : 'overview'; };
function renderNav() {
  const r = route(), n = pending().length;
  $('#nav').innerHTML = NAV.map(([g, items]) => `<div class="nav-group"><div class="nav-label">${g}</div>${items.map(([id, l]) => `<a href="#${id}" class="${r === id ? 'on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[id]}</svg>${l}${id === 'alerts' && n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</div>`).join('');
  $('#railNum').textContent = showPhone(normPhone(CFG.number)) || 'Not set';
  $('#railWho').textContent = S.me?.name || session.user.email;
}
const header = (title, p, right = '') => `<div class="head"><div><h1>${title}</h1><p>${p}</p></div><div class="row">${right}</div></div>`;

/* ---------------- Today ---------------- */
function vOverview() {
  const c = S.calls.filter((x) => x.kind !== 'test');
  const setup = [];
  if (!S.me.name || !S.me.agency) setup.push(['preferences', 'Add your name and agency']);
  if (!S.projects.some((p) => p.status === 'checked')) setup.push(['projects', 'Upload a project sales kit']);
  if (!LANGS.some((l) => S.me.voices?.[l]?.voice_id)) setup.push(['voice', 'Record your voice (optional)']);
  const F = [['Leads called', c.length], ['Answered', c.filter((x) => x.status === 'answered').length], ['Interested', c.filter((x) => (x.score || 0) >= 60 || ['hot', 'follow'].includes(x.col)).length], ['You replied', c.filter((x) => x.alert === 'accepted').length], ['Viewings agreed', c.filter((x) => x.viewing).length]];
  const max = Math.max(1, c.length);
  const reps = c.filter((x) => x.replied_at && x.ended_at);
  const avg = reps.length ? Math.round(reps.reduce((a, x) => a + (t(x.replied_at) - t(x.ended_at)) / MIN, 0) / reps.length) : null;
  const w = pending().sort((a, b) => t(a.promise_due) - t(b.promise_due));
  return header(`Hello, ${esc(firstName())}`, 'Hot leads the AI found wait here for your reply. Everything else is handled.', '<a class="btn pri" href="#campaign">New campaign</a>') +
    (setup.length ? `<div class="banner"><b>Finish setting up</b><div class="row">${setup.map(([h, l]) => `<a class="btn sm" href="#${h}">${l}</a>`).join('')}</div></div>` : '') +
    `<div class="panel"><div class="panel-head"><h2>Waiting for you</h2><span class="small muted">The AI promised each lead a reply within ${prefs().promise} minutes</span></div>
    <div class="waitlist">${w.length ? w.map((x) => `<div class="wait"><div><b>${esc(x.name || showPhone(x.phone))}</b> <span class="chip">${LSHORT[x.lang]}</span><div class="small muted">${esc(proj(x.project_id)?.name || '')}</div></div><div class="q">${x.quote ? '“' + esc(x.quote) + '”' : esc(x.summary || '')}</div>${dueText(x)}<div class="row"><button class="btn sm pri" data-act="compose" data-id="${x.id}">Accept & send</button><button class="btn sm" data-act="mail" data-id="${x.id}">Open alert</button></div></div>`).join('') : '<div class="empty">No hot leads waiting right now.</div>'}</div></div>
    <div class="grid4">
     <div class="panel stat"><span class="small muted">Hot leads waiting</span><b>${w.length}</b></div>
     <div class="panel stat"><span class="small muted">Your average reply time</span><b>${avg == null ? '–' : avg + ' min'}</b></div>
     <div class="panel stat"><span class="small muted">Campaigns running</span><b>${S.campaigns.filter((x) => ['queued', 'running'].includes(x.status)).length}</b></div>
     <div class="panel stat"><span class="small muted">Do-not-call numbers</span><b>${S.dnc.length}</b></div></div>
    <div class="panel"><div class="panel-head"><h2>Funnel</h2><span class="small muted">Your last ${c.length} calls</span></div>
    ${c.length ? `<div class="funnel">${F.map(([l, v]) => `<div class="fr"><span>${l}</span><div class="bar"><i style="width:${Math.max(2, (v / max) * 100)}%"></i></div><span class="v">${v}</span></div>`).join('')}</div>` : '<div class="empty">Your funnel appears after the first campaign runs.</div>'}</div>`;
}

/* ---------------- Voice Studio ---------------- */
const SCRIPT = {
  en: "Hi, this is {me}. I help families and investors find the right home around Kuala Lumpur. If you have a moment, I'd love to share a few details about a new project that matches what you're looking for. Would Saturday morning or Sunday afternoon suit you better for a viewing?",
  zh: '你好，我是{me}。我专门帮家庭和投资者在吉隆坡一带找到合适的房子。如果你方便的话，我想跟你分享一个符合你需求的新项目。你看这个星期六早上还是星期天下午比较方便来看房呢？',
  ms: 'Hai, saya {me}. Saya membantu keluarga dan pelabur mencari rumah yang sesuai di sekitar Kuala Lumpur. Kalau ada masa sebentar, saya ingin kongsi sedikit maklumat tentang projek baharu yang sesuai dengan keperluan anda. Hari Sabtu pagi atau Ahad petang lebih sesuai untuk lawatan?',
};
function vVoice() {
  const v = S.me.voices || {};
  const card = (l) => {
    const x = v[l] || { mode: 'ai' }, s = UI.samples[l], busy = UI.busy['clone' + l];
    const qc = (q) => (q >= 80 ? 'ok' : q >= 60 ? 'warn' : 'bad');
    return `<div class="voice"><div class="panel-head"><h3>${LANG[l]}</h3><div class="toggle" role="group" aria-label="Voice for ${LANG[l]}"><button class="${x.mode === 'own' ? 'on' : ''}" data-act="vmode" data-l="${l}" data-m="own">My voice</button><button class="${x.mode !== 'own' ? 'on' : ''}" data-act="vmode" data-l="${l}" data-m="ai">AI voice</button></div></div>
    ${x.mode === 'own' ? `
      ${x.voice_id ? `<div class="row"><span class="chip ok">Your voice is ready</span><span class="small muted">Made ${fmtDay(x.created_at)}${x.secs ? ' · ' + x.secs + 's' : ''}</span></div>` : '<span class="chip warn">Not made yet. Calls use the AI voice until it is.</span>'}
      <p class="small muted">Read this aloud in a quiet room at your normal pace (about 20–30 seconds).</p>
      <div class="script" lang="${l}">${esc(SCRIPT[l].replace('{me}', firstName()))}</div>
      ${s ? `<div class="row"><span class="chip ${qc(s.quality)}">Quality ${s.quality}/100</span><span class="small muted">${s.secs}s · background noise ${s.snr >= 25 ? 'low' : s.snr >= 15 ? 'some' : 'high'}</span></div>
        <div class="meter"><i style="width:${s.quality}%"></i></div><audio controls src="${s.url}"></audio>
        ${s.secs < 15 ? '<p class="hint">Too short. Read the whole paragraph (at least 15 seconds).</p>' : s.snr < 15 ? '<p class="hint">Quite noisy. A quieter room will sound more like you.</p>' : ''}` : ''}
      <div class="row"><button class="btn sm ${s ? '' : 'pri'}" data-act="rec" data-l="${l}">${UI.recording === l ? '■ Stop recording' : s ? 'Record again' : 'Record'}</button>
        <label class="btn sm">Upload a voice memo<input type="file" accept="audio/*" data-up="${l}" hidden></label>
        ${s ? `<button class="btn sm pri" data-act="clone" data-l="${l}" ${busy || s.secs < 15 ? 'disabled' : ''}>${busy ? '<span class="spin"></span> Making your voice…' : x.voice_id ? 'Replace my voice' : 'Make my voice'}</button>` : ''}</div>`
      : `<p class="small muted">Calls in ${LANG[l]} use the AI voice. Good for a language you prefer not to record.</p>`}
    </div>`;
  };
  return header('Voice Studio', 'Record a short paragraph in each language so your AI calls sound like you. Pick the AI voice for any language you prefer not to record.') +
    `<div class="grid3">${LANGS.map(card).join('')}</div>
    <div class="grid2">
     <div class="panel"><h2>Hear it yourself</h2>
      <div class="grid2"><label class="f">Language<select class="in" id="testLang">${LANGS.map((l) => `<option value="${l}">${LANG[l]}</option>`).join('')}</select></label>
      <label class="f">Project<select class="in" id="testProj"><option value="">No project</option>${S.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label></div>
      <p class="hint">Rings your mobile (${esc(S.me.mobile || 'add it in Preferences')}) from your calling number. The result also lands in Call history.</p>
      <div><button class="btn pri" data-act="testcall">Test call me</button></div>
      <label class="f">AI voice<select class="in" data-me="ai_voice_id">${(CFG.aiVoices || []).map((o) => `<option value="${esc(o.id)}" ${o.id === (S.me.ai_voice_id || CFG.defaultVoice) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label></div>
     <div class="panel"><h2>Consent and control</h2>
      <label class="check"><input type="checkbox" data-act="consent" ${S.me.consent_at ? 'checked' : ''}><span>I agree that my voice recordings are used only to make calls to my own leads. I can delete them at any time.</span></label>
      <p class="hint">The AI says it is calling for you and answers truthfully if asked whether it is an AI. Recordings are personal data under the PDPA and are stored only in your account.</p>
      <div><button class="btn danger" data-act="delvoice">Delete my voice and recordings</button></div></div></div>`;
}
async function analyze(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const d = buf.getChannelData(0), win = Math.floor(buf.sampleRate * 0.05), rms = [];
    for (let i = 0; i + win <= d.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += d[j] * d[j]; rms.push(Math.sqrt(s / win) + 1e-6); }
    rms.sort((a, b) => a - b);
    const noise = rms[Math.floor(rms.length * 0.1)] || 1e-6, speech = rms[Math.floor(rms.length * 0.9)] || 1e-6;
    const snr = Math.round(20 * Math.log10(speech / noise)), secs = Math.round(buf.duration);
    const quality = Math.max(0, Math.min(100, Math.round(Math.min(snr, 40) * 2 + Math.min(secs, 30) - (speech > 0.9 ? 15 : 0))));
    return { secs, snr, quality };
  } finally { ctx.close(); }
}
async function takeSample(l, blob, name) {
  try {
    const a = await analyze(blob);
    UI.samples[l] = { blob, name, url: URL.createObjectURL(blob), ...a };
  } catch { UI.samples[l] = { blob, name, url: URL.createObjectURL(blob), secs: 20, snr: 20, quality: 70 }; }
  render();
}
let mr = null;
async function recToggle(l) {
  if (mr && UI.recording === l) { mr.stop(); return; }
  if (mr) return toast('Stop the other recording first.');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: false, echoCancellation: false } });
    const chunks = []; mr = new MediaRecorder(st); UI.recording = l; render();
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = () => { st.getTracks().forEach((x) => x.stop()); const type = mr.mimeType || 'audio/webm'; UI.recording = null; mr = null; takeSample(l, new Blob(chunks, { type }), `voice-${l}.${type.includes('mp4') ? 'm4a' : 'webm'}`); };
    mr.start();
  } catch { toast('Microphone blocked. Allow microphone access in your browser, or upload a voice memo.'); }
}

/* ---------------- Projects ---------------- */
const FACTS = [['Developer', 'developer'], ['Location', 'location'], ['Price', 'price'], ['Sizes', 'sizes'], ['Tenure', 'tenure'], ['Completion', 'completion'], ['Facilities', 'facilities'], ['Promotion', 'promotion'], ['Other details', 'extra']];
function vProjects() {
  const chip = (p) => ({ empty: '<span class="chip">No sales kit yet</span>', reading: '<span class="chip acc"><span class="spin"></span> Reading your sales kit…</span>', needs_check: '<span class="chip warn">Filled from your PDF. Please check</span>', checked: '<span class="chip ok">Checked</span>', error: '<span class="chip bad">Could not read</span>' }[p.status]);
  return header('Projects', 'Upload a sales kit and the facts fill in automatically. The AI quotes only these facts on calls.', `<label class="btn pri">New project from sales kit<input type="file" accept="application/pdf,image/*" multiple data-newproj hidden></label>`) +
    (S.projects.length ? `<div class="grid2">${S.projects.map((p) => `<div class="projcard"><div class="panel-head"><h2>${esc(p.name)}</h2>${chip(p)}</div>
     ${p.status === 'error' ? `<p class="hint">${esc(p.error || '')}</p>` : ''}
     <dl class="facts">${FACTS.map(([l, k]) => `<dt>${l}</dt><dd>${p[k] ? `<pre class="facts-extra">${esc(p[k])}</pre>` : '<span class="muted">Not in the documents</span>'}</dd>`).join('')}</dl>
     <div class="row">${(p.docs || []).map((d) => `<span class="doc">📄 ${esc(d.name)}</span>`).join('')}<span class="small muted">${(p.docs || []).length}/3 documents</span></div>
     <div class="row">${p.status === 'needs_check' ? `<button class="btn sm pri" data-act="projok" data-id="${p.id}">Looks right</button>` : ''}<button class="btn sm" data-act="editproj" data-id="${p.id}">Edit</button>
      ${(p.docs || []).length < 3 ? `<label class="btn sm">Add document<input type="file" accept="application/pdf,image/*" data-adddoc="${p.id}" hidden></label>` : ''}
      ${(p.docs || []).length ? `<button class="btn sm" data-act="reread" data-id="${p.id}">Read again</button>` : ''}<button class="btn sm ghost danger" data-act="delproj" data-id="${p.id}">Delete</button></div></div>`).join('')}</div>`
      : '<div class="panel empty">No projects yet. Upload a sales kit PDF (up to 3 files: brochure, price list, floor plans) and the fact card fills itself in.</div>');
}
async function addDocs(projectId, files) {
  const p = proj(projectId); const docs = [...(p.docs || [])];
  for (const f of [...files].slice(0, 3 - docs.length)) docs.push({ path: await upload('sales-kits', f, projectId), name: f.name });
  p.docs = docs; p.status = 'reading'; render();
  await q(sb.from('projects').update({ docs, status: 'reading' }).eq('id', projectId));
  await readProject(projectId);
}
async function readProject(id) {
  const p = proj(id); p.status = 'reading'; render();
  try { const r = await api('/api/projects/extract', { project_id: id }); Object.assign(p, r.project); toast('Facts filled in from your sales kit. Give them a quick check.'); }
  catch (e) { p.status = 'error'; p.error = e.message; fail(e); }
  render();
}

/* ---------------- New campaign ---------------- */
const DRAFT_KEY = 'sembang-draft';
function newDraft() {
  const d = new Date(Date.now() + 10 * MIN); d.setSeconds(0, 0);
  return { name: '', project_id: S.projects.find((p) => p.status === 'checked')?.id || S.projects[0]?.id || '', tag: '', paste: '', rows: [], gap: 2, attempts: 2, retry: 120, maxLen: 1, skip: true, checked: false, start: new Date(d - d.getTimezoneOffset() * MIN).toISOString().slice(0, 16) };
}
let D;
function draft() {
  if (!D) { try { D = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { D = null; } if (!D) D = newDraft(); }
  return D;
}
const saveDraft = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(D)); } catch {} };
let rid = 0;
const mkRow = (name, phone, o = {}) => ({ id: 'r' + ++rid + Date.now().toString(36), name: String(name || '').trim(), phone: normPhone(phone), lang: o.lang || guessLang(name || ''), guessed: !o.lang, notes: o.notes || '', source: o.source || 'paste' });
function parsePaste(txt) {
  return txt.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/(\+?\d[\d\s\-]{2,}\d)/);
    if (!m) return mkRow(l, '');
    const rest = (l.slice(0, m.index) + ' ' + l.slice(m.index + m[0].length)).replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const k = rest.search(/\b(interested|want|wants|budget|looking|ask|asked|need|call|nak|mahu)\b/i);
    return mkRow(k > 0 ? rest.slice(0, k) : rest, m[1], { notes: k > 0 ? rest.slice(k) : '' });
  });
}
function validate(rows) {
  const d = draft(), seen = new Set(), D2 = new Set(S.dnc.map((x) => x.phone)), out = {};
  const recent = new Map(S.calls.filter((c) => c.status === 'answered' && Date.now() - t(c.started_at) < 30 * DAY).map((c) => [c.phone, c]));
  for (const r of rows) {
    const iss = []; let level = 'ok';
    if (!r.phone || (!isMobile(r.phone) && !isLand(r.phone))) { iss.push(['bad', 'Invalid number']); level = 'bad'; }
    else if (isLand(r.phone)) { iss.push(['warn', 'Landline']); level = 'warn'; }
    if (r.phone && D2.has(r.phone)) { iss.push(['bad', 'Do-not-call list']); level = 'bad'; }
    if (r.phone && seen.has(r.phone)) { iss.push(['warn', 'Duplicate']); if (level !== 'bad') level = 'dupe'; } else if (r.phone) seen.add(r.phone);
    const rc = r.phone && recent.get(r.phone);
    if (rc) { iss.push(['warn', `Spoke ${fmtDay(rc.started_at).split(',')[0]} · ${rc.interest || 'unknown'} interest`]); if (level === 'ok' || level === 'warn') level = d.skip ? 'skip' : 'warn'; }
    if (!r.name) iss.push(['warn', 'No name (the opening line skips it)']);
    out[r.id] = { iss, level, ready: level === 'ok' || level === 'warn' };
  }
  return out;
}
function finishEstimate(n) {
  const d = draft(), P = prefs(); let tm = new Date(d.start).getTime(); if (isNaN(tm) || !n) return null; let days = 0;
  for (let i = 0; i < n; i++) {
    const dt = new Date(tm);
    if (dt.getHours() < P.hours_start) { dt.setHours(P.hours_start, 0, 0, 0); tm = dt.getTime(); }
    if (new Date(tm).getHours() >= P.hours_end) { const nx = new Date(tm); nx.setDate(nx.getDate() + 1); nx.setHours(P.hours_start, 0, 0, 0); tm = nx.getTime(); days++; }
    if (i < n - 1) tm += d.gap * MIN;
  }
  return { end: tm, days };
}
function vCampaign() {
  const d = draft(), V = validate(d.rows), P = prefs();
  const cnt = { ready: 0, bad: 0, dupe: 0, skip: 0 };
  d.rows.forEach((r) => { const v = V[r.id]; if (v.ready) cnt.ready++; if (v.level === 'bad') cnt.bad++; if (v.level === 'dupe') cnt.dupe++; if (v.level === 'skip') cnt.skip++; });
  const shown = d.rows.filter((r) => UI.filter === 'all' || (UI.filter === 'ready' ? V[r.id].ready : !V[r.id].ready || V[r.id].iss.length));
  const est = finishEstimate(cnt.ready);
  const tabs = [['paste', 'Paste text'], ['file', 'Excel or CSV'], ['photo', 'Photo or business card']];
  const pr = proj(d.project_id);
  return header('New campaign', 'Add leads in any format, fix problems in one click, then queue. The AI calls them for you.', '<button class="btn" data-act="resetdraft">Start over</button>') +
  `<div class="panel"><div class="step"><span class="step-n">1</span><h2>Campaign details</h2></div>
   <div class="grid3"><label class="f">Project<select class="in" data-d="project_id"><option value="">No project</option>${S.projects.map((p) => `<option value="${p.id}" ${p.id === d.project_id ? 'selected' : ''}>${esc(p.name)}${p.status !== 'checked' ? ' (not checked yet)' : ''}</option>`).join('')}</select></label>
   <label class="f">Campaign name<input class="in" data-d="name" value="${esc(d.name)}" placeholder="For example, Mid Valley roadshow Nov"></label>
   <label class="f">Lead source tag<input class="in" data-d="tag" value="${esc(d.tag)}" placeholder="Roadshow, referral, old leads…"></label></div>
   ${pr && pr.status !== 'checked' ? '<p class="hint">This project’s facts haven’t been checked yet. The AI will quote them on calls.</p>' : ''}</div>

  <div class="panel"><div class="panel-head"><div class="step"><span class="step-n">2</span><h2>Add leads</h2></div><span class="chip">${d.rows.length} of 200 leads</span></div>
   <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="${UI.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div>
   ${UI.tab === 'paste' ? `<textarea class="in mono" id="pasteBox" rows="7" style="font-size:13px" placeholder="Sarah Lim 012-345 6789 interested 3 room&#10;Ahmad 0129876543&#10;尤泽新 017 737 8502">${esc(d.paste)}</textarea><div class="row" style="justify-content:space-between"><span class="hint">One lead per line. Any format works: names, numbers with dashes or spaces, notes after the number.</span><button class="btn pri" data-act="process">Process list</button></div>` : ''}
   ${UI.tab === 'file' ? vFileTab() : ''}
   ${UI.tab === 'photo' ? `<div class="drop"><b>Upload a photo of a lead list, whiteboard or business card</b><span class="hint">Names and numbers are read from the photo and added below for you to check.</span><label class="btn pri">${UI.busy.photo ? '<span class="spin"></span> Reading photo…' : 'Choose photo'}<input type="file" accept="image/*" data-photo hidden ${UI.busy.photo ? 'disabled' : ''}></label></div>` : ''}
  </div>

  <div class="panel"><div class="panel-head"><h2>Review the list</h2><div class="row"><button class="btn sm" data-act="rmbad" ${cnt.bad ? '' : 'disabled'}>Remove invalid (${cnt.bad})</button><button class="btn sm" data-act="rmdupe" ${cnt.dupe ? '' : 'disabled'}>Merge duplicates (${cnt.dupe})</button><button class="btn sm" data-act="addrow">+ Add lead</button></div></div>
   <div class="sumbar small"><span><b>${cnt.ready}</b> ready</span><span style="color:var(--bad)"><b>${cnt.bad}</b> invalid or blocked</span><span style="color:var(--warn)"><b>${cnt.dupe}</b> duplicates</span><span class="muted"><b>${cnt.skip}</b> spoke in last 30 days${d.skip ? ' (will be skipped)' : ''}</span></div>
   <div class="row" style="justify-content:space-between"><div class="toggle">${[['all', 'All'], ['ready', 'Ready'], ['issues', 'Needs a look']].map(([k, l]) => `<button class="${UI.filter === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="row small"><span class="muted">${UI.sel.size} selected · set language</span>${LANGS.map((l) => `<button class="btn sm" data-act="bulklang" data-l="${l}" ${UI.sel.size ? '' : 'disabled'}>${LSHORT[l]}</button>`).join('')}<button class="btn sm danger" data-act="bulkdel" ${UI.sel.size ? '' : 'disabled'}>Remove</button></div></div>
   <div class="tablewrap"><table><thead><tr><th><input type="checkbox" data-act="selall" aria-label="Select all shown" ${shown.length && shown.every((r) => UI.sel.has(r.id)) ? 'checked' : ''}></th><th>Status</th><th>Phone</th><th>Name</th><th>Language</th><th>Notes</th><th></th></tr></thead><tbody>
   ${shown.map((r) => { const v = V[r.id]; const cls = v.level === 'bad' ? 'bad' : v.level === 'dupe' || v.level === 'skip' ? 'warn' : '';
     return `<tr class="${cls}"><td><input type="checkbox" data-act="sel" data-id="${r.id}" ${UI.sel.has(r.id) ? 'checked' : ''} aria-label="Select"></td>
     <td><div class="row" style="gap:4px">${v.iss.length ? v.iss.map(([k, x]) => `<span class="chip ${k}">${esc(x)}</span>`).join('') : '<span class="chip ok">Ready</span>'}</div></td>
     <td><input class="in mono" style="min-width:150px" data-row="${r.id}" data-k="phone" value="${esc(r.phone)}" aria-label="Phone"></td>
     <td><input class="in" style="min-width:150px" data-row="${r.id}" data-k="name" value="${esc(r.name)}" aria-label="Name"></td>
     <td><select class="in" style="min-width:110px" data-row="${r.id}" data-k="lang" aria-label="Language">${LANGS.map((l) => `<option value="${l}" ${r.lang === l ? 'selected' : ''}>${LANG[l]}</option>`).join('')}</select>${r.guessed ? '<div class="hint" style="font-size:11px">Guessed from name</div>' : ''}</td>
     <td><input class="in" style="min-width:150px" data-row="${r.id}" data-k="notes" value="${esc(r.notes)}" placeholder="Budget, unit type…" aria-label="Notes"></td>
     <td><button class="btn sm ghost" data-act="rmrow" data-id="${r.id}" aria-label="Remove">✕</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">No leads yet. Paste, import a file or upload a photo above.</td></tr>'}
   </tbody></table></div>
   <p class="hint">Notes are passed to the AI. “Budget 600k” means it won't ask about budget again.</p>
   <label class="check"><input type="checkbox" data-d="checked" ${d.checked ? 'checked' : ''}><b>I have checked this list. Every number matches the right name.</b></label></div>

  <div class="panel"><div class="step"><span class="step-n">3</span><h2>Call details</h2></div>
   <div class="grid4"><label class="f">Start at<input type="datetime-local" class="in" data-d="start" value="${esc(d.start)}"></label>
    <label class="f">Minutes between calls<input type="number" min="1" class="in" data-d="gap" value="${d.gap}"></label>
    <label class="f">Attempts if no answer<input type="number" min="1" max="5" class="in" data-d="attempts" value="${d.attempts}"></label>
    <label class="f">Retry after (minutes)<input type="number" min="15" class="in" data-d="retry" value="${d.retry}"></label></div>
   <label class="f" style="max-width:340px">Aim for calls of about<select class="in" data-d="maxLen">${[[1, '1 minute (recommended)'], [2, '2 minutes'], [3, '3 minutes']].map(([v, l]) => `<option value="${v}" ${+d.maxLen === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
   <p class="hint">If a call reaches voicemail, that lead is not called again. Calls save the transcript only, no audio.</p>
   <label class="check"><input type="checkbox" data-d="skip" ${d.skip ? 'checked' : ''}><span><b>Skip leads you spoke with in the last 30 days</b><br><span class="hint">Your minutes go to new people. Untick to call them again.</span></span></label>
   <div class="sumbar small" style="flex-direction:column;align-items:flex-start;gap:6px">
    <span><b>${cnt.ready}</b> leads will be called${est ? `, finishing around <b>${fmtDay(est.end)}</b>` : ''}${est?.days ? ` <span class="chip warn">Pauses at ${P.hours_end - 12} PM and continues next day at ${P.hours_start} AM</span>` : ''}</span>
    <span class="muted">Calls only go out between ${P.hours_start}:00 and ${P.hours_end}:00. Change this in Preferences.</span></div>
   <div class="row"><button class="btn pri" data-act="queue" ${UI.busy.queue ? 'disabled' : ''}>${UI.busy.queue ? '<span class="spin"></span> Queuing…' : 'Queue campaign'}</button><a class="btn" href="#voice">Test call me first</a>${!d.checked ? '<span class="hint">Tick “I have checked this list” to queue.</span>' : ''}</div></div>

  <div class="panel"><h2>Your campaigns</h2>${S.campaigns.length ? S.campaigns.map((c) => { const pg = S.progress[c.id] || { total: 0, done: 0 };
    return `<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding-top:10px"><div style="min-width:0"><b>${esc(c.name)}</b> <span class="small muted">· ${esc(proj(c.project_id)?.name || 'No project')} · starts ${fmtDay(c.start_at)}</span></div>
    <div class="row"><div class="progress" title="${pg.done} of ${pg.total} done"><i style="width:${pg.total ? (pg.done / pg.total) * 100 : 0}%"></i></div><span class="small mono">${pg.done}/${pg.total}</span><span class="chip ${c.status === 'running' ? 'acc' : c.status === 'paused' ? 'warn' : ''}">${c.status}</span>
    ${['queued', 'running'].includes(c.status) ? `<button class="btn sm" data-act="camp" data-id="${c.id}" data-s="paused">Pause</button>` : ''}${c.status === 'paused' ? `<button class="btn sm" data-act="camp" data-id="${c.id}" data-s="running">Resume</button>` : ''}${['queued', 'running', 'paused'].includes(c.status) ? `<button class="btn sm ghost danger" data-act="camp" data-id="${c.id}" data-s="cancelled">Cancel</button>` : ''}</div></div>`; }).join('') : '<div class="empty">No campaigns yet.</div>'}</div>`;
}
function vFileTab() {
  if (UI.mapRows) {
    const hdr = UI.mapHeader, body = UI.mapRows.slice(0, 4);
    const F = [['ignore', 'Ignore'], ['name', 'Name'], ['phone', 'Phone'], ['lang', 'Language'], ['budget', 'Budget'], ['notes', 'Notes']];
    return `<p><b>Match your columns.</b> <span class="muted">We guessed each one. Fix any that are wrong. This layout is remembered for next time.</span></p>
    <div class="tablewrap"><table><thead><tr>${UI.map.map((m, i) => `<th><select class="in" data-map="${i}" aria-label="Column ${i + 1}">${F.map(([k, l]) => `<option value="${k}" ${m === k ? 'selected' : ''}>${l}</option>`).join('')}</select><div style="margin-top:4px;text-transform:none">${esc(hdr ? hdr[i] : 'Column ' + (i + 1))}</div></th>`).join('')}</tr></thead>
    <tbody>${body.map((r) => `<tr>${UI.map.map((m, i) => `<td class="${m === 'ignore' ? 'muted' : ''}">${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="row"><button class="btn pri" data-act="usemap">Add ${UI.mapRows.length} leads</button><button class="btn" data-act="cancelmap">Cancel</button></div>`;
  }
  return `<div class="drop" id="dropzone"><b>Drop an Excel (.xlsx) or CSV file here</b><span class="hint">Messy headers like “H/P No.” or “Contact” are fine. Extra columns go into notes.</span><label class="btn pri">Choose file<input type="file" accept=".csv,.xlsx,.xls,.txt" data-sheet hidden></label></div>
  <div class="row small"><span class="muted">Want a clean format? Use these columns:</span><code class="mono">Name, Phone, Language, Project, Budget, Remarks</code><button class="btn sm" data-act="copyhdr">Copy header</button></div>`;
}
function parseCSV(s) { const R = []; let r = [], f = '', qt = false; for (let i = 0; i < s.length; i++) { const c = s[i]; if (qt) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else qt = false; } else f += c; } else if (c === '"') qt = true; else if (c === ',' || c === '\t') { r.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; r.push(f); R.push(r); r = []; f = ''; } else f += c; } if (f || r.length) { r.push(f); R.push(r); } return R.filter((x) => x.some((y) => String(y).trim())); }
function guessCol(h, samples) {
  h = String(h || '').toLowerCase();
  if (/phone|h\/?p|mobile|contact|tel|number|电话|手机|no\.?\s*$/.test(h)) return 'phone';
  if (/name|nama|姓名|名字/.test(h)) return 'name';
  if (/lang|bahasa|语言/.test(h)) return 'lang';
  if (/budget|bajet|预算|price/.test(h)) return 'budget';
  if (/remark|note|catatan|备注|comment/.test(h)) return 'notes';
  if (samples.length && samples.every((s) => isMobile(normPhone(s)) || isLand(normPhone(s)))) return 'phone';
  return 'ignore';
}
function loadTable(rows) {
  if (!rows.length) return toast('That file looks empty.');
  const first = rows[0].map(String), headless = first.some((c) => isMobile(normPhone(c)));
  UI.mapHeader = headless ? null : first; UI.mapRows = headless ? rows : rows.slice(1);
  let saved = null; try { saved = JSON.parse(localStorage.getItem('sembang-map:' + first.join('|').toLowerCase()) || 'null'); } catch {}
  UI.map = !headless && saved?.length === first.length ? saved : first.map((h, i) => { const g = guessCol(headless ? '' : h, UI.mapRows.slice(0, 5).map((r) => r[i]).filter(Boolean)); return g === 'ignore' && headless && i === 0 ? 'name' : g; });
  if (saved && !headless) toast('Used your saved column layout for this file.');
  render();
}
function readSheet(f) {
  const rd = new FileReader();
  if (/\.xlsx?$/i.test(f.name)) {
    if (!window.XLSX) return toast('The Excel reader did not load. Save the sheet as CSV and try again.');
    rd.onload = () => { try { const wb = XLSX.read(new Uint8Array(rd.result), { type: 'array' }); loadTable(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).filter((r) => r.some((c) => String(c).trim()))); } catch { toast('Could not read that Excel file. Try saving it as CSV.'); } };
    rd.readAsArrayBuffer(f);
  } else { rd.onload = () => loadTable(parseCSV(String(rd.result))); rd.readAsText(f); }
}

/* ---------------- Call history ---------------- */
const COLS = [['noanswer', 'No answer', 'var(--muted)'], ['hot', 'Hot · you to reply', 'var(--hot)'], ['follow', 'Follow up', 'var(--warn)'], ['others', 'Others', 'var(--line)'], ['done', 'Completed', 'var(--ok)']];
const campName = (id) => S.campaigns.find((c) => c.id === id)?.name || '';
function vHistory() {
  const qq = UI.histQ.toLowerCase();
  const list = S.calls.filter((c) => (!UI.histCamp || c.campaign_id === UI.histCamp) && (!qq || ((c.name || '') + c.phone + (c.summary || '')).toLowerCase().includes(qq)));
  return header('Call history', 'Hot leads go straight to “Hot · you to reply”. Drag a card to move it. Click a card for the lead profile and transcript.', '<button class="btn" data-act="refresh">Refresh</button>') +
  `<div class="row"><input class="in" style="max-width:280px" placeholder="Search name, number or summary" id="histQ" value="${esc(UI.histQ)}" aria-label="Search calls"><select class="in" style="max-width:260px" id="histCamp" aria-label="Campaign"><option value="">All campaigns (${S.calls.length} calls)</option>${S.campaigns.map((c) => `<option value="${c.id}" ${UI.histCamp === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
  <div class="board">${COLS.map(([k, l, col]) => { const cs = list.filter((c) => c.col === k).sort((a, b) => (k === 'hot' ? t(a.promise_due) - t(b.promise_due) : t(b.started_at) - t(a.started_at)));
    return `<div class="col" data-col="${k}"><div class="col-h"><span class="dot" style="background:${col}"></span>${l}<span class="n">${cs.length}</span></div>
    ${cs.map((c) => `<button class="card ${k === 'hot' ? 'isHot' : ''}" draggable="true" data-act="open" data-id="${c.id}" data-drag="${c.id}"><div class="who">${esc(c.name || 'No name')} <span class="ph">${showPhone(c.phone)}</span></div>
      <div class="row" style="gap:5px"><span class="chip">${LSHORT[c.lang] || c.lang}</span>${c.kind === 'test' ? '<span class="chip">Test</span>' : ''}${c.status === 'dialing' ? '<span class="chip acc"><span class="spin"></span> Calling</span>' : ''}${c.score != null ? `<span class="score">${c.score}</span>` : ''}${c.interest ? `<span class="chip ${c.interest === 'High' ? 'hot' : c.interest === 'Medium' ? 'warn' : ''}">${esc(c.interest)}</span>` : ''}${c.alert === 'accepted' ? '<span class="chip ok">Replied</span>' : ''}${c.alert === 'rejected' ? '<span class="chip">Rejected</span>' : ''}${c.viewing ? '<span class="chip acc">Viewing</span>' : ''}</div>
      ${dueText(c)}<div class="sum">${esc(c.summary || '')}</div><div class="small muted">${fmtDay(c.started_at)}${c.campaign_id ? ' · ' + esc(campName(c.campaign_id)) : ''}</div></button>`).join('') || '<div class="empty">Empty</div>'}</div>`; }).join('')}</div>`;
}
function drawer(c) {
  const p = proj(c.project_id), pr = c.profile || {};
  return `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-label="Lead details">
  <div class="panel-head"><div><h2>${esc(c.name || 'No name')}</h2><div class="mono small muted">${showPhone(c.phone)} · ${LANG[c.lang] || c.lang}</div></div><button class="btn sm" data-act="close">Close</button></div>
  <div class="row">${c.score != null ? `<span class="score">Score ${c.score}/100</span>` : ''}${c.interest ? `<span class="chip ${c.interest === 'High' ? 'hot' : ''}">${esc(c.interest)} interest</span>` : ''}${p ? `<span class="chip">${esc(p.name)}</span>` : ''}${dueText(c)}</div>
  ${c.quote ? `<div class="quote">“${esc(c.quote)}”</div>` : ''}
  <p>${esc(c.summary || '')}</p>
  ${c.status === 'answered' ? `<div class="profile">${[['Budget', pr.budget], ['Unit type', pr.unit], ['Purpose', pr.purpose], ['Timeline', pr.timeline], ['Loan', pr.loan], ['Concerns', c.objections]].map(([l, v]) => `<div><small>${l}</small>${esc(v || '–')}</div>`).join('')}</div>
   ${c.next_step ? `<div class="panel" style="padding:12px;gap:4px;background:var(--accent-soft);border-color:transparent"><small class="muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;font-size:11px">Suggested next step</small><b>${esc(c.next_step)}</b></div>` : ''}` : ''}
  ${c.route ? `<p class="small muted">Routed: ${esc(c.route)} (${esc(c.reject_reason || '')})</p>` : ''}
  <div class="row">${c.col === 'hot' && c.alert === 'pending' ? `<button class="btn pri" data-act="compose" data-id="${c.id}">Accept & send WhatsApp</button><button class="btn" data-act="reject" data-id="${c.id}">Reject</button>` : `<button class="btn" data-act="compose" data-id="${c.id}">WhatsApp</button>`}<button class="btn" data-act="again" data-id="${c.id}">AI calls again now</button>
   <select class="in" style="width:auto" data-move="${c.id}" aria-label="Move to">${COLS.map(([k, l]) => `<option value="${k}" ${c.col === k ? 'selected' : ''}>Move to: ${l}</option>`).join('')}</select></div>
  <label class="check"><input type="checkbox" data-viewing="${c.id}" ${c.viewing ? 'checked' : ''}><span>Viewing booked</span></label>
  <h3>Transcript</h3>${(c.transcript || []).length ? `<div class="tx">${c.transcript.map(([w, x]) => `<p class="${w}">${esc(x)}</p>`).join('')}</div>` : '<p class="muted small">No conversation on this call.</p>'}
  <p class="hint">Only the transcript is kept. No audio is recorded.</p>
  <div class="row"><button class="btn sm" data-act="archive" data-id="${c.id}">Archive</button><button class="btn danger sm" data-act="delcall" data-id="${c.id}">Delete this call</button></div></aside>`;
}

/* ---------------- Hot lead alerts ---------------- */
function vAlerts() {
  const list = S.calls.filter((c) => c.alert).sort((a, b) => (a.alert === 'pending' ? 0 : 1) - (b.alert === 'pending' ? 0 : 1) || t(b.started_at) - t(a.started_at));
  if (!UI.mailSel || !list.find((c) => c.id === UI.mailSel)) UI.mailSel = list[0]?.id;
  const c = S.calls.find((x) => x.id === UI.mailSel);
  return header('Hot lead alerts', `When the AI finds a hot lead, this email goes to ${esc(S.me.alert_email || 'your email')}. Only you receive it. Accept to send the ready-made WhatsApp, or reject to pass the lead on.`) +
  `<div class="mailshell"><div class="inbox">${list.map((x) => `<button class="${x.id === UI.mailSel ? 'on' : ''}" data-act="mailsel" data-id="${x.id}"><div class="row" style="justify-content:space-between"><b>${esc(x.name || showPhone(x.phone))}</b>${x.alert === 'pending' ? '<span class="chip hot">New</span>' : x.alert === 'accepted' ? '<span class="chip ok">Accepted</span>' : '<span class="chip">Rejected</span>'}</div><span class="small muted">${esc(proj(x.project_id)?.name || '')}</span>${dueText(x)}</button>`).join('') || '<div class="empty">No hot leads yet. They appear here and in your Gmail as soon as a call finds one.</div>'}</div>
  ${c ? mail(c) : '<div></div>'}</div>`;
}
function mail(c) {
  const p = proj(c.project_id), pr = c.profile || {};
  const sit = ['viewing', 'price', 'brochure'].includes(c.situation) ? c.situation : 'viewing';
  const tp = pickTpl(sit, c.lang);
  const why = { viewing: 'wants a viewing', price: 'is asking about price', brochure: 'asked for the floor plan', loan: 'is asking about loans' }[c.situation] || 'is interested';
  return `<article class="mail"><div class="mail-top"><div class="subj">🔥 Hot lead: ${esc(c.name || showPhone(c.phone))} ${why}${p ? ' · ' + esc(p.name) : ''}</div>
   <div class="small muted">To ${esc(S.me.alert_email || '')} · ${fmtDay(c.ended_at || c.started_at)}</div></div>
  <div class="mail-body">
   ${c.alert === 'pending' ? `<div>${dueText(c)}</div><p>The AI told ${esc(c.name || 'the lead')}: <i>“${esc(firstName())} will WhatsApp you within ${prefs().promise} minutes.”</i></p>` : c.alert === 'accepted' ? '<span class="chip ok" style="align-self:flex-start">You accepted and replied</span>' : `<span class="chip" style="align-self:flex-start">Rejected · ${esc(c.reject_reason || '')} · ${esc(c.route || '')}</span>`}
   ${c.quote ? `<div class="quote">“${esc(c.quote)}”</div>` : ''}
   <dl class="kv"><dt>Phone</dt><dd class="mono">${showPhone(c.phone)}</dd><dt>Language</dt><dd>${LANG[c.lang]}</dd><dt>Budget</dt><dd>${esc(pr.budget || '–')}</dd><dt>Unit type</dt><dd>${esc(pr.unit || '–')}</dd><dt>Purpose</dt><dd>${esc(pr.purpose || '–')}</dd><dt>Timeline</dt><dd>${esc(pr.timeline || '–')}</dd><dt>Loan</dt><dd>${esc(pr.loan || '–')}</dd><dt>Lead score</dt><dd><b>${c.score ?? '–'}</b>/100</dd></dl>
   ${tp ? `<div><div class="small muted" style="margin-bottom:6px">Ready-to-send WhatsApp (${LANG[c.lang]})</div><div class="msgbox">${esc(fillFor(tp.body, c))}</div></div>` : ''}
   ${c.alert === 'pending' ? `<div class="row"><button class="btn pri" data-act="compose" data-id="${c.id}">Accept & send</button><button class="btn" data-act="compose" data-id="${c.id}" data-edit="1">Edit message first</button><button class="btn danger" data-act="reject" data-id="${c.id}">Reject</button></div>` : ''}
   <div class="row small"><button class="btn sm ghost" data-act="open" data-id="${c.id}">View transcript</button></div></div></article>`;
}
const SITS = [['viewing', 'Viewing request'], ['price', 'Price enquiry'], ['brochure', 'Send brochure'], ['busy', 'Holding message']];
function composer(c, edit) {
  UI.cSit ||= ['viewing', 'price', 'brochure'].includes(c.situation) ? c.situation : 'viewing'; UI.cLang ||= c.lang;
  const tp = pickTpl(UI.cSit, UI.cLang), txt = UI.cText ?? (tp ? fillFor(tp.body, c) : '');
  const p = proj(c.project_id);
  return `<div class="scrim" data-act="close"></div><div class="dialog" role="dialog" aria-label="WhatsApp message"><div class="panel-head"><h2>WhatsApp ${esc(c.name || showPhone(c.phone))}</h2><button class="btn sm" data-act="close">Close</button></div>
  <div class="grid2"><label class="f">Message type<select class="in" id="cSit">${SITS.map(([k, l]) => `<option value="${k}" ${UI.cSit === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label class="f">Language<select class="in" id="cLang">${LANGS.map((l) => `<option value="${l}" ${UI.cLang === l ? 'selected' : ''}>${LANG[l]}</option>`).join('')}</select></label></div>
  <label class="f">Message<textarea class="in" id="cText" rows="6" ${edit ? 'autofocus' : ''}>${esc(txt)}</textarea></label>
  ${p?.docs?.length ? `<div class="row small"><span class="muted">Attach in WhatsApp:</span>${p.docs.map((d) => `<span class="doc">📄 ${esc(d.name)}</span>`).join('')}</div>` : ''}
  <div class="row"><a class="btn pri" id="waLink" href="${waUrl(c, txt)}" target="_blank" rel="noopener" data-act="wasent" data-id="${c.id}">Open in WhatsApp</a><button class="btn" data-act="copymsg">Copy message</button></div>
  <p class="hint">WhatsApp opens with this message for <span class="mono">${showPhone(c.phone)}</span>. Press Send there. The lead is marked as replied.</p></div>`;
}
const waUrl = (c, txt) => 'https://wa.me/' + c.phone.replace(/\D/g, '') + '?text=' + encodeURIComponent(txt);
function rejectDlg(c) {
  const team = prefs().team || [];
  return `<div class="scrim" data-act="close"></div><div class="dialog" role="dialog" aria-label="Reject lead"><div class="panel-head"><h2>Reject ${esc(c.name || showPhone(c.phone))}</h2><button class="btn sm" data-act="close">Close</button></div>
  <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px"><legend class="small muted" style="margin-bottom:6px">Why?</legend>${['Not my area', 'Already handled it', 'Lead is not serious', 'Too busy right now'].map((r, i) => `<label class="check"><input type="radio" name="rr" value="${r}" ${i === 0 ? 'checked' : ''}><span>${r}</span></label>`).join('')}</fieldset>
  <label class="f">What happens to the lead<select class="in" id="rRoute">${team.map((x) => `<option>Pass to ${esc(x)}</option>`).join('')}<option>AI follows up in 3 days</option><option>Archive the lead</option></select></label>
  <p class="hint">The lead was promised a reply. If you pass it to a teammate, share the lead with them${team.length ? '' : ' (add teammates in Preferences)'}.</p>
  <div class="row"><button class="btn danger" data-act="doreject" data-id="${c.id}">Reject and route</button></div></div>`;
}

/* ---------------- Messages (templates) ---------------- */
function vTemplates() {
  const tabs = [['opening', 'Call opening line'], ...SITS];
  const sample = { name: 'Sarah', phone: '+60123456789', lang: 'en', profile: { unit: '3-room' }, project_id: S.projects[0]?.id, promise_due: new Date(Date.now() + 30 * MIN).toISOString() };
  const noName = { ...sample, name: '' };
  return header('Messages', UI.tplSit === 'opening' ? 'The first thing the AI says when the lead picks up, in each language.' : 'WhatsApp replies used by hot lead alerts, picked by situation and the lead’s language.', '<button class="btn" data-act="addtpl">Add language version</button>') +
  `<div class="tabs">${tabs.map(([k, l]) => `<button class="${UI.tplSit === k ? 'on' : ''}" data-act="tplsit" data-s="${k}">${l}</button>`).join('')}</div>
  <div class="panel" style="gap:8px"><div class="row small"><span class="muted">Placeholders:</span>${['{name}', '{agent_name}', '{agency}', '{project}', '{unit_type}', '{viewing_slots}', '{price}', '{promo}', '{promise_time}'].map((x) => `<code class="chip mono">${x}</code>`).join('')}</div>
   <p class="small">Put optional parts in <b>[square brackets]</b>. They are left out when the lead has no name or no project. Example: <code class="mono">Hi[ {name}], I'm {agent_name}[, you were interested in {project}].</code></p></div>
  <div class="grid3">${S.templates.filter((x) => x.situation === UI.tplSit).sort((a, b) => LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang)).map((x) => `<div class="panel"><div class="panel-head"><h3>${LANG[x.lang]}</h3><button class="btn sm ghost danger" data-act="deltpl" data-id="${x.id}">Delete</button></div>
   <textarea class="in" rows="5" data-tpl="${x.id}" aria-label="Message text">${esc(x.body)}</textarea>
   <div><div class="small muted" style="margin-bottom:4px">With a name and project</div><div class="msgbox small">${esc(fillFor(x.body, { ...sample, lang: x.lang }))}</div></div>
   <div><div class="small muted" style="margin-bottom:4px">With no name or project</div><div class="msgbox small">${esc(fillFor(x.body, { ...noName, project_id: null, lang: x.lang }))}</div></div></div>`).join('') || '<div class="empty">No versions yet.</div>'}</div>`;
}

/* ---------------- Preferences ---------------- */
function vPrefs() {
  const P = prefs();
  return header('Preferences', 'Your profile, how the AI promises replies, and when calls are allowed.') +
  `<div class="grid2"><div class="panel"><h2>Your profile</h2>
   <label class="f">Your name<input class="in" data-me="name" value="${esc(S.me.name || '')}" placeholder="Jayden Wong"></label>
   <label class="f">Agency<input class="in" data-me="agency" value="${esc(S.me.agency || '')}" placeholder="Vista Realty"></label>
   <label class="f">Email for hot lead alerts (only you receive these)<input class="in" type="email" data-me="alert_email" value="${esc(S.me.alert_email || '')}"></label>
   <label class="f">Your mobile (for test calls)<input class="in mono" data-me="mobile" value="${esc(S.me.mobile || '')}" placeholder="012-345 6789"></label></div>
  <div class="panel"><h2>The promise to leads</h2>
   <div class="grid2"><label class="f">AI promises a reply within<select class="in" data-p="promise">${[15, 30, 60, 120].map((v) => `<option value="${v}" ${+P.promise === v ? 'selected' : ''}>${v < 60 ? v + ' minutes' : v / 60 + ' hour' + (v > 60 ? 's' : '')}</option>`).join('')}</select></label>
   <label class="f">Reminder email before deadline<select class="in" data-p="remind">${[5, 10, 15].map((v) => `<option value="${v}" ${+P.remind === v ? 'selected' : ''}>${v} minutes</option>`).join('')}</select></label></div>
   <label class="f">Viewing slots to offer ({viewing_slots})<input class="in" data-p="slots" value="${esc(P.slots)}" placeholder="Saturday 11am or 3pm"></label></div>
  <div class="panel"><h2>Calling hours</h2><div class="grid2"><label class="f">Start<select class="in" data-p="hours_start">${[8, 9, 10].map((h) => `<option value="${h}" ${+P.hours_start === h ? 'selected' : ''}>${h}:00 AM</option>`).join('')}</select></label><label class="f">End<select class="in" data-p="hours_end">${[19, 20, 21].map((h) => `<option value="${h}" ${+P.hours_end === h ? 'selected' : ''}>${h - 12}:00 PM</option>`).join('')}</select></label></div><p class="hint">Malaysia time. Campaigns pause outside these hours and continue the next day.</p></div>
  <div class="panel"><h2>Calling number</h2><p class="mono" style="font-size:18px">${esc(showPhone(normPhone(CFG.number)) || 'Not set up yet')}</p><p class="hint">All AI calls come from this fixed number.</p></div>
  <div class="panel"><h2>Do-not-call list</h2><textarea class="in mono" rows="5" id="dncBox" aria-label="Do-not-call numbers">${esc(S.dnc.map((x) => x.phone).join('\n'))}</textarea><div class="row"><button class="btn sm" data-act="savednc">Save list</button><span class="hint">Leads who ask not to be called are added automatically.</span></div></div>
  <div class="panel"><h2>Team</h2><p class="hint">Rejected leads can be passed to these teammates.</p><textarea class="in" rows="3" data-p="team" aria-label="Teammates">${esc((P.team || []).join('\n'))}</textarea></div></div>`;
}

/* ---------------- render + layers ---------------- */
const VIEWS = { overview: vOverview, voice: vVoice, projects: vProjects, campaign: vCampaign, history: vHistory, alerts: vAlerts, templates: vTemplates, preferences: vPrefs };
function render() { if (!S.me) return; renderNav(); $('#view').innerHTML = VIEWS[route()](); bindDrop(); }
let layer = null;
function openLayer(kind, id, extra) { layer = { kind, id, extra }; if (kind === 'compose') { UI.cSit = null; UI.cLang = null; UI.cText = null; } renderLayer(); }
function renderLayer() {
  const L = $('#layer'); if (!layer) { L.innerHTML = ''; return; }
  const c = S.calls.find((x) => x.id === layer.id);
  if (layer.kind === 'proj') { L.innerHTML = projDlg(proj(layer.id)); }
  else if (!c) { layer = null; L.innerHTML = ''; toast('That call is no longer on the board.'); return; }
  else L.innerHTML = layer.kind === 'drawer' ? drawer(c) : layer.kind === 'compose' ? composer(c, layer.extra) : rejectDlg(c);
  (L.querySelector('[autofocus]') || L.querySelector('button'))?.focus();
}
const closeLayer = () => { layer = null; renderLayer(); };
function projDlg(p) {
  const F = [['name', 'Project name'], ...FACTS.map(([l, k]) => [k, l])];
  return `<div class="scrim" data-act="close"></div><div class="dialog" role="dialog" aria-label="Edit project"><div class="panel-head"><h2>Edit facts</h2><button class="btn sm" data-act="close">Close</button></div>
  <div class="grid2">${F.map(([k, l]) => `<label class="f" ${k === 'extra' ? 'style="grid-column:1/-1"' : ''}>${l}${k === 'extra' ? `<textarea class="in" rows="4" data-pf="${k}">${esc(p[k])}</textarea>` : `<input class="in" data-pf="${k}" value="${esc(p[k])}">`}</label>`).join('')}</div>
  <div class="row"><button class="btn pri" data-act="saveproj" data-id="${p.id}">Save and mark as checked</button></div></div>`;
}
async function updCall(id, patch) { const c = S.calls.find((x) => x.id === id); Object.assign(c, patch); await q(sb.from('calls').update(patch).eq('id', id)); }

/* ---------------- events ---------------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id, c = id && S.calls.find((x) => x.id === id);
  try {
    switch (a) {
      case 'loginmode': renderLogin(el.dataset.m); break;
      case 'signout': await sb.auth.signOut(); break;
      case 'theme': { const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); r.dataset.theme = cur === 'dark' ? 'light' : 'dark'; break; }
      case 'refresh': await loadAll(); render(); toast('Up to date'); break;
      case 'close': closeLayer(); break;
      case 'open': openLayer('drawer', id); break;
      case 'compose': openLayer('compose', id, el.dataset.edit); break;
      case 'reject': openLayer('reject', id); break;
      case 'mail': UI.mailSel = id; location.hash = 'alerts'; break;
      case 'mailsel': UI.mailSel = id; render(); break;
      case 'copymsg': { const x = $('#cText').value; try { await navigator.clipboard.writeText(x); toast('Message copied'); } catch { $('#cText').select(); toast('Press Ctrl+C or ⌘C to copy'); } break; }
      case 'wasent': if (c.alert === 'pending' || c.col === 'hot') { await updCall(id, { alert: c.alert ? 'accepted' : null, replied_at: new Date().toISOString(), col: c.col === 'hot' ? 'follow' : c.col, next_step: 'WhatsApp sent. Waiting for the lead to reply.' }); closeLayer(); render(); toast(`${c.name || 'Lead'} moved to Follow up.`); } break;
      case 'doreject': {
        const r = document.querySelector('input[name=rr]:checked').value, rt = $('#rRoute').value;
        const col = rt.startsWith('Archive') ? 'done' : rt.startsWith('AI') ? 'follow' : 'others';
        await updCall(id, { alert: 'rejected', reject_reason: r, route: rt, col, next_step: rt });
        if (rt.startsWith('AI') && c.lead_id && c.campaign_id) {
          await q(sb.from('leads').update({ status: 'callback', next_attempt_at: new Date(Date.now() + 3 * DAY).toISOString() }).eq('id', c.lead_id));
          const camp = S.campaigns.find((x) => x.id === c.campaign_id);
          if (camp && camp.status === 'done') { await q(sb.from('campaigns').update({ status: 'running' }).eq('id', camp.id)); camp.status = 'running'; }
        }
        closeLayer(); render(); toast(`${c.name || 'Lead'}: ${rt}`); break;
      }
      case 'again': await api('/api/calls/start', { mode: 'again', call_id: id }); await loadCalls(); closeLayer(); render(); toast(`Calling ${c.name || showPhone(c.phone)} now`); break;
      case 'delcall': await q(sb.from('calls').delete().eq('id', id)); S.calls = S.calls.filter((x) => x.id !== id); closeLayer(); render(); toast('Call deleted'); break;
      case 'archive': await updCall(id, { archived: true }); S.calls = S.calls.filter((x) => x.id !== id); closeLayer(); render(); toast('Archived'); break;
      case 'vmode': { const voices = { ...(S.me.voices || {}) }; voices[el.dataset.l] = { ...(voices[el.dataset.l] || {}), mode: el.dataset.m }; await saveMe({ voices }); render(); break; }
      case 'rec': recToggle(el.dataset.l); break;
      case 'clone': {
        const l = el.dataset.l, s = UI.samples[l];
        if (!S.me.consent_at) return toast('Tick the consent box below first.');
        UI.busy['clone' + l] = true; render();
        try { const path = await upload('voice-samples', new File([s.blob], s.name, { type: s.blob.type }), l); const r = await api('/api/voice/clone', { lang: l, paths: [path], secs: s.secs, quality: s.quality }); S.me.voices = r.voices; delete UI.samples[l]; toast(`Your ${LANG[l]} voice is ready. Try a test call.`); }
        finally { UI.busy['clone' + l] = false; render(); }
        break;
      }
      case 'consent': await saveMe({ consent_at: el.checked ? new Date().toISOString() : null }); render(); break;
      case 'testcall': { if (!S.me.mobile) { location.hash = 'preferences'; return toast('Add your mobile number first.'); } await api('/api/calls/start', { mode: 'test', lang: $('#testLang')?.value || 'en', project_id: $('#testProj')?.value || null }); toast(`Calling ${S.me.mobile} now. Pick up to hear your agent.`); break; }
      case 'delvoice': { const r = await api('/api/voice/clone', null, 'DELETE'); S.me.voices = r.voices; S.me.consent_at = null; UI.samples = {}; render(); toast('Your voice clones and recordings were deleted.'); break; }
      case 'projok': await q(sb.from('projects').update({ status: 'checked' }).eq('id', id)); proj(id).status = 'checked'; render(); break;
      case 'editproj': openLayer('proj', id); break;
      case 'reread': readProject(id); break;
      case 'delproj': { const p = proj(id); if (p.docs?.length) await sb.storage.from('sales-kits').remove(p.docs.map((d) => d.path)); await q(sb.from('projects').delete().eq('id', id)); S.projects = S.projects.filter((x) => x.id !== id); render(); toast('Project deleted'); break; }
      case 'saveproj': { const patch = { status: 'checked' }; document.querySelectorAll('[data-pf]').forEach((i) => (patch[i.dataset.pf] = i.value)); await q(sb.from('projects').update(patch).eq('id', id)); Object.assign(proj(id), patch); closeLayer(); render(); toast('Saved'); break; }
      case 'tab': UI.tab = el.dataset.t; render(); break;
      case 'process': { const d = draft(); d.paste = $('#pasteBox').value; const rows = parsePaste(d.paste); d.rows = d.rows.concat(rows); d.paste = ''; d.checked = false; saveDraft(); render(); toast(`${rows.length} leads added to the list`); break; }
      case 'filter': UI.filter = el.dataset.f; render(); break;
      case 'rmbad': { const d = draft(), V = validate(d.rows); d.rows = d.rows.filter((r) => V[r.id].level !== 'bad'); saveDraft(); render(); break; }
      case 'rmdupe': { const d = draft(), s = new Set(); d.rows = d.rows.filter((r) => { if (!r.phone) return true; if (s.has(r.phone)) return false; s.add(r.phone); return true; }); saveDraft(); render(); break; }
      case 'addrow': draft().rows.unshift(mkRow('', '', { lang: 'en', source: 'manual' })); saveDraft(); render(); break;
      case 'rmrow': { const d = draft(); d.rows = d.rows.filter((r) => r.id !== id); UI.sel.delete(id); saveDraft(); render(); break; }
      case 'sel': el.checked ? UI.sel.add(id) : UI.sel.delete(id); render(); break;
      case 'selall': { const d = draft(), V = validate(d.rows); d.rows.filter((r) => UI.filter === 'all' || (UI.filter === 'ready' ? V[r.id].ready : !V[r.id].ready || V[r.id].iss.length)).forEach((r) => (el.checked ? UI.sel.add(r.id) : UI.sel.delete(r.id))); render(); break; }
      case 'bulklang': draft().rows.forEach((r) => { if (UI.sel.has(r.id)) { r.lang = el.dataset.l; r.guessed = false; } }); saveDraft(); render(); break;
      case 'bulkdel': { const d = draft(); d.rows = d.rows.filter((r) => !UI.sel.has(r.id)); UI.sel.clear(); saveDraft(); render(); break; }
      case 'resetdraft': D = newDraft(); UI.sel.clear(); UI.mapRows = null; saveDraft(); render(); break;
      case 'copyhdr': try { await navigator.clipboard.writeText('Name,Phone,Language,Project,Budget,Remarks'); toast('Header copied. Paste it into the first row of Excel.'); } catch { toast('Name, Phone, Language, Project, Budget, Remarks'); } break;
      case 'usemap': {
        const m = UI.map, col = (k) => m.indexOf(k);
        const rows = UI.mapRows.map((r) => {
          const extra = m.map((k, i) => (k === 'ignore' && r[i] && UI.mapHeader ? `${UI.mapHeader[i]}: ${r[i]}` : '')).filter(Boolean);
          const lv = String(r[col('lang')] ?? '').toLowerCase();
          const lang = /zh|chinese|中|mandarin|cantonese/.test(lv) ? 'zh' : /ms|malay|bm|melayu/.test(lv) ? 'ms' : /en/.test(lv) ? 'en' : undefined;
          return mkRow(r[col('name')] ?? '', r[col('phone')] ?? '', { lang, source: 'file', notes: [col('budget') >= 0 && r[col('budget')] ? 'Budget ' + r[col('budget')] : '', col('notes') >= 0 ? r[col('notes')] : '', ...extra].filter(Boolean).join(' · ') });
        });
        if (UI.mapHeader) try { localStorage.setItem('sembang-map:' + UI.mapHeader.join('|').toLowerCase(), JSON.stringify(m)); } catch {}
        const d = draft(); d.rows = d.rows.concat(rows); d.checked = false; UI.mapRows = null; saveDraft(); render(); toast(`${rows.length} leads added`); break;
      }
      case 'cancelmap': UI.mapRows = null; render(); break;
      case 'queue': {
        const d = draft(), V = validate(d.rows), rows = d.rows.filter((r) => V[r.id].ready);
        if (!d.checked) return toast('Tick “I have checked this list” first.');
        if (!rows.length) return toast('No ready leads to call.');
        UI.busy.queue = true; render();
        try {
          const r = await api('/api/campaigns/queue', { name: d.name, tag: d.tag, project_id: d.project_id || null, start_at: new Date(d.start).toISOString(), gap_min: d.gap, attempts: d.attempts, retry_min: d.retry, max_len_min: d.maxLen, skip_reached: d.skip, rows: rows.map(({ name, phone, lang, notes, source }) => ({ name, phone, lang, notes, source })) });
          D = newDraft(); UI.sel.clear(); saveDraft();
          S.campaigns.unshift(r.campaign); await loadProgress();
          const sk = Object.values(r.skipped).reduce((x, y) => x + y, 0);
          toast(`Campaign queued: ${r.queued} leads${sk ? `, ${sk} skipped` : ''}.`);
        } finally { UI.busy.queue = false; render(); }
        break;
      }
      case 'camp': { await q(sb.from('campaigns').update({ status: el.dataset.s }).eq('id', id)); S.campaigns.find((x) => x.id === id).status = el.dataset.s; render(); break; }
      case 'tplsit': UI.tplSit = el.dataset.s; render(); break;
      case 'deltpl': await q(sb.from('templates').delete().eq('id', id)); S.templates = S.templates.filter((x) => x.id !== id); render(); break;
      case 'addtpl': {
        const have = S.templates.filter((x) => x.situation === UI.tplSit).map((x) => x.lang), l = LANGS.find((x) => !have.includes(x));
        if (!l) return toast('All three languages already exist here.');
        const row = await q(sb.from('templates').insert({ situation: UI.tplSit, lang: l, body: 'Hi[ {name}], ' }).select().single());
        S.templates.push(row); render(); break;
      }
      case 'savednc': {
        const want = [...new Set($('#dncBox').value.split(/[\s,]+/).map(normPhone).filter((p) => isMobile(p) || isLand(p)))];
        const have = S.dnc.map((x) => x.phone);
        const del = have.filter((p) => !want.includes(p)), add = want.filter((p) => !have.includes(p));
        if (del.length) await q(sb.from('dnc').delete().in('phone', del));
        if (add.length) await q(sb.from('dnc').insert(add.map((phone) => ({ phone, reason: 'Added by you' }))));
        S.dnc = await q(sb.from('dnc').select('*')); render(); toast('Do-not-call list saved'); break;
      }
    }
  } catch (err) { fail(err); }
});

document.addEventListener('change', async (e) => {
  const x = e.target;
  try {
    if (x.dataset.me) { await saveMe({ [x.dataset.me]: x.value.trim() || null }); renderNav(); toast('Saved'); return; }
    if (x.dataset.p) { const P = prefs(); let v = x.value; if (['promise', 'remind', 'hours_start', 'hours_end'].includes(x.dataset.p)) v = +v; if (x.dataset.p === 'team') v = x.value.split('\n').map((s) => s.trim()).filter(Boolean); await saveMe({ prefs: { ...P, [x.dataset.p]: v } }); toast('Saved'); return; }
    if (x.dataset.d) { const d = draft(); let v = x.type === 'checkbox' ? x.checked : x.value; if (['gap', 'attempts', 'retry', 'maxLen'].includes(x.dataset.d)) v = +v; d[x.dataset.d] = v; saveDraft(); render(); return; }
    if (x.dataset.row) { const r = draft().rows.find((y) => y.id === x.dataset.row); if (!r) return; r[x.dataset.k] = x.dataset.k === 'phone' ? normPhone(x.value) : x.value; if (x.dataset.k === 'lang') r.guessed = false; if (x.dataset.k === 'name' && r.guessed) r.lang = guessLang(x.value); saveDraft(); render(); return; }
    if (x.dataset.map) { UI.map[+x.dataset.map] = x.value; render(); return; }
    if (x.dataset.move) { await updCall(x.dataset.move, { col: x.value }); render(); renderLayer(); return; }
    if (x.dataset.viewing) { await updCall(x.dataset.viewing, { viewing: x.checked }); render(); return; }
    if (x.dataset.tpl) { const tp = S.templates.find((y) => y.id === x.dataset.tpl); tp.body = x.value; await q(sb.from('templates').update({ body: x.value }).eq('id', tp.id)); render(); toast('Saved'); return; }
    if (x.id === 'histCamp') { UI.histCamp = x.value; render(); return; }
    if (x.id === 'cSit' || x.id === 'cLang') { UI.cSit = $('#cSit').value; UI.cLang = $('#cLang').value; UI.cText = null; renderLayer(); return; }
    if (x.dataset.up) { const f = x.files[0]; if (f) takeSample(x.dataset.up, f, f.name); return; }
    if (x.hasAttribute('data-sheet')) { const f = x.files[0]; if (f) readSheet(f); return; }
    if (x.hasAttribute('data-photo')) {
      const f = x.files[0]; if (!f) return;
      UI.busy.photo = true; render();
      try { const path = await upload('lead-photos', f); const r = await api('/api/leads/photo', { path }); const d = draft(); const rows = r.leads.map((l) => mkRow(l.name, l.phone, { notes: l.notes, source: 'photo' })); d.rows = d.rows.concat(rows); d.checked = false; saveDraft(); toast(rows.length ? `${rows.length} leads read from the photo. Please check them.` : 'No phone numbers found in that photo.'); }
      finally { UI.busy.photo = false; render(); }
      return;
    }
    if (x.hasAttribute('data-newproj')) {
      const files = [...x.files]; if (!files.length) return;
      const p = await q(sb.from('projects').insert({ name: files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') }).select().single());
      S.projects.push(p); render(); await addDocs(p.id, files); return;
    }
    if (x.dataset.adddoc) { const f = [...x.files]; if (f.length) await addDocs(x.dataset.adddoc, f); return; }
  } catch (err) { fail(err); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'histQ') { UI.histQ = e.target.value; const pos = e.target.selectionStart; render(); const h = $('#histQ'); h.focus(); h.setSelectionRange(pos, pos); }
  if (e.target.id === 'cText') { UI.cText = e.target.value; const c = S.calls.find((x) => x.id === layer.id); $('#waLink').href = waUrl(c, UI.cText); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && layer) closeLayer(); });
document.addEventListener('dragstart', (e) => { const c = e.target.closest?.('[data-drag]'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.drag); e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragover', (e) => { const col = e.target.closest?.('[data-col]'); if (col) { e.preventDefault(); col.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const col = e.target.closest?.('[data-col]'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); });
document.addEventListener('drop', async (e) => { const col = e.target.closest?.('[data-col]'); if (!col) return; e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (S.calls.find((x) => x.id === id)) { try { await updCall(id, { col: col.dataset.col }); } catch (err) { fail(err); } render(); } });
function bindDrop() {
  const z = $('#dropzone'); if (!z) return;
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readSheet(f); });
}
window.addEventListener('hashchange', () => { closeLayer(); render(); scrollTo(0, 0); });
setInterval(() => { if (['overview', 'alerts', 'history'].includes(route()) && !layer && !document.activeElement?.matches('input,textarea,select')) render(); }, 30000);
boot().catch(fail);
