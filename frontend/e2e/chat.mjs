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
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea")');
}

try {
  run("open", url);
  run("network", "route", "**/api/**", "--body", '{"reply":"e2e reply"}');
  run("eval", `window.chatRequests = []; const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (input === "/api/chat") window.chatRequests.push(JSON.parse(options.body));
      return originalFetch(input, options);
    };`);

  // Click empty space near the right edge, beyond the placeholder text.
  const x = run("eval", `document.querySelector('${opener}').parentElement.getBoundingClientRect().right - 80`);
  const y = run("eval", `document.querySelector('${opener}').parentElement.getBoundingClientRect().top + 30`);
  run("mouse", "move", x, y);
  run("mouse", "down");
  run("mouse", "up");
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea")');
  run("fill", "textarea", "mouse message");
  run("click", send);
  run("wait", "--text", "e2e reply");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");

  openInput();
  run("fill", "textarea", "keyboard message");
  run("press", "Shift+Enter");
  assert.equal(run("eval", 'document.querySelector("textarea").value === "keyboard message\\n"'), "true");
  run("press", "Enter");
  run("wait", "--fn", 'document.querySelector("main").innerText.split("e2e reply").length === 3');

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/**", "--abort");
  openInput();
  run("fill", "textarea", "failed message");
  run("click", send);
  run("wait", "--text", "Error: Failed to fetch");
  assert.equal(run("eval", 'document.querySelector("main").innerText.includes("mouse message")'), "true");

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/**", "--body", '{"reply":"recovered reply"}');
  openInput();
  run("fill", "textarea", "retry message");
  run("click", send);
  run("wait", "--text", "recovered reply");

  run("network", "unroute", "**/api/**");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({
    reply: "review the prompt and click generate music.", musicPrompt: "a song about tiny paws",
  }));
  const lyrics = "Tiny paws in the morning dew,\nA world of green and a sky of blue.";
  const generatedAudioUrl = "/api/music/00000000-0000-0000-0000-000000000000.mp3";
  run("network", "route", "**/api/music", "--body", JSON.stringify({
    track: { url: generatedAudioUrl, lyrics },
  }));
  openInput();
  run("fill", "textarea", "create a song about cats");
  run("click", send);
  run("wait", "--text", "review the prompt and click generate music.");
  assert.equal(run("eval", 'document.querySelector("audio") === null'), "true");
  run("find", "role", "button", "click", "--name", "generate music");
  run("wait", "--fn", 'document.querySelector("audio") !== null');
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
  run("wait", "--fn", 'document.querySelector("main").innerText.split("Error: Failed to fetch").length === 3');
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "3");
  run("network", "unroute", "**/api/audio?*");
  const audioUrl = "/api/audio/22222222-2222-2222-2222-222222222222.wav";
  run("network", "route", "**/api/audio?*", "--body", JSON.stringify({
    audio: { url: audioUrl, name: "uploaded track.wav" },
  }));
  run("upload", 'input[type="file"]', uploadPath);
  run("wait", "--text", "uploaded track.wav");
  run("network", "unroute", "**/api/chat");
  run("network", "route", "**/api/chat", "--body", JSON.stringify({
    reply: "uploaded stems are ready.", stems,
  }));
  run("click", 'audio[aria-label^="uploaded audio:"] ~ button');
  run("wait", "--text", "uploaded stems are ready.");
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(audioUrl));
  assert.equal(run("eval", 'document.querySelectorAll("audio").length'), "6");
  // Selecting an older generated track also changes the source for follow-up requests.
  run("click", 'div:has(> audio[aria-label="generated music"]) ~ button');
  run("wait", "--fn", 'document.querySelectorAll("audio").length === 8');
  openInput();
  run("fill", "textarea", "separate that track again");
  run("click", send);
  run("wait", "--fn", 'document.querySelectorAll("audio").length === 10');
  assert.equal(run("eval", 'window.chatRequests.at(-1).audioUrl'), JSON.stringify(generatedAudioUrl));
  console.log("Chat E2E passed: chat recovery, music confirmation, uploads, and stem separation recovery.");
} finally {
  try { unlinkSync(uploadPath); } catch { /* No upload fixture to remove. */ }
  run("close");
}
