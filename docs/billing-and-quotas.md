# Quotas & Paddle Billing

This guide covers global and per-plan usage limits, agent token budgets, and Paddle sandbox checkout.

## Usage Quotas

### Global Daily Limits

Set shared daily attempt limits across all users in **Supabase Table Editor → `public.global_usage` → `daily_limit`**:
- Default initial limits: `200` (`chat`), `30` (`analysis`), `20` (`generation`).
- Set `daily_limit` to `0` to disable an operation immediately without restarting the backend.
- Usage resets at midnight UTC (`used` and `usage_date` are managed automatically).

### Plan Allowances

Edit **Supabase → Table Editor → `public.plan_limits`** to adjust tier allowances (`chat_daily`, `analysis_daily`, `songs_monthly`, `lyrics_monthly`, `storage_bytes`). Keep `songs_daily` and `lyrics_daily` null.

| Plan | Chat / day | Analyses / day | Songs / month | Lyrics / month | Storage |
| --- | ---: | ---: | ---: | ---: | ---: |
| `free` | 20 | 10 | 10 (calendar month) | 20 (calendar month) | 512 MiB |
| `starter` | 40 | 20 | 30 (billing month) | 10 (billing month) | 2 GiB |
| `pro` | 80 | 50 | 80 (billing month) | 30 (billing month) | 5 GiB |
| `ultra` | 150 | 100 | 180 (billing month) | 60 (billing month) | 10 GiB |

- **Reset windows**: Daily limits reset at midnight UTC. Free monthly limits reset at the start of each UTC calendar month. Paid monthly limits reset on each monthly window anchored to the Paddle subscription billing period.
- **Per-user overrides**: Set custom limits in `public.user_quotas` (`null` inherits from the user's plan; `0` blocks the operation).
- **Storage**: Counts saved generated songs and pending generation reservations. Temporary audio uploads do not consume storage quota.

### Resetting a User's Usage

Run in the Supabase SQL Editor as an admin (`lyrics`, `chat`, `analysis`, or `generation`):

```sql
select public.reset_user_usage('USER_UUID', 'lyrics');
```

## Agent Token Budgets

- **Chat agent**: Retains up to 16 recent messages and allows up to 3 model calls per request, within a 20,000 total token budget and 4,096 output token budget (max 4,096 output tokens per call). Older history is trimmed automatically to fit.
- **Lyrics agent**: Allows up to 2 turns (load genre skill + write lyrics) with a 32,768-token completion budget per call (including reasoning). Each admitted chat request can trigger at most one lyrics attempt.

## Paddle Sandbox Billing

The `/pricing` page previews USD prices from Paddle and supports monthly ($10 / $20 / $40) and annual ($99 / $199 / $380) sandbox subscriptions.

### Frontend Variables (`frontend/.env.local`, build-time in Coolify)

```dotenv
VITE_PADDLE_CLIENT_TOKEN=test_your_public_client_token
VITE_PADDLE_STARTER_PRICE_ID=pri_01m4tvkjam9nptz0f1ngrbr9mj
VITE_PADDLE_PRO_PRICE_ID=pri_01m4tvmm85j15s4vjd9ykmsa0d
VITE_PADDLE_ULTRA_PRICE_ID=pri_01m4tvnr6xfnyk1nwtyt5vma9e
VITE_PADDLE_STARTER_ANNUAL_PRICE_ID=pri_01m50px1szmdvk7ytv5sejdzgr
VITE_PADDLE_PRO_ANNUAL_PRICE_ID=pri_01m50pzdw9pfn9c5ss1kehnv9n
VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID=pri_01m50q3rnc8na58rv1s4n9yay9
```

### Backend Variables (`backend/.env`, runtime-only in Coolify)

```dotenv
PADDLE_SANDBOX_API_KEY=your_sandbox_api_key
PADDLE_NOTIFICATION_WEBHOOK_SECRET=your_notification_destination_signing_secret
PADDLE_STARTER_PRICE_ID=pri_01m4tvkjam9nptz0f1ngrbr9mj
PADDLE_PRO_PRICE_ID=pri_01m4tvmm85j15s4vjd9ykmsa0d
PADDLE_ULTRA_PRICE_ID=pri_01m4tvnr6xfnyk1nwtyt5vma9e
PADDLE_STARTER_ANNUAL_PRICE_ID=pri_01m50px1szmdvk7ytv5sejdzgr
PADDLE_PRO_ANNUAL_PRICE_ID=pri_01m50pzdw9pfn9c5ss1kehnv9n
PADDLE_ULTRA_ANNUAL_PRICE_ID=pri_01m50q3rnc8na58rv1s4n9yay9
```

### Webhooks & Subscription Lifecycle

- **Webhook destination**: `https://studio.lau.lu/api/paddle/webhook`
- **Subscribed events**: `customer.created`, `customer.updated`, `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.activated`, `subscription.trialing`, `subscription.paused`, `subscription.past_due`, `subscription.resumed`.
- **Ownership**: Checkout creates a transaction on the authenticated backend and binds it to the user before returning the transaction ID.
- **Status & plan changes**: Only `active` and `trialing` subscriptions grant paid allowances. Upgrades prorate immediately; downgrades and cancellations take effect at the next renewal while preserving current allowances until the period ends.
