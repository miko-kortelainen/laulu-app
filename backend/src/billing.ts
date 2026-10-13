import {
  Environment, EventName, Paddle, type EventEntity,
  type CustomerCreatedEvent, type CustomerUpdatedEvent,
  type SubscriptionNotification, type SubscriptionCreatedNotification,
  type TransactionCompletedEvent,
} from '@paddle/paddle-node-sdk';
import { database } from './database.js';

const planSettings = {
  starter: { variable: 'PADDLE_STARTER_PRICE_ID', songs: 30 },
  pro: { variable: 'PADDLE_PRO_PRICE_ID', songs: 80 },
  ultra: { variable: 'PADDLE_ULTRA_PRICE_ID', songs: 180 },
} as const;

let paddle: Paddle | undefined;
export function getPaddle(): Paddle {
  const key = process.env.PADDLE_SANDBOX_API_KEY;
  if (!key?.startsWith('pdl_sdbx_')) throw new Error('sandbox billing is not configured.');
  paddle ??= new Paddle(key, { environment: Environment.sandbox });
  return paddle;
}

function plans() {
  return Object.entries(planSettings).map(([name, settings]) => {
    const priceId = process.env[settings.variable];
    if (!priceId || !/^pri_[a-z0-9]{26}$/.test(priceId)) throw new Error('sandbox billing prices are not configured.');
    return { name, priceId, songs: settings.songs };
  });
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
  scheduledChange: { action: string; effectiveAt: string } | null;
  transactionId: string | null;
}

export async function getBilling(userId: string): Promise<Billing> {
  const data = await billingRpc('get_billing', { p_user_id: userId });
  if (!data || typeof data !== 'object' || !('paidAccess' in data) || typeof data.paidAccess !== 'boolean' ||
      !('plan' in data) || (data.plan !== null && !['starter', 'pro', 'ultra'].includes(String(data.plan))) ||
      !('status' in data) || (data.status !== null && typeof data.status !== 'string') ||
      !('periodEnd' in data) || (data.periodEnd !== null && (typeof data.periodEnd !== 'string' || !Number.isFinite(Date.parse(data.periodEnd))))) {
    throw new Error('invalid billing response.');
  }
  return data as Billing;
}

export async function createCheckout(userId: string, requestedPlan: unknown): Promise<string> {
  if (!process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET) throw new Error('subscription fulfillment is not configured yet.');
  const plan = plans().find(item => item.name === requestedPlan);
  if (!plan) throw new Error('choose a valid monthly plan.');
  const billing = await getBilling(userId);
  if (billing.status && billing.status !== 'canceled') throw new Error('you already have a subscription. manage it before buying another plan.');

  const price = await getPaddle().prices.get(plan.priceId);
  if (price.status !== 'active' || price.billingCycle?.interval !== 'month' || price.billingCycle.frequency !== 1 || price.trialPeriod) {
    throw new Error('this monthly plan is unavailable.');
  }
  const pending = await database().from('paddle_transactions').select('id').eq('user_id', userId)
    .order('id', { ascending: false }).limit(1)
    .abortSignal(AbortSignal.timeout(3500)).maybeSingle();
  if (pending.error) throw new Error('could not check previous checkout. try again.');
  const row: unknown = pending.data;
  if (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string') {
    const previous = await getPaddle().transactions.get(row.id);
    if (previous.subscriptionId) {
      // A completed payment can arrive before its subscription delivery.
      const subscription = await database().from('paddle_subscriptions').select('status')
        .eq('id', previous.subscriptionId).eq('user_id', userId)
        .abortSignal(AbortSignal.timeout(3500)).maybeSingle();
      if (subscription.error) throw new Error('could not check previous subscription. try again.');
      if (subscription.data?.status !== 'canceled') throw new Error('your previous payment is processing. check your subscription before paying again.');
    } else {
      if (previous.status === 'draft' || previous.status === 'ready') {
        if (previous.items.length !== 1 || previous.items[0].price?.id !== plan.priceId || previous.items[0].quantity !== 1) {
          await getPaddle().transactions.update(previous.id, { items: [{ priceId: plan.priceId, quantity: 1 }] });
        }
        return previous.id;
      }
      if (previous.status !== 'canceled') throw new Error('your previous payment is processing. check your subscription before paying again.');
    }
  }
  const transaction = await getPaddle().transactions.create({
    items: [{ priceId: plan.priceId, quantity: 1 }], collectionMode: 'automatic',
  });
  // Ownership comes from the authenticated server request, never checkout customData or email.
  await billingRpc('register_paddle_checkout', { p_transaction_id: transaction.id, p_user_id: userId });
  return transaction.id;
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
  const plan = item && item.quantity === 1 && item.recurring && ['active', 'trialing'].includes(item.status) &&
    data.billingCycle.interval === 'month' && data.billingCycle.frequency === 1 &&
    item.price?.billingCycle?.interval === 'month' && item.price.billingCycle.frequency === 1
    ? plans().find(candidate => candidate.priceId === item.price?.id) : undefined;
  await sync('subscription', {
    id: data.id, customer_id: data.customerId, status: data.status,
    transaction_id: 'transactionId' in data ? data.transactionId : null,
    price_id: item?.price?.id ?? null, plan: plan?.name ?? null, song_limit: plan?.songs ?? 0,
    period_start: data.currentBillingPeriod?.startsAt ?? null,
    period_end: data.currentBillingPeriod?.endsAt ?? null,
    scheduled_change: data.scheduledChange, updated_at: data.updatedAt,
  }, occurredAt);
}

async function handleTransaction(event: TransactionCompletedEvent): Promise<void> {
  await sync('transaction', {
    id: event.data.id, customer_id: event.data.customerId, subscription_id: event.data.subscriptionId,
    status: event.data.status, currency_code: event.data.currencyCode,
    total: event.data.details?.totals?.total ?? null, updated_at: event.data.updatedAt,
  }, event.occurredAt);
}

export async function processPaddleEvent(event: EventEntity): Promise<void> {
  switch (event.eventType) {
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      return handleCustomer(event);
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
    case EventName.SubscriptionActivated:
    case EventName.SubscriptionTrialing:
    case EventName.SubscriptionPaused:
    case EventName.SubscriptionPastDue:
    case EventName.SubscriptionResumed:
      return handleSubscription(event.data, event.occurredAt);
    case EventName.TransactionCompleted:
      return handleTransaction(event);
    default:
      return;
  }
}
