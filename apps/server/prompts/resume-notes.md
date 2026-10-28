{{NAME}} left notes on their resume in the Sidedoor resume editor and wants you to act on them now.
The resume is id **{{RESUME_ID}}**. Today is {{TODAY}}.

## Open notes
Each note has an id, a `target` (the resume line id it's attached to, or null for the whole
resume), a `quote` (the text they selected, if any) and a thread.
{{NOTES}}

## What to do
1. `get_resume` {{RESUME_ID}} to see every line with its id. Read `get_profile_doc` 'experience'
   (the only source of facts) and 'writing' (how they write).
2. For each open note: when it asks for a change you can make with true facts, make it directly
   with `update_resume_lines` / `add_resume_line` / `remove_resume_line`, keeping line ids. Don't
   put it in a suggestion list for them to apply. The editor shows every line you changed so they
   can keep, tweak or undo it.
3. Only use facts from Experience or the notes. If a note needs a fact you don't have (a number, a
   date), don't invent one: ask in your reply.
4. Any prose you write follows their writing style. Run `check_tells` on each new or rewritten line
   and fix every hit with weight >= 1. When a note quotes their own wording, edit it only very
   slightly. Stories in the story bank are good material; their "Facts to confirm" aren't confirmed.
5. `build_resume_pdf` {{RESUME_ID}} at the end and keep it within its page limit (usually 2).

Reply with a short summary: per note, what you changed, or the question you need answered.
