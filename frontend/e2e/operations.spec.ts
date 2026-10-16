import { test, expect, fulfillJson, userId, wavBuffer } from "./fixtures";

const audio = { url: "/api/audio/10000000-0000-4000-8000-000000000002.wav", name: "reference.wav" };
const chatId = "10000000-0000-4000-8000-000000000003";
const laterId = "10000000-0000-4000-8000-000000000005";
const prompt = { genre: "analysis folk", mood: "", key: "", bpm: "", duration: "", vocals: "",
  instruments: "", production: "", lyrics: "recovered words" };
const operation = (id: string, kind: string, state: string, result: unknown = null, status = "working...") =>
  ({ id, kind, state, result, status });

test.describe("operation recovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/audio\/[^/]+\.wav$/, (route) => route.fulfill({ contentType: "audio/wav", body: wavBuffer() }));
  });
  test("recovers a lost generation response across reload without posting twice", async ({ authedPage: page }) => {
    let id = "";
    let posts = 0;
    let completed = false;
    const acknowledgements: string[] = [];
    await page.route(/\/api\/music$/, async (route) => {
      id = (route.request().postDataJSON() as { operationId: string }).operationId;
      posts++;
      await route.abort();
    });
    await page.route(/\/api\/operations$/, (route) => fulfillJson(route, {
      operations: id ? [operation(id, "music", "running")] : [],
    }));
    await page.route(/\/api\/operations\/[^/]+$/, (route) => fulfillJson(route, {
      operation: completed
        ? operation(id, "music", "completed", { track: { url: `/api/music/${id}.mp3`, lyrics: "recovered lyrics" } }, "")
        : operation(id, "music", "running", null, "saving track..."),
    }));
    await page.route(/\/api\/operations\/[^/]+\/acknowledge$/, (route) => {
      acknowledgements.push(route.request().url());
      return route.fulfill({ status: 204 });
    });
    await page.route(/\/api\/music\/[^/]+\.mp3$/, (route) => route.fulfill({ contentType: "audio/mpeg", body: "" }));
    await page.goto("/");
    await page.getByLabel("genre / style").fill("recovery folk");
    await page.getByRole("textbox", { name: "lyrics", exact: true }).fill("keep these lyrics");
    await page.getByRole("button", { name: "generate song", exact: true }).click();
    await expect(page.getByText("saving track...", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("saving track...", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("recovery folk");
    await expect(page.getByRole("textbox", { name: "lyrics", exact: true })).toHaveValue("keep these lyrics");
    await expect(page.getByRole("button", { name: "generate song", exact: true })).toBeDisabled();
    completed = true;
    await expect(page.getByText("your track is ready.")).toBeVisible();
    await expect(page.getByRole("button", { name: "generate song", exact: true })).toBeEnabled();
    await expect.poll(() => acknowledgements.length).toBe(1);
    expect(posts).toBe(1);
  });

  test("reconnects to recovered analysis and protects newer edits from an old result", async ({ authedPage: page }) => {
    let disconnected = false;
    let completed = false;
    let acknowledged = false;
    await page.route(/\/api\/operations$/, (route) => fulfillJson(route, { operations: [operation(chatId, "chat", "running")] }));
    await page.route(new RegExp(`/api/operations/${chatId}$`), (route) => disconnected ? route.abort() : fulfillJson(route, {
      operation: completed ? operation(chatId, "chat", "completed", { reply: "recovered audio analysis", musicPrompt: prompt }, "")
        : operation(chatId, "chat", "running", null, "analyzing audio..."),
    }));
    await page.route(new RegExp(`/api/operations/${chatId}/acknowledge$`), (route) => {
      acknowledged = true;
      return route.fulfill({ status: 204 });
    });
    await page.addInitScript(({ key, attachment, id }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({ pendingAudio: attachment, pendingChatId: id }));
    }, { key: `music-draft:${userId}`, attachment: audio, id: chatId });
    await page.goto("/");
    await expect(page.getByText("analyzing audio...", { exact: true })).toBeVisible();
    disconnected = true;
    await expect(page.getByText("reconnecting to your request...", { exact: true })).toBeVisible();
    disconnected = false;
    completed = true;
    await expect(page.getByText("recovered audio analysis", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("analysis folk");
    await expect(page.locator("footer").getByText("reference.wav")).toHaveCount(0);
    await expect.poll(() => acknowledged).toBe(true);
    await page.getByLabel("genre / style").fill("newer manual edit");
    await page.evaluate(({ key, attachment }) => {
      const draft = JSON.parse(sessionStorage.getItem(key)!);
      sessionStorage.setItem(key, JSON.stringify({ ...draft, pendingAudio: attachment }));
    }, { key: `music-draft:${userId}`, attachment: audio });
    await page.reload();
    await expect(page.getByText("recovered audio analysis", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("newer manual edit");
    await expect(page.locator("footer").getByText("reference.wav", { exact: true })).toBeVisible();
  });

  test("retries discovery and acknowledgements while later work stays locked", async ({ authedPage: page }) => {
    let discoveryFails = true;
    let ackFails = true;
    let ackAttempts = 0;
    let laterCompleted = false;
    const completedChat = operation(chatId, "chat", "completed", { reply: "recovered audio analysis" }, "");
    await page.route(/\/api\/operations$/, (route) => discoveryFails ? route.abort() : fulfillJson(route, {
      operations: [completedChat, operation(laterId, "chat", "running")],
    }));
    await page.route(new RegExp(`/api/operations/${chatId}$`), (route) => fulfillJson(route, { operation: completedChat }));
    await page.route(new RegExp(`/api/operations/${chatId}/acknowledge$`), (route) => {
      ackAttempts++;
      return route.fulfill({ status: ackFails ? 503 : 204 });
    });
    await page.route(new RegExp(`/api/operations/${laterId}$`), (route) => fulfillJson(route, {
      operation: laterCompleted ? operation(laterId, "chat", "completed", { reply: "later answer recovered" }, "")
        : operation(laterId, "chat", "running", null, "recovering later analysis..."),
    }));
    await page.goto("/");
    await expect(page.getByText("reconnecting to your request...", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toBeDisabled();
    discoveryFails = false;
    await expect(page.getByText("recovering later analysis...", { exact: true })).toBeVisible();
    await expect.poll(() => ackAttempts).toBeGreaterThanOrEqual(2);
    ackFails = false;
    const before = ackAttempts;
    await expect.poll(() => ackAttempts).toBeGreaterThan(before);
    await expect(page.getByText("recovered audio analysis", { exact: true })).toHaveCount(1);
    await expect(page.getByLabel("genre / style")).toBeDisabled();
    laterCompleted = true;
    await expect(page.getByText("later answer recovered", { exact: true })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toBeEnabled();
  });

  test("reports an unknown outcome without regenerating or discarding the draft", async ({ authedPage: page }) => {
    const id = "10000000-0000-4000-8000-000000000004";
    const unknown = operation(id, "music", "unknown", { error: "the outcome is unknown; your song allowance remains reserved." }, "");
    let posts = 0;
    await page.route(/\/api\/music$/, (route) => { posts++; return route.abort(); });
    await page.route(/\/api\/operations$/, (route) => fulfillJson(route, { operations: [unknown] }));
    await page.route(new RegExp(`/api/operations/${id}$`), (route) => fulfillJson(route, { operation: unknown }));
    await page.addInitScript((key) => sessionStorage.setItem(key, JSON.stringify({ musicPrompt: { genre: "recovery folk", mood: "", key: "", bpm: "", duration: "", vocals: "", instruments: "", production: "", lyrics: "" } })), `music-draft:${userId}`);
    await page.goto("/");
    await expect(page.getByRole("alert").filter({ hasText: "your song allowance remains reserved" })).toBeVisible();
    await expect(page.getByLabel("genre / style")).toHaveValue("recovery folk");
    expect(posts).toBe(0);
  });
});
