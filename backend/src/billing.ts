import {
  Environment, EventName, Paddle, type EventEntity,
  type CustomerCreatedEvent, type CustomerUpdatedEvent,
  type SubscriptionNotification, type SubscriptionCreatedNotification,
  type TransactionCompletedEvent, type Price, type Transaction, type Subscription, type UpdateSubscriptionRequestBody,
} from '@paddle/paddle-node-sdk';
import { database } from './database.js';
import { isRecord, isTimestamp } from './validation.js';

const planSettings = {
  starter: { month: 'PADDLE_STARTER_PRICE_ID', year: 'PADDLE_STARTER_ANNUAL_PRICE_ID' },
  pro: { month: 'PADDLE_PRO_PRICE_ID', year: 'PADDLE_PRO_ANNUAL_PRICE_ID' },
  ultra: { month: 'PADDLE_ULTRA_PRICE_ID', year: 'PADDLE_ULTRA_ANNUAL_PRICE_ID' },
} as const;

let paddle: Paddle | undefined;
export function getPaddle(): Paddle {
  const key = process.env.PADDLE_SANDBOX_API_KEY;
  if (!key?.startsWith('pdl_sdbx_')) throw new Error('sandbox billing is not configured.');
  paddle ??= new Paddle(key, { environment: Environment.sandbox });
  return paddle;
}

function plans() {
  return Object.entries(planSettings).flatMap(([name, settings]) =>
    (['month', 'year'] as const).flatMap(interval => {
      const priceId = process.env[settings[interval]];
      if (!priceId && interval === 'year') return [];
      if (!priceId || !/^pri_[a-z0-9]{26}$/.test(priceId)) throw new Error('sandbox billing prices are not configured.');
      return [{ name, priceId, interval }];
    }));
}

async function billingRpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const result = await database().rpc(name, parameters).abortSignal(AbortSignal.timeout(3500));
  if (result.error) throw new Error('billing database is unavailable. try again.');
  return result.data as unknown;
}

export interface Billing {
  plan: string | null;
  status: string | null;
  paidAccess: boolean;
  periodEnd: string | null;
  billingInterval: 'month' | 'year' | null;
  scheduledChange: { action: string; effectiveAt: string } | null;
  transactionId: string | null;
}

export async function getBilling(userId: string): Promise<Billing> {
  const data = await billingRpc('get_billing', { p_user_id: userId });
  if (!isRecord(data) || !validBilling(data)) throw new Error('invalid billing response.');
  return data as unknown as Billing;
}

function validBilling(data: Record<string, unknown>): boolean {
  return typeof data.paidAccess === 'boolean' &&
    [null, 'starter', 'pro', 'ultra'].some(plan => plan === data.plan) &&
    (data.status === null || typeof data.status === 'string') && validBillingPeriod(data);
}

function validBillingPeriod(data: Record<string, unknown>): boolean {
  return [null, 'month', 'year'].some(interval => interval === data.billingInterval) &&
    (data.periodEnd === null || isTimestamp(data.periodEnd));
}

type Plan = ReturnType<typeof plans>[number];

function requestedBillingPlan(requestedPlan: unknown, interval: unknown): Plan {
  if (!process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET) throw new Error('subscription fulfillment is not configured yet.');
  const plan = plans().find(item => item.name === requestedPlan && item.interval === interval);
  if (!plan) throw new Error('choose a valid billing plan.');
  return plan;
}

async function validatePrice(plan: Plan): Promise<void> {
  const price = await getPaddle().prices.get(plan.priceId);
  if (!validPrice(price, plan)) {
    throw new Error('this billing plan is unavailable.');
  }
}

function validPrice(price: Price, plan: Plan): boolean {
  return price.status === 'active' && price.billingCycle?.interval === plan.interval && price.billingCycle.frequency === 1 && !price.trialPeriod;
}

export async function createCheckout(userId: string, requestedPlan: unknown, interval: unknown = 'month'): Promise<string> {
  const plan = requestedBillingPlan(requestedPlan, interval);
  const billing = await getBilling(userId);
  if (billing.status && billing.status !== 'canceled') throw new Error('you already have a subscription. manage it before buying another plan.');

  await validatePrice(plan);
  const previous = await previousCheckout(userId, plan);
  if (previous) return previous;
  const transaction = await getPaddle().transactions.create({
    items: [{ priceId: plan.priceId, quantity: 1 }], collectionMode: 'automatic',
  });
  // Ownership comes from the authenticated server request, never checkout customData or email.
  await billingRpc('register_paddle_checkout', { p_transaction_id: transaction.id, p_user_id: userId });
  return transaction.id;
}

async function previousCheckout(userId: string, plan: Plan): Promise<string | undefined> {
  const pending = await database().from('paddle_transactions').select('id').eq('user_id', userId)
    .order('id', { ascending: false }).limit(1)
    .abortSignal(AbortSignal.timeout(3500)).maybeSingle();
  if (pending.error) throw new Error('could not check previous checkout. try again.');
  const row: unknown = pending.data;
  if (!isRecord(row) || typeof row.id !== 'string') return undefined;
  const previous = await getPaddle().transactions.get(row.id);
  if (!previous.subscriptionId) return reuseCheckout(previous, plan);
  await verifyPreviousSubscription(userId, previous.subscriptionId);
  return undefined;
}

async function verifyPreviousSubscription(userId: string, subscriptionId: string): Promise<void> {
  // A completed payment can arrive before its subscription delivery.
  const subscription = await database().from('paddle_subscriptions').select('status')
    .eq('id', subscriptionId).eq('user_id', userId)
    .abortSignal(AbortSignal.timeout(3500)).maybeSingle();
  if (subscription.error) throw new Error('could not check previous subscription. try again.');
  if (subscription.data?.status !== 'canceled') throw new Error('your previous payment is processing. check your subscription before paying again.');
}

async function reuseCheckout(previous: Transaction, plan: Plan): Promise<string | undefined> {
  if (previous.status === 'canceled') return undefined;
  if (previous.status !== 'draft' && previous.status !== 'ready') {
    throw new Error('your previous payment is processing. check your subscription before paying again.');
  }
  if (!checkoutMatches(previous, plan)) {
    await getPaddle().transactions.update(previous.id, { items: [{ priceId: plan.priceId, quantity: 1 }] });
  }
  return previous.id;
}

function checkoutMatches(previous: Transaction, plan: Plan): boolean {
  return previous.items.length === 1 && previous.items[0].price?.id === plan.priceId && previous.items[0].quantity === 1;
}

async function ownedSubscription(userId: string): Promise<{ subscription: Subscription; pendingChange: boolean; synced: boolean }> {
  const result = await database().from('paddle_subscriptions').select('id, customer_id, scheduled_change, updated_at')
    .eq('user_id', userId).neq('status', 'canceled').order('updated_at', { ascending: false }).limit(1)
    .abortSignal(AbortSignal.timeout(3500)).maybeSingle();
  if (result.error) throw new Error('could not load your subscription. try again.');
  const row: unknown = result.data;
  if (!validSubscriptionOwner(row)) throw new Error('no subscription to manage.');
  const subscription = await getPaddle().subscriptions.get(row.id);
  if (subscription.customerId !== row.customer_id) throw new Error('subscription ownership could not be verified.');
  return {
    subscription, pendingChange: row.scheduled_change != null,
    synced: isTimestamp(row.updated_at) && Date.parse(row.updated_at) === Date.parse(subscription.updatedAt),
  };
}

function validSubscriptionOwner(row: unknown): row is Record<string, unknown> & { id: string; customer_id: string } {
  return isRecord(row) && typeof row.id === 'string' && /^sub_[a-z0-9]{26}$/.test(row.id) && typeof row.customer_id === 'string';
}

function currentPlan(subscription: Subscription, catalogue: Plan[]): Plan {
  const item = subscription.items.length === 1 ? subscription.items[0] : undefined;
  const current = catalogue.find(candidate => candidate.priceId === item?.price.id);
  if (!current || !subscriptionMatches(subscription, current)) {
    throw new Error('this subscription cannot change plans here.');
  }
  return current;
}

function subscriptionMatches(subscription: Subscription, plan: Plan): boolean {
  return subscription.items[0]?.quantity === 1 && subscription.billingCycle.interval === plan.interval && subscription.billingCycle.frequency === 1;
}

function isActiveAutomatic(subscription: Subscription): boolean {
  return subscription.status === 'active' && subscription.collectionMode === 'automatic';
}

async function changeableSubscription(userId: string): Promise<Subscription> {
  const { subscription, pendingChange, synced } = await ownedSubscription(userId);
  if (!synced) throw new Error('your subscription update is processing. check its status before changing plans.');
  if (!isActiveAutomatic(subscription)) {
    throw new Error('only active subscriptions can change plans.');
  }
  if (pendingChange || subscription.scheduledChange) throw new Error('your subscription already has a scheduled change.');
  return subscription;
}

async function planChange(userId: string, requestedPlan: unknown, interval: unknown) {
  const plan = requestedBillingPlan(requestedPlan, interval);
  const subscription = await changeableSubscription(userId);
  const current = currentPlan(subscription, plans());
  if (plan.interval !== current.interval) throw new Error('keep your current billing frequency when changing tiers.');
  if (current.name === plan.name) throw new Error('you already have this plan.');
  await validatePrice(plan);
  return { subscription, plan, ...subscriptionChange(subscription, plan, current) };
}

function subscriptionChange(subscription: Subscription, plan: Plan, current: Plan) {
  const tiers = Object.keys(planSettings);
  const downgrade = tiers.indexOf(plan.name) < tiers.indexOf(current.name);
  const effectiveAt = downgrade ? subscription.currentBillingPeriod?.endsAt : null;
  if (effectiveAt === undefined) throw new Error('your renewal date is unavailable. try again.');
  const body: UpdateSubscriptionRequestBody = {
    items: [{ priceId: plan.priceId, quantity: 1 }],
    prorationBillingMode: downgrade ? 'do_not_bill' : 'prorated_immediately',
    onPaymentFailure: 'prevent_change',
  };
  return { effectiveAt, body };
}

export interface PlanChangePreview {
  plan: string;
  billingInterval: 'month' | 'year';
  subscriptionUpdatedAt: string;
  effectiveAt: string | null;
  chargeNow: string;
  recurringTotal: string;
  nextTotal: string;
  nextBilledAt: string;
}

function money(amount: string = '0', currency: string): string {
  if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) throw new Error('invalid subscription price.');
  const format = new Intl.NumberFormat('en', { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(Number(amount) / 10 ** digits);
}

export async function previewPlanChange(userId: string, requestedPlan: unknown, interval: unknown = 'month'): Promise<PlanChangePreview> {
  const { subscription, plan, effectiveAt, body } = await planChange(userId, requestedPlan, interval);
  const preview = await getPaddle().subscriptions.previewUpdate(subscription.id, body);
  const recurring = preview.recurringTransactionDetails?.totals;
  const next = preview.nextTransaction?.details.totals;
  if (!recurring || !next) throw new Error('subscription prices are unavailable. try again.');
  if (!preview.nextBilledAt) throw new Error('subscription prices are unavailable. try again.');

  return {
    plan: plan.name, billingInterval: plan.interval, subscriptionUpdatedAt: subscription.updatedAt,
    effectiveAt,
    chargeNow: money(preview.immediateTransaction?.details.totals.grandTotal, subscription.currencyCode),
    recurringTotal: money(recurring.total, recurring.currencyCode),
    nextTotal: money(next.grandTotal, next.currencyCode), nextBilledAt: preview.nextBilledAt,
  };
}

export async function changeSubscription(userId: string, requestedPlan: unknown, updatedAt: unknown, interval: unknown = 'month'): Promise<void> {
  const { subscription, body } = await planChange(userId, requestedPlan, interval);
  if (typeof updatedAt !== 'string' || subscription.updatedAt !== updatedAt) {
    throw new Error('your subscription changed. review the new price before confirming.');
  }
  await getPaddle().subscriptions.update(subscription.id, body);
}

export async function cancelSubscription(userId: string): Promise<void> {
  const { subscription } = await ownedSubscription(userId);
  if (subscription.status === 'canceled' || subscription.scheduledChange?.action === 'cancel') return;
  await getPaddle().subscriptions.cancel(subscription.id, {
    effectiveFrom: subscription.status === 'paused' ? 'immediately' : 'next_billing_period',
  });
}

async function sync(entity: 'customer' | 'subscription' | 'transaction', data: Record<string, unknown>, occurredAt: string): Promise<void> {
  await billingRpc('sync_paddle_event', { p_entity: entity, p_data: data, p_occurred_at: occurredAt });
}

async function handleCustomer(event: CustomerCreatedEvent | CustomerUpdatedEvent): Promise<void> {
  await sync('customer', {
    id: event.data.id, email: event.data.email, name: event.data.name, status: event.data.status,
    updated_at: event.data.updatedAt,
  }, event.occurredAt);
}

async function handleSubscription(data: SubscriptionNotification | SubscriptionCreatedNotification, occurredAt: string): Promise<void> {
  const item = data.items.length === 1 ? data.items[0] : undefined;
  const plan = purchasedPlan(data);
  const period = data.currentBillingPeriod ?? { startsAt: null, endsAt: null };
  await sync('subscription', {
    id: data.id, customer_id: data.customerId, status: data.status,
    transaction_id: 'transactionId' in data ? data.transactionId : null,
    price_id: item?.price?.id ?? null, plan: plan?.name ?? null, billing_interval: plan?.interval ?? null,
    period_start: period.startsAt,
    period_end: period.endsAt,
    scheduled_change: data.scheduledChange, updated_at: data.updatedAt,
  }, occurredAt);
}

function purchasedPlan(data: SubscriptionNotification | SubscriptionCreatedNotification): Plan | undefined {
  const item = data.items.length === 1 ? data.items[0] : undefined;
  if (!item || !validPurchasedItem(item, data)) return undefined;
  return plans().find(candidate => candidate.priceId === item.price?.id && candidate.interval === data.billingCycle.interval);
}

function validPurchasedItem(item: SubscriptionNotification['items'][number], data: SubscriptionNotification | SubscriptionCreatedNotification): boolean {
  return item.quantity === 1 && item.recurring && ['active', 'trialing'].includes(item.status) &&
    data.billingCycle.frequency === 1 && item.price?.billingCycle?.frequency === 1 &&
    data.billingCycle.interval === item.price.billingCycle.interval;
}

async function handleTransaction(event: TransactionCompletedEvent): Promise<void> {
  await sync('transaction', {
    id: event.data.id, customer_id: event.data.customerId, subscription_id: event.data.subscriptionId,
    status: event.data.status, currency_code: event.data.currencyCode,
    total: event.data.details?.totals?.total ?? null, updated_at: event.data.updatedAt,
  }, event.occurredAt);
}

const subscriptionEventTypes = [
  EventName.SubscriptionCreated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
  EventName.SubscriptionActivated,
  EventName.SubscriptionTrialing,
  EventName.SubscriptionPaused,
  EventName.SubscriptionPastDue,
  EventName.SubscriptionResumed,
] as const;

function isSubscriptionEvent(event: EventEntity): event is Extract<EventEntity, { eventType: typeof subscriptionEventTypes[number] }> {
  return subscriptionEventTypes.some(type => type === event.eventType);
}

export async function processPaddleEvent(event: EventEntity): Promise<void> {
  if (isSubscriptionEvent(event)) return handleSubscription(event.data, event.occurredAt);
  switch (event.eventType) {
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      return handleCustomer(event);
    case EventName.TransactionCompleted:
      return handleTransaction(event);
    default:
      return;
  }
}
