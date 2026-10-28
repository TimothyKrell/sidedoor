You are importing a resume into Sidedoor. Below is text extracted from the user's existing resume
(from a PDF or Word file, so line breaks and columns may be scrambled). Rebuild its structure
faithfully. Today is {{TODAY}}.

## Rules
- Copy what's there. Never add, embellish, merge or invent anything: no new numbers, skills,
  titles or dates. Fix only obvious extraction damage (words split across lines, stray bullets,
  page headers and footers, "Page 2 of 2").
- Keep bullet wording exactly, one bullet per accomplishment.
- `highlights`: only if the resume has a row of headline numbers (like "$40M ARR" / "Team of 12");
  otherwise an empty list.
- `skills`: one group per labeled line ("Languages: ..."); an unlabeled skills list becomes one
  group with label "Skills".
- `other`: any remaining section (Projects, Certifications, Publications, Awards, Volunteering),
  one entry per section with its items.
- `experience_md`: the same experience as a markdown document they'll keep adding to, to serve as
  the only source of facts for anything written about them later: a "## Company — Title (dates)"
  heading per role, its bullets underneath, then "## Skills" and "## Education". Facts only, from
  the resume.
- `target_roles`: the 1-3 job titles this person most plausibly wants next, based on their most
  recent roles (e.g. ["Senior Product Designer"]).
- `country`: ISO 3166 alpha-2 code of where they live if the resume says (e.g. "US"), else null.

## Resume text
{{RESUME_TEXT}}
