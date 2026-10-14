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

async function submit(email = first.user.email, password = "offline-password", confirmPassword = password) {
  await run("fill", "#auth-email", email);
  await run("fill", "#auth-password", password);
  if (await run("eval", "Boolean(document.querySelector('#auth-confirm-password'))") === "true") {
    await run("fill", "#auth-confirm-password", confirmPassword);
  }
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
  await run("network", "route", "**/api/terms", "--body", '{"accepted":true,"version":"2026-10-13"}');
  await run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  await run("open", `${url}/profile`);
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "location.pathname"), '"/login"');
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("focus", "#auth-email");
  await run("press", "Tab");
  assert.equal(await run("eval", "document.activeElement.id"), '"auth-password"');

  // The notice is public, survives a direct reload, and links back to login.
  await run("find", "role", "link", "click", "--name", "privacy and beta limits", "--exact");
  await run("wait", "--text", "AI processing");
  assert.equal(await run("eval", "location.pathname"), '"/privacy"');
  assert.equal(await run("eval", 'document.querySelector("#auth-email")'), "null");
  assert.equal(await run("eval", "document.querySelector('a[href^=mailto]').getAttribute('href')"), '"mailto:miko@kortelainen.dev"');
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("eval", "location.reload()");
  await run("wait", "--text", "privacy and beta limits");
  for (const pathname of ["/privacy/", "/PRIVACY"]) {
    await run("open", `${url}${pathname}`);
    await run("wait", "--text", "AI processing");
    assert.equal(await run("eval", 'document.querySelector("#auth-email")'), "null");
  }
  await run("find", "role", "link", "click", "--name", "back to app", "--exact");
  await run("wait", "--text", "log in");

  await run("open", `${url}/terms`);
  await run("wait", "--text", "You must be at least 18 years old");
  assert.equal(await run("eval", "document.body.textContent.includes('at least 13')"), "false");
  await run("open", `${url}/create-account`);
  await run("wait", 'section[aria-label="create account"]');
  assert.equal(await run("eval", "document.querySelector('#auth-terms').checked"), "false");
  await run("wait", "--text", "i am 18 or older and accept the");
  assert.equal(await run("eval", "location.pathname"), '"/create-account"');
  await verify();
  const retainedCaptchaRenders = captcha ? await run("eval", "window.captchaRenders") : undefined;
  await run("find", "role", "link", "click", "--name", "back to login", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "location.pathname"), '"/login"');
  await run("find", "role", "link", "click", "--name", "create account", "--exact");
  await run("wait", 'section[aria-label="create account"]');
  assert.equal(await run("eval", "location.pathname"), '"/create-account"');
  if (captcha) {
    assert.equal(await run("eval", "window.captchaRenders"), retainedCaptchaRenders, "form links retain the existing widget");
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "false", "form links retain unused verification");
  }
  for (const direction of ["back", "forward"]) {
    await run("fill", "#auth-password", "history-password");
    if (direction === "back") await run("fill", "#auth-confirm-password", "history-password");
    await verify();
    await run(direction);
    await run("wait", `section[aria-label="${direction === "back" ? "log in" : "create account"}"]`);
    assert.equal(await run("eval", 'document.querySelector("#auth-password").value'), '""', "history navigation clears the previous password");
    assert.equal(await run("eval", "document.querySelector('#auth-confirm-password')?.value ?? null"), direction === "back" ? "null" : '""', "confirmation is registration-only and clears on navigation");
    if (captcha) {
      assert.equal(await run("eval", "window.captchaRenders"), retainedCaptchaRenders, "history navigation retains the existing widget");
      assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "false", "history navigation retains unused verification");
    }
  }
  if (captcha) {
    await run("wait", "--fn", "Boolean(window.captchaOptions)");
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "false");
    await verify();
    await run("eval", "window.captchaOptions['expired-callback']()");
    assert.equal(await run("eval", "document.querySelector('button[type=submit]').disabled"), "true");
    await run("eval", "window.captchaOptions['error-callback']()");
    await run("wait", "--text", "verification could not finish.");
    await run("find", "role", "button", "click", "--name", "retry verification", "--exact");
    await run("eval", `window.captchaRequests = []; const beforeCaptcha = window.fetch;
      window.fetch = (input, options) => {
        if (['signup', 'recover'].some(path => String(input).includes('/auth/v1/' + path))) window.captchaRequests.push(JSON.parse(options.body));
        return beforeCaptcha(input, options);
      };`);
  }
  await run("network", "route", `${authOrigin}/auth/v1/signup*`, "--body", JSON.stringify({ user: first.user, session: null }));
  await run("eval", `window.signupRequests = 0; const beforeSignup = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).includes('/auth/v1/signup')) window.signupRequests++;
      return beforeSignup(input, options);
    };`);
  await submit();
  assert.equal(await run("eval", "document.querySelector('#auth-terms').validity.valueMissing"), "true");
  assert.equal(await run("eval", "window.signupRequests"), "0");
  await run("eval", "document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))");
  await run("wait", "--text", "confirm you are 18 or older and accept the terms of service to create an account.");
  assert.equal(await run("eval", "window.signupRequests"), "0", "the submit action also requires terms acceptance");
  assert.equal(await run("eval", "document.querySelector('label[for=auth-terms] a').getAttribute('href')"), JSON.stringify("/terms"));
  await run("focus", "#auth-terms");
  await run("press", "Space");
  await submit(first.user.email, "offline-password", "different-password");
  await run("wait", "--text", "passwords don't match");
  assert.equal(await run("eval", "window.signupRequests"), "0", "mismatched passwords do not submit signup");
  assert.equal(await run("eval", "document.querySelector('#auth-confirm-password').getAttribute('aria-invalid')"), '"true"');
  assert.equal(await run("eval", "document.querySelector('#auth-password').value"), '"offline-password"', "a mismatch preserves the password for correction");
  await submit();
  await run("wait", "--text", "check your email to confirm your account.");
  assert.equal(await run("eval", "window.signupRequests"), "1");
  assert.equal(await run("eval", "document.querySelector('form')"), "null", "successful registration replaces the form with confirmation guidance");
  assert.equal(await run("eval", "getComputedStyle(document.querySelector('[role=status]')).textAlign"), '"center"');
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  if (captcha) {
    assert.equal(await run("eval", "Boolean(window.captchaOptions)"), "false", "successful registration removes the CAPTCHA");
    assert.equal(await run("eval", "window.captchaRequests[0].gotrue_meta_security.captcha_token"), '"offline-captcha-token"');
  }
  await run("back");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "document.querySelector('[role=status]').textContent"), '""', "history navigation clears the registration notice");
  await run("forward");
  await run("wait", 'section[aria-label="create account"]');
  assert.equal(await run("eval", "document.querySelector('#auth-terms').checked"), "false", "history navigation requires fresh acceptance");
  assert.equal(await run("eval", "document.querySelector('#auth-confirm-password').value"), '""', "returning to registration clears password confirmation");
  assert.equal(await run("eval", "document.querySelector('[role=status]').textContent"), '""');

  // The actual Supabase SDK processes the confirmation callback and removes its tokens.
  const hash = new URLSearchParams({ access_token: first.access_token, refresh_token: first.refresh_token,
    expires_in: "3600", token_type: "bearer", type: "signup" });
  await run("open", `${url}/#${hash}`);
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", "location.pathname"), JSON.stringify("/"), "account confirmation opens chat");
  await run("open", `${url}/create-account`);
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", "location.pathname"), JSON.stringify("/"), "authenticated account creation opens chat");
  assert.equal(await run("eval", "location.hash"), '""');
  await run("set", "viewport", "1280", "900");
  await run("network", "route", `${authOrigin}/auth/v1/logout*`, "--body", "{}");
  await run("eval", `window.sessionEndRequests = []; window.failSessionEnd = true; const beforeSessionEnd = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/session/end') {
        window.sessionEndRequests.push({ method: options.method, token: new Headers(options.headers).get('authorization') });
        if (window.failSessionEnd) return Promise.resolve(new Response(null, { status: 500 }));
      }
      return beforeSessionEnd(input, options);
    };`);
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--text", "member since");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "could not delete session uploads. try logging out again.");
  assert.equal(await run("eval", "Boolean(document.querySelector('#profile-title'))"), "true", "cleanup failure keeps the user signed in for retry");
  await run("eval", "window.failSessionEnd = false");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.deepEqual(JSON.parse(await run("eval", "window.sessionEndRequests")), Array(2).fill({ method: "POST", token: `Bearer ${first.access_token}` }));

  // Failed login preserves form state, followed by successful recovery.
  await run("eval", `window.authFetch = window.fetch; window.failLogin = true;
    window.fetch = (input, options) => String(input).includes('/auth/v1/token') && window.failLogin
      ? Promise.resolve(Response.json({ code: 'invalid_credentials', msg: 'invalid login credentials' }, { status: 400 }))
      : window.authFetch(input, options);`);
  const loginFormHeight = await run("eval", "document.querySelector('form').getBoundingClientRect().height");
  await submit();
  await run("wait", "--text", "invalid login credentials");
  assert.equal(await run("eval", "document.querySelector('#auth-login-error').textContent"), '"invalid login credentials"');
  assert.equal(await run("eval", "document.querySelector('form').getBoundingClientRect().height"), loginFormHeight, "login errors use reserved space");
  assert.equal(await run("eval", 'document.querySelector("#auth-email").value'), JSON.stringify(first.user.email));
  assert.equal(await run("eval", 'document.querySelector("#auth-password").value'), '"offline-password"');
  await run("eval", "window.failLogin = false");
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(first));
  await clickSubmit();
  await run("wait", "--text", "member since");
  await run("find", "role", "link", "click", "--name", "studio", "--exact");
  await run("wait", "--text", "0 / 40 messages");
  await run("eval", "location.reload()");
  await run("wait", "--text", "0 / 40 messages");

  // Profile routing uses the current user and preserves the song form on return.
  await run("fill", 'input[name="genre"]', "retained song style");
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "location.pathname"), '"/profile"');
  assert.equal(await run("eval", "document.querySelector('a[aria-current=page]').textContent.trim()"), '"my profile"');
  assert.deepEqual(JSON.parse(await run("eval", "Array.from(document.querySelectorAll('#profile-title + dl dd'), element => element.textContent)")), [
    first.user.email, "confirmed",
    JSON.parse(await run("eval", `new Date(${JSON.stringify(first.user.created_at)}).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })`)),
    JSON.parse(await run("eval", `new Date(${JSON.stringify(first.user.last_sign_in_at)}).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })`)),
  ]);
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("back");
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", 'document.querySelector("input[name=genre]").value'), '"retained song style"');
  await run("find", "role", "link", "click", "--name", "privacy", "--exact");
  await run("wait", "--text", "LangSmith tracing is disabled in the production beta.");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("find", "role", "link", "click", "--name", "back to app", "--exact");
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", 'document.querySelector("input[name=genre]").value'), '"retained song style"');
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("eval", "location.reload()");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "location.pathname"), '"/profile"');
  await run("find", "role", "link", "click", "--name", "studio", "--exact");
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
  await run("click", 'textarea[aria-label="Prompt message"]');
  await run("fill", "textarea:not([name])", "private pending message");
  await run("click", 'button[aria-label="Send prompt"]');
  await run("wait", "--text", "thinking...");
  assert.equal(await run("eval", "window.requestHeaders[0]"), JSON.stringify(`Bearer ${first.access_token}`));
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--text", "member since");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "window.pendingAborted"), "true");
  assert.equal(await run("eval", `localStorage.getItem(${JSON.stringify(storageKey)})`), "null");
  await run("network", "unroute", `${authOrigin}/auth/v1/token*`);
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(second));
  await submit(second.user.email);
  await run("wait", "--text", second.user.email);
  assert.equal(await run("eval", 'document.body.innerText.includes("private pending message")'), "false");
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--text", "member since");
  assert.equal(await run("eval", "document.querySelector('dd').textContent"), JSON.stringify(second.user.email));
  assert.equal(await run("eval", "document.querySelectorAll('#profile-title + dl dd')[1].textContent"), '"not confirmed"');
  assert.equal(await run("eval", "document.querySelectorAll('#profile-title + dl dd')[3].textContent"), '"not available"');
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
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--fn", "document.querySelector('main section > button')?.disabled === false");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  await run("open", `${url}/#error=access_denied&error_description=link%20expired&type=recovery`);
  await run("wait", "--text", "link expired");
  assert.equal(await run("eval", "location.hash"), '""');
  assert.equal(await run("eval", "document.querySelector('button[type=submit]').textContent.trim()"), '"log in"');
  console.log(`Auth E2E passed: ${captcha ? "CAPTCHA expiry, failure recovery and token reset, " : ""}public privacy notice and reload, registration, confirmation guidance, login recovery, profile navigation and reload, retained song form across privacy navigation, logout cancellation, account isolation, password recovery, and expired links.`);
} catch (error) {
  process.stderr.write(`${await run("snapshot")}\n`);
  throw error;
} finally {
  await run("close");
}
