import { supabase } from "./supabase";

let userId: string | undefined;
let requests = new AbortController();

export function setApiUser(nextUserId: string | undefined): void {
  if (nextUserId === userId) return;
  requests.abort();
  requests = new AbortController();
  userId = nextUserId;
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!url.startsWith("/api/")) throw new Error("invalid API address.");
  if (!supabase || !userId) throw new Error("log in to continue.");
  const controller = requests;
  const { data, error } = await supabase.auth.getSession();
  controller.signal.throwIfAborted();
  if (error) throw error;
  if (!data.session || data.session.user.id !== userId) throw new Error("log in to continue.");
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${data.session.access_token}`);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const response = await fetch(url, { ...options, headers, signal });
  controller.signal.throwIfAborted();
  if (response.status === 401) {
    window.dispatchEvent(new Event("session-expired"));
    throw new Error("your session expired. log in again.");
  }
  return response;
}

export async function downloadAudio(url: string, name: string): Promise<void> {
  const response = await authenticatedFetch(url);
  if (!response.ok) throw new Error("could not download audio. try again.");
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export async function getPlaybackUrl(src: string, signal: AbortSignal): Promise<string> {
  const response = await authenticatedFetch("/api/playback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src }), signal,
  });
  if (!response.ok) throw new Error("could not load audio.");
  const data: unknown = await response.json();
  if (!hasPlaybackUrl(data) || !data.url.startsWith(`${src}?playback=`)) throw new Error("invalid audio address.");
  return data.url;
}

function hasPlaybackUrl(data: unknown): data is { url: string } {
  if (!data || typeof data !== "object") return false;
  return "url" in data && typeof data.url === "string";
}
