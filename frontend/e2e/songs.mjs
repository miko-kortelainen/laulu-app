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
const songFields = {
  genre: "warm acoustic folk", mood: "hopeful", key: "C major", bpm: "90", duration: "3 minutes",
  vocals: "soft English vocals", instruments: "acoustic guitar\n\npiano", production: "warm room sound\nkey: keep this line", lyrics: "a quiet morning",
};
const songs = [
  { id: "11111111-1111-4111-8111-111111111111",
    prompt: "genre / style: warm acoustic folk\n\nmood: hopeful\n\nkey: C major\n\nBPM: 90\n\nduration: 3 minutes\n\nvocals / language: soft English vocals\n\ninstruments: acoustic guitar\n\npiano\n\nproduction: warm room sound\nkey: keep this line\n\nLyrics:\nrequested lyrics\n\nmood: not a field",
    lyrics: songFields.lyrics, model: "lyria-3.5", createdAt: "2026-10-06T10:00:00Z" },
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
  await run("network", "route", "**/api/songs/recovery", "--body", '{"songIds":[]}');
  await seedAuth(run, `${url}/songs`, first);
  await run("set", "viewport", "1280", "900");
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
  assert.equal(await run("eval", "document.querySelector('main section > div button')"), "null");
  assert.equal(await run("eval", "document.querySelector('main time').dateTime"), JSON.stringify(songs[0].createdAt));
  assert.equal(await run("eval", "window.songRequests.some(request => request.url.startsWith('/api/music/'))"), "false");
  assert.equal(await run("eval", "document.querySelectorAll('main li details, main li textarea').length"), "0");
  await run("wait", "--text", "select a song to view its prompt and lyrics.");
  await run("focus", "main li:first-child h2 button");
  await run("press", "Enter");
  await run("wait", "--fn", "document.querySelector('main li > div:not([hidden]) audio')?.duration > 0");
  assert.deepEqual(JSON.parse(await run("eval", "Object.fromEntries(Array.from(document.querySelectorAll('#song-info input, #song-info textarea')).map(field => [field.name, field.value]))")), { musicModel: songs[0].model, ...songFields });
  assert.equal(await run("eval", "document.querySelector('#song-info [name=originalPrompt]')"), "null");
  assert.equal(await run("eval", "Array.from(document.querySelectorAll('#song-info input, #song-info textarea')).every(field => field.readOnly && !field.disabled)"), "true");
  assert.equal(await run("eval", "document.querySelector('#song-info').getBoundingClientRect().left >= document.querySelector('section[aria-labelledby=songs-title]').getBoundingClientRect().right"), "true");
  await run("find", "role", "button", "click", "--name", "play song 1", "--exact");
  await run("wait", "--fn", "document.querySelector('main li > div:not([hidden]) audio')?.currentTime > 0");
  await run("find", "role", "button", "click", "--name", "download MP3 song 1", "--exact");
  await run("wait", "--fn", "window.songDownloads.length === 1");
  assert.equal(await run("eval", "window.songDownloads[0].name"), JSON.stringify(`song-${songs[0].id}.mp3`));
  assert.equal(await run("eval", "window.songDownloads[0].href.startsWith('blob:')"), "true");
  assert.equal(await run("eval", "window.songRequests.every(request => request.token === " + JSON.stringify(`Bearer ${first.access_token}`) + ")"), "true");
  await run("eval", `window.firstSongAudio = document.querySelector('main li > div:not([hidden]) audio');
    window.firstSongRequestCount = window.songRequests.filter(request => request.url === ${JSON.stringify(songs[0].url)}).length; undefined`);
  await run("find", "role", "button", "click", "--name", "listen song 2", "--exact");
  await run("wait", "--fn", "document.querySelector('main li > div:not([hidden]) audio')?.duration > 0");
  assert.equal(await run("eval", "document.querySelectorAll('main li > div:not([hidden]) audio').length"), "1");
  assert.equal(await run("eval", "document.querySelector('main li > div:not([hidden]) audio').getAttribute('aria-label')"), '"song 2"');
  assert.equal(await run("eval", "document.querySelector('#song-info [name=originalPrompt]').value"), JSON.stringify(songs[1].prompt));
  assert.equal(await run("eval", "window.firstSongAudio.paused"), "true");
  assert.equal(await run("eval", "Array.from(document.querySelectorAll('#song-info fieldset input:not([name=musicModel]), #song-info fieldset textarea')).every(field => field.value === '')"), "true");
  await run("find", "role", "button", "click", "--name", "close song 2", "--exact");
  await run("wait", "--text", "select a song to view its prompt and lyrics.");
  assert.equal(await run("eval", "document.querySelectorAll('#song-info textarea, main li > div:not([hidden]) audio').length"), "0");
  await run("find", "role", "button", "click", "--name", "listen song 1", "--exact");
  assert.equal(await run("eval", "document.querySelector('main li > div:not([hidden]) audio') === window.firstSongAudio"), "true");
  await run("find", "role", "button", "click", "--name", "play song 1", "--exact");
  await run("wait", "--fn", "!window.firstSongAudio.paused");
  assert.equal(await run("eval", `window.songRequests.filter(request => request.url === ${JSON.stringify(songs[0].url)}).length === window.firstSongRequestCount`), "true");
  await run("find", "role", "button", "click", "--name", "listen song 2", "--exact");
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  assert.equal(await run("eval", "document.querySelector('#song-info').getBoundingClientRect().top >= document.querySelector('section[aria-labelledby=songs-title]').getBoundingClientRect().bottom"), "true");

  await run("eval", "window.songFailure = true");
  await run("set", "viewport", "1280", "900");
  await run("find", "role", "link", "click", "--name", "studio", "--exact");
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "could not load your songs.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "0");
  await run("eval", "window.songFailure = false; window.badSongs = true");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--text", "invalid songs response.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "0");
  await run("eval", "window.badSongs = false");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--fn", "!document.querySelector('[role=alert]') && !document.querySelector('[role=status]')");
  await run("find", "role", "button", "click", "--name", "listen song 2", "--exact");
  await run("wait", "--fn", "document.querySelector('main li > div:not([hidden]) audio')?.duration > 0");

  await run("eval", `window.deleteConfirmed = false; window.deleteFailure = true; window.deleteRequests = [];
    window.confirm = () => window.deleteConfirmed;
    const beforeDelete = window.fetch;
    window.fetch = (input, options) => {
      if (options?.method !== 'DELETE') return beforeDelete(input, options);
      window.deleteRequests.push({ url: input, token: new Headers(options.headers).get('authorization') });
      if (window.deleteFailure) return Promise.resolve(Response.json({}, { status: 502 }));
      return new Promise((resolve, reject) => {
        window.finishSongDelete = () => resolve(new Response(null, { status: 204 }));
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };`);
  await run("find", "role", "button", "click", "--name", "delete song 2", "--exact");
  assert.equal(await run("eval", "window.deleteRequests.length"), "0");
  await run("eval", "window.deleteConfirmed = true");
  await run("find", "role", "button", "click", "--name", "delete song 2", "--exact");
  await run("wait", "--text", "could not delete the song.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "2");
  assert.equal(await run("eval", "document.querySelector('main li > div:not([hidden]) audio').getAttribute('aria-label')"), '"song 2"');
  assert.equal(await run("eval", "document.querySelector('#song-info [name=originalPrompt]').value"), JSON.stringify(songs[1].prompt));
  await run("eval", "window.deleteFailure = false");
  await run("find", "role", "button", "click", "--name", "delete song 2", "--exact");
  await run("wait", "--text", "deleting...");
  assert.equal(await run("eval", "Array.from(document.querySelectorAll('main li > div > button')).every(button => button.disabled)"), "true");
  assert.equal(await run("eval", "window.deleteRequests.length"), "2");
  assert.equal(await run("eval", "window.deleteRequests[1].url"), JSON.stringify(`/api/songs/${songs[1].id}`));
  assert.equal(await run("eval", "window.deleteRequests[1].token"), JSON.stringify(`Bearer ${first.access_token}`));
  await run("eval", "window.finishSongDelete()");
  await run("wait", "--fn", "document.querySelectorAll('main li').length === 1 && !document.querySelector('main li > div:not([hidden]) audio')");
  await run("wait", "--text", "select a song to view its prompt and lyrics.");
  assert.equal(await run("eval", "document.querySelectorAll('#song-info textarea').length"), "0");
  assert.equal(await run("eval", "document.querySelector('main time').dateTime"), JSON.stringify(songs[0].createdAt));
  assert.equal(await run("eval", "document.querySelector('[role=alert]')"), "null");

  await run("set", "viewport", "1280", "900");
  await run("find", "role", "link", "click", "--name", "studio", "--exact");
  await run("wait", "--text", "0 / 40 messages");
  assert.equal(await run("eval", 'document.querySelector("input[name=genre]").value'), '"retained song style"');
  await listResponse([songs[0]]);
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "song 1");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "1");
  await run("eval", "location.reload()");
  await run("wait", "--text", "song 1");
  assert.equal(await run("eval", "location.pathname"), '"/songs"');

  // Unfinished saves survive reload and retry existing audio, without generating again.
  const recoveredSong = { ...songs[0], id: "33333333-3333-4333-8333-333333333333",
    url: "/api/music/33333333-3333-4333-8333-333333333333.mp3", prompt: "recovered acoustic song", createdAt: "2026-10-07T10:00:00Z" };
  await run("network", "unroute", "**/api/songs/recovery");
  await run("network", "route", "**/api/songs/recovery", "--body", JSON.stringify({ songIds: [recoveredSong.id] }));
  await run("eval", "location.reload()");
  await run("wait", "--text", "unsaved song 1");
  assert.equal(await run("eval", "document.querySelectorAll('ul[aria-label=\"saved songs\"] > li').length"), "1");
  assert.equal(await run("eval", "document.documentElement.scrollWidth <= innerWidth"), "true");
  await run("eval", `window.recoveryFailure = false; window.badRecovery = false; window.retryMode = 'failure'; window.retryRequests = []; window.generationRequests = 0;
    const beforeRecovery = window.fetch;
    window.fetch = (input, options) => {
      if (input === '/api/music' && options?.method === 'POST') window.generationRequests++;
      if (input === '/api/songs/recovery' && window.recoveryFailure) return Promise.resolve(Response.json({}, { status: 503 }));
      if (input === '/api/songs/recovery' && window.badRecovery) return Promise.resolve(Response.json({ songIds: ['invalid-id'] }));
      if (input !== ${JSON.stringify(`/api/songs/${recoveredSong.id}/retry`)}) return beforeRecovery(input, options);
      window.retryRequests.push({ url: input, method: options.method, token: new Headers(options.headers).get('authorization') });
      if (window.retryMode === 'failure') return Promise.resolve(Response.json({ error: 'song storage unavailable. try again.' }, { status: 502 }));
      if (window.retryMode === 'invalid') return Promise.resolve(Response.json({ track: ${JSON.stringify(songs[0])} }));
      return new Promise((resolve, reject) => {
        window.finishSongRetry = () => resolve(Response.json({ track: ${JSON.stringify(recoveredSong)} }));
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };`);
  await run("eval", "window.recoveryFailure = true");
  await run("find", "role", "link", "click", "--name", "studio", "--exact");
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "could not load unsaved songs.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "1");
  await run("eval", "window.recoveryFailure = false; window.badRecovery = true");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--text", "invalid unsaved songs response.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "1");
  await run("eval", "window.badRecovery = false");
  await run("find", "role", "button", "click", "--name", "try again", "--exact");
  await run("wait", "--fn", "!document.querySelector('[role=alert]') && !document.querySelector('[role=status]')");
  await run("find", "role", "button", "click", "--name", "retry saving unsaved song 1", "--exact");
  await run("wait", "--text", "song storage unavailable.");
  assert.equal(await run("eval", "document.querySelectorAll('ul[aria-label=\"unsaved songs\"] > li').length"), "1");
  await run("eval", "window.retryMode = 'invalid'");
  await run("find", "role", "button", "click", "--name", "retry saving unsaved song 1", "--exact");
  await run("wait", "--text", "invalid saved song response.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "2");
  await run("eval", "window.retryMode = 'pending'");
  await run("find", "role", "button", "click", "--name", "retry saving unsaved song 1", "--exact");
  await run("wait", "--text", "saving...");
  assert.equal(await run("eval", "Array.from(document.querySelectorAll('main li button')).every(button => button.disabled || button.getAttribute('aria-label')?.startsWith('listen '))"), "true");
  assert.equal(await run("eval", "window.retryRequests.length"), "3");
  assert.equal(await run("eval", "window.retryRequests.every(request => request.method === 'POST' && request.token === " + JSON.stringify(`Bearer ${first.access_token}`) + ")"), "true");
  assert.equal(await run("eval", "window.generationRequests"), "0");
  await listResponse([recoveredSong, songs[0]]);
  await run("network", "unroute", "**/api/songs/recovery");
  await run("network", "route", "**/api/songs/recovery", "--body", '{"songIds":[]}');
  await run("eval", "window.finishSongRetry()");
  await run("wait", "--fn", "!document.querySelector('#unsaved-songs-title') && document.querySelectorAll('main li').length === 2");
  assert.equal(await run("eval", "document.querySelector('main time').dateTime"), JSON.stringify(recoveredSong.createdAt));
  assert.equal(await run("eval", "document.querySelector('[role=alert]')"), "null");
  await run("eval", "location.reload()");
  await run("wait", "--text", "song 2");
  assert.equal(await run("eval", "document.querySelector('#unsaved-songs-title')"), "null");

  // Switching accounts must clear the previous user's song list.
  await run("network", "route", `${authOrigin}/auth/v1/logout*`, "--body", "{}");
  await run("find", "role", "link", "click", "--name", "my profile", "--exact");
  await run("wait", "--text", "member since");
  await run("find", "role", "button", "click", "--name", "log out", "--exact");
  await run("wait", "--text", "log in");
  assert.equal(await run("eval", "document.querySelector('#songs-title')"), "null");
  await listResponse([]);
  await run("network", "route", `${authOrigin}/auth/v1/token*`, "--body", JSON.stringify(second));
  await run("fill", "#auth-email", second.user.email);
  await run("fill", "#auth-password", "offline-password");
  await run("click", 'button[type="submit"]');
  await run("wait", "--text", "member since");
  await run("find", "role", "link", "click", "--name", "my songs", "--exact");
  await run("wait", "--text", "no saved songs yet.");
  assert.equal(await run("eval", "document.querySelectorAll('main li').length"), "0");

  // A signed-in user without a recorded acceptance must accept before reaching the app.
  await run("network", "unroute", "**/rest/v1/terms_acceptances*");
  await run("network", "route", "**/rest/v1/terms_acceptances*", "--body", "null");
  await run("eval", "location.reload()");
  await run("wait", "--text", "accept the terms of service to continue");
  assert.equal(await run("eval", "document.querySelector('#songs-title')"), "null");
  await run("check", "#terms-acceptance");
  await run("find", "role", "button", "click", "--name", "accept and continue", "--exact");
  await run("wait", "--text", "no saved songs yet.");
  console.log("Songs E2E passed: authenticated navigation and reload, empty state, saved metadata, read-only details sidebar and keyboard selection, playback and download, deletion confirmation and failure recovery, retained chat form, load failure recovery, unsaved-song discovery and retry without generation, invalid-response rejection, narrow layout, and account switching.");
} catch (error) {
  process.stderr.write(`${await run("snapshot")}\n`);
  throw error;
} finally {
  await run("close");
}
