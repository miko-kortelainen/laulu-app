import { test, expect, fulfillJson, usage, wavBuffer } from "./fixtures";

const operationId = "10000000-0000-4000-8000-000000000010";

test.describe("chat (studio)", () => {
  test("sends a message and shows the reply", async ({ authedPage: page }) => {
    await page.route(/\/api\/chat$/, (route) => fulfillJson(route, { reply: "e2e reply" }));

    await page.goto("/");

    await expect(page.getByText("0 / 16")).toBeVisible();
    const prompt = page.getByLabel("Prompt message");
    await expect(page.getByRole("button", { name: "Send prompt" })).toBeDisabled();
    await expect(prompt).toHaveAttribute("placeholder", "chat with laulu");
    const bounds = (await prompt.boundingBox())!;
    await prompt.click({ position: { x: bounds.width - 70, y: 20 } });
    await expect(prompt).toBeFocused();
    await prompt.fill("word ".repeat(300));
    await expect.poll(() => prompt.evaluate((input) => input.clientHeight)).toBeGreaterThan(46);
    expect(await prompt.evaluate((input) => input.clientHeight)).toBeLessThanOrEqual(178);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await prompt.fill("   ");
    await expect(page.getByRole("button", { name: "Send prompt" })).toBeDisabled();
    await prompt.fill("hello laulu");
    await page.getByRole("button", { name: "Send prompt" }).click();

    await expect(page.getByText("e2e reply")).toBeVisible();
    await expect(page.getByText("hello laulu")).toBeVisible();
    await expect(prompt).toHaveValue("");
    await expect.poll(() => prompt.evaluate((input) => input.clientHeight)).toBe(46);
  });

  test("generates a song through a polled operation", async ({ authedPage: page }) => {
    // The app generates the operation id and expects the 202 to echo it back.
    await page.route(/\/api\/music$/, (route) => {
      const id = (route.request().postDataJSON() as { operationId: string }).operationId;
      return fulfillJson(route, { operation: { id, kind: "music", state: "running", status: "working...", result: null } }, 202);
    });
    await page.route(/\/api\/operations\/[^/]+$/, (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? operationId;
      const track = { url: `/api/music/${id}.mp3`, title: "quiet morning", lyrics: "a quiet morning" };
      return fulfillJson(route, { operation: { id, kind: "music", state: "completed", status: "", result: { track } } });
    });
    await page.route(/\/api\/music\/[^/]+\.mp3(?:\?playback=offline)?$/, (route) => route.fulfill({ status: 200, contentType: "audio/mpeg", body: "" }));

    await page.goto("/");
    await page.getByLabel("genre / style").fill("warm acoustic folk");
    await page.getByLabel("lyrics").fill("a quiet morning");
    await page.getByRole("button", { name: "generate song" }).click();

    await expect(page.getByText("your track is ready.")).toBeVisible();
  });

  test("shows allowances on the profile page", async ({ authedPage: page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "my profile" }).click();

    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByText("20 / 20 remaining")).toBeVisible();
    await expect(page.getByText("test@example.com")).toBeVisible();
  });

  test("sends keyboard messages and revises the current draft without generating music", async ({ authedPage: page }) => {
    let musicPosts = 0;
    const requests: { musicPrompt: string }[] = [];
    let musicPrompt = { genre: "indie folk", mood: "warm", key: "G major", bpm: "82", duration: "2 minutes",
      instruments: "acoustic guitar", vocals: "alto vocals in English", production: "natural", lyrics: "a song about tiny paws" };
    await page.route(/\/api\/music$/, (route) => { musicPosts++; return route.abort(); });
    await page.route(/\/api\/chat$/, (route) => {
      requests.push(route.request().postDataJSON() as { musicPrompt: string });
      return fulfillJson(route, { reply: `revision ${requests.length}`, musicPrompt });
    });
    await page.goto("/");
    await page.getByRole("combobox", { name: "music model", exact: true }).selectOption("lyria-3-clip-preview");
    const input = page.getByLabel("Prompt message");
    await input.fill("create a song");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("create a song\n");
    await input.press("Enter");
    await expect(page.getByText("revision 1", { exact: true })).toBeVisible();
    await expect(page.getByLabel("key", { exact: true })).toHaveValue("G major");
    await expect(page.getByRole("textbox", { name: "lyrics", exact: true })).toHaveClass(/music-field-updated/);
    await page.getByLabel("key", { exact: true }).fill("D minor");
    await page.getByLabel("BPM", { exact: true }).fill("110 with a swung feel");
    await page.getByLabel("mood", { exact: true }).fill("hopeful");
    await expect(page.locator(".music-field-updated")).toHaveCount(0);
    musicPrompt = { ...musicPrompt, genre: "indie pop", key: "D minor", bpm: "110 with a swung feel", mood: "hopeful" };
    await input.fill("change only the genre");
    await input.press("Enter");
    await expect(page.getByText("revision 2", { exact: true })).toBeVisible();
    expect(JSON.parse(requests[1].musicPrompt)).toEqual({ ...musicPrompt, genre: "indie folk" });
    await expect(page.locator(".music-field-updated")).toHaveCount(1);
    await expect(page.getByLabel("genre / style")).toHaveClass(/music-field-updated/);
    await page.emulateMedia({ reducedMotion: "reduce" });
    musicPrompt = { ...musicPrompt, key: "E minor" };
    await input.fill("change only the key");
    await input.press("Enter");
    await expect(page.getByText("revision 3", { exact: true })).toBeVisible();
    expect(JSON.parse(requests[2].musicPrompt)).toEqual({ ...musicPrompt, key: "D minor" });
    await expect(page.getByLabel("key", { exact: true })).toHaveCSS("animation-name", "none");
    await expect(page.getByRole("combobox", { name: "music model", exact: true })).toHaveValue("lyria-3-clip-preview");
    expect(musicPosts).toBe(0);
    await page.getByRole("link", { name: "my profile", exact: true }).click();
    await page.goBack();
    await expect(page.getByLabel("genre / style")).toHaveValue("indie pop");
    await page.getByRole("link", { name: "privacy", exact: true }).click();
    await page.getByRole("link", { name: "back to app", exact: true }).click();
    await expect(page.getByLabel("genre / style")).toHaveValue("indie pop");
  });

  test("preserves the context count on invalid refresh and recovers after a failed message", async ({ authedPage: page }) => {
    let contextMessages = 6;
    let fail = true;
    await page.route(/\/api\/context$/, (route) => fulfillJson(route, { messages: contextMessages, limit: 16 }));
    await page.route(/\/api\/chat$/, (route) => fulfillJson(route, fail ? { error: "chat unavailable" } : { reply: "recovered reply" }, fail ? 400 : 200));
    await page.goto("/");
    await expect(page.getByText("6 / 16")).toBeVisible();
    contextMessages = -1;
    await page.getByLabel("Prompt message").fill("failed message");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("Error: chat unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("invalid conversation context response.")).toBeVisible();
    await expect(page.getByText("6 / 16")).toBeVisible();
    fail = false;
    contextMessages = 16;
    await page.getByLabel("Prompt message").fill("try again");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("recovered reply", { exact: true })).toBeVisible();
    await expect(page.getByText("16 / 16")).toBeVisible();
    await expect(page.getByText("invalid conversation context response.")).toHaveCount(0);
  });

  test("rejects malformed responses and keeps the draft usable", async ({ authedPage: page }) => {
    await page.route(/\/api\/chat$/, (route) => fulfillJson(route, { reply: "untrusted reply", musicPrompt: { genre: "incomplete" } }));
    // await page.route(/\/api\/audio\?name=/, (route) => fulfillJson(route, { audio: { url: "https://example.com/reference.wav", name: "reference.wav" } }));
    let track: unknown = { url: "/api/music/00000000-0000-0000-0000-000000000000.mp3", lyrics: "retained lyrics", title: null };
    await page.route(/\/api\/music$/, (route) => fulfillJson(route, { track }));
    await page.route(/\/api\/music\/[^/]+\.mp3(?:\?playback=offline)?$/, (route) => route.fulfill({ contentType: "audio/mpeg", body: "" }));
    await page.goto("/");
    await page.getByLabel("genre / style").fill("retained style");
    await page.getByLabel("Prompt message").fill("keep my draft");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("Error: Invalid chat response.", { exact: true })).toBeVisible();
    await expect(page.getByText("untrusted reply", { exact: true })).toHaveCount(0);
    // Audio uploads are temporarily disabled.
    // await page.getByLabel("upload audio", { exact: true }).setInputFiles({ name: "reference.wav", mimeType: "audio/wav", buffer: wavBuffer() });
    // await expect(page.getByRole("alert")).toHaveText("Invalid audio upload response.");
    // await expect(page.getByText("attached to your next message")).toHaveCount(0);
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Invalid music response." })).toBeVisible();
    await expect(page.getByText("your track is ready.")).toHaveCount(0);
    await expect(page.getByLabel("genre / style")).toHaveValue("retained style");
    track = { url: "/api/music/00000000-0000-0000-0000-000000000000.mp3", lyrics: "retained lyrics" };
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByText("your track is ready.")).toBeVisible();
    await expect(page.getByText("untitled", { exact: true })).toBeVisible();
  });

  // Audio uploads are temporarily disabled.
  test.skip("keeps attachments after failed replacement, send, and reset, then clears on success", async ({ authedPage: page }) => {
    const audioUrl = "/api/audio/44444444-4444-4444-4444-444444444444.wav";
    const wav = wavBuffer();
    let failUpload = false;
    let failChat = true;
    let failReset = true;
    const requests: { audioUrl: string }[] = [];
    await page.route(/\/api\/audio\?name=/, (route) => fulfillJson(route, failUpload ? { error: "upload unavailable" }
      : { audio: { url: audioUrl, name: "reference.wav" } }, failUpload ? 503 : 200));
    await page.route(new RegExp(`${audioUrl}(?:\\?playback=offline)?$`), (route) => {
      expect(new URL(route.request().url()).searchParams.get("playback")).toBe("offline");
      return route.fulfill({ contentType: "audio/wav", body: wav });
    });
    await page.route(/\/api\/chat$/, (route) => {
      requests.push(route.request().postDataJSON() as { audioUrl: string });
      return fulfillJson(route, failChat ? { error: "chat unavailable" } : { reply: "audio received." }, failChat ? 400 : 200);
    });
    await page.route(/\/api\/reset$/, (route) => fulfillJson(route, { status: failReset ? "failed" : "ok" }));
    await page.goto("/");
    await page.getByLabel("genre / style").fill("retained style");
    const upload = page.getByLabel("upload audio", { exact: true });
    const file = { name: "reference.wav", mimeType: "audio/wav", buffer: wav };
    await expect(upload).toBeEnabled();
    await upload.setInputFiles(file);
    await expect(page.getByText("attached to your next message")).toBeVisible();
    failUpload = true;
    await expect(upload).toBeEnabled();
    await upload.setInputFiles(file);
    await expect(page.getByRole("alert")).toHaveText("upload unavailable");
    await expect(page.getByText("attached to your next message")).toBeVisible();
    await page.getByLabel("Prompt message").fill("check this attachment");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("Error: chat unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("attached to your next message")).toBeVisible();
    await page.getByRole("button", { name: "new session", exact: true }).click();
    await expect(page.getByText("Error: Conversation reset failed.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("retained style");
    await expect(page.getByText("attached to your next message")).toBeVisible();
    failChat = false;
    await page.getByLabel("Prompt message").fill("retry attachment");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(page.getByText("audio received.", { exact: true })).toBeVisible();
    await expect(page.getByText("attached to your next message")).toHaveCount(0);
    expect(requests).toEqual([expect.objectContaining({ audioUrl }), expect.objectContaining({ audioUrl })]);
    failReset = false;
    await page.getByRole("button", { name: "new session", exact: true }).click();
    await expect(page.getByText("fresh start. what kind of song are we making now?")).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("");
    await expect(page.locator("audio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "generate song", exact: true })).toBeDisabled();
  });

  test("preserves failed generation fields and retries saving without another generation", async ({ authedPage: page }) => {
    const id = "00000000-0000-0000-0000-000000000000";
    let mode = "failure";
    let retryFails = true;
    let retries = 0;
    const generations: Record<string, unknown>[] = [];
    await page.route(/\/api\/music$/, (route) => {
      generations.push(route.request().postDataJSON() as Record<string, unknown>);
      return fulfillJson(route, mode === "failure" ? { error: "generation unavailable" }
        : mode === "quota" ? { error: `your generation allowance exhausted. try again after ${usage.resetAt}.`, code: "quota_exceeded", resetAt: usage.resetAt }
        : { error: "song generated, but saving failed. retry saving instead of generating again.", songId: id }, 502);
    });
    await page.route(new RegExp(`/api/songs/${id}/retry$`), (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      retries++;
      return fulfillJson(route, retryFails ? { error: "saving is still unavailable." }
        : { track: { url: `/api/music/${id}.mp3`, title: "quiet morning", lyrics: "retained lyrics" } }, retryFails ? 503 : 200);
    });
    await page.route(new RegExp(`/api/music/${id}.mp3(?:\\?playback=offline)?$`), (route) => route.fulfill({ contentType: "audio/wav", body: wavBuffer() }));
    await page.goto("/");
    await page.getByLabel("genre / style").fill("indie pop");
    await page.getByRole("textbox", { name: "lyrics", exact: true }).fill("retained lyrics");
    await page.getByLabel("song title", { exact: true }).fill("quiet morning");
    await page.getByRole("combobox", { name: "music model", exact: true }).selectOption("lyria-3-clip-preview");
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("generation unavailable");
    await expect(page.getByLabel("song title", { exact: true })).toHaveValue("quiet morning");
    await expect(page.getByRole("textbox", { name: "lyrics", exact: true })).toHaveValue("retained lyrics");
    expect(generations[0]).toMatchObject({ title: "quiet morning", model: "lyria-3-clip-preview", prompt: "genre / style: indie pop\n\nLyrics:\nretained lyrics" });
    mode = "quota";
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("your generation allowance exhausted");
    await expect(page.getByRole("alert")).not.toContainText(usage.resetAt);
    mode = "storage";
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByText("this saves the song already generated.")).toBeVisible();
    await page.getByRole("button", { name: "retry saving", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("saving is still unavailable.");
    retryFails = false;
    await page.getByRole("button", { name: "retry saving", exact: true }).click();
    await expect(page.getByText("your track is ready.")).toBeVisible();
    expect(generations).toHaveLength(3);
    expect(retries).toBe(2);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "download MP3", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("generated-music.mp3");
  });

  test("preserves allowances on failed and malformed refreshes and updates at reset time", async ({ authedPage: page }) => {
    let mode = "valid";
    let counts = structuredClone(usage);
    await page.clock.install();
    await page.route(/\/api\/usage$/, (route) => mode === "offline" ? route.fulfill({ status: 503 }) : fulfillJson(route,
      mode === "invalid" ? { ...counts, generation: { ...counts.generation, remaining: -1 } } : counts));
    await page.goto("/profile");
    await expect(page.getByText("20 / 20 remaining")).toBeVisible();
    await expect(page.getByText("songs per month", { exact: true })).toBeVisible();
    await expect(page.getByText("lyric requests per month", { exact: true })).toBeVisible();
    mode = "offline";
    await page.evaluate(() => window.dispatchEvent(new Event("billing-updated")));
    await expect(page.getByRole("alert")).toContainText("could not load allowances");
    await expect(page.getByText("20 / 20 remaining")).toBeVisible();
    mode = "invalid";
    await page.getByRole("button", { name: "retry allowances" }).click();
    await expect(page.getByRole("alert")).toContainText("invalid usage response");
    await expect(page.getByText("5 / 5 remaining")).toBeVisible();
    mode = "valid";
    const now = await page.evaluate(() => Date.now());
    counts = { ...counts, resetAt: new Date(now + 30_000).toISOString(), generation: { limit: 5, used: 1, remaining: 4 } };
    await page.getByRole("button", { name: "retry allowances" }).click();
    await expect(page.getByText("4 / 5 remaining")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("time").first()).toHaveAttribute("datetime", counts.resetAt);
    counts = structuredClone(usage);
    await page.clock.fastForward(32_000);
    await expect(page.getByText("5 / 5 remaining")).toBeVisible();
  });

  test("opens and dismisses mobile navigation and keeps the draft when moving between pages", async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByLabel("genre / style").fill("retained mobile style");
    const menu = page.getByRole("button", { name: "menu", exact: true });
    const dialog = page.getByRole("dialog", { name: "navigation", exact: true });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await dialog.getByRole("link", { name: "my profile", exact: true }).click();
    await expect(page.getByText("member since")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.press("Enter");
    await dialog.getByRole("link", { name: "studio", exact: true }).click();
    await expect(page.getByLabel("genre / style")).toHaveValue("retained mobile style");
    await menu.click();
    await page.getByRole("button", { name: "close menu" }).click();
    await expect(dialog).toBeHidden();
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("overflow", "visible");
    await menu.click();
    await page.mouse.click(380, 400);
    await expect(dialog).toBeHidden();
    await menu.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(dialog).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
