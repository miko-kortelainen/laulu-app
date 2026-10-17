import { test, expect, fulfillJson, wavBuffer } from "./fixtures";

const songs = [
  { id: "11111111-1111-4111-8111-111111111111", title: "quiet morning",
    prompt: "genre / style: warm acoustic folk\n\nmood: hopeful\n\nLyrics:\na quiet morning",
    lyrics: "a quiet morning", model: "lyria-3.5", createdAt: "2026-10-06T10:00:00Z",
    url: "/api/music/11111111-1111-4111-8111-111111111111.mp3", sizeBytes: 16044, isFavourite: false },
  { id: "22222222-2222-4222-8222-222222222222", title: "untitled", prompt: "instrumental piano",
    lyrics: "", model: "lyria-3.5", createdAt: "2026-10-05T10:00:00Z",
    url: "/api/music/22222222-2222-4222-8222-222222222222.mp3", sizeBytes: 16044, isFavourite: false },
];

const librarySongs = Array.from({ length: 105 }, (_, index) => {
  const id = `30000000-0000-4000-8000-${String(105 - index).padStart(12, "0")}`;
  return { ...songs[0], id, title: `library song ${index + 1}`, url: `/api/music/${id}.mp3`,
    createdAt: "2026-10-17T10:00:00.123456Z", isFavourite: index >= 50 };
});

test.describe("my songs", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => fulfillJson(route, { songs }));
    await page.route(/\/api\/songs\/recovery$/, (route) => fulfillJson(route, { songIds: [] }));
    await page.route(/\/api\/music\/[^/]+\.mp3$/, (route) => route.fulfill({ contentType: "audio/wav", body: wavBuffer() }));
  });

  test("shows 50 songs per request and loads older pages through the full-width show more button", async ({ authedPage: page }) => {
    const cursors = [null, `${librarySongs[49].createdAt},${librarySongs[49].id}`, `${librarySongs[99].createdAt},${librarySongs[99].id}`];
    const pages = [librarySongs.slice(0, 50), librarySongs.slice(50, 100), librarySongs.slice(100)];
    const requests: (string | null)[] = [];
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => {
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      const before = new URL(route.request().url()).searchParams.get("before");
      const index = cursors.indexOf(before);
      expect(index).toBeGreaterThanOrEqual(0);
      requests.push(before);
      return fulfillJson(route, { songs: pages[index] });
    });
    await page.goto("/songs");
    const items = page.getByRole("list", { name: "saved songs", exact: true }).getByRole("listitem");
    await expect(items).toHaveCount(50);
    await expect(items.first()).toContainText("library song 1");
    await expect(items.last()).toContainText("library song 50");
    await expect(page.getByRole("button", { name: "listen library song 51", exact: true })).toHaveCount(0);
    const showMore = page.getByRole("button", { name: "show more", exact: true });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await showMore.evaluate(button => Math.abs(button.getBoundingClientRect().width - button.parentElement!.clientWidth))).toBeLessThanOrEqual(1);
    }
    await showMore.click();
    await expect(items).toHaveCount(100);
    await expect(items.last()).toContainText("library song 100");
    await showMore.click();
    await expect(items).toHaveCount(105);
    await expect(items.last()).toContainText("library song 105");
    await expect(page.getByRole("button", { name: "end of list", exact: true })).toBeDisabled();
    expect(requests).toEqual(cursors);
  });

  test("preserves loaded songs and the selected song while retrying a failed or invalid next page", async ({ authedPage: page }) => {
    let mode = "offline";
    let finishPage: (() => void) | undefined;
    const cursors: string[] = [];
    await page.route(/\/api\/songs(?:\?.*)?$/, async (route) => {
      const before = new URL(route.request().url()).searchParams.get("before");
      if (!before) return fulfillJson(route, { songs: librarySongs.slice(0, 50) });
      cursors.push(before);
      if (mode === "offline") {
        await new Promise<void>(resolve => { finishPage = resolve; });
        return route.fulfill({ status: 503 });
      }
      return fulfillJson(route, { songs: mode === "invalid" ? librarySongs.slice(50, 101) : librarySongs.slice(50, 52) });
    });
    await page.goto("/songs");
    const items = page.getByRole("list", { name: "saved songs", exact: true }).getByRole("listitem");
    await expect(items).toHaveCount(50);
    await page.getByRole("button", { name: "listen library song 1", exact: true }).click();
    const showMore = page.getByRole("button", { name: "show more", exact: true });
    await showMore.click();
    await expect(page.getByRole("button", { name: "loading more songs...", exact: true })).toBeDisabled();
    await expect(page.getByRole("tab", { name: "favourites", exact: true })).toBeDisabled();
    await expect.poll(() => Boolean(finishPage)).toBe(true);
    finishPage!();
    await expect(page.getByRole("alert")).toContainText("could not load your songs");
    await expect(items).toHaveCount(50);
    await expect(page.getByRole("button", { name: "close library song 1", exact: true })).toBeVisible();
    mode = "invalid";
    await showMore.click();
    await expect(page.getByRole("alert")).toContainText("invalid songs response");
    await expect(items).toHaveCount(50);
    mode = "valid";
    await showMore.click();
    await expect(items).toHaveCount(52);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "close library song 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "end of list", exact: true })).toBeDisabled();
    expect(cursors).toEqual(Array(3).fill(`${librarySongs[49].createdAt},${librarySongs[49].id}`));
  });

  test("finds and pages favourites beyond the first page of all songs and resets the cursor on tab changes", async ({ authedPage: page }) => {
    const requests: { favourites: boolean; before: string | null }[] = [];
    const favouriteCursor = `${librarySongs[99].createdAt},${librarySongs[99].id}`;
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => {
      const query = new URL(route.request().url()).searchParams;
      const favourites = query.get("favourites") === "true";
      const before = query.get("before");
      requests.push({ favourites, before });
      if (favourites) {
        expect(before === null || before === favouriteCursor).toBe(true);
        return fulfillJson(route, { songs: before ? librarySongs.slice(100) : librarySongs.slice(50, 100) });
      }
      expect(before).toBeNull();
      return fulfillJson(route, { songs: librarySongs.slice(0, 50) });
    });
    await page.goto("/songs");
    const items = page.getByRole("list", { name: "saved songs", exact: true }).getByRole("listitem");
    await expect(items).toHaveCount(50);
    await page.getByRole("tab", { name: "favourites", exact: true }).click();
    await expect(items.first()).toContainText("library song 51");
    await expect(items).toHaveCount(50);
    await page.getByRole("button", { name: "show more", exact: true }).click();
    await expect(items).toHaveCount(55);
    await expect(items.last()).toContainText("library song 105");
    await expect(page.getByRole("button", { name: "end of list", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "all songs", exact: true }).click();
    await expect(items.first()).toContainText("library song 1");
    await expect(items).toHaveCount(50);
    await expect(page.getByRole("button", { name: "show more", exact: true })).toBeEnabled();
    expect(requests).toEqual([
      { favourites: false, before: null }, { favourites: true, before: null },
      { favourites: true, before: favouriteCursor }, { favourites: false, before: null },
    ]);
  });

  test("lists songs, favourites one, and opens its details", async ({ authedPage: page }) => {
    let favourite = false;
    let fail = true;
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => fulfillJson(route, {
      songs: songs.map((song) => ({ ...song, isFavourite: song.title === "quiet morning" ? favourite : song.isFavourite }))
        .filter((song) => !new URL(route.request().url()).searchParams.has("favourites") || song.isFavourite),
    }));
    await page.route(/\/api\/songs\/recovery$/, (route) => fulfillJson(route, { songIds: [] }));
    await page.route(/\/api\/songs\/[^/]+\/favourite$/, async (route) => {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      if (fail) return route.fulfill({ status: 503 });
      favourite = (JSON.parse(route.request().postData() ?? "{}") as { isFavourite: boolean }).isFavourite;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/songs");

    await expect(page.getByRole("heading", { name: "my songs" })).toBeVisible();
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toBeVisible();
    await expect(page.getByRole("button", { name: "listen untitled" })).toBeVisible();
    await page.getByRole("tab", { name: "favourites" }).click();
    await expect(page.getByText("no favourites yet.")).toBeVisible();
    await page.getByRole("tab", { name: "favourites" }).press("Home");
    await expect(page.getByRole("tab", { name: "all songs" })).toBeFocused();
    await page.getByRole("button", { name: "favourite quiet morning" }).click();
    await expect(page.getByRole("alert")).toContainText("could not update favourite");
    await expect(page.getByRole("button", { name: "favourite quiet morning" })).toHaveAttribute("aria-pressed", "false");
    fail = false;
    await page.getByRole("button", { name: "favourite quiet morning" }).click();
    await expect(page.getByRole("button", { name: "favourite quiet morning" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("tab", { name: "favourites" }).click();
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toBeVisible();
    await expect(page.getByRole("button", { name: "listen untitled" })).toHaveCount(0);
    await page.getByRole("button", { name: "favourite quiet morning" }).click();
    await expect(page.getByText("no favourites yet.")).toBeVisible();

    await page.getByRole("tab", { name: "all songs" }).click();
    await page.getByRole("button", { name: "favourite quiet morning" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "favourite quiet morning" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "listen quiet morning" }).press("Enter");
    await expect(page.getByText("select a song to view its prompt and lyrics.")).toHaveCount(0);
    await expect(page.getByLabel("genre / style")).toHaveValue("warm acoustic folk");
    await expect(page.getByLabel("genre / style")).toHaveAttribute("readonly", "");
    await page.getByRole("button", { name: "play quiet morning", exact: true }).click();
    await expect.poll(() => page.locator("audio[aria-label='quiet morning']").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "download MP3 quiet morning" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe(`song-${songs[0].id}.mp3`);
    const first = await page.locator("audio[aria-label='quiet morning']").elementHandle();
    await page.getByRole("button", { name: "listen untitled" }).click();
    await expect.poll(() => first!.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    await expect(page.getByLabel("original prompt")).toHaveValue("instrumental piano");
    await expect(page.getByLabel("genre / style")).toHaveValue("");
    await page.getByRole("button", { name: "close untitled" }).click();
    await expect(page.getByText("select a song to view its prompt and lyrics.")).toBeVisible();
    await page.getByRole("button", { name: "listen quiet morning" }).click();
    expect(await page.locator("audio[aria-label='quiet morning']").evaluate((audio, previous) => audio === previous, first)).toBe(true);
    await page.setViewportSize({ width: 320, height: 760 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("shows the empty state with no saved songs", async ({ authedPage: page }) => {
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => fulfillJson(route, { songs: [] }));
    await page.route(/\/api\/songs\/recovery$/, (route) => fulfillJson(route, { songIds: [] }));

    await page.goto("/songs");
    await expect(page.getByText(/no saved songs yet/)).toBeVisible();
    await page.getByRole("link", { name: "create a song in chat" }).click();
    await expect(page.getByText("0 / 16")).toBeVisible();
  });

  test("rejects failed or invalid lists and recovers with the visible retry action", async ({ authedPage: page }) => {
    let mode = "offline";
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => mode === "offline" ? route.fulfill({ status: 503 })
      : fulfillJson(route, { songs: mode === "invalid" ? [{ ...songs[0], url: "https://untrusted.invalid/audio" }] : songs }));
    await page.goto("/songs");
    await expect(page.getByRole("alert")).toContainText("could not load your songs");
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toHaveCount(0);
    mode = "invalid";
    await page.getByRole("button", { name: "try again", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("invalid songs response");
    mode = "valid";
    await page.getByRole("button", { name: "try again", exact: true }).click();
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("confirms deletion, preserves the selected song on failure, and retries once", async ({ authedPage: page }) => {
    let remaining = songs;
    let fail = true;
    let deletes = 0;
    let finishDelete = () => {};
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => fulfillJson(route, { songs: remaining }));
    await page.route(new RegExp(`/api/songs/${songs[1].id}$`), async (route) => {
      expect(route.request().method()).toBe("DELETE");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      deletes++;
      if (fail) return route.fulfill({ status: 502 });
      await new Promise<void>((resolve) => { finishDelete = resolve; });
      remaining = [songs[0]];
      await route.fulfill({ status: 204 });
    });
    await page.goto("/songs");
    await page.getByRole("button", { name: "listen untitled" }).click();
    const trigger = page.getByRole("button", { name: "delete untitled", exact: true });
    const dialog = page.getByRole("dialog", { name: "delete song?" });
    await trigger.click();
    await expect(dialog).toContainText("untitled");
    await expect(dialog.getByRole("button", { name: "cancel", exact: true })).toBeFocused();
    expect(deletes).toBe(0);
    await dialog.getByRole("button", { name: "cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(deletes).toBe(0);
    await trigger.click();
    await dialog.getByRole("button", { name: "delete song", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("could not delete the song");
    await expect(page.getByLabel("original prompt")).toHaveValue("instrumental piano");
    await expect(page.getByRole("button", { name: "close untitled" })).toBeVisible();
    fail = false;
    await dialog.getByRole("button", { name: "delete song", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "deleting..." })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(deletes).toBe(2);
    finishDelete();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "my songs" })).toBeFocused();
    await expect(page.getByRole("button", { name: "listen untitled" })).toHaveCount(0);
    await expect(page.getByText("select a song to view its prompt and lyrics.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toBeVisible();
    await expect(page.getByRole("button", { name: "listen untitled" })).toHaveCount(0);
  });

  test("discovers unsaved songs and retries storage without generating again", async ({ authedPage: page }) => {
    const recovered = { ...songs[0], id: "33333333-3333-4333-8333-333333333333", title: "recovered song",
      url: "/api/music/33333333-3333-4333-8333-333333333333.mp3", createdAt: "2026-10-07T10:00:00Z" };
    let recoveryMode = "offline";
    let saveMode = "failure";
    let saved = false;
    let generations = 0;
    let retries = 0;
    let finishSave = () => {};
    await page.route(/\/api\/songs(?:\?.*)?$/, (route) => fulfillJson(route, { songs: saved ? [recovered, songs[0]] : [songs[0]] }));
    await page.route(/\/api\/songs\/recovery$/, (route) => recoveryMode === "offline" ? route.fulfill({ status: 503 })
      : fulfillJson(route, { songIds: recoveryMode === "invalid" ? ["invalid-id"] : saved ? [] : [recovered.id] }));
    await page.route(/\/api\/music$/, (route) => { generations++; return route.abort(); });
    await page.route(new RegExp(`/api/songs/${recovered.id}/retry$`), async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      retries++;
      if (saveMode === "failure") return fulfillJson(route, { error: "song storage unavailable. try again." }, 502);
      if (saveMode === "invalid") return fulfillJson(route, { track: songs[0] });
      await new Promise<void>((resolve) => { finishSave = resolve; });
      saved = true;
      await fulfillJson(route, { track: recovered });
    });
    await page.goto("/songs");
    await expect(page.getByRole("alert")).toContainText("could not load unsaved songs");
    await expect(page.getByRole("button", { name: "listen quiet morning" })).toBeVisible();
    recoveryMode = "invalid";
    await page.getByRole("button", { name: "try again", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("invalid unsaved songs response");
    recoveryMode = "valid";
    await page.getByRole("button", { name: "try again", exact: true }).click();
    const retry = page.getByRole("button", { name: "retry saving unsaved song 1" });
    await retry.click();
    await expect(page.getByRole("alert")).toContainText("song storage unavailable");
    saveMode = "invalid";
    await retry.click();
    await expect(page.getByRole("alert")).toContainText("invalid saved song response");
    await expect(page.getByRole("button", { name: "listen recovered song" })).toHaveCount(0);
    saveMode = "pending";
    await retry.click();
    await expect(page.getByRole("button", { name: "saving... unsaved song 1", exact: true })).toBeDisabled();
    expect(retries).toBe(3);
    finishSave();
    await expect(page.getByRole("button", { name: "listen recovered song" })).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(generations).toBe(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "listen recovered song" })).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(generations).toBe(0);
  });
});
