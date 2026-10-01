import { useRef, useState } from "react";
import { resetChat, sendMessage } from "./api";

export interface Message {
  role: "user" | "agent";
  text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "Hello! I am your AI assistant powered by NVIDIA Nemotron Super on Nebius Token Factory. How can I help you?",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || busy.current) return;

    busy.current = true;
    setLoading(true);
    setMessages((previous) => [...previous, { role: "user", text: message }]);

    const reply = await sendMessage(message).catch(
      (error: unknown) => `Error: ${errorMessage(error)}`,
    );

    setMessages((previous) => [...previous, { role: "agent", text: reply }]);
    busy.current = false;
    setLoading(false);
  }

  async function clear(): Promise<void> {
    if (busy.current) return;

    busy.current = true;
    setLoading(true);

    const error = await resetChat().catch(
      (cause: unknown) => new Error(errorMessage(cause)),
    );

    if (error) {
      setMessages((previous) => [
        ...previous,
        { role: "agent", text: `Error: ${error.message}` },
      ]);
    } else {
      setMessages([
        { role: "agent", text: "Conversation cleared. How can I help you?" },
      ]);
    }

    busy.current = false;
    setLoading(false);
  }

  return { messages, loading, send, clear };
}
