import { cn } from "@/lib/utils";
import { musicPromptFields, type MusicPrompt } from "./musicPrompt";

export function MusicPromptFields({ prompt, updatedFields, model, disabled, onChange, onModelChange }: {
  prompt: MusicPrompt;
  updatedFields: (keyof MusicPrompt)[];
  model: string;
  disabled: boolean;
  onChange: (field: keyof MusicPrompt, value: string) => void;
  onModelChange: (model: string) => void;
}) {
  const controlClass = "w-full min-w-0 rounded-lg border border-white/15 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-60";

  return (
    <fieldset disabled={disabled} aria-label="song prompt" className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <p aria-live="polite" className="sr-only">
        {updatedFields.length > 0 && `updated: ${musicPromptFields.filter(({ name }) => updatedFields.includes(name)).map(({ label }) => label).join(", ")}`}
      </p>
      <label className="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span className="text-xs text-zinc-400">music model</span>
        <select name="musicModel" value={model} onChange={(event) => onModelChange(event.target.value)} className={controlClass}>
          <option value="lyria-3.5">Lyria 3.5</option>
          <option value="lyria-3-clip-preview">Lyria 3 Clip Preview (30 seconds)</option>
        </select>
      </label>
      {musicPromptFields.map((field) => (
        <label key={field.name} className={cn("flex min-w-0 flex-col gap-1", "multiline" in field && "sm:col-span-2")}>
          <span className="text-xs text-zinc-400">{field.label}</span>
          {"multiline" in field ? (
            <textarea name={field.name} value={prompt[field.name]} rows={field.name === "lyrics" ? 6 : 2}
              maxLength={field.name === "lyrics" ? 3000 : undefined}
              onChange={(event) => onChange(field.name, event.target.value)}
              className={cn(controlClass, "resize-y", updatedFields.includes(field.name) && "music-field-updated")} />
          ) : (
            <input name={field.name} type="text" value={prompt[field.name]}
              onChange={(event) => onChange(field.name, event.target.value)}
              className={cn(controlClass, updatedFields.includes(field.name) && "music-field-updated")} />
          )}
        </label>
      ))}
    </fieldset>
  );
}
