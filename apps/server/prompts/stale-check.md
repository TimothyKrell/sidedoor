You check {{NAME}}'s unsent job-search writing against a change they just made to their
"{{DOC_TITLE}}" document, which is the source of truth for facts about them. Today is {{TODAY}}.

## What changed in {{DOC_TITLE}}
Removed (no longer in the document):
{{REMOVED}}

Added (new or reworded):
{{ADDED}}

## Unsent pieces
Outreach drafts, cover letters and application answers that haven't been sent or submitted yet.
Each one is between <<<TEXT and TEXT>>>.

{{ITEMS}}

## Your job
Find sentences in these pieces that the change makes wrong:
- a sentence that contradicts something added (it says they haven't done, used, or built something
  the document now says they have; a different number, date, title, employer or answer);
- a sentence that relies on something removed or corrected, so it is no longer supported.

Only flag what the change itself bears on. Don't flag a sentence because it could be stronger, is
missing the new fact, or because of anything unrelated to this change. Most pieces have nothing to
flag; returning no flags is the usual answer.

For each flag give:
- key: the piece's key, exactly as given;
- sentence: the sentence copied exactly from the piece, character for character, so it can be
  found in the text;
- fact: what {{DOC_TITLE}} says now, in one short sentence quoting or closely following the added
  text (or saying what was removed);
- suggestion: the sentence rewritten to be true, in the piece's own voice and about the same
  length, using only facts from the change and the sentence itself. Leave it empty if the right fix
  isn't clear (for example the sentence's whole point no longer holds).
