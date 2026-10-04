import { createClient } from "@supabase/supabase-js";

const callback = new URLSearchParams(window.location.hash.slice(1));
export const authCallback = {
  recovery: callback.get("type") === "recovery",
  error: callback.get("error_description") ?? undefined,
};

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key) : undefined;
