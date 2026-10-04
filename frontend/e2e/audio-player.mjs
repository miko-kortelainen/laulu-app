import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const session = `musical-player-e2e-${process.pid}`;
const fixturePath = `/tmp/musical-player-${process.pid}.wav`;
const run = async (...args) => (await exec("agent-browser", ["--session", session, ...args], { timeout: 30000 })).stdout.trim();
const audioUrl = "/api/audio/44444444-4444-4444-4444-444444444444.wav";
const brokenUrl = "/api/audio/55555555-5555-5555-5555-555555555555.wav";
const player = 'footer [role="group"]';
const media = 'document.querySelector("footer audio")';

// Real PCM audio exercises browser decoding, seeking, and playback without providers.
const samples = 8000 * 8;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const envelope = 0.1 + 0.6 * i / samples;
  wav.writeInt16LE(Math.round(Math.sin(i / 8000 * Math.PI * 2 * 220) * envelope * 32767), 44 + i * 2);
}

let broken = true;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/context") return response.end('{"messages":0,"limit":40}');
  if (pathname === "/api/audio") {
    const name = new URL(request.url, "http://localhost").searchParams.get("name");
    return response.end(JSON.stringify({ audio: { url: name === "broken.wav" ? brokenUrl : audioUrl, name } }));
  }
  if (pathname === "/api/chat") return response.end('{"reply":"audio received."}');
  if (pathname === "/test/repair") {
    broken = false;
    return response.end("ok");
  }
  if (pathname === audioUrl || pathname === brokenUrl) {
    response.setHeader("Cache-Control", "no-store");
    if (pathname === brokenUrl && broken) {
      response.writeHead(503);
      return response.end();
    }
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Accept-Ranges", "bytes");
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${wav.length}`, "Content-Length": end - start + 1 });
      return response.end(wav.subarray(start, end + 1));
    }
    response.setHeader("Content-Length", wav.length);
    return response.end(wav);
  }
  const path = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = await readFile(new URL(`../dist/${path}`, import.meta.url)).catch(() => undefined);
  if (!file) {
    response.writeHead(404);
    return response.end();
  }
  response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(path)] || "application/octet-stream");
  response.end(file);
});

try {
  await writeFile(fixturePath, wav);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await run("open", `http://127.0.0.1:${address.port}`);
  await run("wait", "--text", "0 / 40 messages");
  await run("upload", 'input[type="file"]', fixturePath);
  await run("wait", "--fn", `${media}?.duration === 8 && document.querySelector('footer svg path') !== null`);
  const path = JSON.parse(await run("eval", 'document.querySelector("footer svg path").getAttribute("d")'));
  assert.equal(path.split("M").length - 1, 80);
  assert.ok(new Set(path.match(/v[\d.]+/g)).size > 20);
  assert.equal(await run("eval", `${media}.controls`), "false");
  await run("click", `${player} button[aria-label^="play "]`);
  await run("wait", "--fn", `${media}.currentTime > 0.1 && !${media}.paused`);
  await run("click", `${player} button[aria-label^="pause "]`);
  assert.equal(await run("eval", `${media}.paused`), "true");
  const paused = await run("eval", `${media}.currentTime`);
  await run("focus", `${player} input[aria-label^="volume "]`);
  await run("press", "Home");
  assert.equal(await run("eval", `${media}.volume`), "0");
  await run("press", "End");
  assert.equal(await run("eval", `${media}.volume`), "1");
  assert.equal(await run("eval", `${media}.currentTime`), paused);
  const bounds = JSON.parse(await run("eval", `const rect = document.querySelector('footer input[aria-label^="seek "]').getBoundingClientRect();
    ({ x: rect.left, y: Math.round(rect.top + rect.height / 2), width: rect.width });`));
  await run("mouse", "move", String(Math.round(bounds.x + bounds.width / 2)), String(bounds.y));
  await run("mouse", "down");
  await run("mouse", "up");
  assert.ok(Number(await run("eval", `${media}.currentTime`)) > 2);
  await run("mouse", "move", String(Math.round(bounds.x + bounds.width / 4)), String(bounds.y));
  await run("mouse", "down");
  await run("mouse", "move", String(Math.round(bounds.x + bounds.width * 0.75)), String(bounds.y));
  await run("mouse", "up");
  assert.ok(Number(await run("eval", `${media}.currentTime`)) > 5);
  await run("press", "Home");
  await run("press", "ArrowRight");
  assert.ok(Number(await run("eval", `${media}.currentTime`)) > 0);
  assert.ok(Number(JSON.parse(await run("eval", 'document.querySelector("footer [data-playhead]").getAttribute("x1")'))) > 0);
  await run("press", "End");
  assert.equal(await run("eval", `${media}.currentTime`), "8");
  await run("click", `${player} button[aria-label^="stop "]`);
  assert.equal(await run("eval", `${media}.currentTime`), "0");
  assert.equal(await run("eval", `${media}.paused`), "true");
  await run("set", "viewport", "320", "760");
  assert.equal(await run("eval", 'document.documentElement.scrollWidth <= window.innerWidth'), "true");
  assert.equal(await run("eval", 'Array.from(document.querySelectorAll("footer [role=group] button, footer [role=group] input")).every(el => el.getBoundingClientRect().right <= window.innerWidth)'), "true");
  await run("screenshot", "/tmp/musical-player-preview.png");
  await run("set", "viewport", "1280", "900");
  await run("eval", 'window.previewAudio = document.querySelector("footer audio"); undefined');
  await run("click", `${player} button[aria-label^="play "]`);
  await run("wait", "--fn", `${media}.currentTime > 0.1`);
  await run("click", 'button[aria-label="Open prompt input"]');
  await run("fill", "textarea:not([name])", "here is my track");
  await run("click", 'button[aria-label="Send prompt"]');
  await run("wait", "--text", "audio received.");
  assert.equal(await run("eval", 'window.previewAudio.paused'), "true");
  await run("wait", "--fn", 'document.querySelector("main audio")?.duration === 8');
  await run("click", 'main [role=group] button[aria-label^="play "]');
  await run("wait", "--fn", 'document.querySelector("main audio").currentTime > 0.1');
  await run("click", 'main [role=group] button[aria-label^="stop "]');
  await run("screenshot", "/tmp/musical-player-sent.png");
  await run("eval", `const file = new File(["invalid audio"], "broken.wav"); const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await run("wait", "--text", "waveform unavailable");
  await run("wait", "--text", "could not load audio. try play again.");
  await run("eval", 'fetch("/test/repair")');
  await run("click", `${player} button[aria-label^="play "]`);
  await run("wait", "--fn", `${media}.currentTime > 0.1 && !${media}.paused`);
  assert.equal(await run("eval", 'document.querySelector("footer [role=alert]")'), "null");
  await run("click", `${player} button[aria-label^="stop "]`);
  console.log("Audio player E2E passed: real waveform, playback, pause, stop, seeking, volume, attachment handoff, mobile layout, and failure recovery.");
} finally {
  await run("close");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await unlink(fixturePath).catch(() => {});
}
