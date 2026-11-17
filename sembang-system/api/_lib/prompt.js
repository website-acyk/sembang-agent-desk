import { LANG, fill, templateValues } from '../../public/shared.js';

const FACTS = [['Developer','developer'],['Location','location'],['Price','price'],['Sizes and rooms','sizes'],['Tenure','tenure'],['Completion','completion'],['Facilities','facilities'],['Promotion','promotion'],['Other details','extra']];

/** The instructions the AI follows on one call. */
export function buildPrompt({ agent, lead, project, maxMin = 1 }) {
  const first = (agent.name || 'the agent').split(' ')[0];
  const promise = agent.prefs?.promise || 30;
  const facts = project
    ? `${project.name}\n` + FACTS.filter(([, k]) => project[k]).map(([l, k]) => `- ${l}: ${project[k]}`).join('\n')
    : 'No project selected. Ask what kind of property they are looking for and in which area.';
  return `You are a phone assistant calling on behalf of ${agent.name || first}, a property agent at ${agent.agency || 'a property agency'} in Malaysia.
You are calling ${lead.name || 'a lead'} who enquired about property.

LANGUAGE
- Start in ${LANG[lead.lang] || 'English'}. Malaysians often mix English, Malay and Chinese. If the person switches language, switch with them.
- Speak naturally and briefly: one or two short sentences per turn. Ask one question at a time.

HONESTY
- You are an AI assistant for ${first}. If asked whether you are a real person or a robot, say truthfully that you are ${first}'s AI assistant and that ${first} will follow up personally.
- Only use the project facts below. Never invent prices, units, dates or promotions. If you don't know, say ${first} will confirm on WhatsApp.

GOAL
- Find out if they are still interested, then learn: budget, unit type or rooms, own stay or investment, timeline, and loan status.
- The call should take about ${maxMin} minute${maxMin > 1 ? 's' : ''}. Wrap up politely when you have what you need.

HOT LEAD
- If they want a viewing, want to negotiate price, ask for a floor plan or brochure, or ask about loans, say: "Sure! ${first} will WhatsApp you within ${promise} minutes with the details." Confirm this number is on WhatsApp, thank them and end the call.
- Do not book a specific viewing time yourself. ${first} will arrange it.

OTHER CASES
- Busy: ask when is a better time to call back, repeat the time to confirm, then end the call.
- Not interested: thank them and end the call politely.
- Asks not to be called again: apologise, confirm they will not be called again, end the call.
- Wrong person: apologise and end the call.
- Never pressure anyone.

NOTES ABOUT THIS LEAD
${lead.notes || 'None.'}

PROJECT FACTS
${facts}`;
}

/** First sentence of the call, from the agent's own "opening" template. */
export function buildOpening({ agent, lead, project, templates }) {
  const t = templates.find((x) => x.situation === 'opening' && x.lang === lead.lang)
    || templates.find((x) => x.situation === 'opening' && x.lang === 'en');
  const body = t?.body || 'Hi[ {name}], I\'m calling for {agent_name}[ about {project}]. Is now a good time?';
  return fill(body, templateValues({ lead, project, agent }));
}

/** Which voice to use: the agent's own clone for this language if chosen, otherwise the AI voice. */
export function pickVoice(agent, lang) {
  const v = agent.voices?.[lang];
  if (v?.mode === 'own' && v.voice_id && agent.consent_at) return v.voice_id;
  return agent.ai_voice_id || process.env.DEFAULT_AI_VOICE_ID;
}
