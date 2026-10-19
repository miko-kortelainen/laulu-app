import { cn } from "@/lib/utils";
import { musicPromptFields, type MusicPrompt } from "@/lib/music-prompt";

type MusicPromptFieldsProps = {
  prompt: MusicPrompt;
  model: string;
  title: string;
} & ({ readOnly: true } | {
  readOnly?: false;
  updatedFields: (keyof MusicPrompt)[];
  disabled: boolean;
  onChange: (field: keyof MusicPrompt, value: string) => void;
  onModelChange: (model: string) => void;
  onTitleChange: (title: string) => void;
});

export function MusicPromptFields(props: MusicPromptFieldsProps) {
  const { prompt, model, title, readOnly } = props;
  const updatedFields = props.readOnly ? [] : props.updatedFields;
  const controlClass = "w-full min-w-0 rounded-lg border border-white/15 bg-zinc-900/60 px-3 pt-[8.5px] pb-[7.5px] text-sm text-zinc-100 motion-safe:transition-[background-color,box-shadow] motion-safe:duration-150 motion-safe:ease-out focus-visible:border-white/15 focus-visible:bg-zinc-800 focus-visible:shadow-[inset_0_3px_7px_rgb(0_0_0/0.55),0_1px_0_rgb(255_255_255/0.09)] focus-visible:outline-hidden disabled:opacity-60";

  return (
    <fieldset disabled={!props.readOnly && props.disabled} aria-label="song prompt" className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <p aria-live="polite" className="sr-only">
        {updatedFields.length > 0 && `updated: ${musicPromptFields.filter(({ name }) => updatedFields.includes(name)).map(({ label }) => label).join(", ")}`}
      </p>
      <label className="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span className="text-xs text-zinc-400">song title</span>
        <input name="songTitle" type="text" readOnly={readOnly} value={title} placeholder="untitled" maxLength={200}
          onChange={(event) => { if (!props.readOnly) props.onTitleChange(event.target.value); }} className={controlClass} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span className="text-xs text-zinc-400">music model</span>
        {readOnly ? (
          <input name="musicModel" readOnly value={model} className={controlClass} />
        ) : (
          <select name="musicModel" value={model} onChange={(event) => { if (!props.readOnly) props.onModelChange(event.target.value); }} className={controlClass}>
            <option value="lyria-3.5">Lyria 3.5</option>
            <option value="lyria-3-clip-preview">Lyria 3 Clip Preview (30 seconds)</option>
          </select>
        )}
      </label>
      {musicPromptFields.map((field) => (
        <label key={field.name} className={cn("flex min-w-0 flex-col gap-1", "multiline" in field && "sm:col-span-2")}>
          <span className="text-xs text-zinc-400">{field.label}</span>
          {"multiline" in field ? (
            <textarea name={field.name} readOnly={readOnly} value={prompt[field.name]} rows={field.name === "lyrics" ? 6 : 2}
              maxLength={field.name === "lyrics" ? 3000 : undefined}
              onChange={(event) => { if (!props.readOnly) props.onChange(field.name, event.target.value); }}
              className={cn(controlClass, "resize-y", updatedFields.includes(field.name) && "music-field-updated")} />
          ) : (
            <input name={field.name} type="text" readOnly={readOnly} value={prompt[field.name]}
              onChange={(event) => { if (!props.readOnly) props.onChange(field.name, event.target.value); }}
              className={cn(controlClass, updatedFields.includes(field.name) && "music-field-updated")} />
          )}
        </label>
      ))}
    </fieldset>
  );
}
