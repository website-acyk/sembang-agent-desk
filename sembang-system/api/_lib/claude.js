import Anthropic from '@anthropic-ai/sdk';
import { need } from './db.js';

const model = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
let client;
const ai = () => (client ||= new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') }));

function block(file) {
  const data = Buffer.from(file.bytes).toString('base64');
  if (file.type === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const mt = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mt, data } };
}
function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Could not read the AI response');
  return JSON.parse(text.slice(s, e + 1));
}
async function ask(files, instruction, maxTokens = 2000) {
  const msg = await ai().messages.create({
    model: model(), max_tokens: maxTokens,
    messages: [{ role: 'user', content: [...files.map(block), { type: 'text', text: instruction }] }],
  });
  return parseJson(msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
}

/** Read sales-kit PDFs/images and return the project fact card. */
export function extractProject(files) {
  return ask(files, `These are sales-kit documents for one Malaysian property project. Fill in the fact card that a phone assistant will quote to buyers.
Return ONLY a JSON object with these string keys:
"name" (project name), "developer", "location" (area and city), "price" (price range, e.g. "RM 498k – RM 880k"),
"sizes" (built-up range and room types), "tenure" (Freehold / Leasehold N years), "completion" (expected completion),
"facilities" (main facilities and transport links, one line), "promotion" (current promotions or rebates, one line),
"extra" (up to 6 short lines of other useful facts: unit types with sizes and prices, maintenance fee, car parks, density).
Copy numbers exactly as written. Use "" for anything the documents do not state. Do not guess.`);
}

/** Read a photo of a lead list, whiteboard or business card. */
export async function extractLeads(files) {
  const r = await ask(files, `This photo contains contact details of property leads in Malaysia (a list, a whiteboard, a form or a business card).
Return ONLY a JSON object: {"leads":[{"name":"...","phone":"...","notes":"..."}]}.
Copy phone numbers digit by digit exactly as written. "notes" holds anything else written next to the person (budget, unit type, remarks), or "".
Skip entries with no phone number. If nothing is readable return {"leads":[]}.`, 4000);
  return Array.isArray(r.leads) ? r.leads : [];
}
