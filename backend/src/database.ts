import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function database(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('configure SUPABASE_URL and the server-only SUPABASE_SECRET_KEY before using paid operations.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
