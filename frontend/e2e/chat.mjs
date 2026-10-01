import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const session = `musical-chat-e2e-${process.pid}`;
const url = process.env.E2E_URL || "http://127.0.0.1:5173";
const run = (...args) => execFileSync("agent-browser", ["--session", session, ...args], {
  encoding: "utf8",
  timeout: 30000,
}).trim();
const opener = 'button[aria-label="Open prompt input"]';
const send = 'button[aria-label="Send prompt"]';

function openInput() {
  run("click", opener);
  run("wait", "--fn", 'document.activeElement === document.querySelector("textarea")');
}

try {
  run("open", url);
  run("network", "route", "**/api/**", "--body", '{"reply":"e2e reply"}');

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
  run("network", "route", "**/api/music", "--body", JSON.stringify({
    track: { url: "/api/music/00000000-0000-0000-0000-000000000000.mp3", lyrics },
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
  console.log("Chat E2E passed: opening, sending, failure recovery, music confirmation, and lyrics.");
} finally {
  run("close");
}
