import { test as base, expect, type Page, type Route } from "@playwright/test";

export const userId = "10000000-0000-4000-8000-000000000001";
export const userEmail = "test@example.com";

export const usage = {
  resetAt: "2099-01-01T00:00:00Z",
  generationResetAt: "2099-01-01T00:00:00Z",
  plan: "free",
  lyrics: { limit: 1, used: 0, remaining: 1 },
  chat: { limit: 20, used: 0, remaining: 20 },
  analysis: { limit: 10, used: 0, remaining: 10 },
  generation: { limit: 5, used: 0, remaining: 5 },
  storage: { limit: 536870912, used: 0, reserved: 0, remaining: 536870912 },
};

export function authSession(baseURL: string, id = userId, email = userEmail, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: `${baseURL}/auth/v1`, sub: id, aud: "authenticated", role: "authenticated", iat: now, exp: now + expiresIn,
  })}.c2lnbmF0dXJl`;
  return {
    access_token: accessToken,
    refresh_token: `offline-refresh-${id}`,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    user: {
      id, email, aud: "authenticated", role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
      created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(),
    },
  };
}

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function seedSession(page: Page, origin: string, session = authSession(origin)): Promise<void> {
  await page.context().setStorageState({ cookies: [], origins: [{ origin, localStorage: [
    { name: `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`, value: JSON.stringify(session) },
  ] }] });
}

interface CaptchaOptions {
  callback(token: string): void;
  "expired-callback"(): void;
  "error-callback"(): void;
}

declare global {
  interface Window { captchaOptions?: CaptchaOptions; captchaRenders: number }
}

export async function verifyCaptcha(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(window.captchaOptions))).toBe(true);
  await page.evaluate(() => window.captchaOptions!.callback("offline-captcha-token"));
  await expect(page.locator("button[type=submit]")).toBeEnabled();
}

/** Eight seconds of PCM audio for decoding, seeking, and playback specs. */
export function wavBuffer(): Buffer {
  const samples = 8000 * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / 8000) * Math.PI * 2 * 220) * (0.1 + 0.6 * i / samples) * 32767), 44 + i * 2);
  return wav;
}

/**
 * Default offline API mocks. Register overrides after this call and before
 * `goto` — Playwright matches the most recently registered route first.
 */
export async function mockApi(page: Page, baseURL: string): Promise<void> {
  const session = authSession(baseURL);
  await page.route(/\/auth\/v1\/user$/, (route) => fulfillJson(route, session.user));
  await page.route(/\/api\/terms$/, (route) => fulfillJson(route, { accepted: true, version: "2026-10-13" }));
  await page.route(/\/api\/context$/, (route) => fulfillJson(route, { messages: 0, limit: 16 }));
  await page.route(/\/api\/usage$/, (route) => fulfillJson(route, usage));
  await page.route(/\/api\/operations$/, (route) => fulfillJson(route, { operations: [] }));
  await page.route(/\/api\/operations\/[^/]+\/acknowledge$/, (route) => route.fulfill({ status: 204 }));
  await page.route(/\/api\/session\/end$/, (route) => route.fulfill({ status: 204 }));
}

/** Offline Paddle.js stand-in: records Checkout.open calls, never loads the CDN. */
export async function mockPaddle(page: Page): Promise<void> {
  await page.route("https://cdn.paddle.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.addInitScript(() => {
    const win = window as unknown as {
      checkoutRequests: unknown[]; billingRequests: unknown[];
      PaddleBillingV1: unknown; paddleCallback?: (event: unknown) => void;
    };
    win.checkoutRequests = [];
    win.billingRequests = [];
    const originalFetch = window.fetch;
    window.fetch = (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      if (String(input).includes("/api/billing/") && init?.body) win.billingRequests.push(JSON.parse(String(init.body)));
      return originalFetch(...args);
    };
    win.PaddleBillingV1 = {
      Initialized: false,
      Environment: { set() {} },
      Initialize(options: { eventCallback: (event: unknown) => void }) {
        (win.PaddleBillingV1 as { Initialized: boolean }).Initialized = true;
        win.paddleCallback = options.eventCallback;
      },
      Update(options: { eventCallback: (event: unknown) => void }) { win.paddleCallback = options.eventCallback; },
      PricePreview({ items, currencyCode }: { items: { priceId: string }[]; currencyCode: string }) {
        void currencyCode;
        return Promise.resolve({ data: { details: { lineItems: items.map((item) => ({
          price: { id: item.priceId, status: "active", billingCycle: {
            interval: ["pri_01m50px1szmdvk7ytv5sejdzgr", "pri_01m50pzdw9pfn9c5ss1kehnv9n", "pri_01m50q3rnc8na58rv1s4n9yay9"].includes(item.priceId) ? "year" : "month", frequency: 1 }, trialPeriod: null },
          product: { status: "active" },
          totals: { total: item.priceId.startsWith("pri_01m50") ? "9000" : "900" },
          formattedTotals: { total: item.priceId.startsWith("pri_01m50") ? "$90.00" : "$9.00" },
        })) } } });
      },
      Checkout: { open(options: unknown) { win.checkoutRequests.push(options); }, close() {} },
    };
  });
}

interface Fixtures { authedPage: Page }

/** Isolated page with a seeded Supabase session and default offline mocks. */
export const test = base.extend<Fixtures>({
  // External fonts add no behaviour under test and stall the load event offline.
  page: async ({ page }, run) => {
    await page.route(/\/(api|auth\/v1)\//, (route) => route.abort());
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
      contentType: "text/javascript", body: `window.captchaRenders = 0;
        window.turnstile = {
          render(container, options) { window.captchaOptions = options; return String(++window.captchaRenders); },
          remove() { window.captchaOptions = undefined; }
        };`,
    }));
    await run(page);
  },
  authedPage: async ({ page, baseURL }, run) => {
    const origin = baseURL!;
    await seedSession(page, origin);
    await mockApi(page, origin);
    await run(page);
  },
});

export { expect };
