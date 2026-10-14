import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { cancelSubscription, changeSubscription, createCheckout, getPaddle, processPaddleEvent } from '../src/billing.js';

// Offline payloads and a mocked database transport; no Paddle or database entities are created.
test('plan changes enforce ownership, replace the tier, preserve declined payments, and defer downgrades', async () => {
  process.env.PADDLE_SANDBOX_API_KEY = 'pdl_sdbx_offline_billing';
  process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET = 'offline_notification_signing_secret';
  process.env.SUPABASE_URL = 'https://offline-billing.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';
  const prices = ['pri_01m4tvkjam9nptz0f1ngrbr9mj', 'pri_01m4tvmm85j15s4vjd9ykmsa0d', 'pri_01m4tvnr6xfnyk1nwtyt5vma9e'];
  [process.env.PADDLE_STARTER_PRICE_ID, process.env.PADDLE_PRO_PRICE_ID, process.env.PADDLE_ULTRA_PRICE_ID] = prices;
  const userId = '9f218508-49ca-4d85-9f7b-08dc3383fd82';
  const subscriptionId = 'sub_01m4tvkjam9nptz0f1ngrbr9mj';
  const customerId = 'ctm_01m4tvkjam9nptz0f1ngrbr9mj';
  const updatedAt = '2026-10-14T12:00:00Z';
  const price = { id: prices[1], status: 'active', billing_cycle: { interval: 'month', frequency: 1 },
    trial_period: null, unit_price: { amount: '1900', currency_code: 'USD' }, quantity: { minimum: 1, maximum: 1 } };
  const subscription = { id: subscriptionId, customer_id: customerId, status: 'active', updated_at: updatedAt,
    collection_mode: 'automatic', billing_cycle: price.billing_cycle,
    current_billing_period: { starts_at: '2026-10-13T12:00:00Z', ends_at: '2026-11-13T12:00:00Z' },
    items: [{ price, quantity: 1, product: { id: 'pro_01m4tvkjam9nptz0f1ngrbr9mj' } }] };
  const originalFetch = globalThis.fetch;
  let ownerFound = true;
  let customerMatches = true;
  let pendingChange = false;
  const writes: unknown[] = [];
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    if (url.hostname === 'offline-billing.supabase.co') {
      assert.equal(url.pathname, '/rest/v1/paddle_subscriptions');
      assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
      return Response.json(ownerFound ? { id: subscriptionId, updated_at: updatedAt, customer_id: customerMatches ? customerId : 'another-customer',
        scheduled_change: pendingChange ? { action: 'downgrade' } : null } : null);
    }
    if (url.pathname.startsWith('/prices/')) return Response.json({ data: { ...price, id: url.pathname.split('/').at(-1) } });
    if (request.method === 'GET') return Response.json({ data: subscription });
    writes.push(await request.json());
    return Response.json({ data: subscription });
  };
  try {
    await assert.rejects(changeSubscription(userId, 'unknown', updatedAt), /valid monthly plan/);
    await assert.rejects(changeSubscription(userId, 'ultra', 'old-preview'), /subscription changed/);
    ownerFound = false;
    await assert.rejects(cancelSubscription(userId), /no subscription/);
    ownerFound = true;
    customerMatches = false;
    await assert.rejects(changeSubscription(userId, 'ultra', updatedAt), /ownership/);
    customerMatches = true;
    pendingChange = true;
    await assert.rejects(changeSubscription(userId, 'ultra', updatedAt), /scheduled change/);
    pendingChange = false;
    assert.equal(writes.length, 0, 'rejected requests must not mutate Paddle');
    await changeSubscription(userId, 'ultra', updatedAt);
    await changeSubscription(userId, 'starter', updatedAt);
    await cancelSubscription(userId);
    assert.deepEqual(writes, [
      { items: [{ price_id: prices[2], quantity: 1 }], proration_billing_mode: 'prorated_immediately', on_payment_failure: 'prevent_change' },
      { items: [{ price_id: prices[0], quantity: 1 }], proration_billing_mode: 'do_not_bill', on_payment_failure: 'prevent_change' },
      { effective_from: 'next_billing_period' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('raw webhook verification rejects tampering and dispatches only supported verified events', async () => {
  process.env.PADDLE_SANDBOX_API_KEY = 'pdl_sdbx_offline_billing';
  process.env.SUPABASE_URL = 'https://offline-billing.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';
  const secret = 'offline_notification_signing_secret';
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    assert.equal(request.url, 'https://offline-billing.supabase.co/rest/v1/rpc/sync_paddle_event');
    requests.push(await request.json() as Record<string, unknown>);
    return Response.json(null);
  };
  const event = {
    event_id: 'evt_01m4tvkjam9nptz0f1ngrbr9mj', notification_id: 'ntf_01m4tvkjam9nptz0f1ngrbr9mj',
    event_type: 'customer.updated', occurred_at: '2026-10-13T12:00:00Z',
    data: { id: 'ctm_01m4tvkjam9nptz0f1ngrbr9mj', name: null, email: 'owner@example.com', status: 'active',
      locale: 'en', marketing_consent: false, custom_data: { user_id: 'untrusted-browser-user' },
      created_at: '2026-10-13T11:00:00Z', updated_at: '2026-10-13T12:00:00Z', import_meta: null },
  };
  async function verify(body: string, timestamp = Math.floor(Date.now() / 1000)) {
    const hmac = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
    return getPaddle().webhooks.unmarshal(body, secret, `ts=${timestamp};h1=${hmac}`);
  }
  try {
    const rawBody = JSON.stringify(event, null, 2);
    const signed = await verify(rawBody);
    await processPaddleEvent(signed);
    assert.deepEqual(requests[0], { p_entity: 'customer', p_data: {
      id: event.data.id, email: event.data.email, name: null, status: 'active', updated_at: event.data.updated_at,
    }, p_occurred_at: event.occurred_at });
    assert.equal(requests.length, 1, 'browser custom data cannot bind an account');
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');
    await assert.rejects(getPaddle().webhooks.unmarshal(JSON.stringify(event), secret, `ts=${timestamp};h1=${hmac}`));
    await assert.rejects(verify(rawBody, timestamp - 10));
    await assert.rejects(getPaddle().webhooks.unmarshal(rawBody, 'wrong_secret', `ts=${timestamp};h1=${hmac}`));
    const ignored = await verify(JSON.stringify({ ...event, event_type: 'future.unsupported' }));
    await processPaddleEvent(ignored);
    assert.equal(requests.length, 1, 'unhandled types are safely ignored');
    const transaction = await verify(JSON.stringify({ ...event, event_type: 'transaction.completed', data: {
      id: 'txn_01m4tvkjam9nptz0f1ngrbr9mj', customer_id: event.data.id, subscription_id: null,
      status: 'completed', currency_code: 'USD', items: [], payments: [],
      details: { totals: null, tax_rates_used: [], line_items: [] }, updated_at: event.data.updated_at,
    } }));
    await processPaddleEvent(transaction);
    assert.deepEqual(requests[1], { p_entity: 'transaction', p_data: {
      id: 'txn_01m4tvkjam9nptz0f1ngrbr9mj', customer_id: event.data.id, subscription_id: null,
      status: 'completed', currency_code: 'USD', total: null, updated_at: event.data.updated_at,
    }, p_occurred_at: event.occurred_at });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout blocks a completed payment until its subscription is confirmed canceled', async () => {
  process.env.PADDLE_SANDBOX_API_KEY = 'pdl_sdbx_offline_billing';
  process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET = 'offline_notification_signing_secret';
  process.env.SUPABASE_URL = 'https://offline-billing.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';
  const priceId = 'pri_01m4tvkjam9nptz0f1ngrbr9mj';
  [process.env.PADDLE_STARTER_PRICE_ID, process.env.PADDLE_PRO_PRICE_ID, process.env.PADDLE_ULTRA_PRICE_ID] =
    [priceId, 'pri_01m4tvmm85j15s4vjd9ykmsa0d', 'pri_01m4tvnr6xfnyk1nwtyt5vma9e'];
  const userId = '9f218508-49ca-4d85-9f7b-08dc3383fd82';
  const previousId = 'txn_01m4tvkjam9nptz0f1ngrbr9mj';
  const nextId = 'txn_01m4tvmm85j15s4vjd9ykmsa0d';
  const subscriptionId = 'sub_01m4tvkjam9nptz0f1ngrbr9mj';
  const price = { id: priceId, status: 'active', billing_cycle: { interval: 'month', frequency: 1 },
    trial_period: null, unit_price: { amount: '900', currency_code: 'USD' }, quantity: { minimum: 1, maximum: 1 } };
  const originalFetch = globalThis.fetch;
  const scenarios = [
    { status: 'completed', subscriptionId, mirroredStatus: null, result: 'blocked' },
    ...['active', 'trialing', 'paused', 'past_due'].map(mirroredStatus =>
      ({ status: 'completed', subscriptionId, mirroredStatus, result: 'blocked' })),
    { status: 'completed', subscriptionId, mirroredStatus: 'canceled', result: 'created' },
    { status: 'paid', subscriptionId: null, mirroredStatus: null, result: 'blocked' },
    { status: 'completed', subscriptionId: null, mirroredStatus: null, result: 'blocked' },
    { status: 'draft', subscriptionId: null, mirroredStatus: null, result: 'reused' },
    { status: 'ready', subscriptionId: null, mirroredStatus: null, result: 'reused' },
    { status: 'canceled', subscriptionId: null, mirroredStatus: null, result: 'created' },
    { status: 'completed', subscriptionId, mirroredStatus: 'database-error', result: 'database-error' },
  ];
  try {
    for (const scenario of scenarios) {
      let created = 0;
      let registered = 0;
      const transaction = { id: previousId, status: scenario.status, subscription_id: scenario.subscriptionId,
        items: [{ price, quantity: 1 }], payments: [] };
      globalThis.fetch = async (input, options) => {
        const request = new Request(input, options);
        const url = new URL(request.url);
        if (url.hostname === 'sandbox-api.paddle.com') {
          if (url.pathname === `/prices/${priceId}`) return Response.json({ data: price });
          if (url.pathname === `/transactions/${previousId}`) return Response.json({ data: transaction });
          assert.equal(url.pathname, '/transactions');
          assert.equal(request.method, 'POST');
          created++;
          return Response.json({ data: { ...transaction, id: nextId, subscription_id: null, status: 'draft' } });
        }
        assert.equal(url.hostname, 'offline-billing.supabase.co');
        if (url.pathname === '/rest/v1/rpc/get_billing') {
          return Response.json({ plan: null, status: null, paidAccess: false, periodEnd: null, scheduledChange: null, transactionId: null });
        }
        if (url.pathname === '/rest/v1/paddle_transactions') {
          assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
          assert.equal(url.searchParams.has('subscription_id'), false, 'completed payments must remain visible');
          return Response.json([{ id: previousId }]);
        }
        if (url.pathname === '/rest/v1/paddle_subscriptions') {
          assert.equal(url.searchParams.get('id'), `eq.${subscriptionId}`);
          assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
          if (scenario.mirroredStatus === 'database-error') return Response.json({ message: 'offline database failure' }, { status: 500 });
          return Response.json(scenario.mirroredStatus ? [{ status: scenario.mirroredStatus }] : []);
        }
        assert.equal(url.pathname, '/rest/v1/rpc/register_paddle_checkout');
        assert.deepEqual(await request.json(), { p_transaction_id: nextId, p_user_id: userId });
        registered++;
        return Response.json(null);
      };
      if (scenario.result === 'blocked') {
        await assert.rejects(createCheckout(userId, 'starter'), /previous payment is processing/);
      } else if (scenario.result === 'database-error') {
        await assert.rejects(createCheckout(userId, 'starter'), /could not check previous subscription/);
      } else {
        assert.equal(await createCheckout(userId, 'starter'), scenario.result === 'reused' ? previousId : nextId);
      }
      assert.equal(created, scenario.result === 'created' ? 1 : 0);
      assert.equal(registered, created, 'every new transaction is bound before returning it');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('subscription dispatch maps actual purchased prices, including trialing items, without browser ownership', async () => {
  process.env.PADDLE_SANDBOX_API_KEY = 'pdl_sdbx_offline_billing';
  process.env.SUPABASE_URL = 'https://offline-billing.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';
  const priceIds = ['pri_01m4tvkjam9nptz0f1ngrbr9mj', 'pri_01m4tvmm85j15s4vjd9ykmsa0d', 'pri_01m4tvnr6xfnyk1nwtyt5vma9e'];
  [process.env.PADDLE_STARTER_PRICE_ID, process.env.PADDLE_PRO_PRICE_ID, process.env.PADDLE_ULTRA_PRICE_ID] = priceIds;
  const originalFetch = globalThis.fetch;
  const writes: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const data = await request.json() as { p_data: Record<string, unknown> };
    writes.push(data.p_data);
    return Response.json(null);
  };
  try {
    for (const [index, name] of ['starter', 'pro', 'ultra'].entries()) {
      for (const status of ['active', 'trialing']) {
        const body = JSON.stringify({ event_type: 'subscription.created', event_id: 'evt_01m4tvkjam9nptz0f1ngrbr9mj',
          notification_id: 'ntf_01m4tvkjam9nptz0f1ngrbr9mj', occurred_at: '2026-10-13T12:00:00Z', data: {
            id: 'sub_01m4tvkjam9nptz0f1ngrbr9mj', customer_id: 'ctm_01m4tvkjam9nptz0f1ngrbr9mj',
            transaction_id: 'txn_01m4tvkjam9nptz0f1ngrbr9mj', status, currency_code: 'USD', collection_mode: 'automatic',
            billing_cycle: { interval: 'month', frequency: 1 }, created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:00Z',
            current_billing_period: { starts_at: '2026-10-13T12:00:00Z', ends_at: '2026-11-13T12:00:00Z' },
            scheduled_change: { action: 'cancel', effective_at: '2026-11-13T12:00:00Z', resume_at: null },
            custom_data: { user_id: 'untrusted-browser-user' }, discount: null, billing_details: null, import_meta: null,
            items: [{ status, quantity: 1, recurring: true, price: { id: priceIds[index], billing_cycle: { interval: 'month', frequency: 1 } },
              product: null, trial_dates: null, created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:00Z' }],
          } });
        const timestamp = Math.floor(Date.now() / 1000);
        const secret = 'offline_notification_secret';
        const hmac = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
        await processPaddleEvent(await getPaddle().webhooks.unmarshal(body, secret, `ts=${timestamp};h1=${hmac}`));
        const write = writes.at(-1);
        assert.equal(write?.plan, name);
        assert.equal('song_limit' in (write ?? {}), false, 'allowances come from the plan table');
        assert.equal(write?.status, status);
        assert.equal('user_id' in (write ?? {}), false);
        assert.deepEqual(write?.scheduled_change, { action: 'cancel', effectiveAt: '2026-11-13T12:00:00Z', resumeAt: null });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
