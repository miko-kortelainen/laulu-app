export async function sendMessage(message: string): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data: unknown = await response.json();

  if (!data || typeof data !== "object") {
    throw new Error("Invalid chat response.");
  }

  const reply = "reply" in data && typeof data.reply === "string" ? data.reply : "";
  const error = "error" in data && typeof data.error === "string" ? data.error : "";

  if (!response.ok) {
    throw new Error(error || reply || "Chat request failed.");
  }

  return reply || error || "No response received.";
}

export async function resetChat(): Promise<void> {
  const response = await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "default" }),
  });

  if (!response.ok) {
    throw new Error("Conversation reset failed.");
  }
}
