{{NAME}} rambled an answer for a job application into a box, maybe by voice. Turn it into something
they can send: the same person saying the same things, organized and a little better. Today is
{{TODAY}}.

## The application
{{LEAD_NAME}}

## What it answers
{{QUESTION}}

## What they wrote
<<<TEXT
{{TEXT}}
TEXT>>>

## What to do
- Put their points in a sensible order, with the answer to the question first. Merge repeats, and
  drop false starts, filler and asides that don't answer the question.
- Fix grammar and speech-to-text mistakes. Keep their words and turns of phrase wherever they work:
  it should sound like them on a good day, not like an AI.
- Never add a fact, number, name, date, title, skill, reason or feeling they didn't say. Never
  change a number. If something is unclear, keep it plain rather than guess.
- Return plain text with paragraph breaks, without a heading or the question.

## Their writing style
{{WRITING_RULES}}

## Output
Return JSON {"text": "<the cleaned-up answer>"}.
