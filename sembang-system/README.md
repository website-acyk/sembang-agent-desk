# Sembang Agent Desk

An AI calling desk for property agents. Agents upload leads, the AI calls them from one fixed Malaysian number in the agent's own voice (or an AI voice), and hot leads trigger a Gmail alert to the agent with a ready-made WhatsApp reply.

## What it does

| Area | How it works |
|---|---|
| Fixed +60 number | A SIP trunk from a Malaysian provider, connected to ElevenLabs. Every call shows this number. |
| Own voice / AI voice | Agents record a paragraph in English, 中文 and BM in **Voice Studio**. ElevenLabs makes a voice clone per language. Any language can use the AI voice instead. |
| The conversation | An ElevenLabs agent follows instructions built for every call: the agent's name, the lead's notes, the project's facts, and the hot-lead rules. |
| Opening line | Editable per language in **Messages → Call opening line**, with placeholders like `{name}` and `{project}`. Text in `[brackets]` is dropped when the value is missing. |
| PDF auto-fill | Upload up to 3 sales-kit files per project. Claude reads them and fills the fact card. No typing needed; the agent just clicks **Looks right**. |
| Lead upload | Paste text, Excel/CSV (columns are matched automatically and remembered), or a photo of a list or business card (read by Claude). The review list flags invalid, duplicate, do-not-call and recently-called numbers. |
| Database | Supabase Postgres stores every agent, project, campaign, lead and call. Each agent sees only their own data. |
| Call results | ElevenLabs sends the **transcript** and analysis (budget, unit type, loan, score, key quote…) to a webhook. **No audio is recorded or stored.** |
| Hot lead alerts | Gmail email to the **agent only**, with **Accept & send** (opens WhatsApp with the message filled in), **Edit message first** and **Reject**. A reminder email goes out before the promised reply time. |
| Scheduling | A dispatcher runs every minute: calls only within calling hours (Malaysia time), keeps the gap between calls, retries no-answers, never calls voicemail again, and calls back at times the lead asked for. |

## Accounts you need

| Service | What for | Notes |
|---|---|---|
| **SIP provider (Malaysia)** | The fixed +60 number | You need a +60 DID number with **outbound calling** and **SIP trunk** credentials (server address, username, password). Providers to ask: [DIDWW](https://news.didww.com/2024/05/02/two-way-voice-services-with-local-call-termination-in-malaysia-60-now-at-didww/), [AlienVoIP](https://alienvoip.com/siptrunk.php), [Telnyx](https://support.telnyx.com/en/articles/3739509-malaysia-did-requirements), [AVOXI](https://www.avoxi.com/malaysia-sip-trunk/). Confirm with them that the +60 number is shown as caller ID on calls to Malaysian mobiles. Twilio states that verified Malaysian caller IDs are not supported for calls into Malaysia ([Twilio guidelines](https://www.twilio.com/en-us/guidelines/my/voice)). |
| **ElevenLabs** | Voice cloning, AI voice, the conversation, outbound calls | A paid plan that includes voice cloning and Agents. Billed per call minute. |
| **Supabase** | Database, logins, file storage | The free tier is enough to start. |
| **Vercel** | Hosts the web app and server | The free tier works. The app uses 9 server functions (Hobby limit is 12). |
| **Anthropic (Claude API)** | Reads PDFs and lead photos | Pay per use. |
| **Gmail** | Sends alerts | Use a separate Gmail such as `yourcompany.alerts@gmail.com` with 2-step verification and an **App password**. |

## Setup, step by step

### 1. Supabase
1. Create a project at supabase.com (region: Singapore).
2. **SQL Editor** → paste all of `supabase/schema.sql` → **Run**.
3. **Database → Extensions**: enable **pg_cron** and **pg_net**.
4. **Project Settings → API**: copy the URL, the `anon` key and the `service_role` key.
5. **Authentication → URL Configuration**: set the Site URL to your Vercel address (after step 3).

### 2. Your SIP number
Get from your provider: the number in +60 format, the SIP server address, username and password.

### 3. Deploy to Vercel
1. Put this folder in a GitHub repository (or use `vercel deploy` from the folder).
2. In Vercel, **Add New → Project** → import it. No build settings are needed.
3. **Settings → Environment Variables**: add everything from `.env.example`. Leave the three ElevenLabs IDs empty for now.
4. Deploy, then set `APP_URL` to the address Vercel gives you and redeploy.

### 4. ElevenLabs
1. Create an API key (**Developers → API keys**).
2. On your computer, in this folder: copy `.env.example` to `.env`, fill in the ElevenLabs key, SIP details, `APP_URL` and `DEFAULT_AI_VOICE_ID`, then run:
   ```
   npm install
   node --env-file=.env scripts/setup-elevenlabs.mjs
   ```
   This imports your SIP number, creates the call-results webhook and creates the calling agent. It prints `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_ID` and `ELEVENLABS_WEBHOOK_SECRET`.
3. Add those four values to Vercel and redeploy.
4. Finish the checklist the script prints (in the ElevenLabs dashboard, agent **Sembang caller**): turn on **End call**, **Detect language** and **Voicemail detection**; add **Chinese** and **Malay** as languages; set the maximum duration to 180 seconds; keep audio webhooks **off**.
5. Pick AI voices in the Voice Library and list them in `AI_VOICES` (`id|label;id|label`).

### 5. Gmail
1. Sign in to the alerts Gmail → **Google Account → Security** → turn on 2-Step Verification → **App passwords** → create one.
2. Put the address in `GMAIL_USER` and the 16-character password in `GMAIL_APP_PASSWORD`.

### 6. Start the every-minute dispatcher
In Supabase **SQL Editor**, run the `cron.schedule(...)` block at the bottom of `schema.sql`, with your Vercel address and `CRON_SECRET` filled in.

### 7. First test
1. Open your Vercel address → **Create account**.
2. **Preferences**: your name, agency, alert email and mobile.
3. **Projects**: upload a sales kit PDF. The facts fill in. Click **Looks right**.
4. **Voice Studio**: tick consent, record English, click **Make my voice**, then **Test call me**.
5. **New campaign**: paste 2–3 colleagues' numbers, tick the check box, queue it with a start time a few minutes away.
6. On a test call, ask for a viewing. Within a minute of hanging up you should get the Gmail alert. Click **Accept & send** and WhatsApp opens with the message.

## Check on the first real calls
These parts follow the ElevenLabs documentation, but confirm them during the first tests:
- **Webhook signature**: the app expects `ElevenLabs-Signature: t=…,v0=…` (HMAC-SHA256 of `timestamp.body`). If every result returns 401 in Vercel logs, check this in `api/_lib/eleven.js`.
- **Malay and Chinese**: the voice model supports both; confirm the agent accepts `ms` and `zh` as languages.
- **Caller ID**: confirm leads see your +60 number.
- **Voice quality**: instant clones work best with 30–60 seconds of clear speech. Agents can record again at any time.

## Honesty and PDPA
- The AI introduces itself as calling *for* the agent and answers truthfully if asked whether it is an AI. Keep this in the prompt (`api/_lib/prompt.js`).
- Voice clones are made only after the agent ticks consent, and can be deleted any time (clones and recordings).
- Leads who say "don't call me again" go to the do-not-call list automatically.
- Only transcripts are stored, no audio. Lead data is personal data under the PDPA. Keep the Supabase project private, and delete old leads you no longer need.

## Files
```
public/            Web app (index.html, app.js, styles.css, shared.js)
api/config.js      Public settings for the browser
api/projects/extract.js   PDF auto-fill (Claude)
api/leads/photo.js        Leads from a photo (Claude)
api/voice/clone.js        Make / delete voice clones (ElevenLabs)
api/campaigns/queue.js    Save a reviewed lead list as a campaign
api/calls/start.js        Test call me / AI calls again
api/cron/dispatch.js      Every-minute dialer and reminder emails
api/webhooks/elevenlabs.js  Call results -> board columns, hot lead emails
api/alert-link.js         Accept / Reject buttons in emails
api/_lib/                 Shared server code
supabase/schema.sql       Database, security rules, storage, cron
scripts/setup-elevenlabs.mjs  One-time ElevenLabs setup
scripts/selftest.mjs      Logic checks (npm test)
```
