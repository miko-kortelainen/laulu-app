import { test, expect, fulfillJson, mockPaddle } from "./fixtures";

const plans = [
  { plan: "free", lyrics_daily: null, lyrics_monthly: 20, chat_daily: 20, analysis_daily: 10, songs_daily: null, songs_monthly: 10, storage_bytes: 536870912 },
  { plan: "starter", lyrics_daily: null, lyrics_monthly: 10, chat_daily: 40, analysis_daily: 20, songs_daily: null, songs_monthly: 30, storage_bytes: 2147483648 },
  { plan: "pro", lyrics_daily: null, lyrics_monthly: 30, chat_daily: 80, analysis_daily: 50, songs_daily: null, songs_monthly: 80, storage_bytes: 5368709120 },
  { plan: "ultra", lyrics_daily: null, lyrics_monthly: 60, chat_daily: 150, analysis_daily: 100, songs_daily: null, songs_monthly: 180, storage_bytes: 10737418240 },
];
const billing = { plan: null, status: null, paidAccess: false, periodEnd: null, billingInterval: null, scheduledChange: null, transactionId: null };
const transactionId = "txn_01m4tvkjam9nptz0f1ngrbr9mj";

test.describe("pricing", () => {
  test.beforeEach(async ({ page }) => {
    await mockPaddle(page);
    await page.route(/\/api\/plans$/, (route) => fulfillJson(route, plans));
    await page.route(/\/api\/billing$/, (route) => fulfillJson(route, billing));
  });

  test("toggles billing frequency and opens monthly and yearly checkout", async ({ authedPage: page }) => {
    await page.route(/\/api\/billing\/checkout$/, (route) => fulfillJson(route, { transactionId }));

    await page.goto("/pricing");

    await expect(page.getByText("180 songs")).toBeVisible();
    await expect(page.getByText("40 chat messages per day")).toBeVisible();

    await page.getByRole("button", { name: "yearly" }).click();
    await expect(page.getByText("billed yearly").first()).toBeVisible();
    await expect(page.getByText("$90.00").first()).toBeVisible();

    await page.getByRole("button", { name: "monthly" }).click();
    await page.getByRole("button", { name: "choose starter" }).click();

    // Overlay checkout opens with a server-created transaction and the signed-in
    // customer's email pre-filled; provisioning stays with the webhook, not this call.
    await expect.poll(() => page.evaluate(() => (window as unknown as { checkoutRequests: unknown[] }).checkoutRequests.length)).toBe(1);
    const checkout = await page.evaluate(() => (window as unknown as { checkoutRequests: Record<string, unknown>[] }).checkoutRequests[0]);
    expect(checkout.transactionId).toBe(transactionId);
    expect(checkout.customer).toEqual({ email: "test@example.com" });
    expect(checkout.settings).toMatchObject({ displayMode: "overlay", variant: "one-page" });
    expect(checkout).not.toHaveProperty("currencyCode");

    const billingRequests = await page.evaluate(() => (window as unknown as { billingRequests: Record<string, unknown>[] }).billingRequests);
    expect(billingRequests.at(-1)).toMatchObject({ billingInterval: "month" });
    await page.evaluate(() => (window as unknown as { paddleCallback: (event: unknown) => void }).paddleCallback({ name: "checkout.closed" }));
    await page.getByRole("button", { name: "yearly" }).click();
    await page.getByRole("button", { name: "choose starter" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { checkoutRequests: unknown[] }).checkoutRequests.length)).toBe(2);
    expect(await page.evaluate(() => (window as unknown as { billingRequests: unknown[] }).billingRequests.at(-1))).toMatchObject({ plan: "starter", billingInterval: "year" });
  });

  test("shows public allowances and savings and reloads edited limits without a build", async ({ page }) => {
    let catalogue = plans;
    await page.route(/\/api\/plans$/, (route) => fulfillJson(route, catalogue));
    await page.goto("/pricing");
    await expect(page.getByRole("link", { name: "log in to choose starter" })).toBeVisible();
    for (const plan of plans) {
      const card = page.getByRole("region", { name: plan.plan, exact: true });
      await expect(card).toContainText(`${plan.songs_monthly} songs per month`);
      await expect(card).toContainText(`${plan.lyrics_monthly} lyric requests per month`);
      await expect(card).toContainText(`${plan.chat_daily} chat messages per day`);
      await expect(card).toContainText(`${plan.analysis_daily} audio analyses per day`);
    }
    await expect(page.getByText("save 17%").first()).toBeHidden();
    await page.getByRole("button", { name: "yearly" }).click();
    await expect(page.getByText("save 17%")).toHaveCount(3);
    await expect(page.getByText("save 17%").first()).toBeVisible();
    catalogue = plans.map((plan) => plan.plan === "starter" ? { ...plan, chat_daily: 75, analysis_daily: 25, songs_monthly: 45, storage_bytes: 3221225472 } : plan);
    await page.reload();
    const starter = page.getByRole("region", { name: "starter", exact: true });
    await expect(starter).toContainText("45 songs per month");
    await expect(starter).toContainText("75 chat messages");
    await expect(starter).toContainText("25 audio analyses");
    await expect(starter).toContainText("3 GiB");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("blocks checkout for unavailable or invalid allowances and recovers through retry", async ({ authedPage: page }) => {
    let mode = "offline";
    await page.route(/\/api\/plans$/, (route) => mode === "offline" ? route.abort() : fulfillJson(route,
      mode === "invalid" ? plans.map((plan) => plan.plan === "starter" ? { ...plan, chat_daily: -1 } : plan) : plans));
    await page.goto("/pricing");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "choose starter" })).toBeDisabled();
    mode = "invalid";
    await page.getByRole("button", { name: "retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("invalid plan allowances.");
    await expect(page.getByRole("button", { name: "choose starter" })).toBeDisabled();
    mode = "valid";
    await page.getByRole("button", { name: "retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "choose starter" })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  for (const interval of ["month", "year"] as const) {
    test(`previews a ${interval} downgrade and keeps the current plan until cancellation at renewal`, async ({ authedPage: page }) => {
      const periodEnd = "2099-11-13T12:00:00Z";
      let scheduledChange: { action: string; effectiveAt: string; plan?: string } | null = null;
      const preview = { plan: "starter", billingInterval: interval, subscriptionUpdatedAt: "2026-10-14T12:00:00Z", effectiveAt: periodEnd,
        chargeNow: "$0.00", recurringTotal: interval === "year" ? "$90.00" : "$9.00", nextTotal: "$9.00", nextBilledAt: periodEnd };
      const changes: unknown[] = [];
      let cancellations = 0;
      await page.route(/\/api\/billing$/, (route) => fulfillJson(route, { ...billing, plan: "pro", status: "active", paidAccess: true,
        periodEnd, billingInterval: interval, scheduledChange }));
      await page.route(/\/api\/billing\/preview$/, (route) => {
        expect(route.request().postDataJSON()).toEqual({ plan: "starter", billingInterval: interval });
        return fulfillJson(route, preview);
      });
      await page.route(/\/api\/billing\/change$/, (route) => {
        changes.push(route.request().postDataJSON());
        scheduledChange = { action: "downgrade", effectiveAt: periodEnd, plan: "starter" };
        return fulfillJson(route, {});
      });
      await page.route(/\/api\/billing\/cancel$/, (route) => {
        cancellations++;
        scheduledChange = { action: "cancel", effectiveAt: periodEnd };
        return fulfillJson(route, {});
      });
      await page.goto("/pricing");
      if (interval === "year") {
        await expect(page.getByText(/select your current billing frequency/)).toBeVisible();
        await expect(page.getByRole("button", { name: "change to starter" })).toBeDisabled();
        await page.getByRole("button", { name: "yearly" }).click();
      }
      await expect(page.getByRole("region", { name: "pro", exact: true }).getByRole("button", { name: "current plan" })).toBeDisabled();
      await page.getByRole("button", { name: "change to starter" }).click();
      await expect(page.getByText(/no charge or credit today/)).toBeVisible();
      await expect(page.getByText(new RegExp(`${interval === "year" ? "\\$90.00" : "\\$9.00"} per ${interval}`))).toBeVisible();
      await page.getByRole("button", { name: "keep current plan" }).click();
      expect(changes).toEqual([]);
      await page.getByRole("button", { name: "change to starter" }).click();
      await page.getByRole("button", { name: "confirm plan change" }).click();
      await expect(page.getByRole("status")).toContainText("starter starts at your next renewal");
      expect(changes).toEqual([{ plan: "starter", billingInterval: interval, subscriptionUpdatedAt: preview.subscriptionUpdatedAt }]);
      await expect(page.getByRole("button", { name: "change to ultra" })).toBeDisabled();
      await expect(page.getByRole("region", { name: "pro", exact: true }).getByRole("button", { name: "current plan" })).toBeVisible();
      await page.getByRole("button", { name: "cancel subscription", exact: true }).click();
      await expect(page.getByText(/it will not renew/)).toBeVisible();
      expect(cancellations).toBe(0);
      await page.getByRole("button", { name: "confirm cancellation" }).click();
      await expect(page.getByRole("status")).toContainText("cancellation is scheduled");
      expect(cancellations).toBe(1);
      await expect(page.getByRole("region", { name: "pro", exact: true }).getByRole("button", { name: "current plan" })).toBeVisible();
    });
  }
});
