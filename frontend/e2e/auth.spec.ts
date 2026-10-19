import { test, expect, authSession, fulfillJson, mockApi, seedSession, userEmail, verifyCaptcha } from "./fixtures";

test.describe("auth", () => {
  test("redirects signed-out visitors to login and links to create account", async ({ page }) => {
    await page.goto("/profile");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "log in" })).toBeVisible();
    await expect(page.getByLabel("email")).toBeVisible();
    await expect(page.getByLabel("password", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 760 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("email").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("password", { exact: true })).toBeFocused();

    await page.getByRole("link", { name: "create account" }).click();
    await expect(page).toHaveURL(/\/create-account$/);
    await expect(page.getByLabel(/i am 18 or older/)).not.toBeChecked();

    await page.getByRole("link", { name: "back to login" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "log in" })).toBeVisible();
  });

  test("shows the public privacy page without a session", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "privacy and beta limits" }).click();

    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByText("AI processing")).toBeVisible();
    await expect(page.getByLabel("email")).toHaveCount(0);
    for (const path of ["/privacy/", "/PRIVACY"]) {
      await page.goto(path);
      await page.reload();
      await expect(page.getByText("AI processing")).toBeVisible();
    }
    await page.goto("/terms");
    await expect(page.getByText("You must be at least 18 years old", { exact: false })).toBeVisible();
  });

  test("requires terms and matching passwords before signup, then shows confirmation guidance", async ({ page, baseURL }) => {
    const session = authSession(baseURL!);
    const signups: unknown[] = [];
    await page.route(/\/auth\/v1\/signup/, (route) => {
      signups.push(route.request().postDataJSON());
      return fulfillJson(route, { user: session.user, session: null });
    });
    await page.goto("/create-account");
    await page.getByLabel("email").fill(userEmail);
    await page.getByLabel("password", { exact: true }).fill("offline-password");
    await page.getByLabel("confirm password", { exact: true }).fill("different-password");
    await verifyCaptcha(page);
    await page.getByRole("button", { name: "create account", exact: true }).click();
    expect(signups).toHaveLength(0);
    await page.locator("form").dispatchEvent("submit");
    await expect(page.getByRole("alert")).toContainText("confirm you are 18 or older");
    expect(signups).toHaveLength(0);
    await page.getByLabel(/i am 18 or older/).check();
    await page.getByRole("button", { name: "create account", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("passwords don't match");
    await expect(page.getByLabel("confirm password", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("password", { exact: true })).toHaveValue("offline-password");
    expect(signups).toHaveLength(0);
    await page.getByLabel("confirm password", { exact: true }).fill("offline-password");
    await page.getByRole("button", { name: "create account", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("check your email to confirm your account.");
    await expect(page.locator("form")).toHaveCount(0);
    await expect(page.getByLabel("human verification")).toHaveCount(0);
    expect(signups).toEqual([expect.objectContaining({ gotrue_meta_security: { captcha_token: "offline-captcha-token" } })]);
    await page.goBack();
    await page.goto("/create-account");
    await expect(page.getByLabel(/i am 18 or older/)).not.toBeChecked();
    await expect(page.getByLabel("confirm password", { exact: true })).toHaveValue("");
  });

  test("retains unused CAPTCHA across links and history, handles expiry, and retries errors", async ({ page }) => {
    await page.goto("/login");
    await verifyCaptcha(page);
    const renders = await page.evaluate(() => window.captchaRenders);
    await page.getByRole("link", { name: "create account", exact: true }).click();
    await page.getByLabel("password", { exact: true }).fill("history-password");
    await page.getByLabel("confirm password", { exact: true }).fill("history-password");
    await page.goBack();
    await expect(page.getByLabel("password", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("confirm password", { exact: true })).toHaveCount(0);
    await page.goForward();
    await expect(page.getByLabel("confirm password", { exact: true })).toHaveValue("");
    await expect(page.locator("button[type=submit]")).toBeEnabled();
    expect(await page.evaluate(() => window.captchaRenders)).toBe(renders);
    await page.evaluate(() => window.captchaOptions!["expired-callback"]());
    await expect(page.locator("button[type=submit]")).toBeDisabled();
    await page.evaluate(() => window.captchaOptions!["error-callback"]());
    await expect(page.getByRole("alert").filter({ hasText: "verification could not finish" })).toBeVisible();
    await page.getByRole("button", { name: "retry verification" }).click();
    await verifyCaptcha(page);
    expect(await page.evaluate(() => window.captchaRenders)).toBe(renders + 1);
  });

  test("preserves failed login fields and retries logout cleanup before signing out", async ({ page, baseURL }) => {
    const session = authSession(baseURL!);
    await mockApi(page, baseURL!);
    let failLogin = true;
    await page.route(/\/auth\/v1\/token/, (route) => fulfillJson(route, failLogin
      ? { code: "invalid_credentials", msg: "invalid login credentials" } : session, failLogin ? 400 : 200));
    await page.route(/\/auth\/v1\/logout/, (route) => route.fulfill({ status: 204 }));
    let failCleanup = true;
    const cleanups: string[] = [];
    await page.route(/\/api\/session\/end$/, (route) => {
      cleanups.push(route.request().headers().authorization);
      expect(route.request().method()).toBe("POST");
      return route.fulfill({ status: failCleanup ? 500 : 204 });
    });
    await page.goto("/profile");
    await page.getByLabel("email").fill(userEmail);
    await page.getByLabel("password", { exact: true }).fill("offline-password");
    await verifyCaptcha(page);
    const formHeight = await page.locator("form").evaluate((form) => form.getBoundingClientRect().height);
    await page.getByRole("button", { name: "log in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("invalid login credentials");
    await expect(page.getByLabel("email")).toHaveValue(userEmail);
    await expect(page.getByLabel("password", { exact: true })).toHaveValue("offline-password");
    expect(await page.locator("form").evaluate((form) => form.getBoundingClientRect().height)).toBe(formHeight);
    failLogin = false;
    await verifyCaptcha(page);
    await page.getByRole("button", { name: "log in", exact: true }).click();
    await expect(page.getByText("member since")).toBeVisible();
    await page.reload();
    await expect(page.getByText(userEmail)).toBeVisible();
    await page.getByRole("button", { name: "log out", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("could not delete session uploads");
    await expect(page.getByText("member since")).toBeVisible();
    failCleanup = false;
    await page.getByRole("button", { name: "log out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "log in" })).toBeVisible();
    expect(cleanups).toEqual([`Bearer ${session.access_token}`, `Bearer ${session.access_token}`]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "log in" })).toBeVisible();
  });

  test("aborts private work on logout and clears songs and drafts when switching accounts", async ({ authedPage: page, baseURL }) => {
    await page.route(/\/auth\/v1\/logout/, (route) => route.fulfill({ status: 204 }));
    const second = authSession(baseURL!, "20000000-0000-4000-8000-000000000002", "second@example.com");
    let switched = false;
    await page.route(/\/auth\/v1\/token/, (route) => { switched = true; return fulfillJson(route, second); });
    await page.route(/\/api\/songs$/, (route) => fulfillJson(route, { songs: switched ? [] : [{
      id: "11111111-1111-4111-8111-111111111111", title: "private saved song", prompt: "private style", lyrics: "",
      model: "lyria-3.5", createdAt: "2026-10-06T10:00:00Z", isFavourite: false,
      url: "/api/music/11111111-1111-4111-8111-111111111111.mp3",
    }] }));
    await page.route(/\/api\/songs\/recovery$/, (route) => fulfillJson(route, { songIds: [] }));
    await page.goto("/");
    await page.getByLabel("genre / style").fill("private song style");
    await page.getByRole("link", { name: "my songs", exact: true }).click();
    await expect(page.getByRole("button", { name: "song details: private saved song" })).toBeVisible();
    await page.getByRole("link", { name: "studio", exact: true }).click();
    await page.evaluate(() => {
      const original = window.fetch;
      (window as unknown as { pendingAborted: boolean }).pendingAborted = false;
      window.fetch = (input, options) => input === "/api/chat" ? new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => {
          (window as unknown as { pendingAborted: boolean }).pendingAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }) : original(input, options);
    });
    await page.getByLabel("Prompt message").fill("private pending message");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("thinking...", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "my profile", exact: true }).click();
    await page.getByRole("button", { name: "log out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "log in" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { pendingAborted: boolean }).pendingAborted)).toBe(true);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.endsWith("-auth-token")))).toEqual([]);
    await page.getByLabel("email").fill(second.user.email);
    await page.getByLabel("password", { exact: true }).fill("offline-password");
    await verifyCaptcha(page);
    await page.getByRole("button", { name: "log in", exact: true }).click();
    await expect(page.getByText(second.user.email)).toBeVisible();
    await page.getByRole("link", { name: "studio", exact: true }).click();
    await expect(page.getByLabel("genre / style")).toHaveValue("");
    await expect(page.getByText("private pending message")).toHaveCount(0);
    await page.getByRole("link", { name: "my songs", exact: true }).click();
    await expect(page.getByText(/no saved songs yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "song details: private saved song" })).toHaveCount(0);
  });

  test("processes confirmation callbacks and refreshes an expired saved session", async ({ page, baseURL }) => {
    const session = authSession(baseURL!);
    await mockApi(page, baseURL!);
    const hash = new URLSearchParams({ access_token: session.access_token, refresh_token: session.refresh_token,
      expires_in: "3600", token_type: "bearer", type: "signup" });
    await page.goto(`/#${hash}`);
    await expect(page.getByText("0 / 16")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${baseURL}/#?$`));
    expect(await page.evaluate(() => location.hash)).toBe("");
    await page.goto("/create-account");
    await expect(page).toHaveURL(`${baseURL}/`);
    const refreshes: unknown[] = [];
    await page.route(/\/auth\/v1\/token/, (route) => {
      refreshes.push(route.request().postDataJSON());
      return fulfillJson(route, session);
    });
    await seedSession(page, baseURL!, authSession(baseURL!, undefined, undefined, -5));
    await page.reload();
    await expect(page.getByText("0 / 16")).toBeVisible();
    expect(refreshes).toEqual([{ refresh_token: session.refresh_token }]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("sb-127-auth-token")!).expires_at > Date.now() / 1000)).toBe(true);
  });

  test("recovers a password after email failure and rejects an expired callback", async ({ page, baseURL }) => {
    const session = authSession(baseURL!);
    await mockApi(page, baseURL!);
    let fail = true;
    await page.route(/\/auth\/v1\/recover/, (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ gotrue_meta_security: { captcha_token: "offline-captcha-token" } });
      return fulfillJson(route, fail ? { msg: "email delivery failed" } : {}, fail ? 400 : 200);
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "forgot password?" }).click();
    await page.getByLabel("email").fill(userEmail);
    await verifyCaptcha(page);
    await page.getByRole("button", { name: "reset password", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("email delivery failed");
    await expect(page.getByLabel("email")).toHaveValue(userEmail);
    fail = false;
    await verifyCaptcha(page);
    await page.getByRole("button", { name: "reset password", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("if an account exists");
    const hash = new URLSearchParams({ access_token: session.access_token, refresh_token: session.refresh_token,
      expires_in: "3600", token_type: "bearer", type: "recovery" });
    await page.route(/\/auth\/v1\/user$/, (route) => {
      if (route.request().method() === "PUT") expect(route.request().postDataJSON()).toMatchObject({ password: "new-offline-password" });
      return fulfillJson(route, session.user);
    });
    await page.goto(`/#${hash}`);
    await expect(page.getByRole("button", { name: "save new password" })).toBeVisible();
    await expect(page.getByLabel("Prompt message")).toHaveCount(0);
    await page.getByLabel("new password", { exact: true }).fill("new-offline-password");
    await page.getByRole("button", { name: "save new password" }).click();
    await expect(page.getByText("0 / 16")).toBeVisible();
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto("/#error=access_denied&error_description=link%20expired&type=recovery");
    await expect(page.getByRole("alert")).toHaveText("link expired");
    await expect(page.getByRole("button", { name: "log in", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("requires current adult terms and preserves the gate after a failed save", async ({ authedPage: page }) => {
    const acceptances: unknown[] = [];
    let fail = true;
    await page.route(/\/api\/terms$/, (route) => {
      if (route.request().method() === "GET") return fulfillJson(route, { accepted: false, version: "2026-10-13" });
      acceptances.push(route.request().postDataJSON());
      return fail ? fulfillJson(route, { error: "could not record terms acceptance. try again." }, 503) : route.fulfill({ status: 204 });
    });
    await page.addInitScript(() => sessionStorage.setItem("terms-acceptance-pending", "2026-10-12"));
    await page.goto("/");
    await expect(page.getByText(/laulu is for adults aged 18 and over/)).toBeVisible();
    await expect(page.getByRole("button", { name: "accept and continue" })).toBeDisabled();
    await expect(page.getByLabel("Prompt message")).toHaveCount(0);
    await page.getByLabel(/i am 18 or older/).check();
    await page.getByRole("button", { name: "accept and continue" }).click();
    await expect(page.getByRole("alert")).toContainText("could not record terms acceptance");
    fail = false;
    await page.getByRole("button", { name: "accept and continue" }).click();
    await expect(page.getByText("0 / 16")).toBeVisible();
    expect(acceptances).toEqual([{ version: "2026-10-13" }, { version: "2026-10-13" }]);
    await page.reload();
    await expect(page.getByRole("button", { name: "accept and continue" })).toBeDisabled();
  });
});
