import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authOrigin, authSession, storageKey } from "./auth-fixture.mjs";

const exec = promisify(execFile);
const session = `musical-auth-e2e-${process.pid}`;
const run = async (...args) => (await exec("agent-browser", ["--session", session, ...args], { timeout: 30000 })).stdout.trim();
const url = process.env.E2E_URL;
const first = authSession();
first.user.email_confirmed_at = "2026-01-15T12:00:00Z";
first.user.created_at = "2026-01-15T12:00:00Z";
first.user.last_sign_in_at = "2026-10-05T12:00:00Z";
const second = authSession("20000000-0000-4000-8000-000000000002", "second@example.com");
const captcha = Boolean(process.env.E2E_CAPTCHA);

async function verify() {
  if (!captcha) return;
  await run("wait", "--fn", "Boolean(window.captchaOptions)");
  await run("eval", "window.captchaOptions.callback('offline-captcha-token')");
}

async function clickSubmit() {
  await verify();
  await run("click", 'button[type="submit"]');
}

async function submit(email = first.user.email, password = "offline-password") {
  await run("fill", "#auth-email", email);
  await run("fill", "#auth-password", password);
  await clickSubmit();
}

try {
  await run("open", "about:blank");
  if (captcha) await run("network", "route", "https://challenges.cloudflare.com/turnstile/v0/api.js*", "--body", `
    window.captchaRenders = 0;
    window.turnstile = {
      render(container, options) { window.captchaOptions = options; return String(++window.captchaRenders); },
      remove() { window.captchaOptions = undefined; }
    };`);
  await run("network", "route", `${authOrigin}/auth/v1/user`, "--body", JSON.stringify(first.user));
  await run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  await run("open", `${url}/profile`);
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("focus", "#auth-email");
  await run("press", "Tab");
  assert.equal(await run("eval", "document.activeElement.id"), '"auth-password"');

  await run("find", "role", "button", "click", "--name", "register", "--exact");
  if (captcha) {
    await run("wait", "--fn", "Boolean(window.captchaOptions)");
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "true");
    await verify();
    await run("eval", "window.captchaOptions['expired-callback']()");
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "true");
    await run("eval", "window.captchaOptions['error-callback']()");
    await run("wait", "--text", "verification could not finish.");
    await run("find", "role", "button", "click", "--name", "retry verification", "--exact");
    await run("eval", `window.captchaRequests = []; const beforeCaptcha = window.fetch;
      window.fetch = (input, options) => {
        if (['signup', 'resend', 'recover'].some(path => String(input).includes('/auth/v1/' + path))) window.captchaRequests.push(JSON.parse(options.body));
        return beforeCaptcha(input, options);
      };`);
  }
  await run("network", "route", `${authOrigin}/auth/v1/signup*`, "--body", JSON.stringify({ user: first.user, session: null }));
  await submit();
  await run("wait", "--text", "check your email to confirm your account");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("network", "route", `${authOrigin}/auth/v1/resend*`, "--body", "{}");
  if (captcha) {
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "true", "a consumed token must be replaced");
    assert.equal(await run("eval", "window.captchaRequests[0].gotrue_meta_security.captcha_token"), '"offline-captcha-token"');
  }
  await verify();
  await run("find", "role", "button", "click", "--name", "resend confirmation", "--exact");
  await run("wait", "--text", "check your email for a confirmation link.");
  if (captcha) assert.equal(await run("eval", "window.captchaRequests[1].gotrue_meta_security.captcha_token"), '"offline-captcha-token"');

  // The actual Supabase SDK processes the confirmation callback and removes its tokens.
  const hash = new URLSearchParams({ access_token: first.access_token, refresh_token: first.refresh_token,
    expires_in: "3600", token_type: "bearer", type: "signup" });
  await run("open", `${url}/#${hash}`);
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", "location.hash"), '""');
  await run("network", "route", `${authOrigin}/auth/v1/logout*`, "--body", "{}");
  await run("eval", `window.sessionEndRequests = []; window.failSessionEnd = true; const beforeSessionEnd = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/session/end') {
        window.sessionEndRequests.push({ method: options.method, token: new Headers(options.headers).get('authorization') });
        if (window.failSessionEnd) return Promise.resolve(new Response(null, { status: 500 }));
      }
      return beforeSessionEnd(input, options);
    };`);
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "could not delete session uploads. try logging out again.");
  assert.equal(await run("eval", "Boolean(document.querySelector('section[aria-label=chat]'))"), "true", "cleanup failure keeps the user signed in for retry");
  await run("eval", "window.failSessionEnd = false");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.deepEqual(JSON.parse(await run("eval", "window.sessionEndRequests")), Array(2).fill({ method: "POST", token: `Bearer ${first.access_token}` }));

  // Failed login preserves form state, followed by successful recovery.
  await run("eval", `window.authFetch = window.fetch; window.failLogin = true;
    window.fetch = (input, options) => String(input).includes('/auth/v1/token') && window.failLogin
      ? Promise.resolve(Response.json({ code: 'invalid_credentials', msg: 'invalid login credentials' }, { status: 400 }))
      : window.authFetch(input, options);`);
  await submit();
  await run("wait", "--text", "invalid login credentials");
  assert.equal(await run("eval", 'document.querySelector("#auth-email").value'), JSON.stringify(first.user.email));
  assert.equal(await run("eval", 'document.querySelector("#auth-password").value'), '"offline-password"');
  await run("eval", "window.failLogin = false");
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(first));
  await clickSubmit();
  await run("wait", "--text", "0 / 40 messages");
  await run("eval", "location.reload()");
  await run("wait", "--text", "0 / 40 messages");

  // Profile routing uses the current user and preserves the song form on return.
  await run("fill", 'input[name="genre"]', "retained song style");
  await run("find", "role", "link", "click", "--name", "profile", "--exact");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "location.pathname"), '"/profile"');
  assert.equal(await run("eval", "document.querySelector('a[aria-current=page]').textContent.trim()"), '"profile"');
  assert.deepEqual(JSON.parse(await run("eval", "Array.from(document.querySelectorAll('dd'), element => element.textContent)")), [
    first.user.email, "confirmed",
    JSON.parse(await run("eval", `new Date(${JSON.stringify(first.user.created_at)}).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })`)),
    JSON.parse(await run("eval", `new Date(${JSON.stringify(first.user.last_sign_in_at)}).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })`)),
  ]);
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("back");
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", 'document.querySelector("input[name=genre]").value'), '"retained song style"');
  await run("find", "role", "link", "click", "--name", "profile", "--exact");
  await run("eval", "location.reload()");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "location.pathname"), '"/profile"');
  await run("find", "role", "link", "click", "--name", "chat", "--exact");
  await run("wait", "--text", "0 / 40 messages");

  // The real SDK refreshes an expired saved session through the mocked token endpoint.
  const expired = authSession(first.user.id, first.user.email, -5);
  await run("eval", `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(expired))}); location.reload();`);
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", `JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).expires_at > Date.now() / 1000`), "true");

  // An authenticated request carries a token. Logout aborts its pending result.
  await run("eval", `window.requestHeaders = []; window.pendingAborted = false; const fetchBeforeChat = window.fetch;
    window.fetch = (input, options) => input === '/api/chat' ? new Promise((resolve, reject) => {
      window.requestHeaders.push(new Headers(options.headers).get('authorization'));
      options.signal.addEventListener('abort', () => { window.pendingAborted = true; reject(new DOMException('aborted', 'AbortError')); });
    }) : fetchBeforeChat(input, options);`);
  await run("click", 'button[aria-label="Open prompt input"]');
  await run("fill", "textarea:not([name])", "private pending message");
  await run("click", 'button[aria-label="Send prompt"]');
  await run("wait", "--text", "thinking...");
  assert.equal(await run("eval", "window.requestHeaders[0]"), JSON.stringify(`Bearer ${first.access_token}`));
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "window.pendingAborted"), "true");
  assert.equal(await run("eval", `localStorage.getItem(${JSON.stringify(storageKey)})`), "null");
  await run("network", "unroute", `${authOrigin}/auth/v1/token*`);
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(second));
  await submit(second.user.email);
  await run("wait", "--text", second.user.email);
  assert.equal(await run("eval", 'document.body.innerText.includes("private pending message")'), "false");
  await run("find", "role", "link", "click", "--name", "profile", "--exact");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "document.querySelector('dd').textContent"), JSON.stringify(second.user.email));
  assert.equal(await run("eval", "document.querySelectorAll('dd')[1].textContent"), '"not confirmed"');
  assert.equal(await run("eval", "document.querySelectorAll('dd')[3].textContent"), '"not available"');
  await run("eval", `const beforeLogout = window.fetch; window.failLogout = true;
    window.fetch = (input, options) => String(input).includes('/auth/v1/logout') && window.failLogout
      ? Promise.resolve(Response.json({ msg: 'logout unavailable' }, { status: 400 })) : beforeLogout(input, options);`);
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "logout unavailable");
  assert.equal(await run("eval", 'document.querySelector("#profile-title")'), "null");
  await run("eval", "window.failLogout = false");
  await submit(second.user.email);
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "document.querySelector('dd').textContent"), JSON.stringify(second.user.email));
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", 'document.querySelector("#profile-title")'), "null");
  await run("open", url);
  await run("wait", "--text", "log in");

  // Recovery email failures preserve the form. The recovery callback gates chat.
  await run("find", "role", "button", "click", "--name", "forgot password?", "--exact");
  await run("fill", "#auth-email", first.user.email);
  await run("eval", `const beforeRecover = window.fetch; window.failRecovery = true;
    window.fetch = (input, options) => String(input).includes('/auth/v1/recover') && window.failRecovery
      ? Promise.resolve(Response.json({ msg: 'email delivery failed' }, { status: 400 })) : beforeRecover(input, options);`);
  await clickSubmit();
  await run("wait", "--text", "email delivery failed");
  await run("eval", "window.failRecovery = false");
  await run("network", "route", `${authOrigin}/auth/v1/recover*`, "--body", "{}");
  await clickSubmit();
  await run("wait", "--text", "if an account exists");
  hash.set("type", "recovery");
  await run("open", `${url}/#${hash}`);
  await run("wait", "--text", "save new password");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("network", "route", `${authOrigin}/auth/v1/user`, "--body", JSON.stringify(first.user));
  await run("fill", "#auth-password", "new-offline-password");
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "0 / 40 messages");
  await run("wait", "--fn", "document.querySelector('header button')?.disabled === false");
  await run("click", "header button");
  await run("wait", "--text", "log in");
  await run("open", `${url}/#error=access_denied&error_description=link%20expired&type=recovery`);
  await run("wait", "--text", "link expired");
  assert.equal(await run("eval", "location.hash"), '""');
  assert.equal(await run("eval", 'document.querySelector("h1").innerText'), '"log in"');
  console.log(`Auth E2E passed: ${captcha ? "CAPTCHA expiry, failure recovery and token reset, " : ""}registration, confirmation, resend, login recovery, profile navigation and reload, retained song form, logout cancellation, account isolation, password recovery, and expired links.`);
} catch (error) {
  process.stderr.write(`${await run("snapshot")}\n`);
  throw error;
} finally {
  await run("close");
}
