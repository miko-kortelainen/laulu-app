import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authOrigin, authSession, storageKey } from "./auth-fixture.mjs";

const exec = promisify(execFile);
const session = `musical-auth-e2e-${process.pid}`;
const run = async (...args) => (await exec("agent-browser", ["--session", session, ...args], { timeout: 30000 })).stdout.trim();
const url = process.env.E2E_URL;
const first = authSession();
const second = authSession("20000000-0000-4000-8000-000000000002", "second@example.com");

async function submit(email = first.user.email, password = "offline-password") {
  await run("fill", "#auth-email", email);
  await run("fill", "#auth-password", password);
  await run("click", 'button[type="submit"]');
}

try {
  await run("open", "about:blank");
  await run("network", "route", `${authOrigin}/auth/v1/user`, "--body", JSON.stringify(first.user));
  await run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  await run("open", url);
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("focus", "#auth-email");
  await run("press", "Tab");
  assert.equal(await run("eval", "document.activeElement.id"), '"auth-password"');

  await run("find", "role", "button", "click", "--name", "register", "--exact");
  await run("network", "route", `${authOrigin}/auth/v1/signup*`, "--body", JSON.stringify({ user: first.user, session: null }));
  await submit();
  await run("wait", "--text", "check your email to confirm your account");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("network", "route", `${authOrigin}/auth/v1/resend*`, "--body", "{}");
  await run("find", "role", "button", "click", "--name", "resend confirmation", "--exact");
  await run("wait", "--text", "check your email for a confirmation link.");

  // The actual Supabase SDK processes the confirmation callback and removes its tokens.
  const hash = new URLSearchParams({ access_token: first.access_token, refresh_token: first.refresh_token,
    expires_in: "3600", token_type: "bearer", type: "signup" });
  await run("open", `${url}/#${hash}`);
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", "location.hash"), '""');
  await run("network", "route", `${authOrigin}/auth/v1/logout*`, "--body", "{}");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");

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
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "0 / 40 messages");
  await run("eval", "location.reload()");
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
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");

  // Recovery email failures preserve the form. The recovery callback gates chat.
  await run("find", "role", "button", "click", "--name", "forgot password?", "--exact");
  await run("fill", "#auth-email", first.user.email);
  await run("eval", `const beforeRecover = window.fetch; window.failRecovery = true;
    window.fetch = (input, options) => String(input).includes('/auth/v1/recover') && window.failRecovery
      ? Promise.resolve(Response.json({ msg: 'email delivery failed' }, { status: 400 })) : beforeRecover(input, options);`);
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "email delivery failed");
  await run("eval", "window.failRecovery = false");
  await run("network", "route", `${authOrigin}/auth/v1/recover*`, "--body", "{}");
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "if an account exists");
  hash.set("type", "recovery");
  await run("open", `${url}/#${hash}`);
  await run("wait", "--text", "save new password");
  assert.equal(await run("eval", 'document.querySelector("section[aria-label=chat]")'), "null");
  await run("network", "route", `${authOrigin}/auth/v1/user`, "--body", JSON.stringify(first.user));
  await run("fill", "#auth-password", "new-offline-password");
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "0 / 40 messages");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  await run("open", `${url}/#error=access_denied&error_description=link%20expired&type=recovery`);
  await run("wait", "--text", "link expired");
  assert.equal(await run("eval", "location.hash"), '""');
  assert.equal(await run("eval", 'document.querySelector("h1").innerText'), '"log in"');
  console.log("Auth E2E passed: registration, confirmation, resend, login recovery, reload, logout cancellation, account isolation, password recovery, and expired links.");
} catch (error) {
  process.stderr.write(`${await run("snapshot")}\n`);
  throw error;
} finally {
  await run("close");
}
