import { CodeBlock } from "@/components/ui/code-block";
import { cn } from "@/lib/utils";
import type { Message } from "./useChat";

function MessageContent({ text }: { text: string }) {
  const parts = [];
  let lastIndex = 0;

  for (const match of text.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={lastIndex} className="whitespace-pre-wrap">
          {text.slice(lastIndex, match.index)}
        </span>,
      );
    }

    parts.push(
      <div
        key={match.index}
        className="my-2 max-w-full overflow-hidden first:mt-0 last:mb-0"
      >
        <CodeBlock code={match[2]} language={match[1] || "typescript"} />
      </div>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={lastIndex} className="whitespace-pre-wrap">
        {text.slice(lastIndex)}
      </span>,
    );
  }

  return <>{parts}</>;
}

export function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 max-w-[90%] sm:max-w-[85%]",
        isUser ? "ml-auto items-end" : "mr-auto items-start",
      )}
    >
      <div className="text-[11px] font-mono text-zinc-500 px-4">
        {isUser ? "You" : "Nemotron Super"}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          "[overflow-wrap:anywhere] border",
          isUser && "border-transparent bg-zinc-100 font-medium text-zinc-950",
          isUser && "dark:bg-white dark:text-zinc-950",
          !isUser && "border-white/10 bg-zinc-900/80 text-zinc-100 shadow-xs",
        )}
      >
        <MessageContent text={isUser ? message.text : message.text.trim()} />
      </div>
    </div>
  );
}
