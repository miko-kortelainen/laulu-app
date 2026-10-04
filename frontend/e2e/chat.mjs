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

function openInput() {
  run("click", opener);
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea:not([name])")');
}

try {
  run("open", "about:blank");
  run("network", "route", "**/api/context", "--body", '{"messages":0,"limit":40}');
  run("open", url);
  run("wait", "--text", "0 / 40 messages");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "0");
  run("set", "viewport", "1280", "900");
  assert.equal(run("eval", 'document.querySelectorAll("fieldset").length'), "1");
  assert.equal(run("eval", 'document.querySelector("aside fieldset") !== null && document.querySelector("main fieldset") === null'), "true");
  assert.equal(run("eval", 'document.querySelector("aside button").disabled'), "true");
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
  run("eval", `window.chatRequests = []; window.musicRequests = []; window.contextMessages = 6; const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (input === "/api/context") return Promise.resolve(Response.json({ messages: window.contextMessages, limit: 40 }));
      if (input === "/api/chat") window.chatRequests.push(JSON.parse(options.body));
      if (input === "/api/music") window.musicRequests.push(JSON.parse(options.body));
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
  run("click", send);
  run("wait", "--text", "e2e reply");
  run("wait", "--text", "6 / 40 messages");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "6");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");

  openInput();
  run("fill", "textarea:not([name])", "keyboard message");
  run("press", "Shift+Enter");
  assert.equal(run("eval", 'document.querySelector("textarea:not([name])").value === "keyboard message\\n"'), "true");
  run("press", "Enter");
  run("wait", "--fn", 'document.querySelector("main").innerText.split("e2e reply").length === 3');

  // A failed context refresh preserves the last known count and reports the failure.
  run("eval", 'window.contextMessages = -1');

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/**", "--abort");
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

  // Progress follows streamed activity, even when a record is split across chunks.
  run("eval", `window.fetchBeforeProgress = window.fetch;
    window.fetch = (input, options) => input === "/api/chat"
      ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
          window.chatProgress = controller;
        } }), { headers: { "content-type": "application/x-ndjson" } }))
      : window.fetchBeforeProgress(input, options);`);
  openInput();
  run("fill", "textarea:not([name])", "edit the fields and lyrics");
  run("click", send);
  run("wait", "--text", "thinking...");
  run("eval", 'window.chatProgress.enqueue(new TextEncoder().encode(\'{"status":"editing fi\'))');
  assert.equal(run("eval", 'document.querySelector("[role=status]").textContent.trim()'), '"thinking..."');
  run("eval", 'window.chatProgress.enqueue(new TextEncoder().encode(\'elds..."}\\n\'))');
  run("wait", "--text", "editing fields...");
  run("eval", 'window.chatProgress.enqueue(new TextEncoder().encode(\'{"status":"editing lyrics..."}\\n\'))');
  run("wait", "--text", "editing lyrics...");
  assert.equal(run("eval", 'document.querySelector("fieldset").disabled'), "true");
  run("eval", 'window.chatProgress.enqueue(new TextEncoder().encode(\'{"reply":"progress complete."}\\n\')); window.chatProgress.close()');
  run("wait", "--text", "progress complete.");
  run("wait", "--fn", 'document.querySelector("[role=status]") === null');

  // A streamed error clears progress and lets the user retry.
  openInput();
  run("fill", "textarea:not([name])", "try another edit");
  run("click", send);
  run("wait", "--text", "thinking...");
  run("eval", 'window.chatProgress.enqueue(new TextEncoder().encode(\'{"status":"editing lyrics..."}\\n{"error":"lyric service failed"}\\n\')); window.chatProgress.close()');
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
  run("network", "route", "**/api/music", "--abort");
  run("eval", `window.fetchBeforeGeneration = window.fetch;
    window.fetch = (input, options) => input === "/api/music"
      ? new Promise(resolve => { window.finishGeneration = () => resolve(window.fetchBeforeGeneration(input, options)); })
      : window.fetchBeforeGeneration(input, options);`);
  run("find", "role", "button", "click", "--name", "generate music");
  run("wait", "--text", "generating track...");
  assert.equal(run("eval", 'document.querySelector("aside button").disabled'), "true");
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
  run("find", "role", "button", "click", "--name", "generate music");
  run("wait", "--fn", 'document.querySelector("audio") !== null');
  run("wait", "--fn", '!document.querySelector("fieldset").disabled');
  assert.equal(run("eval", 'window.musicRequests.length'), "2");
  assert.equal(run("eval", 'window.musicRequests.at(-1).model'), '"lyria-3.5"');
  run("select", "select[name=musicModel]", "lyria-3-clip-preview");
  assert.equal(run("eval", 'document.querySelector("summary").textContent.trim()'), '"lyrics"');
  run("click", "summary");
  assert.equal(run("eval", 'document.querySelector("details > div").textContent.trim()'), JSON.stringify(lyrics));

  // A generated track stays playable when separation fails, then succeeds on retry.
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", '{"reply":"local separation failed."}');
  run("find", "role", "button", "click", "--name", "separate stems");
  run("wait", "--text", "local separation failed.");
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "1");
  const stems = {
    vocalsUrl: "/api/stems/11111111-1111-1111-1111-111111111111/source_vocals.wav",
    instrumentalUrl: "/api/stems/11111111-1111-1111-1111-111111111111/source_instrumental.wav",
  };
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({ reply: "stems are ready.", stems }));
  run("find", "role", "button", "click", "--name", "separate stems");
  run("wait", "--text", "download vocals WAV");
  assert.equal(run("eval", 'document.querySelector("audio[aria-label=vocals]").getAttribute("src")'), JSON.stringify(stems.vocalsUrl));
  assert.equal(run("eval", 'document.querySelector("audio[aria-label=instrumental]").getAttribute("src")'), JSON.stringify(stems.instrumentalUrl));

  // Upload failure leaves prior results intact; the same file can be uploaded again.
  writeFileSync(uploadPath, "mock WAV upload");
  run("network", "route", "**/api/audio?*", "--abort");
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--fn", 'document.querySelector("footer [role=alert]")?.textContent === "Failed to fetch"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "3");
  run("network", "unroute", "**/api/audio?*");
  const audioUrl = "/api/audio/22222222-2222-2222-2222-222222222222.wav";
  run("network", "route", "**/api/audio?*", "--body", JSON.stringify({
    audio: { url: audioUrl, name: "uploaded track.wav" },
  }));
  const requestsBeforeUpload = run("eval", 'window.chatRequests.length');
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "uploaded track.wav");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("uploaded track.wav")'), "false");
  assert.equal(run("eval", 'document.querySelector("footer audio").getAttribute("src")'), JSON.stringify(audioUrl));
  assert.equal(run("eval", 'window.chatRequests.length'), requestsBeforeUpload);
  run("set", "viewport", "390", "844");
  assert.equal(run("eval", 'document.documentElement.scrollWidth <= window.innerWidth'), "true");
  assert.equal(run("eval", 'document.querySelector("footer audio").getBoundingClientRect().right <= window.innerWidth'), "true");
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
  run("wait", "--fn", 'document.querySelector("footer [role=alert]")?.textContent === "Failed to fetch"');
  assert.equal(run("eval", 'document.querySelector("footer audio").getAttribute("src")'), JSON.stringify(audioUrl));
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
  assert.equal(run("eval", 'document.querySelector(\'main audio[aria-label^="uploaded audio:"]\').getAttribute("src")'), JSON.stringify(audioUrl));
  run("eval", 'window.finishAttachment(); window.fetch = window.fetchBeforeAttachment');
  run("wait", "--text", "audio received.");
  assert.equal(run("eval", 'document.querySelector("footer audio")'), "null");
  assert.equal(run("eval", 'document.querySelector(\'main audio[aria-label^="uploaded audio:"]\').closest("main > div").textContent.includes("here is my track")'), "true");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(audioUrl));
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({
    reply: "uploaded stems are ready.", stems,
  }));
  run("click", 'div:has(> audio[aria-label^="uploaded audio:"]) ~ button:first-of-type');
  run("wait", "--text", "uploaded stems are ready.");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(audioUrl));
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "6");
  // Selecting an older generated track also changes the source for follow-up requests.
  run("click", 'div:has(> audio[aria-label="generated music"]) ~ button:first-of-type');
  run("wait", "--fn", 'document.querySelectorAll("audio").length === 8');
  openInput();
  run("fill", "textarea:not([name])", "separate that track again");
  run("click", send);
  run("wait", "--fn", 'document.querySelectorAll("audio").length === 10');
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(generatedAudioUrl));
  // Cleanup supports the original track, selected stems, and valid retry after failure.
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--abort");
  run("click", 'div:has(> audio[aria-label="generated music"]) ~ button:last-of-type');
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 3');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "10");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(generatedAudioUrl));
  const cleanedAudio = {
    url: "/api/cleaned/33333333-3333-3333-3333-333333333333/source_cleaned.wav", name: "cleaned audio",
  };
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({ reply: "cleaned audio is ready.", cleanedAudio }));
  run("click", 'button[aria-label="remove echo/reverb from vocals"]:first-of-type');
  run("wait", "--text", "download cleaned audio WAV");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(stems.vocalsUrl));
  assert.equal(run("eval", 'document.querySelector(`audio[aria-label="cleaned audio"]`).getAttribute("src")'), JSON.stringify(cleanedAudio.url));
  openInput();
  run("fill", "textarea:not([name])", "clean it again");
  run("click", send);
  run("wait", "--fn", 'document.querySelectorAll("audio").length === 12');
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(cleanedAudio.url));
  // A failed send retains the attachment for a retry, and reset failures preserve it.
  run("network", "unroute", "**/api/audio?*");
  run("network", "route", "**/api/audio?*", "--body", JSON.stringify({
    audio: { url: audioUrl, name: "uploaded track.wav" },
  }));
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "attached to your next message");
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--abort");
  openInput();
  run("fill", "textarea:not([name])", "check this attachment");
  run("click", send);
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 4');
  assert.equal(run("eval", 'document.querySelector("footer audio").getAttribute("src")'), JSON.stringify(audioUrl));
  // Failed resets preserve the draft and tracks; successful resets clear both.
  run("network", "route", "**/api/reset", "--body", '{"status":"failed"}');
  run("find", "role", "button", "click", "--name", "Clear", "--exact");
  run("wait", "--text", "Error: Conversation reset failed.");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "40");
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "14");
  run("network", "unroute", "**/api/reset");
  run("network", "route", "**/api/reset", "--abort");
  run("find", "role", "button", "click", "--name", "Clear", "--exact");
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 5');
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "40");
  assert.equal(run("eval", 'document.querySelector("input[name=genre]").value'), '"indie pop"');
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3-clip-preview"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "14");
  run("network", "unroute", "**/api/reset");
  run("network", "route", "**/api/reset", "--body", '{"status":"ok"}');
  run("find", "role", "button", "click", "--name", "Clear", "--exact");
  run("wait", "--text", "Conversation cleared.");
  run("wait", "--text", "0 / 40 messages");
  assert.equal(run("eval", 'document.querySelector("aside meter").value'), "0");
  assert.equal(run("eval", 'Array.from(document.querySelectorAll("fieldset input, fieldset textarea")).every(el => el.value === "")'), "true");
  assert.equal(run("eval", 'document.querySelector("select[name=musicModel]").value'), '"lyria-3.5"');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "0");
  assert.equal(run("eval", 'document.querySelector("aside button").disabled'), "true");
  console.log("Chat E2E passed: chat recovery, music confirmation, uploads, stem separation, and echo removal recovery.");
} finally {
  try { unlinkSync(uploadPath); } catch { /* No upload fixture to remove. */ }
  run("close");
}
