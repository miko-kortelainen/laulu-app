import type { RequestHandler } from 'express';
import { database } from './database.js';

export const TERMS_VERSION = '2026-10-13';

export async function hasAcceptedTerms(userId: string): Promise<boolean> {
  const { data, error } = await database().from('terms_acceptances').select('version')
    .eq('user_id', userId).eq('version', TERMS_VERSION).maybeSingle();
  if (error) throw new Error('could not check terms acceptance. try again.');
  return data !== null;
}

export async function recordTermsAcceptance(userId: string): Promise<void> {
  const { error } = await database().from('terms_acceptances')
    .insert({ user_id: userId, version: TERMS_VERSION });
  // A duplicate means another tab already recorded this version.
  if (error && error.code !== '23505') throw new Error('could not record terms acceptance. try again.');
}

export const requireTerms: RequestHandler = async (_req, res, next) => {
  const accepted = await hasAcceptedTerms(res.locals.userId).catch(() => {
    res.status(503).json({ error: 'could not check terms acceptance. try again.' });
  });
  if (accepted === undefined) return;
  if (!accepted) {
    res.status(403).json({ error: 'confirm you are 18 or older and accept the current terms of service to continue.', code: 'terms_required' });
    return;
  }
  next();
};
