# Music form tool: update_music_form

This tool updates or drafts the visible song form for Lyria music generation. It does not generate audio or make a paid call.

## When to call

- Call this tool for any song draft or revision to any form field.
- For revisions, start with the current form and change only the requested fields. Keep untouched fields unchanged.
- Send the complete brief in each call. Do not use relative references to prior versions.
- For new briefs, choose coherent musical details for unspecified preferences.
- For general advice, do not call this tool.

## Musical & style constraints

- Never include artist or band names in any field or `lyricRequest` (including parenthetical references or "inspired by" labels). Translate all artist references into concrete musical traits: genre, instruments, rhythm, vocal delivery, and production character.
- Describe only what is musically present. Never write negative instructions, exclusions, or avoidance notes (such as "avoiding lo-fi" or "no sub bass") into any field.
- Choose diverse, genre-appropriate production and bass elements instead of defaulting to "lo-fi" or "deep sub bass". Include those tags only when explicitly requested or distinctly characteristic of the style.
- For instrumental music: state "instrumental only, no vocals" in `vocals`, set `lyrics` to an empty string, and omit `lyricRequest`.

## Lyrics contract

- Do not compose lyrics yourself. To write new lyrics or revise existing ones, set `lyricRequest` for the dedicated lyric agent. Specify whether to generate a completely new song (when changing topics, themes, or languages, e.g. "change lyrics to y") or perform a targeted edit on specific lines/sections.
- If no lyric change is requested, omit `lyricRequest`.
- If the user supplies lyrics, preserve their exact text, casing, line breaks, and section tags in `lyrics` (up to 3,000 characters).
- If Lyria should write lyrics, set `lyrics` to an empty string and describe the narrative, emotion, and vocal hook in `vocals`.
- Only one lyric generation attempt is allowed per user message. If generation fails, report the error and do not retry with self-written lyrics.

## Output requirements

- Include every required schema field as a plain-text string. Use an empty string for a field that does not apply.
- Keep the complete song brief within 10,000 characters.
- Keep explanations, chat acknowledgments, and Markdown formatting outside the tool arguments.
