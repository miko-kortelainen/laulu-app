import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authSession, seedAuth } from './auth-fixture.mjs';

const exec = promisify(execFile);
const session = `musical-pricing-e2e-${process.pid}`;
const run = async (...args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30000 })).stdout.trim();
const url = process.env.E2E_URL;
const plans = [
  { plan: 'free', lyrics_daily: 1, lyrics_monthly: null, chat_daily: 20, analysis_daily: 10, songs_daily: 5, songs_monthly: null, storage_bytes: 536870912 },
  { plan: 'starter', lyrics_daily: null, lyrics_monthly: 10, chat_daily: 40, analysis_daily: 20, songs_daily: null, songs_monthly: 30, storage_bytes: 2147483648 },
  { plan: 'pro', lyrics_daily: null, lyrics_monthly: 30, chat_daily: 80, analysis_daily: 50, songs_daily: null, songs_monthly: 80, storage_bytes: 5368709120 },
  { plan: 'ultra', lyrics_daily: null, lyrics_monthly: 60, chat_daily: 150, analysis_daily: 100, songs_daily: null, songs_monthly: 180, storage_bytes: 10737418240 },
];
const billing = { plan: null, status: null, paidAccess: false, periodEnd: null, scheduledChange: null, transactionId: null };
const transactionId = 'txn_01m4tvkjam9nptz0f1ngrbr9mj';
async function planResponse(data) {
  await run('network', 'unroute', '**/api/plans');
  await run('network', 'route', '**/api/plans', '--body', JSON.stringify(data));
}
const card = name => `document.querySelector('#plan-${name}').closest('section')`;
try {
  await run('open', 'about:blank');
  await planResponse(plans);
  await run('open', `${url}/pricing`);
  await run('wait', '--text', '180 songs');
  for (const plan of plans) {
    const text = JSON.parse(await run('eval', `${card(plan.plan)}.textContent`));
    assert.ok(text.includes(`${plan.chat_daily} chat messages per UTC day`));
    assert.ok(text.includes(`${plan.analysis_daily} audio analyses per UTC day`));
    assert.ok(text.includes(`${plan.songs_daily ?? plan.songs_monthly} songs`));
    assert.ok(text.includes(`${plan.lyrics_daily ?? plan.lyrics_monthly} lyric requests`));
  }
  assert.equal(await run('eval', 'window.checkoutRequests.length'), '0');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify(billing));
  await run('network', 'route', '**/api/billing/checkout', '--body', JSON.stringify({ transactionId }));
  await seedAuth(run, `${url}/pricing`, authSession());
  await run('wait', '--fn', `${card('starter')}.querySelector('button')?.disabled === false`);
  await run('find', 'role', 'button', 'click', '--name', 'choose starter', '--exact');
  await run('wait', '--fn', 'window.checkoutRequests.length === 1');
  assert.equal(await run('eval', 'window.checkoutRequests[0].transactionId'), JSON.stringify(transactionId));
  await run('eval', "window.PaddleBillingV1.callback({ name: 'checkout.closed' })");

  // Reload uses edited allowances, with no rebuilt frontend or new subscription event.
  plans[1] = { ...plans[1], chat_daily: 75, analysis_daily: 25, songs_monthly: 45, storage_bytes: 3221225472 };
  await planResponse(plans);
  await run('eval', 'location.reload()');
  await run('wait', '--text', '45 songs');
  const updated = JSON.parse(await run('eval', `${card('starter')}.textContent`));
  assert.ok(updated.includes('75 chat messages') && updated.includes('25 audio analyses') && updated.includes('3 GiB'));

  // A missing or malformed catalogue blocks checkout and can recover through the visible retry action.
  await run('network', 'unroute', '**/api/plans');
  await run('network', 'route', '**/api/plans', '--abort');
  await run('eval', 'location.reload()');
  await run('wait', '--fn', "document.querySelector('[role=alert]') !== null");
  assert.equal(await run('eval', `${card('starter')}.querySelector('button').disabled`), 'true');
  await planResponse(plans.map(plan => plan.plan === 'starter' ? { ...plan, chat_daily: -1 } : plan));
  await run('find', 'role', 'button', 'click', '--name', 'retry', '--exact');
  await run('wait', '--text', 'invalid plan allowances.');
  assert.equal(await run('eval', `${card('starter')}.querySelector('button').disabled`), 'true');
  await planResponse(plans);
  await run('find', 'role', 'button', 'click', '--name', 'retry', '--exact');
  await run('wait', '--fn', `${card('starter')}.querySelector('button').disabled === false`);
  assert.equal(await run('eval', "document.querySelector('[role=alert]')"), 'null');
  await run('set', 'viewport', '390', '844');
  assert.equal(await run('eval', 'document.documentElement.scrollWidth <= innerWidth'), 'true');
  console.log('Pricing E2E passed: public and signed-in plan allowances, checkout gating, edited values after reload, request failure, malformed data, retry recovery, and mobile width. All billing calls were mocked.');
} catch (error) {
  process.stderr.write(`${await run('snapshot')}\n`);
  throw error;
} finally {
  await run('close');
}
