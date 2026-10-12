import { useId } from "react";
import { cn } from "@/lib/utils";

export function LauluWordmark({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    // Monoton's glyph bounds let the word scale evenly to its container width.
    <svg className={cn("font-brand font-normal", className)} viewBox="93 -1482 7171 1554" role="img" aria-label="laulu">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f87171" />
          <stop offset="33%" stopColor="#fb923c" />
          <stop offset="67%" stopColor="#fde047" />
          <stop offset="100%" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      <text fontSize="2048" fill={`url(#${gradientId})`}>laulu</text>
    </svg>
  );
}
