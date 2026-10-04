import { createClient } from '@supabase/supabase-js';
import type { RequestHandler } from 'express';
import 'dotenv/config';

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}) : undefined;

export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
  if (!token) {
    res.status(401).json({ error: 'log in to continue.' });
    return;
  }
  if (!supabase) {
    res.status(503).json({ error: 'authentication is not configured on the server.' });
    return;
  }

  const result = await supabase.auth.getClaims(token).catch(() => null);
  if (!result || result.error?.name === 'AuthRetryableFetchError' || (result.error?.status ?? 0) >= 500) {
    res.status(503).json({ error: 'could not verify your session. try again.' });
    return;
  }
  const claims = result?.data?.claims;
  if (result?.error || !claims || claims.iss !== `${url}/auth/v1` ||
      claims.role !== 'authenticated' || claims.is_anonymous === true ||
      !(Array.isArray(claims.aud) ? claims.aud.includes('authenticated') : claims.aud === 'authenticated') ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(claims.sub) ||
      !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
    res.status(401).json({ error: 'your session expired. log in again.' });
    return;
  }

  res.locals.userId = claims.sub;
  next();
};
