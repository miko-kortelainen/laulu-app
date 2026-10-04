export const authOrigin = process.env.E2E_AUTH_ORIGIN;
export const storageKey = `sb-${new URL(authOrigin).hostname.split(".")[0]}-auth-token`;

export function authSession(id = "10000000-0000-4000-8000-000000000001", email = "test@example.com", expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access_token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: `${authOrigin}/auth/v1`, sub: id, aud: "authenticated", role: "authenticated", iat: now, exp: now + expiresIn,
  })}.c2lnbmF0dXJl`;
  return { access_token, refresh_token: `offline-refresh-${id}`, token_type: "bearer", expires_in: expiresIn,
    expires_at: now + expiresIn, user: { id, email, aud: "authenticated", role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, created_at: new Date().toISOString(),
    } };
}

export async function seedAuth(run, url, session = authSession()) {
  await run("open", "about:blank");
  await run("network", "route", `${authOrigin}/auth/v1/user`, "--body", JSON.stringify(session.user));
  await run("open", url);
  await run("eval", `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(session))}); location.reload();`);
}
