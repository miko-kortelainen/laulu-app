import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function ChatInput({ onSubmit, disabled }: { onSubmit: (message: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    function resize() {
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 178)}px`;
    }
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  function submit() {
    if (disabled || !value.trim()) return;
    onSubmit(value);
    setValue("");
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); submit(); }}
      className={cn("relative w-full rounded-2xl border border-white/15 bg-zinc-900/60 shadow-[0_16px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl motion-safe:transition-[background-color,box-shadow] motion-safe:duration-150 motion-safe:ease-out focus-within:border-white/12 focus-within:bg-zinc-800 focus-within:shadow-[inset_0_3px_7px_rgb(0_0_0/0.55),0_1px_0_rgb(255_255_255/0.09)] hover:not-focus-within:border-white/20", disabled && "opacity-60")}>
      <textarea ref={textareaRef} name="message" rows={1} value={value} disabled={disabled}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="chat with laulu" aria-label="Prompt message"
        className="block min-h-11.5 w-full resize-none rounded-[inherit] bg-transparent py-3 pl-4 pr-12 text-sm leading-5.5 text-zinc-100 outline-none placeholder:text-transparent" />
      {value === "" && <p aria-hidden="true" className="pointer-events-none absolute left-4 right-12 top-3 text-sm font-medium leading-5.5 text-zinc-500">
        chat with <span className="bg-clip-text text-transparent"
          style={{ backgroundImage: "linear-gradient(to right, #f87171 0%, #fb923c 33%, #fde047 67%, #4ade80 100%)" }}>laulu</span>
      </p>}
      <button type="submit" disabled={disabled || !value.trim()} aria-label="Send prompt"
        className="absolute right-[10px] bottom-[8.5px] flex size-7 items-center justify-center rounded-full bg-zinc-300 text-black shadow-sm hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 disabled:cursor-not-allowed disabled:opacity-40">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </form>
  );
}
