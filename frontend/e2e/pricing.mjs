import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authSession, seedAuth } from './auth-fixture.mjs';

const exec = promisify(execFile);
const session = `musical-pricing-e2e-${process.pid}`;
const run = async (...args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30000 })).stdout.trim();
const url = process.env.E2E_URL;
const plans = [
  { plan: 'free', lyrics_daily: null, lyrics_monthly: 20, chat_daily: 20, analysis_daily: 10, songs_daily: null, songs_monthly: 10, storage_bytes: 536870912 },
  { plan: 'starter', lyrics_daily: null, lyrics_monthly: 10, chat_daily: 40, analysis_daily: 20, songs_daily: null, songs_monthly: 30, storage_bytes: 2147483648 },
  { plan: 'pro', lyrics_daily: null, lyrics_monthly: 30, chat_daily: 80, analysis_daily: 50, songs_daily: null, songs_monthly: 80, storage_bytes: 5368709120 },
  { plan: 'ultra', lyrics_daily: null, lyrics_monthly: 60, chat_daily: 150, analysis_daily: 100, songs_daily: null, songs_monthly: 180, storage_bytes: 10737418240 },
];
const billing = { plan: null, status: null, paidAccess: false, periodEnd: null, billingInterval: null, scheduledChange: null, transactionId: null };
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
  assert.equal(await run('eval', 'window.previewRequests.at(-1).currencyCode'), JSON.stringify('USD'));
  assert.equal(await run('eval', "document.querySelector('main').innerText.includes('save 17%')"), 'false');
  for (const plan of plans) {
    const text = JSON.parse(await run('eval', `${card(plan.plan)}.textContent`));
    assert.ok(text.includes(`${plan.chat_daily} chat messages per day`));
    assert.ok(text.includes(`${plan.analysis_daily} audio analyses per day`));
    assert.ok(text.includes(`${plan.songs_monthly} songs per month`));
    assert.ok(text.includes(`${plan.lyrics_monthly} lyric requests per month`));
  }
  await run('find', 'role', 'button', 'click', '--name', 'yearly', '--exact');
  await run('wait', '--text', 'billed yearly');
  assert.ok(JSON.parse(await run('eval', `${card('starter')}.textContent`)).includes('$90.00'));
  assert.ok(JSON.parse(await run('eval', `${card('starter')}.textContent`)).includes('30 songs per month'));
  for (const plan of plans) {
    assert.equal(JSON.parse(await run('eval', `${card(plan.plan)}.textContent`)).includes('save 17%'), plan.plan !== 'free');
  }
  await run('find', 'role', 'button', 'click', '--name', 'monthly', '--exact');
  assert.equal(await run('eval', 'window.checkoutRequests.length'), '0');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify(billing));
  await run('network', 'route', '**/api/billing/checkout', '--body', JSON.stringify({ transactionId }));
  await seedAuth(run, `${url}/pricing`, authSession());
  await run('wait', '--fn', `${card('starter')}.querySelector('button')?.disabled === false`);
  await run('find', 'role', 'button', 'click', '--name', 'choose starter', '--exact');
  await run('wait', '--fn', 'window.checkoutRequests.length === 1');
  assert.equal(await run('eval', 'window.checkoutRequests[0].transactionId'), JSON.stringify(transactionId));
  assert.equal(await run('eval', 'Object.hasOwn(window.checkoutRequests[0], "currencyCode")'), 'false');
  assert.equal(await run('eval', 'window.billingRequests.at(-1).billingInterval'), JSON.stringify('month'));
  await run('eval', "window.PaddleBillingV1.callback({ name: 'checkout.closed' })");
  await run('find', 'role', 'button', 'click', '--name', 'yearly', '--exact');
  await run('find', 'role', 'button', 'click', '--name', 'choose starter', '--exact');
  await run('wait', '--fn', 'window.checkoutRequests.length === 2');
  assert.equal(await run('eval', 'window.billingRequests.at(-1).billingInterval'), JSON.stringify('year'));
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

  const paidBilling = { ...billing, plan: 'pro', billingInterval: 'month', status: 'active', paidAccess: true, periodEnd: '2026-11-13T12:00:00Z' };
  const preview = { plan: 'starter', billingInterval: 'month', subscriptionUpdatedAt: '2026-10-14T12:00:00Z', effectiveAt: paidBilling.periodEnd,
    chargeNow: '$0.00', recurringTotal: '$9.00', nextTotal: '$9.00', nextBilledAt: paidBilling.periodEnd };
  await run('network', 'unroute', '**/api/billing');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify(paidBilling));
  await run('network', 'route', '**/api/billing/preview', '--body', JSON.stringify(preview));
  await run('network', 'route', '**/api/billing/change', '--body', '{}');
  await run('network', 'route', '**/api/billing/cancel', '--body', '{}');
  await run('eval', 'location.reload()');
  await run('wait', '--fn', `${card('starter')}.querySelector('button')?.disabled === false`);
  assert.equal(await run('eval', `${card('pro')}.querySelector('button').disabled`), 'true');
  await run('find', 'role', 'button', 'click', '--name', 'change to starter', '--exact');
  await run('wait', '--text', 'no charge or credit today.');
  await run('find', 'role', 'button', 'click', '--name', 'keep current plan', '--exact');
  assert.equal(await run('eval', "document.querySelector('#subscription-confirm-title')"), 'null');
  await run('find', 'role', 'button', 'click', '--name', 'change to starter', '--exact');
  await run('wait', '--text', 'no charge or credit today.');
  await run('network', 'unroute', '**/api/billing');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify({ ...paidBilling,
    scheduledChange: { action: 'downgrade', effectiveAt: paidBilling.periodEnd, plan: 'starter' } }));
  await run('find', 'role', 'button', 'click', '--name', 'confirm plan change', '--exact');
  await run('wait', '--text', 'starter starts at your next renewal.');
  assert.equal(await run('eval', `${card('ultra')}.querySelector('button').disabled`), 'true');
  await run('find', 'role', 'button', 'click', '--name', 'cancel subscription', '--exact');
  await run('wait', '--text', 'it will not renew.');
  await run('network', 'unroute', '**/api/billing');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify({ ...paidBilling,
    scheduledChange: { action: 'cancel', effectiveAt: paidBilling.periodEnd } }));
  await run('find', 'role', 'button', 'click', '--name', 'confirm cancellation', '--exact');
  await run('wait', '--text', 'cancellation is scheduled.');
  assert.equal(await run('eval', `${card('pro')}.querySelector('button').textContent.trim()`), JSON.stringify('current plan'));
  await run('network', 'unroute', '**/api/billing');
  await run('network', 'route', '**/api/billing', '--body', JSON.stringify({ ...paidBilling, billingInterval: 'year', periodEnd: '2027-10-13T12:00:00Z' }));
  await run('eval', 'location.reload()');
  await run('wait', '--text', 'select your current billing frequency');
  assert.equal(await run('eval', `${card('starter')}.querySelector('button').disabled`), 'true');
  await run('find', 'role', 'button', 'click', '--name', 'yearly', '--exact');
  await run('wait', '--fn', `${card('starter')}.querySelector('button')?.disabled === false`);
  assert.equal(await run('eval', `${card('pro')}.querySelector('button').textContent.trim()`), JSON.stringify('current plan'));
  await run('network', 'unroute', '**/api/billing/preview');
  await run('network', 'route', '**/api/billing/preview', '--body', JSON.stringify({ ...preview, billingInterval: 'year',
    recurringTotal: '$90.00', nextTotal: '$90.00', effectiveAt: '2027-10-13T12:00:00Z', nextBilledAt: '2027-10-13T12:00:00Z' }));
  await run('find', 'role', 'button', 'click', '--name', 'change to starter', '--exact');
  await run('wait', '--text', '$90.00 per year.');
  assert.equal(await run('eval', 'window.billingRequests.at(-1).billingInterval'), JSON.stringify('year'));
  await run('find', 'role', 'button', 'click', '--name', 'keep current plan', '--exact');
  await run('set', 'viewport', '390', '844');
  assert.equal(await run('eval', 'document.documentElement.scrollWidth <= innerWidth'), 'true');
  console.log('Pricing E2E passed: monthly/yearly prices and checkout, monthly allowances, recovery, plan changes, cancellation, and mobile width. All billing calls were mocked.');
} catch (error) {
  process.stderr.write(`${await run('snapshot')}\n`);
  throw error;
} finally {
  await run('close');
}
