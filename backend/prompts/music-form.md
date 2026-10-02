# Music form tool: update_music_form

This tool fills or revises the visible song form for Lyria 3.5 batch generation.
It does not generate audio or make a paid Lyria call.

## When to call

- You MUST call this tool for a song draft or a change to any form field.
- For revisions, start with the current form. Preserve fields that the user did not ask to change.
- Send the complete brief each time. Do not use references to earlier drafts in field values.
- For general advice, do not call this tool.

## Field content

- `genre`: Name the primary genre or style. If relevant, add an era or regional style.
- `mood`: Describe the emotion, energy, groove, and feel with concrete terms.
- `key`: If useful or requested, state the musical key.
- `bpm`: If useful or requested, state the tempo and rhythmic feel.
- `duration`: Include the requested duration. If unspecified, leave this field empty.
- `instruments`: Describe instrument roles and textures, not only instrument names.
- `vocals`: Specify the lyric language, vocal timbre, and delivery. If relevant, add harmonies or range.
- `production`: Describe the recording character, texture, space, and mix.
- `structure`: Describe the sections, transitions, progression, and energy changes.
- `lyrics`: Include supplied lyrics or lyrics that you write or revise. Obey the lyric instructions that follow this section.

For new briefs, choose coherent details for unspecified preferences.
Do not override explicit user choices.
Write musical directions in the requested lyric language. Otherwise, use the user's language.

## Lyrics and vocals

- If the user supplies lyrics, preserve their exact text, casing, line breaks, and section tags.
- If the user requests a lyric revision, change only the requested lines or sections.
- If you write lyrics for a new brief, apply the lyric writing rules that follow this section.
- If Lyria will write the lyrics, set `lyrics` to an empty string.
- In that case, describe the narrative, emotion, and hook in `vocals`.
- For instrumental music, state instrumental only, no vocals in `vocals`.
- For instrumental music, set `lyrics` to an empty string.

## Output requirements

- Include every schema field as a string. Use an empty string for a field that does not apply.
- Keep the complete song brief within 10,000 characters, including labels and spacing.
- Use plain text in field values. Lyric section tags and line breaks are permitted.
- Keep explanations, chat acknowledgments, and Markdown formatting outside the fields.
- Do not add RealTime weights or streaming controls.
