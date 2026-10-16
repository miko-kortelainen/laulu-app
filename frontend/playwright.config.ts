import { defineConfig, devices } from "@playwright/test";

const port = 5174;
const baseURL = `http://127.0.0.1:${port}`;

// Offline by design: specs mock every /api, Supabase, and Paddle call.
// See https://playwright.dev/docs/best-practices and /docs/mock
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Production build + preview: the dev server stalls under parallel workers.
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: baseURL,
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline",
      VITE_TURNSTILE_SITE_KEY: "offline-site-key",
      VITE_PADDLE_CLIENT_TOKEN: "test_offline",
      VITE_PADDLE_STARTER_PRICE_ID: "pri_01m4tvkjam9nptz0f1ngrbr9mj",
      VITE_PADDLE_PRO_PRICE_ID: "pri_01m4tvmm85j15s4vjd9ykmsa0d",
      VITE_PADDLE_ULTRA_PRICE_ID: "pri_01m4tvnr6xfnyk1nwtyt5vma9e",
      VITE_PADDLE_STARTER_ANNUAL_PRICE_ID: "pri_01m50px1szmdvk7ytv5sejdzgr",
      VITE_PADDLE_PRO_ANNUAL_PRICE_ID: "pri_01m50pzdw9pfn9c5ss1kehnv9n",
      VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID: "pri_01m50q3rnc8na58rv1s4n9yay9",
    },
  },
});
