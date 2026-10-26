import type { Page } from "@playwright/test";
import { test, expect, fulfillJson, wavBuffer } from "./fixtures";

const audioId = "44444444-4444-4444-4444-444444444444";
const audioUrl = `/api/audio/${audioId}.wav`;

// Audio uploads are temporarily disabled.
test.describe.skip("audio player", () => {
  test("uploads audio and plays it back", async ({ authedPage: page }) => {
    const wav = wavBuffer();
    let mediaRequests = 0;
    await page.route(/\/api\/audio\?name=/, (route) => fulfillJson(route, { audio: { url: audioUrl, name: "reference.wav" } }));
    await page.route(new RegExp(`/api/audio/${audioId}\\.wav(?:\\?playback=offline)?$`), (route) => {
      mediaRequests++;
      return route.fulfill({
        status: 200, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes", "Content-Length": String(wav.length) }, body: wav,
      });
    });

    await page.goto("/");
    const upload = page.getByLabel("upload audio", { exact: true });
    await expect(upload).toBeEnabled();
    await upload.setInputFiles({ name: "reference.wav", mimeType: "audio/wav", buffer: wav });

    await expect(page.getByText("reference.wav")).toBeVisible();
    const play = page.getByRole("button", { name: "play attached audio: reference.wav" });
    await expect(play).toBeVisible();
    expect(mediaRequests).toBe(0);
    await play.click();
    await expect.poll(() => mediaRequests).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "pause attached audio: reference.wav" })).toBeVisible();
    await page.getByRole("button", { name: "pause attached audio: reference.wav" }).click();
    await expect(play).toBeVisible();
    const media = page.locator("footer audio");
    await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.duration)).toBe(8);
    await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.buffered.end(0))).toBe(8);
    const bufferingTexts = await page.getByRole("status").evaluateHandle((status) => {
      const texts: string[] = [];
      new MutationObserver(() => texts.push(status.textContent ?? "")).observe(status, {
        childList: true, characterData: true, subtree: true,
      });
      return texts;
    });
    await play.click();
    await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "pause attached audio: reference.wav" }).click();
    expect(await bufferingTexts.jsonValue()).not.toContain("buffering...");
    await checkAttachedAudioControls(page);
    await page.setViewportSize({ width: 320, height: 760 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route(/\/api\/chat$/, (route) => fulfillJson(route, { reply: "audio received." }));
    await play.click();
    const previous = await media.elementHandle();
    await page.getByLabel("Prompt message").fill("here is my track");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("audio received.", { exact: true })).toBeVisible();
    expect(await previous!.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    const sent = page.locator("main audio");
    await page.getByRole("button", { name: "play uploaded audio: reference.wav" }).click();
    await expect.poll(() => sent.evaluate((audio: HTMLAudioElement) => audio.duration)).toBe(8);
    await expect(upload).toBeEnabled();
    await upload.setInputFiles({ name: "reference.wav", mimeType: "audio/wav", buffer: wav });
    await expect.poll(() => sent.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await play.click();
    await expect.poll(() => sent.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
    await page.getByRole("button", { name: "play uploaded audio: reference.wav" }).click();
    await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    await page.getByRole("button", { name: "remove attached audio" }).click();
    await expect(media).toHaveCount(0);
  });

  test("shows a media failure and retries playback after the source recovers", async ({ authedPage: page }) => {
    let broken = true;
    await page.route(/\/api\/audio\?name=/, (route) => fulfillJson(route, { audio: { url: audioUrl, name: "broken.wav" } }));
    await page.route(new RegExp(`${audioUrl}(?:\\?playback=offline)?$`), (route) => broken ? route.fulfill({ status: 503 })
      : route.fulfill({ contentType: "audio/wav", body: wavBuffer() }));
    await page.goto("/");
    const upload = page.getByLabel("upload audio", { exact: true });
    await expect(upload).toBeEnabled();
    await upload.setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid audio") });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "play attached audio: broken.wav" }).click();
    await expect(page.getByRole("alert")).toContainText(/could not (load|play) audio/);
    broken = false;
    await page.getByRole("button", { name: "play attached audio: broken.wav" }).click();
    await expect.poll(() => page.locator("footer audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

async function checkAttachedAudioControls(page: Page): Promise<void> {
  const media = page.locator("footer audio");
  const volume = page.getByRole("slider", { name: "volume attached audio: reference.wav" });
  await volume.focus();
  await volume.press("Home");
  expect(await media.evaluate((audio: HTMLAudioElement) => audio.volume)).toBe(0);
  await volume.press("End");
  expect(await media.evaluate((audio: HTMLAudioElement) => audio.volume)).toBe(1);
  const seek = page.getByRole("slider", { name: "seek attached audio: reference.wav" });
  const bounds = (await seek.boundingBox())!;
  await seek.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(2);
  await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2);
  await page.mouse.up();
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(5);
  await seek.press("Home");
  await seek.press("ArrowRight");
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  await seek.press("End");
  await expect.poll(() => media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(8);
  await page.getByRole("button", { name: "stop attached audio: reference.wav" }).click();
  expect(await media.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(0);
  expect(await media.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
}
