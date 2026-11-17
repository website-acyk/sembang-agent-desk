import { createClient } from '@supabase/supabase-js';

let admin;
/** Server-side Supabase client with full access. Never send this key to the browser. */
export function db() {
  if (!admin) {
    admin = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}
export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}
/** Throw on a Supabase error so handlers can return a clear message. */
export function ok({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}
