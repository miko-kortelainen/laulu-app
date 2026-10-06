import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authOrigin, authSession, seedAuth } from "./auth-fixture.mjs";

const exec = promisify(execFile);
const session = `musical-songs-e2e-${process.pid}`;
const run = async (...args) => (await exec("agent-browser", ["--session", session, ...args], { timeout: 30000 })).stdout.trim();
const url = process.env.E2E_URL;
const first = authSession();
const second = authSession("20000000-0000-4000-8000-000000000002", "second@example.com");
const songs = [
  { id: "11111111-1111-4111-8111-111111111111", prompt: "warm acoustic folk", lyrics: "a quiet morning", model: "lyria-3.5", createdAt: "2026-10-06T10:00:00Z" },
  { id: "22222222-2222-4222-8222-222222222222", prompt: "instrumental piano", lyrics: "", model: "lyria-3.5", createdAt: "2026-10-05T10:00:00Z" },
].map((song) => ({ ...song, url: `/api/music/${song.id}.mp3`, sizeBytes: 16044 }));

async function listResponse(items) {
  await run("network", "unroute", "**/api/songs");
  await run("network", "route", "**/api/songs", "--body", JSON.stringify({ songs: items }));
}

try {
  await run("open", `${url}/songs`);
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "document.querySelector('#songs-title')"), "null");
  await run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  await run("network", "route", "**/api/songs", "--body", '{"songs":[]}');
  await seedAuth(run, `${url}/songs`, first);
  await run("wait", "--text", "no saved songs yet.");
  assert.equal(await run("eval", "location.pathname"), '"/songs"');
  await run("find", "role", "link", "click", "--name", "create a song in chat", "--exact");
  await run("wait", "--text", "0 / 40 messages");
  await run("fill", 'input[name="genre"]', "retained song style");
  await listResponse(songs);
  await run("eval", `window.songRequests = []; window.songFailure = false; window.badSongs = false;
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).startsWith('/api/')) window.songRequests.push({ url: String(input), token: new Headers(options.headers).get('authorization') });
      if (input === '/api/songs' && window.songFailure) return Promise.resolve(Response.json({}, { status: 503 }));
      if (input === '/api/songs' && window.badSongs) return Promise.resolve(Response.json({ songs: [{ ...${JSON.stringify(songs[0])}, url: 'https://invalid.example/song.mp3' }] }));
      return originalFetch(input, options);
    };
    window.songDownloads = [];
    HTMLAnchorElement.prototype.click = function() { window.songDownloads.push({ name: this.download, href: this.href }); };`);
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "song 2");
  assert.equal(await run("eval", "document.querySelector('a[aria-current=page]').textContent.trim()"), '"my songs"');
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "2");
  assert.equal(await run("eval", "document.querySelector('main time').dateTime"), JSON.stringify(songs[0].createdAt));
  assert.equal(await run("eval", "window.songRequests.some(request => request.url.startsWith('/api/music/'))"), "false");
  await run("click", "main li:first-child details summary");
  await run("wait", "--text", "warm acoustic folk");
  await run("click", "main li:first-child details:last-child summary");
  await run("wait", "--text", "a quiet morning");
  await run("find", "role", "button", "click", "--name", "listen song 1", "--exact");
  await run("wait", "--fn", "document.querySelector('main audio')?.duration > 0");
  await run("find", "role", "button", "click", "--name", "play song 1", "--exact");
  await run("wait", "--fn", "document.querySelector('main audio')?.currentTime > 0");
  await run("find", "role", "button", "click", "--name", "download MP3", "--exact");
  await run("wait", "--fn", "window.songDownloads.length === 1");
  assert.equal(await run("eval", "window.songDownloads[0].name"), JSON.stringify(`song-${songs[0].id}.mp3`));
  assert.equal(await run("eval", "window.songDownloads[0].href.startsWith('blob:')"), "true");
  assert.equal(await run("eval", "window.songRequests.every(request => request.token === " + JSON.stringify(`Bearer ${first.access_token}`) + ")"), "true");
  await run("find", "role", "button", "click", "--name", "listen song 2", "--exact");
  await run("wait", "--fn", "document.querySelector('main audio')?.duration > 0");
  assert.equal(await run("eval", "document.querySelectorAll('main audio').length"), "1");
  assert.equal(await run("eval", "document.querySelector('main audio').getAttribute('aria-label')"), '"song 2"');
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");

  await run("eval", "window.songFailure = true");
  await run("find", "role", "button", "click", "--name", "refresh", "--exact");
  await run("wait", "--text", "could not load your songs.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "2");
  await run("eval", "window.songFailure = false; window.badSongs = true");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--text", "invalid songs response.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "2");
  await run("eval", "window.badSongs = false");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--fn", "!document.querySelector('[role=alert]') && !document.querySelector('[role=status]')");
  await run("find", "role", "link", "click", "--name", "chat", "--exact");
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", 'document.querySelector("input[name=genre]").value'), '"retained song style"');
  await listResponse([songs[0]]);
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "song 1");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "1");
  await run("eval", "location.reload()");
  await run("wait", "--text", "song 1");
  assert.equal(await run("eval", "location.pathname"), '"/songs"');

  // Switching accounts must clear the previous user's song list.
  await run("network", "route", `${authOrigin}/auth/v1/logout*`, "--body", "{}");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "document.querySelector('#songs-title')"), "null");
  await listResponse([]);
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(second));
  await run("fill", "#auth-email", second.user.email);
  await run("fill", "#auth-password", "offline-password");
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "no saved songs yet.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "0");
  console.log("Songs E2E passed: authenticated navigation and reload, empty state, saved metadata, on-demand playback and download, retained chat form, failed refresh recovery, invalid-response rejection, narrow layout, and account switching.");
} catch (error) {
  process.stderr.write(`${await run("snapshot")}\n`);
  throw error;
} finally {
  await run("close");
}
