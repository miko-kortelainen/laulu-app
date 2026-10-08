import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { authSession, seedAuth } from "./auth-fixture.mjs";

const session = `musical-recovery-e2e-${process.pid}`;
const url = process.env.E2E_URL;
const run = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 30000 }).trim();
const usage = { resetAt: "2099-01-01T00:00:00Z", chat: { limit: 20, used: 1, remaining: 19 },
  analysis: { limit: 10, used: 1, remaining: 9 }, generation: { limit: 5, used: 1, remaining: 4 },
  storage: { limit: 536870912, used: 0, reserved: 100, remaining: 536870812 } };
const audio = { url: "/api/audio/10000000-0000-4000-8000-000000000002.wav", name: "reference.wav" };
const route = (pattern, data) => { run("network", "unroute", pattern); run("network", "route", pattern, "--body", JSON.stringify(data)); };
const operation = (id, kind, state, result = null, status = "working...") => ({ id, kind, state, result, status });

try {
  route("**/api/context", { messages: 0, limit: 40 });
  route("**/api/usage", usage);
  route("**/api/operations", { operations: [] });
  await seedAuth(run, url);
  run("wait", "--text", "19 / 20 remaining");
  run("fill", "[name=genre]", "recovery folk");
  run("fill", "[name=lyrics]", "keep these lyrics");
  run("eval", `const key = 'music-draft:${authSession().user.id}';
    sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)), pendingAudio: ${JSON.stringify(audio)} })); location.reload();`);
  run("wait", "--text", "reference.wav");
  run("wait", "--text", "19 / 20 remaining");

  // Lose the start response after server acceptance. Polling must recover, never POST again.
  run("eval", `const original = window.fetch; window.fetch = (input, options) => {
    if (input === '/api/music') {
      sessionStorage.setItem('start-body', options.body);
      sessionStorage.setItem('generation-posts', String(Number(sessionStorage.getItem('generation-posts') || 0) + 1));
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (typeof input === 'string' && /^\\/api\\/operations\\/[^/]+$/.test(input)) {
      return Promise.resolve(Response.json({ operation: { id: JSON.parse(sessionStorage.getItem('start-body')).operationId,
        kind: 'music', state: 'running', status: 'saving track...', result: null } }));
    }
    return original(input, options);
  };`);
  run("click", "aside > button");
  run("wait", "--text", "saving track...");
  const id = JSON.parse(run("eval", "JSON.parse(sessionStorage.getItem('start-body')).operationId"));
  route("**/api/operations", { operations: [operation(id, "music", "running")] });
  route(`**/api/operations/${id}`, { operation: operation(id, "music", "running", null, "generating track...") });
  run("reload");
  run("wait", "--text", "generating track...");
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '"recovery folk"');
  assert.equal(run("eval", "document.querySelector('[name=lyrics]').value"), '"keep these lyrics"');
  assert.equal(run("eval", "document.querySelector('aside > button').disabled"), "true");

  route(`**/api/operations/${id}`, { operation: operation(id, "music", "completed", { track: { url: `/api/music/${id}.mp3`, lyrics: "recovered lyrics" } }, "") });
  route(`**/api/operations/${id}/acknowledge`, {});
  run("wait", "--text", "your track is ready.");
  run("wait", "--text", "4 / 5 remaining");
  assert.equal(run("eval", "sessionStorage.getItem('generation-posts')"), '"1"');
  assert.equal(run("eval", "document.querySelector('aside > button').disabled"), "false");

  // Analysis through chat also survives a reload and temporary disconnection.
  const chatId = "10000000-0000-4000-8000-000000000003";
  route("**/api/operations", { operations: [operation(chatId, "chat", "running")] });
  route(`**/api/operations/${chatId}`, { operation: operation(chatId, "chat", "running", null, "analyzing audio...") });
  run("eval", `const key = 'music-draft:${authSession().user.id}';
    sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)), pendingChatId: '${chatId}' }));`);
  run("reload");
  run("wait", "--text", "analyzing audio...");
  run("network", "unroute", `**/api/operations/${chatId}`);
  run("network", "route", `**/api/operations/${chatId}`, "--abort");
  run("wait", "--text", "reconnecting to your request...");
  const updatedPrompt = { genre: "analysis folk", mood: "", key: "", bpm: "", duration: "", vocals: "",
    instruments: "", production: "", lyrics: "recovered words" };
  const completedChat = operation(chatId, "chat", "completed", { reply: "recovered audio analysis", musicPrompt: updatedPrompt }, "");
  route(`**/api/operations/${chatId}`, { operation: completedChat });
  route(`**/api/operations/${chatId}/acknowledge`, {});
  run("wait", "--text", "recovered audio analysis");
  run("wait", "--fn", '!document.querySelector("fieldset").disabled');
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '"analysis folk"');
  assert.equal(run("eval", "document.querySelector('footer').innerText.includes('reference.wav')"), "false");
  assert.equal(run("eval", "sessionStorage.getItem('generation-posts')"), '"1"');

  // An old unacknowledged result must preserve edits and a newer attachment.
  run("fill", "[name=genre]", "recovery folk");
  run("eval", `const key = 'music-draft:${authSession().user.id}';
    sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)), pendingAudio: ${JSON.stringify(audio)} }));`);
  route("**/api/operations", { operations: [completedChat] });
  run("reload");
  run("wait", "--text", "recovered audio analysis");
  run("wait", "--text", "19 / 20 remaining");
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '"recovery folk"');
  assert.equal(run("eval", "document.querySelector('footer').innerText.includes('reference.wav')"), "true");

  // Retry discovery without unlocking. A failed acknowledgement must not block later work.
  const laterId = "10000000-0000-4000-8000-000000000005";
  run("network", "unroute", "**/api/operations");
  run("network", "route", "**/api/operations", "--abort");
  run("reload");
  run("wait", "--text", "reconnecting to your request...");
  assert.equal(run("eval", "document.querySelector('aside > button').disabled"), "true");
  run("network", "unroute", `**/api/operations/${chatId}/acknowledge`);
  run("network", "route", `**/api/operations/${chatId}/acknowledge`, "--abort");
  route(`**/api/operations/${laterId}`, { operation: operation(laterId, "chat", "running", null, "recovering later analysis...") });
  route(`**/api/operations/${laterId}/acknowledge`, {});
  route("**/api/operations", { operations: [completedChat, operation(laterId, "chat", "running")] });
  run("wait", "--text", "recovering later analysis...");
  assert.equal(run("eval", "document.querySelector('aside > button').disabled"), "true");
  run("eval", `window.ackAttempts = 0; window.failAck = true; window.ackSucceeded = false;
    const original = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/operations/${chatId}/acknowledge') {
        window.ackAttempts++;
        if (window.failAck) return Promise.resolve(Response.json({}, { status: 503 }));
        return original(input, options).then(response => { window.ackSucceeded = response.ok; return response; });
      }
      return original(input, options);
    };`);
  run("wait", "--fn", "window.ackAttempts >= 2");
  route(`**/api/operations/${chatId}/acknowledge`, {});
  run("eval", "window.failAck = false");
  run("wait", "--fn", "window.ackSucceeded");
  assert.equal(run("eval", "document.querySelector('main').innerText.split('recovered audio analysis').length"), "2");
  route(`**/api/operations/${laterId}`, { operation: operation(laterId, "chat", "completed", { reply: "later answer recovered" }, "") });
  run("wait", "--text", "later answer recovered");
  run("wait", "--fn", '!document.querySelector("fieldset").disabled');
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '"recovery folk"');
  assert.equal(run("eval", "document.querySelector('footer').innerText.includes('reference.wav')"), "true");

  const unknownId = "10000000-0000-4000-8000-000000000004";
  const unknown = operation(unknownId, "music", "unknown", { error: "the outcome is unknown; your song allowance remains reserved." }, "");
  route("**/api/operations", { operations: [unknown] });
  route(`**/api/operations/${unknownId}`, { operation: unknown });
  route(`**/api/operations/${unknownId}/acknowledge`, {});
  run("reload");
  run("wait", "--text", "your song allowance remains reserved");
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '"recovery folk"');
  assert.equal(run("eval", "sessionStorage.getItem('generation-posts')"), '"1"');

  route("**/api/operations", { operations: [] });
  await seedAuth(run, url, authSession("10000000-0000-4000-8000-000000000099", "other@example.com"));
  run("wait", "--text", "other@example.com");
  run("wait", "--text", "19 / 20 remaining");
  assert.equal(run("eval", "document.querySelector('[name=genre]').value"), '""');
  assert.equal(run("eval", "document.querySelector('main').innerText.includes('reference.wav')"), "false");
  console.log("Recovery E2E passed: reloads, reconnects, draft protection, acknowledgement retries, unknown outcomes, and account isolation.");
} finally {
  run("close");
}
