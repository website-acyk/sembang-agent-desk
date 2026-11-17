-- Sembang Agent Desk: database schema for Supabase (Postgres)
-- Run this whole file once in Supabase > SQL Editor.
-- Calls keep the TRANSCRIPT only. No call audio is stored anywhere.

create extension if not exists pgcrypto;

-- ---------- Agents (one row per login) ----------
create table if not exists public.agents (
  id uuid primary key references auth.users on delete cascade,
  name text,
  agency text,
  alert_email text,                 -- hot lead alerts are emailed here (agent only)
  mobile text,                      -- for "Test call me"
  ai_voice_id text,                 -- voice used when a language is set to "AI voice"
  voices jsonb not null default '{"en":{"mode":"ai"},"zh":{"mode":"ai"},"ms":{"mode":"ai"}}',
  consent_at timestamptz,           -- consent to use their own voice for their own calls
  prefs jsonb not null default '{"promise":30,"remind":10,"hours_start":9,"hours_end":21,"slots":"Saturday 11am or 3pm","team":[]}',
  created_at timestamptz not null default now()
);

-- ---------- Projects (sales kits, auto-filled from PDF) ----------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.agents on delete cascade,
  name text not null default 'New project',
  developer text, location text, price text, sizes text, tenure text,
  completion text, facilities text, promotion text, extra text,
  docs jsonb not null default '[]',          -- [{path, name}] in storage bucket "sales-kits"
  status text not null default 'empty' check (status in ('empty','reading','needs_check','checked','error')),
  error text,
  created_at timestamptz not null default now()
);

-- ---------- Do-not-call list ----------
create table if not exists public.dnc (
  owner_id uuid not null default auth.uid() references public.agents on delete cascade,
  phone text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (owner_id, phone)
);

-- ---------- Campaigns ----------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.agents on delete cascade,
  project_id uuid references public.projects on delete set null,
  name text not null,
  tag text,
  status text not null default 'queued' check (status in ('queued','running','paused','done','cancelled')),
  start_at timestamptz not null default now(),
  gap_min int not null default 2,
  attempts int not null default 2,
  retry_min int not null default 120,
  max_len_min int not null default 1,
  next_call_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- Leads (every uploaded lead is kept here) ----------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.agents on delete cascade,
  campaign_id uuid references public.campaigns on delete cascade,
  name text,
  phone text not null,
  lang text not null default 'en' check (lang in ('en','zh','ms')),
  notes text,
  source text,                     -- paste | file | photo | manual
  status text not null default 'pending' check (status in ('pending','calling','retry','callback','done','skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_result text,
  created_at timestamptz not null default now()
);
create index if not exists leads_due on public.leads (campaign_id, status, next_attempt_at);
create index if not exists leads_phone on public.leads (owner_id, phone);

-- ---------- Calls (transcript + AI analysis, no audio) ----------
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.agents on delete cascade,
  lead_id uuid references public.leads on delete set null,
  campaign_id uuid references public.campaigns on delete set null,
  project_id uuid references public.projects on delete set null,
  conversation_id text unique,
  kind text not null default 'campaign' check (kind in ('campaign','test','again','callback')),
  name text, phone text not null, lang text not null default 'en',
  status text not null default 'dialing' check (status in ('dialing','answered','no_answer','busy','failed','voicemail')),
  col text not null default 'noanswer' check (col in ('noanswer','hot','follow','others','done')),
  score int, interest text, situation text,
  summary text, quote text, objections text, next_step text,
  profile jsonb,                   -- {budget, unit, purpose, timeline, loan}
  transcript jsonb not null default '[]',   -- [[ "ai"|"lead", text ]]
  duration_s int,
  alert text check (alert in ('pending','accepted','rejected')),
  alert_sent_at timestamptz, promise_due timestamptz, reminded_at timestamptz, replied_at timestamptz,
  reject_reason text, route text,
  viewing boolean not null default false,
  archived boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists calls_owner on public.calls (owner_id, started_at desc);
create index if not exists calls_alerts on public.calls (col, alert, promise_due);

-- ---------- Message templates ----------
-- situation 'opening' = first thing the AI says on a call; others = WhatsApp replies.
-- Placeholders: {name} {agent_name} {agency} {project} {unit_type} {viewing_slots} {price} {promo} {promise_time}
-- Text inside [square brackets] is dropped when a placeholder in it has no value.
create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.agents on delete cascade,
  situation text not null check (situation in ('opening','viewing','price','brochure','busy')),
  lang text not null check (lang in ('en','zh','ms')),
  body text not null,
  unique (owner_id, situation, lang)
);

-- ---------- Row level security: each agent sees only their own data ----------
alter table public.agents enable row level security;
alter table public.projects enable row level security;
alter table public.dnc enable row level security;
alter table public.campaigns enable row level security;
alter table public.leads enable row level security;
alter table public.calls enable row level security;
alter table public.templates enable row level security;

drop policy if exists own on public.agents;
create policy own on public.agents for all using (id = auth.uid()) with check (id = auth.uid());
do $$ declare t text; begin
  foreach t in array array['projects','dnc','campaigns','leads','calls','templates'] loop
    execute format('drop policy if exists own on public.%I', t);
    execute format('create policy own on public.%I for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- New login -> agent profile + default templates ----------
create or replace function public.handle_new_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.agents (id, alert_email) values (new.id, new.email) on conflict do nothing;
  insert into public.templates (owner_id, situation, lang, body) values
   (new.id,'opening','en','Hi[ {name}], I''m calling for {agent_name} from {agency}[. You were interested in {project}]. Is now a good time?'),
   (new.id,'opening','zh','[{name}]你好，我是{agency} {agent_name}的助理[，你之前对{project}有兴趣]。现在方便聊一下吗？'),
   (new.id,'opening','ms','Hai[ {name}], saya menghubungi bagi pihak {agent_name} dari {agency}[. Anda berminat dengan {project}]. Boleh cakap sekejap?'),
   (new.id,'viewing','en','Hi[ {name}], this is {agent_name} from {agency}. Thanks for your interest[ in {project}]. Here''s the[ {unit_type}] floor plan. Would {viewing_slots} work for a viewing?'),
   (new.id,'viewing','zh','[{name}]你好，我是{agency}的{agent_name}。谢谢你[对{project}]的兴趣。这是[{unit_type}的]平面图。{viewing_slots}，哪个时间方便来看房呢？'),
   (new.id,'viewing','ms','Hai[ {name}], saya {agent_name} dari {agency}. Terima kasih atas minat anda[ terhadap {project}]. Ini pelan lantai[ {unit_type}]. Adakah {viewing_slots} sesuai untuk lawatan?'),
   (new.id,'price','en','Hi[ {name}], {agent_name} here from {agency}.[ About pricing for {project}: units start from {price}][, and right now there is {promo}]. Can I call you for 5 minutes to go through the best option for your budget?'),
   (new.id,'price','zh','[{name}]你好，我是{agency}的{agent_name}。[关于{project}的价钱：目前售价{price}][，现在还有{promo}]。方便我打给你5分钟，帮你看看最适合你预算的配套吗？'),
   (new.id,'price','ms','Hai[ {name}], saya {agent_name} dari {agency}.[ Harga {project} bermula {price}][, dan sekarang ada {promo}]. Boleh saya telefon 5 minit untuk bincang pilihan terbaik ikut bajet anda?'),
   (new.id,'brochure','en','Hi[ {name}], {agent_name} here. As promised, here is the[ {project}] brochure[ and {unit_type} floor plan]. Let me know if you would like to see the show unit.'),
   (new.id,'brochure','zh','[{name}]你好，我是{agent_name}。这是答应给你的[{project}]简介[和{unit_type}平面图]。如果想看样板屋，随时告诉我。'),
   (new.id,'brochure','ms','Hai[ {name}], saya {agent_name}. Seperti dijanji, ini brosur[ {project}][ dan pelan lantai {unit_type}]. Beritahu saya jika anda ingin melawat unit pameran.'),
   (new.id,'busy','en','Hi[ {name}], {agent_name} here. I''m with a client right now. I''ll reach you by {promise_time} with the details you asked for. Thanks for your patience!'),
   (new.id,'busy','zh','[{name}]你好，我是{agent_name}。我现在在见客户，会在{promise_time}前把你要的资料发给你，谢谢你的耐心！'),
   (new.id,'busy','ms','Hai[ {name}], saya {agent_name}. Saya sedang bersama pelanggan. Saya akan hubungi anda sebelum {promise_time} dengan maklumat yang diminta. Terima kasih!')
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_agent();

-- ---------- File storage (private; each agent's files live under their own folder) ----------
insert into storage.buckets (id, name, public) values
  ('sales-kits','sales-kits',false), ('voice-samples','voice-samples',false), ('lead-photos','lead-photos',false)
on conflict (id) do nothing;

drop policy if exists "own files" on storage.objects;
create policy "own files" on storage.objects for all
  using (bucket_id in ('sales-kits','voice-samples','lead-photos') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('sales-kits','voice-samples','lead-photos') and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Every-minute dispatcher (places due calls, sends reminder emails) ----------
-- 1) Database > Extensions: enable pg_cron and pg_net.
-- 2) Replace the two placeholders below, then run this block.
-- select cron.schedule('sembang-dispatch', '* * * * *', $$
--   select net.http_post(
--     url := 'https://YOUR-APP.vercel.app/api/cron/dispatch',
--     headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
--     body := '{}'::jsonb);
-- $$);
