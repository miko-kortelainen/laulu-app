import { authSession, seedAuth } from "./auth-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const session = `musical-chat-e2e-${process.pid}`;
const url = process.env.E2E_URL || "http://127.0.0.1:5173";
const run = (...args) => execFileSync("agent-browser", ["--session", session, ...args], {
  encoding: "utf8",
  timeout: 30000,
}).trim();
const opener = 'button[aria-label="Open prompt input"]';
const send = 'button[aria-label="Send prompt"]';
const uploadPath = `/tmp/musical-chat-upload-${process.pid}.wav`;
const usage = { resetAt: '2099-01-01T00:00:00Z',
  chat: { limit: 20, used: 0, remaining: 20 }, analysis: { limit: 10, used: 0, remaining: 10 },
  generation: { limit: 5, used: 0, remaining: 5 }, storage: { limit: 536870912, used: 0, reserved: 0, remaining: 536870912 } };

function openInput() {
  run("click", opener);
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea:not([name])")');
}

try {
  await seedAuth(run, url);
  run("open", "about:blank");
  run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  run("network", "route", "**/api/usage", "--body", JSON.stringify(usage));
  run("open", url);
  run("wait", "--text", "0 / 40 messages");
  run("wait", "--text", "20 / 20 remaining");
  run("wait", "--text", "5 / 5 remaining");
  assert.equal(run("eval", 'document.querySelector("time").dateTime'), JSON.stringify(usage.resetAt));
  assert.equal(run("eval", 'document.querySelector("time").textContent === new Date(document.querySelector("time").dateTime).toLocaleString()'), "true");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "0");
  run("set", "viewport", "1280", "900");
  assert.equal(run("eval", 'document.querySelectorAll("fieldset").length'), "1");
  assert.equal(run("eval", 'document.querySelector("aside fieldset") !== null && document.querySelector("main fieldset") === null'), "true");
  assert.equal(run("eval", 'document.querySelector("aside > button").disabled'), "true");
  assert.equal(run("eval", 'document.querySelector("[name=structure]")'), "null");
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3.5"');
  assert.deepEqual(JSON.parse(run("eval", 'Array.from(document.querySelector("select[name=musicModel]").options, option => option.text)')), ["Lyria 3.5", "Lyria 3 Clip Preview (30 seconds)"]);
  run("find", "label", "music model", "click");
  run("select", "select[name=musicModel]", "lyria-3-clip-preview");
  run("press", "Escape");
  run("press", "Tab");
  assert.equal(run("eval", 'document.activeElement.name'), '"genre"');
  assert.equal(run("eval", 'document.querySelector("aside").getBoundingClientRect().left >= document.querySelector("section[aria-label=chat]").getBoundingClientRect().right'), "true");
  run("network", "route", "**/api/**", "--body", '{"reply":"e2e reply"}');
  run("eval", `window.usage = ${JSON.stringify(usage)}; window.usageFailure = false;
    window.chatRequests = []; window.musicRequests = []; window.mediaRequests = []; window.contextMessages = 6; const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (input === "/api/context") return Promise.resolve(Response.json({ messages: window.contextMessages, limit: 40 }));
      if (input === "/api/usage") return Promise.resolve(window.usageFailure
        ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json(window.usage));
      if (input === "/api/chat") window.chatRequests.push(JSON.parse(options.body));
      if (input === "/api/music") window.musicRequests.push(JSON.parse(options.body));
      if (/^\\/api\\/(audio|music)\\//.test(input)) window.mediaRequests.push({ url: input, authorization: new Headers(options.headers).get('authorization') });
      return originalFetch(input, options);
    };`);

  // Click empty space near the right edge, beyond the placeholder text.
  const x = run("eval", `document.querySelector('${opener}').parentElement.getBoundingClientRect().right - 80`);
  const y = run("eval", `document.querySelector('${opener}').parentElement.getBoundingClientRect().top + 30`);
  run("mouse", "move", x, y);
  run("mouse", "down");
  run("mouse", "up");
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea:not([name])")');
  run("fill", "textarea:not([name])", "mouse message");
  run("eval", 'window.usage.chat = { limit: 20, used: 1, remaining: 19 }');
  run("click", send);
  run("wait", "--text", "e2e reply");
  run("wait", "--text", "6 / 40 messages");
  run("wait", "--text", "19 / 20 remaining");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "6");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");

  run("find", "role", "link", "click", "--name", "profile", "--exact");
  run("wait", "--text", "member since");
  run("eval", 'window.usage.storage.remaining = 268435456');
  run("find", "role", "link", "click", "--name", "chat", "--exact");
  run("wait", "--text", "6 / 40 messages");
  run("wait", "--text", "256 MiB remaining");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("e2e reply")'), "true");

  openInput();
  run("fill", "textarea:not([name])", "keyboard message");
  run("press", "Shift+Enter");
  assert.equal(run("eval", 'document.querySelector("textarea:not([name])").value === "keyboard message\\n"'), "true");
  run("press", "Enter");
  run("wait", "--fn", 'document.querySelector("main").innerText.split("e2e reply").length === 3');

  // A failed context refresh preserves the last known count and reports the failure.
  run("eval", 'window.contextMessages = -1');

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/**", "--body", '{"error":"Failed to fetch"}');
  openInput();
  run("fill", "textarea:not([name])", "failed message");
  run("click", send);
  run("wait", "--text", "Error: Failed to fetch");
  run("wait", "--text", "invalid conversation context response.");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "6");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/**", "--body", '{"reply":"recovered reply"}');
  run("eval", 'window.contextMessages = 40');
  openInput();
  run("fill", "textarea:not([name])", "retry message");
  run("click", send);
  run("wait", "--text", "recovered reply");
  run("wait", "--text", "40 / 40 messages");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "40");

  // Progress and errors follow durable operation polling.
  run("eval", `window.fetchBeforeProgress = window.fetch;
    window.fetch = (input, options) => {
      if (input === "/api/chat") {
        window.progressOperation = { id: JSON.parse(options.body).operationId, kind: "chat",
          state: "running", status: "thinking...", result: null };
        return Promise.resolve(Response.json({ operation: window.progressOperation }, { status: 202 }));
      }
      if (input === '/api/operations/' + window.progressOperation?.id) {
        return Promise.resolve(Response.json({ operation: window.progressOperation }));
      }
      if (input === '/api/operations/' + window.progressOperation?.id + '/acknowledge') {
        return Promise.resolve(Response.json({}));
      }
      return window.fetchBeforeProgress(input, options);
    };`);
  openInput();
  run("fill", "textarea:not([name])", "edit the fields and lyrics");
  run("click", send);
  run("wait", "--text", "thinking...");
  assert.equal(run("eval", `JSON.parse(sessionStorage.getItem('music-draft:${authSession().user.id}')).pendingChatId === window.progressOperation.id`), "true");
  run("eval", 'window.progressOperation.status = "editing fields..."');
  run("wait", "--text", "editing fields...");
  run("eval", 'window.progressOperation.status = "editing lyrics..."');
  run("wait", "--text", "editing lyrics...");
  assert.equal(run("eval", 'document.querySelector("fieldset").disabled'), "true");
  run("eval", 'Object.assign(window.progressOperation, { state: "completed", status: "", result: { reply: "progress complete." } })');
  run("wait", "--text", "progress complete.");
  run("wait", "--fn", 'document.querySelector("[role=status]") === null');
  assert.equal(run("eval", `JSON.parse(sessionStorage.getItem('music-draft:${authSession().user.id}')).pendingChatId === undefined`), "true");

  openInput();
  run("fill", "textarea:not([name])", "try another edit");
  run("click", send);
  run("wait", "--text", "thinking...");
  run("eval", 'Object.assign(window.progressOperation, { state: "failed", status: "", result: { error: "lyric service failed" } })');
  run("wait", "--text", "Error: lyric service failed");
  run("wait", "--fn", '!document.querySelector("fieldset").disabled && document.querySelector("[role=status]") === null');
  run("eval", 'window.fetch = window.fetchBeforeProgress');

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({
    reply: "review the prompt and click generate music.", musicPrompt: {
      genre: "indie folk", mood: "warm", key: "G major", bpm: "82", duration: "2 minutes",
      instruments: "acoustic guitar", vocals: "alto vocals in English", production: "natural",
      lyrics: "a song about tiny paws",
    },
  }));
  const lyrics = "Tiny paws in the morning dew,\nA world of green and a sky of blue.";
  const generatedAudioUrl = "/api/music/00000000-0000-0000-0000-000000000000.mp3";
  run("network", "route", "**/api/music", "--body", JSON.stringify({
    track: { url: generatedAudioUrl, lyrics },
  }));
  openInput();
  run("fill", "textarea:not([name])", "create a song about cats");
  run("click", send);
  run("wait", "--text", "review the prompt and click generate music.");
  assert.equal(run("eval", 'document.querySelector("textarea[name=lyrics]").classList.contains("music-field-updated")'), "true");
  assert.equal(run("eval", 'document.querySelector("audio") === null'), "true");
  assert.equal(run("eval", 'document.querySelector("input[name=key]").value'), '"G major"');
  assert.equal(run("eval", 'window.musicRequests.length'), "0");
  run("find", "label", "key", "fill", "D minor");
  run("press", "Tab");
  assert.equal(run("eval", 'document.activeElement.name'), '"bpm"');
  run("find", "label", "BPM", "fill", "110 with a swung feel");
  run("find", "label", "mood", "fill", "hopeful");
  run("find", "label", "lyrics", "fill", lyrics);
  assert.equal(run("eval", 'document.querySelector(".music-field-updated") === null'), "true");
  // Agent revisions use the current manually edited draft, and keep one form.
  const revisedPrompt = {
    genre: "indie pop", mood: "hopeful", key: "D minor", bpm: "110 with a swung feel", duration: "2 minutes",
    instruments: "acoustic guitar", vocals: "alto vocals in English", production: "natural",
    lyrics,
  };
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({ reply: "changed the genre.", musicPrompt: revisedPrompt }));
  openInput();
  run("fill", "textarea:not([name])", "change only the genre to indie pop");
  run("click", send);
  run("wait", "--text", "changed the genre.");
  assert.deepEqual(JSON.parse(run("eval", 'Array.from(document.querySelectorAll(".music-field-updated"), field => field.name)')), ["genre"]);
  run("wait", "--fn", 'document.querySelector(".music-field-updated") === null');
  assert.deepEqual(JSON.parse(JSON.parse(run("eval", 'window.chatRequests.at(-1).musicPrompt'))), { ...revisedPrompt, genre: "indie folk" });
  revisedPrompt.key = "E minor";
  run("set", "media", "dark", "reduced-motion");
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({ reply: "changed the key.", musicPrompt: revisedPrompt }));
  openInput();
  run("fill", "textarea:not([name])", "now change only the key to E minor");
  run("click", send);
  run("wait", "--text", "changed the key.");
  assert.deepEqual(JSON.parse(run("eval", 'Array.from(document.querySelectorAll(".music-field-updated"), field => field.name)')), ["key"]);
  assert.equal(run("eval", 'getComputedStyle(document.querySelector("input[name=key]")).animationName'), '"none"');
  run("wait", "--fn", 'document.querySelector(".music-field-updated") === null');
  run("set", "media", "dark");
  assert.deepEqual(JSON.parse(JSON.parse(run("eval", 'window.chatRequests.at(-1).musicPrompt'))), { ...revisedPrompt, key: "D minor" });
  assert.equal(run("eval", 'document.querySelectorAll("fieldset").length'), "1");
  assert.equal(run("eval", 'document.querySelector("input[name=genre]").value'), '"indie pop"');
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3-clip-preview"');
  assert.equal(run("eval", 'window.musicRequests.length'), "0");
  run("set", "viewport", "390", "844");
  assert.equal(run("eval", 'document.documentElement.scrollWidth <= window.innerWidth'), "true");
  assert.equal(run("eval", 'Array.from(document.querySelectorAll("fieldset input, fieldset textarea, fieldset select")).every(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= window.innerWidth)'), "true");
  assert.equal(run("eval", 'document.querySelector("aside").getBoundingClientRect().top >= document.querySelector("section[aria-label=chat]").getBoundingClientRect().bottom'), "true");
  run("set", "viewport", "1280", "900");
  run("network", "unroute", "**/api/music");
  run("network", "route", "**/api/music", "--body", '{"error":"Failed to fetch"}');
  run("eval", `window.fetchBeforeGeneration = window.fetch;
    window.fetch = (input, options) => input === "/api/music"
      ? new Promise(resolve => { window.finishGeneration = () => resolve(window.fetchBeforeGeneration(input, options)); })
      : window.fetchBeforeGeneration(input, options);`);
  run("find", "role", "button", "click", "--name", "generate music");
  run("wait", "--text", "generating track...");
  assert.equal(run("eval", 'document.querySelector("aside > button").disabled'), "true");
  run("eval", 'window.finishGeneration(); window.fetch = window.fetchBeforeGeneration');
  run("wait", "--text", "Failed to fetch");
  run("wait", "--fn", '!document.querySelector("fieldset").disabled');
  assert.equal(run("eval", 'document.querySelector("input[name=key]").value'), '"E minor"');
  assert.equal(run("eval", 'document.querySelector("textarea[name=lyrics]").value'), JSON.stringify(lyrics));
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3-clip-preview"');
  assert.equal(run("eval", 'window.musicRequests.at(-1).model'), '"lyria-3-clip-preview"');
  assert.equal(run("eval", 'window.musicRequests.at(-1).prompt'), JSON.stringify(
    "genre / style: indie pop\n\nmood: hopeful\n\nkey: E minor\n\nBPM: 110 with a swung feel\n\nduration: 2 minutes\n\nvocals / language: alto vocals in English\n\ninstruments: acoustic guitar\n\nproduction: natural\n\nLyrics:\n" + lyrics,
  ));
  run("network", "unroute", "**/api/music");
  run("network", "route", "**/api/music", "--body", JSON.stringify({
    track: { url: generatedAudioUrl, lyrics },
  }));
  run("select", "select[name=musicModel]", "lyria-3.5");
  // A failed save switches the action to storage retry, without another generation.
  run("eval", `window.fetchBeforeStorage = window.fetch; window.storageRetries = []; window.failStorageRetry = true;
    window.fetch = (input, options) => {
      if (input === "/api/music") {
        window.musicRequests.push(JSON.parse(options.body));
        return Promise.resolve(Response.json({ error: "song generated, but saving failed. retry saving instead of generating again.",
          songId: "00000000-0000-0000-0000-000000000000", retryUrl: "/api/music" }, { status: 502 }));
      }
      if (input === "/api/songs/00000000-0000-0000-0000-000000000000/retry") {
        window.storageRetries.push({ url: input, method: options.method,
          authenticated: new Headers(options.headers).get("authorization")?.startsWith("Bearer ") });
        return new Promise(resolve => { window.finishStorageRetry = () => resolve(window.failStorageRetry
          ? Response.json({ error: "saving is still unavailable." }, { status: 503 })
          : Response.json({ track: { url: ${JSON.stringify(generatedAudioUrl)}, lyrics: ${JSON.stringify(lyrics)} } })); });
      }
      return window.fetchBeforeStorage(input, options);
    };`);
  run("find", "role", "button", "click", "--name", "generate music");
  run("wait", "--text", "song generated, but saving failed.");
  run("wait", "--text", "this saves the song already generated.");
  assert.equal(run("eval", 'document.querySelector("aside > button").textContent.trim()'), '"retry saving"');
  assert.equal(run("eval", 'document.querySelector("textarea[name=lyrics]").value'), JSON.stringify(lyrics));
  assert.equal(run("eval", 'window.musicRequests.length'), "2");
  run("find", "role", "button", "click", "--name", "retry saving", "--exact");
  run("wait", "--text", "saving track...");
  assert.equal(run("eval", 'document.querySelector("aside > button").disabled'), "true");
  run("eval", 'document.querySelector("aside > button").click()');
  assert.equal(run("eval", 'window.storageRetries.length'), "1");
  run("eval", 'window.finishStorageRetry()');
  run("wait", "--text", "saving is still unavailable.");
  assert.equal(run("eval", 'document.querySelector("aside > button").textContent.trim()'), '"retry saving"');
  run("eval", 'window.failStorageRetry = false; document.querySelector("aside > button").focus()');
  run("press", "Enter");
  run("wait", "--text", "saving track...");
  run("eval", 'window.finishStorageRetry(); window.fetch = window.fetchBeforeStorage');
  run("wait", "--fn", 'document.querySelector("audio") !== null');
  run("wait", "--fn", '!document.querySelector("fieldset").disabled');
  assert.equal(run("eval", 'window.musicRequests.length'), "2");
  assert.equal(run("eval", 'window.storageRetries.length === 2 && window.storageRetries.every(request => request.method === "POST" && request.authenticated)'), "true");
  assert.equal(run("eval", 'document.querySelector("aside > button").textContent.trim()'), '"generate music"');
  assert.equal(run("eval", 'window.musicRequests.at(-1).model'), '"lyria-3.5"');
  run("select", "select[name=musicModel]", "lyria-3-clip-preview");
  assert.equal(run("eval", 'document.querySelector("summary").textContent.trim()'), '"lyrics"');
  run("click", "summary");
  assert.equal(run("eval", 'document.querySelector("details > div").textContent.trim()'), JSON.stringify(lyrics));

  assert.equal(run("eval", 'window.mediaRequests.length >= 1 && window.mediaRequests.every(request => request.authorization?.startsWith("Bearer "))'), "true");

  // Private downloads report HTTP failure and retry with an authenticated blob.
  run("eval", `window.fetchBeforeDownload = window.fetch; window.failDownload = true;
    window.fetch = (input, options) => input === ${JSON.stringify(generatedAudioUrl)} && window.failDownload
      ? Promise.resolve(new Response(null, { status: 503 })) : window.fetchBeforeDownload(input, options);
    window.anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.downloadedAudio = { href: this.href, name: this.download }; };`);
  run("find", "role", "button", "click", "--name", "download MP3", "--exact");
  run("wait", "--text", "could not download audio. try again.");
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "1");
  run("eval", "window.failDownload = false");
  run("find", "role", "button", "click", "--name", "download MP3", "--exact");
  run("wait", "--fn", 'window.downloadedAudio?.href.startsWith("blob:")');
  assert.equal(run("eval", "window.downloadedAudio.name"), '"generated-music.mp3"');
  assert.equal(run("eval", 'window.mediaRequests.at(-1).authorization.startsWith("Bearer ")'), "true");
  run("eval", "window.fetch = window.fetchBeforeDownload; HTMLAnchorElement.prototype.click = window.anchorClick");

  // Upload failure leaves prior results intact; the same file can be uploaded again.
  writeFileSync(uploadPath, "mock WAV upload");
  run("network", "route", "**/api/audio?*", "--abort");
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--fn", 'document.querySelector("footer > div > [role=alert]")?.textContent === "Failed to fetch"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "1");
  run("network", "unroute", "**/api/audio?*");
  const audioUrl = "/api/audio/22222222-2222-2222-2222-222222222222.wav";
  run("network", "route", "**/api/audio?*", "--body", JSON.stringify({
    audio: { url: audioUrl, name: "uploaded track.wav" },
  }));
  const requestsBeforeUpload = run("eval", 'window.chatRequests.length');
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "uploaded track.wav");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("uploaded track.wav")'), "false");
  run("wait", "--fn", 'document.querySelector("footer audio").getAttribute("src")?.startsWith("blob:")');
  assert.equal(run("eval", 'window.chatRequests.length'), requestsBeforeUpload);
  run("set", "viewport", "390", "844");
  assert.equal(run("eval", 'document.documentElement.scrollWidth <= window.innerWidth'), "true");
  assert.equal(run("eval", 'document.querySelector("footer [role=group]").getBoundingClientRect().right <= window.innerWidth'), "true");
  run("set", "viewport", "1280", "900");
  run("find", "role", "button", "click", "--name", "remove attached audio");
  run("wait", "--text", "no file selected");
  assert.equal(run("eval", 'document.querySelector("footer audio")'), "null");
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "attached to your next message");
  // A failed replacement preserves the existing attachment.
  run("network", "unroute", "**/api/audio?*");
  run("network", "route", "**/api/audio?*", "--abort");
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--fn", 'document.querySelector("footer > div > [role=alert]")?.textContent === "Failed to fetch"');
  run("wait", "--fn", 'document.querySelector("footer audio").getAttribute("src")?.startsWith("blob:")');
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", '{"reply":"audio received."}');
  run("eval", `window.fetchBeforeAttachment = window.fetch;
    window.fetch = (input, options) => input === "/api/chat"
      ? new Promise(resolve => { window.finishAttachment = () => resolve(window.fetchBeforeAttachment(input, options)); })
      : window.fetchBeforeAttachment(input, options);`);
  openInput();
  run("fill", "textarea:not([name])", "here is my track");
  run("click", send);
  run("wait", "--text", "thinking...");
  assert.equal(run("eval", 'document.querySelector("footer audio")'), "null");
  run("wait", "--fn", 'document.querySelector(\'main audio[aria-label^="uploaded audio:"]\').getAttribute("src")?.startsWith("blob:")');
  run("eval", 'window.finishAttachment(); window.fetch = window.fetchBeforeAttachment');
  run("wait", "--text", "audio received.");
  assert.equal(run("eval", 'document.querySelector("footer audio")'), "null");
  assert.equal(run("eval", 'document.querySelector(\'main audio[aria-label^="uploaded audio:"]\').closest("main > div").textContent.includes("here is my track")'), "true");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(audioUrl));
  // A failed send retains the attachment for a retry, and reset failures preserve it.
  run("network", "unroute", "**/api/audio?*");
  run("network", "route", "**/api/audio?*", "--body", JSON.stringify({
    audio: { url: audioUrl, name: "uploaded track.wav" },
  }));
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "attached to your next message");
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", '{"error":"Failed to fetch"}');
  openInput();
  run("fill", "textarea:not([name])", "check this attachment");
  run("click", send);
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 3');
  run("wait", "--fn", 'document.querySelector("footer audio").getAttribute("src")?.startsWith("blob:")');
  // Failed resets preserve the draft and tracks; successful resets clear both.
  run("network", "route", "**/api/reset", "--body", '{"status":"failed"}');
  run("find", "role", "button", "click", "--name", "new session", "--exact");
  run("wait", "--text", "Error: Conversation reset failed.");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "40");
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "4");
  run("network", "unroute", "**/api/reset");
  run("network", "route", "**/api/reset", "--abort");
  run("find", "role", "button", "click", "--name", "new session", "--exact");
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 4');
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "40");
  assert.equal(run("eval", 'document.querySelector("input[name=genre]").value'), '"indie pop"');
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3-clip-preview"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "4");
  run("network", "unroute", "**/api/reset");
  run("network", "route", "**/api/reset", "--body", '{"status":"ok"}');
  run("find", "role", "button", "click", "--name", "new session", "--exact");
  run("wait", "--text", "Conversation cleared.");
  run("wait", "--text", "0 / 40 messages");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "0");
  assert.equal(run("eval", 'Array.from(document.querySelectorAll("fieldset input, fieldset textarea")).every(el => el.value === "")'), "true");
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3.5"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "0");
  assert.equal(run("eval", 'document.querySelector("aside > button").disabled'), "true");
  // Refresh failures preserve valid usage and offer recovery; malformed responses do too.
  run("eval", 'window.usageFailure = true');
  run("find", "role", "button", "click", "--name", "new session", "--exact");
  run("wait", "--text", "could not load daily allowances. try again.");
  run("wait", "--text", "19 / 20 remaining");
  run("eval", 'window.usageFailure = false; window.usage.generation = { limit: 5, used: 1, remaining: -1 }');
  run("find", "role", "button", "click", "--name", "retry allowances", "--exact");
  run("wait", "--text", "invalid usage response.");
  run("wait", "--text", "5 / 5 remaining");
  run("eval", 'window.usage.generation.remaining = 4');
  run("find", "role", "button", "click", "--name", "retry allowances", "--exact");
  run("wait", "--text", "4 / 5 remaining");
  assert.equal(run("eval", 'document.querySelector("aside").innerText.includes("invalid usage response.")'), "false");
  // The reset timer refreshes server counts without another user action.
  run("eval", 'window.usage.resetAt = new Date(Date.now() + 1200).toISOString()');
  run("find", "role", "button", "click", "--name", "new session", "--exact");
  run("wait", "--fn", 'document.querySelector("time").dateTime === window.usage.resetAt');
  run("eval", `window.usage.resetAt = ${JSON.stringify(usage.resetAt)}; window.usage.generation = { limit: 5, used: 0, remaining: 5 }`);
  run("wait", "--text", "5 / 5 remaining");
  console.log("Chat E2E passed: chat recovery, music confirmation, uploads, and private downloads.");
} finally {
  try { unlinkSync(uploadPath); } catch { /* No upload fixture to remove. */ }
  run("close");
}
