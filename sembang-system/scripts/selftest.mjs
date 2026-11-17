// Quick checks of the pure logic (no network). Run: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fill, normPhone, isMobile, isLand, guessLang, templateValues } from '../public/shared.js';
import { intoHours, myHour } from '../api/_lib/time.js';

assert.equal(normPhone('012-345 6789'), '+60123456789');
assert.equal(normPhone('60123456789'), '+60123456789');
assert.equal(normPhone('+60 11-2345 6789'), '+601123456789');
assert.ok(isMobile('+601123456789'));
assert.ok(isLand(normPhone('03-2788 1234')));
assert.ok(!isMobile(normPhone('012-34')));
assert.equal(guessLang('尤泽新'), 'zh');
assert.equal(guessLang('Ahmad Faizal bin Hassan'), 'ms');
assert.equal(guessLang('Sarah Lim'), 'en');

const t = "Hi[ {name}], I'm calling for {agent_name}[. You were interested in {project}]. Is now a good time?";
assert.equal(fill(t, { name: 'Sarah', agent_name: 'Jayden', project: 'Residensi Awan' }), "Hi Sarah, I'm calling for Jayden. You were interested in Residensi Awan. Is now a good time?");
assert.equal(fill(t, { agent_name: 'Jayden' }), "Hi, I'm calling for Jayden. Is now a good time?");
assert.equal(fill('[{name}]你好，我是{agent_name}的助理[，你之前对{project}有兴趣]。', { agent_name: 'Jayden' }), '你好，我是Jayden的助理。');
const v = templateValues({ lead: { name: 'Jackson', profile: { unit: '3-room' } }, project: { name: 'Awan', price: 'RM 498k – RM 880k', promotion: 'Free legal fees' }, agent: { name: 'Jayden Wong', agency: 'Vista', prefs: { slots: 'Sat 11am' } } });
assert.equal(v.price, 'RM 498k'); assert.equal(v.agent_name, 'Jayden'); assert.equal(v.promo, 'free legal fees');

// calling hours (Malaysia time = UTC+8)
const at = (h) => new Date(Date.UTC(2026, 10, 17, h - 8, 30));
assert.equal(intoHours(at(10)).getTime(), at(10).getTime());
assert.equal(myHour(intoHours(at(22))), 9);
assert.equal(intoHours(at(22)).getUTCDate(), 18);
assert.equal(myHour(intoHours(at(6))), 9);

// webhook signature
process.env.ELEVENLABS_WEBHOOK_SECRET = 'wsec_test';
const { verifyWebhook } = await import('../api/_lib/eleven.js');
const body = '{"type":"post_call_transcription"}', ts = Math.floor(Date.now() / 1000);
const sig = `t=${ts},v0=` + crypto.createHmac('sha256', 'wsec_test').update(`${ts}.${body}`).digest('hex');
assert.ok(verifyWebhook(body, sig));
assert.ok(!verifyWebhook(body + 'x', sig));

// signed email links
process.env.LINK_SECRET = 'x'; process.env.APP_URL = 'https://app.test';
const { alertLink, checkLink } = await import('../api/_lib/links.js');
const q = Object.fromEntries(new URL(alertLink('abc', 'accept')).searchParams);
assert.ok(checkLink(q)); assert.ok(!checkLink({ ...q, a: 'reject' }));

console.log('All checks passed.');
