# Decisions

Calls made while turning the personal Sidedoor into an app anyone can install, and why. Keep this
current when making a non-obvious call. Open questions for the maintainer live in
[QUESTIONS.md](QUESTIONS.md).

## Shape

- **Separate repo history.** The standalone app started on an orphan branch (`standalone`) of the
  personal repo, so it can be published without the personal job-search history in git. The
  personal install keeps running from `master` until the switch.
- **One server process.** The personal app ran a TanStack Start web server and a separate worker,
  sharing a SQLite file. Now one Node process serves the web app, the API, MCP and runs the jobs.
  The desktop app runs it as a child (Electron's own binary with `ELECTRON_RUN_AS_NODE`, like T3
  Code), so users need no Node install and a crash in the server never takes the window down.
- **SPA + typed RPC instead of server functions.** TanStack Start's server functions and SSR don't
  fit a desktop app that also serves phones. The web app is a Vite SPA with TanStack Router and
  Query; `POST /api/rpc/<name>` with zod-validated input, and output types flowing to the client
  through a type-only import of the router. The live-invalidation stream (SQLite triggers → SSE →
  query invalidation) carried over unchanged.
- **`node:sqlite`, not better-sqlite3.** No native module to rebuild for every Electron version on
  three OSes. A 90-line shim (`apps/server/src/db/sqlite.ts`) gives Drizzle's sync driver the
  better-sqlite3 API it expects, including nested transactions as savepoints, so every service
  command and test kept working.
- **Plain tables, no event sourcing.** T3 Code event-sources its agent orchestration. Nothing here
  needs replay; the task queue's "running → requeue/failed on boot" is the only recovery needed.
- **Settings stay in the database** (T3 uses settings.json) so settings changes flow through the
  same live-update path as everything else. Secrets are separate files with 0600 permissions.

## Data the app owns

- **Profile documents replace files in the user's folders.** Career inventory + bullet bank →
  *Experience*; fit criteria → *What I want* (plus structured choices in Settings); applicant
  profile → *Standard answers*; writing rules → *Writing style*; tells.json → *Writing check
  rules*; story bank → *Story bank*. Markdown in the `documents` table, edited in the app or by
  agents through MCP tools.
- **Structured resumes.** Resumes used to be hand-built HTML files edited in an iframe. Now a
  resume is structured content (`packages/shared/src/resume.ts`: header, highlights, sections of
  companies/roles/bullets, skills, education, lists) rendered by a theme. Every line keeps a
  stable id, so in-place editing, notes, the review of agent edits and the match check all work as
  before. Tailored copies are resumes linked to an application, starting from the main resume.
- **Agents never touch files to change user data.** They call MCP tools that write through the same
  service commands as the UI. That keeps all four providers, and agents the user runs outside the
  app, on one contract, and means jobs run in empty scratch directories.

## AI

- **"Bring your own AI", one interface.** `Provider` = `probe()` + `run()`. `run` covers JSON jobs
  (schema), agent jobs (MCP tools, web) and chat (resume + streaming events). Each CLI's headless
  mode is used directly: Agent SDK for Claude Code, `codex exec --json --output-schema`, `grok -p
  --output-format streaming-json --json-schema`, `opencode run --format json`.
- **Per-job choice.** Each kind of job (triage, prep, research, outreach, editor, match, fill,
  chat...) can go to a different provider and model; blank means the default AI and a model
  picked by tier (fast/balanced/best).
- **Claude uses the subscription by default.** `ANTHROPIC_API_KEY` is dropped from Claude Code's
  environment unless the user turns that off, so a stray key in a shell profile doesn't bill the
  API.
- **Jobs are isolated from the user's own agent config**: Claude runs with no setting sources and a
  strict MCP config; Codex with plugins/apps off; OpenCode with its edit/bash tools denied.
- **"Claude", not "Claude Code", in the app.** Anthropic's Agent SDK branding rules don't let a
  third-party product label its integration "Claude Code", so the app, README and messages say
  "Claude" (and "the claude command" where the user has to install or sign in to it). Code
  comments and technical docs still name the CLI.
- **Grok for X.** Grok Build can search X, so "Research on X" (find people at a company on X,
  scan for hiring posts) prefers Grok when it's connected.
- **Grok Bot takes work from a queue; nothing pushes it.** Grok Bot (xAI's desktop agent) has no
  API for starting a task. So it connects to Sidedoor's MCP with a token of its own: through the
  local bridge (`sidedoor mcp grokbot`) when its Bot runs on this computer, or at a public address
  when it runs on Grok Bot's cloud computer. Research sent to it waits in the task queue,
  a routine webhook wakes the Bot, and it takes and reports back on tasks through MCP. Driving its
  desktop window instead (as an unofficial macOS tool does) would be fragile. Polling on a schedule
  would spend the user's Grok Bot usage when there's nothing to do.
- **Only `/mcp` goes public for Grok Bot.** Tailscale Funnel publishes that one path. The web app,
  files and pairing stay on the tailnet. Grok Bot's token can't reach `/mcp/browser` or the API,
  and turning Grok Bot off deletes it. A Bot on this computer needs none of this: it uses the
  local bridge, which is why that's the first option in Settings.
- **Grok Bot may submit, through Sidedoor, when the user turns it on.** The never-submit rule has
  one opt-in exception, so Grok Bot can work through a batch of applications. Sidedoor still does
  the filling and the clicking, in its own window on this computer (saved ATS sign-ins, the same
  upload and navigation limits); Grok Bot never gets the browser tools. The fill itself still can't
  submit: a second, separate run does, and only after a fill that left no required question open.
  Grok Bot may approve applications too (the user chose that over approving each package first).
- **A submit is clicked at most once.** The submit step is told never to click twice, and the task
  records when that step started: a task that dies mid-submit and is retried fails instead of
  submitting again, and an application with `appliedAt` is never submitted. A duplicate application
  is worse than a missed one.
- **Form questions go to the user through Grok Bot, and the answers stay.** A required question the
  package doesn't answer stops the submit; `submission_status` lists it word for word with its
  options, Grok Bot asks, `answer_questions` appends the answers to the package (which the filler
  pastes from) and, for answers about the user rather than the job, to Standard answers, which
  every later fill reads. So the same salary question is asked once.
- **A dry run first, and evidence after.** `submit_application` with `dryRun` fills to the same
  bar and reports questions, but never clicks and leaves the stage alone, so a batch can be checked
  before anything goes. For a submitted application Sidedoor reads the page itself after the click
  (`browser_snapshot` through its own client: URL, title, visible text) and stores it next to the
  confirmation the AI says it saw, so "submitted" doesn't rest on the AI's word alone.
- **Unconfirmed answers are held back in code, not just the prompt.** A dry run filled pronouns
  the package marked "(confirm)" and a "how did you hear" it marked "default; confirm", then
  reported `ready`. Now Sidedoor checks every fill (`src/form-answers.ts`): it reads the package
  markdown into answers with a confirmed flag (a table Answer/Source cell saying confirm, inferred,
  default, guess, TBD or TODO; a TODO left in a written answer; a field matching an open item under
  "Questions for …" or "Needs your decision"), and the filler reports each filled field's source.
  Anything unconfirmed, or `ai_generated`, becomes a question with the form's options, and the fill
  can't be `ready`; the audit (label, value, source, confirmed) is stored with the attempt and
  returned by `submission_status`, and the submit step won't run while any entry is unconfirmed.
  Parsing at fill time instead of a migration: the package is edited freely (by the user, prep and
  `answer_questions`), so a stored flag would go stale, and the user's answers in "Answers to the
  other form questions" confirm a field even while the table still says "(confirm)". Matching form
  labels to package wording is by key words, so it errs toward asking.
- **An open item holds only the field it's about, and the question rows decide what's still open.**
  Key-word matching held `Name` on one form for "(yes/no + project name)" and `First Name` on
  another for "the first stack the JD names": 5 of the 7 holds of this kind in 66 audited fills were
  false. So name, email and phone are held only by an explicit mark, and a label of one or two key
  words has to appear as a phrase. Labels of three or more keep the looser match, which still errs
  toward asking. The package keeps an item's text after its question is answered or dropped, so the
  check also reads the question rows (`settledFor`), and the filler is told which items are settled.
- **"Not needed" lets a held value through only for a hold from an open item, only for the value
  shown, and only from the user.** Without it, dismissing left the field held with no question
  open: one form's `Name` stopped the form until a revision happened to drop the item. A marked,
  self-identification or made-up answer still needs an answer, a different value asks again
  (`filledValue` on the row), and an agent's dismissal releases nothing, since agents read postings:
  it answers with the value instead. A fill still waiting on a dismissed question reopens it, so a
  form never stops with nothing to answer.
- **A self-identification no in the form's own words matches a standard no.** "No, I am not a
  veteran or active member" shares too few words with "not a veteran (pick …)", so the fill asked
  about veteran status again. A value starting "No" / "Not" / "I am not" now matches an answer for
  that kind of question that also starts with a no, unless it says "but". Yes needs the words to
  match, and a decline still matches only a decline.
- **An answer confirms a field more strictly than a mark holds one.** Holding errs toward asking,
  so `sameQuestion` matches either way round. Confirming lets a value through, so an answer to
  "Name" doesn't confirm "Emergency contact name" (`confirmsField`).
- **Self-identification answers come only from the user.** Gender, pronouns, race/ethnicity,
  Hispanic/Latino, veteran, disability, orientation: filled only when Standard answers state that
  answer for that kind of question (a "decline" there covers a decline option), or the user
  answered it through `answer_questions` (those go to Standard answers automatically). An explicit
  Standard answer wins over the package's own "(confirm)" on the same field. One answer isn't read
  into another: "Race/ethnicity: White" doesn't answer "Are you Hispanic/Latino?".
- **Routine consent boxes go in on one yes in Standard answers.** "I certify this is true" and
  "I agree to the privacy policy" stopped nearly every submit, and the answer is always the same.
  A line in Standard answers about consent or certification boxes that says yes ("Yes, accept")
  lets the fill tick the required ones, and the audit confirms them from that line, not from the
  filler's say-so. It never covers arbitration, background/credit/drug checks, non-competes, texts,
  marketing or talent communities: those still ask. Without the line, nothing changes.
- **A batch sends one form at a time, and decides each at its turn.** It queues the next fill only
  when the last one is done, instead of queueing all of them: the form lock already serializes
  fills, but queueing ahead would make pause and cancel race the queue, and a company's limit has
  to be checked against what actually went in by then. A form already filling isn't interrupted
  (it might be mid-submit); pause and cancel hold back only the one waiting. Batches live in the
  meta store, not a table: no migration, and they update live like settings; the fill tasks keep
  the real outcomes, so the report reads them rather than copying them.
- **Company limits count what went in, plus what this batch sent.** `appliedAt` within the window
  is the history; a batch item whose form came back with questions still counts, since it may go
  in once they're answered. One role per company per batch by default, because a second
  application the same day reads as spray. Both apply to dry runs too, so the dry run's report is
  what the real run would do.
- **A batch wants the tailored resume.** An application with no tailored resume stops with a
  rule block instead of quietly sending the base one (`allowBaseResume` to opt in). The PDF is
  rebuilt when its file is gone or older than the resume's last change: it used to be built once
  and then reused, so edits after the first build never reached the form.
- **A job page is read for its apply link before filling.** Applications made from a listing
  often have only the company's careers page. The batch fetches it (public hosts only) and takes
  an ATS apply link, a Greenhouse embed (`gh_jid`), an Apply link, or an ATS link in the page's
  data, and saves it as the apply URL; a mailto becomes an email application, marked, not
  filled. When nothing is found the page itself is filled, as before.
- **A batch's dry-run windows close after the report.** Forty-nine windows left open for review
  would be the cost of a check; nothing in a dry run needs the user's eyes there.
- **A submit that stops for questions leaves its window open.** It used to close, since answering
  fills it again from scratch, but the window vanishing with no word looked like a crash. Now it
  stays, with a banner saying how many questions and what to do, and the Review page's Send step
  lists them. A batch still closes its windows (`closeWhenDone`, now set for every batch item).
- **The next fill picks up the window a submit left open** instead of starting over in a new one.
  It puts the submit guard back (`FormTab.guard`, the bridge's `/tabs/:id/guard`), and the fill
  keeps what's there, fills in the answers and reports every field, instead of a whole new fill
  (up to 30 minutes, the resume uploaded again) for two answers.
  Three guards on the pre-submit check: what the window held before is checked with what the fill
  reports now, since a field on a step behind it can't be seen; a field Sidedoor held back must be
  reported again (or asked), or the fill starts over in a new window, because an answer you gave
  confirms its field whatever the window still holds; and a window that's gone, or a new apply URL,
  means a new window. Values typed in by hand count as the AI's, so Sidedoor asks about them.
- **The submit step clicks past a leftover validation message.** Greenhouse keeps "Select a
  country" on the phone's country picker after it's set, until submit is clicked again (checked on
  a live form). The submit step stopped on any flagged field, so a picked-up window that had failed
  once never went in, and asked the same question again. Now only an empty required field stops
  it; a click on a form that's still wrong is rejected by the form and reported as before. The fill
  also sets a phone's country picker from the profile, since it isn't marked required.
- **Long documents are read in pages, not cut.** AI clients cap tool results, so a 51K-character
  Experience document returned whole lost its newest sections (the end, where confirmed facts are
  appended). `get_profile_doc` returns 20,000-character pages ending at line breaks, with
  `nextOffset` and a heading outline to jump by; `get_application` pages the package the same way.
  Agent reads that still cut (notes, research briefs, task logs, board descriptions, prompt
  excerpts) say so, with the offset and the call that reads on; nothing is cut silently.
- **Prep, match and form filling get Experience in their prompt, not by paging.** Telling prep to
  read every page wasn't enough: four reruns barely moved, and their logs suggested the agents never
  reached the newest section, where the confirmed answers were. Now `experience.ts` puts the
  document in the prompt: all of it up to 64,000 characters (16K tokens, a fair price for the
  facts the package is built from); past that, the opening, the newest sections, and the sections
  that share the most (rarer) terms with the posting, confirmed ones counting extra, with every
  section left out listed by heading and offset. The prompt says later sections win over older
  lines that disagree, and the task log records the document's version and which sections went
  in. Filling a form gets 24,000 characters chosen against the posting and package. A digest kept
  up to date by an AI was the other option; it would be one more thing to drift from the source.
- **Agents use MCP, not the database file.** A Bot that can run commands here could write to
  `sidedoor.sqlite` directly, and once did, to an old copy it found. MCP reaches only the running
  app, goes through the same commands as the UI, and keeps the never-send rule in one place.

## MCP

- **One endpoint, profiles by path**: `/mcp` (all app tools), `/mcp/story` (story interviews can
  only save stories), `/mcp/lookup` (JSON jobs can only look things up), `/mcp/browser` (form fills
  add the browser tools).
- **Bearer token**, not OAuth. T3 Code runs a small OAuth server so hosted agents can connect; local
  CLIs don't need that.
- **"Connect" registers a stdio bridge command**, not a URL: `<Sidedoor binary> <~/.sidedoor/runtime/
  <version>/dist/bin.mjs> mcp` with `ELECTRON_RUN_AS_NODE=1`. The bridge reads the current port and
  token at launch, so the user's config never goes stale, and it runs as plain Node (no display;
  works over SSH). The runtime copy exists because AppImages run from a temporary mount.
- **Browser tools are Playwright MCP, proxied.** During a fill, Sidedoor attaches Playwright MCP to
  the form window and re-exposes its tools on `/mcp/browser`, minus anything that runs scripts or
  closes windows (matched by pattern: Playwright renames tools between versions; it added
  `browser_run_code_unsafe`). A click the agent labels "submit" is refused in the proxy, on top of
  the in-page guard.

## Desktop

- **Form windows are real windows**, not a webview in the app page (T3 uses a `<webview>`): a fill
  must survive the user navigating elsewhere, and each form is reviewed and submitted where it was
  filled. They share a persistent partition so ATS sign-ins stick.
- **The submit guard is injected through the debugger** (`Page.addScriptToEvaluateOnNewDocument`)
  and removed when the fill finishes, so the next page of a multi-page form lets the user submit.
- **Opening a form window has a limit per step**, and the server's wait covers them all with room
  to spare (`packages/shared/src/form-window.ts`: load 35s, Page.enable 10s, guard 5s, frames 10s;
  server 90s). The desktop then always answers first with the step that hung, the elapsed time and
  the URL. Before, 45s + 15s used the server's whole 60s and fills failed with a bare "aborted due
  to timeout". When the server gives up, the desktop calls the open off and destroys the window. On
  a timeout the server pings the desktop, resets the forms session (`/tabs/reset`) and tries once
  more. If the desktop doesn't answer the ping, it says so instead of waiting again.
- **An uncaught exception in the desktop's main process is logged, not shown.** Electron's default
  is a modal error box, and while it waits for a click the bridge accepts nothing, so every fill
  timed out. That happened on Oct 30, after a form window closed while Playwright was still talking
  to it. The CDP relay now also treats a closed window as an error reply, not a throw.
- **PDFs come from Electron's printer** (offscreen window, `printToPDF`), so no browser install is
  needed. Page count is read from the PDF itself (no `pdfinfo`).
- **Tray + keep running.** T3 quits when its windows close (except on macOS). The scout is the
  product, so Sidedoor hides to the tray by default.
- **No login screen on desktop.** The desktop generates a token per launch, passes it to the server
  on fd 3 and sets it as the window's session cookie. Browsers and phones pair with a separate,
  rotatable access token (`/pair#token=…`, QR code in Settings).

## Onboarding and defaults

- **New installs start quiet.** Auto-prep, auto-research and the funding radar are off by default
  (they spend the user's AI subscription); triage and daily discovery are on. Nothing AI-shaped
  runs until onboarding is finished and an AI is connected.
- **Filters come from choices.** Title and location regexes are generated from "job titles" and
  "where you can work" (`apps/server/src/scout/filters.ts`) instead of hard-coded engineering
  leadership / US patterns. Empty filters pass everything; AI triage makes the real call.
- **Starter sources** are a catalog (`apps/server/defaults/sources.json`) of public job feeds and
  company boards tagged by industry, preselected by the user's choices.
- **Default writing guide is original.** The personal writing rules were distilled from a paid
  course, so they aren't shipped; the importer brings them over for their owner.

## Scout

- **Filters get a second look.** A posting the filters drop is stored without its description and
  was never looked at again, so loosening a filter only helped future postings. Now each scan runs
  the current filters again over the board's still-listed postings that the filters dropped and
  nobody touched; the ones that pass now go to triage with the description from that read. It's a
  regex per listed posting, cheap next to the fetch.
- **Two age limits.** A company's own board lists only what's open, and senior roles stay up for
  months. On one user's data, the 30-day limit was dropping about as many plausible open roles on
  company boards as the title filter's gaps. Company boards get `boardMaxAgeDays` (180); feeds keep
  `maxAgeDays` (30), since aggregators keep listings after they fill.
- **Boards found through feeds are watched.** Resolving an aggregator listing finds the company's
  own board. That board just listed a role that passed the user's filters, so it's polled from then
  on, instead of waiting as a candidate the user rarely switches on (85 had piled up). It's switched
  on once for boards already waiting; a board the user pauses or rejects stays that way.
- **Descriptions on demand.** Workday, SmartRecruiters and Rippling list jobs without descriptions.
  The scout reads the full posting only for jobs that pass the filters (at most 60 per board per
  scan, three at a time; the rest wait for the next poll). That full posting is filtered again,
  since it can say more about where the job is.
- **Paced sources.** Workday reads up to ten pages of 20, one at a time, so it's polled at most
  hourly. So is the HN thread, one large download that changes slowly. Remotive asks for at most
  four reads a day, so it's polled every six hours. These floors hold even for "scan now".
- **JSON feeds are feeds.** Remotive, Jobicy's API, Working Nomads and JSON Feed are read by the rss
  kind. A URL that's neither RSS nor a JSON job feed is an error on Sources, not a feed that is
  quietly always empty; two such sources had sat active with no jobs.
- **Industries are preferences.** Triage, discovery and the funding radar treat the user's
  industries as where they'd most like to work, not a requirement, unless they mark one required
  or a dealbreaker. A strong role at a solid company elsewhere scores a little lower, not out.
  Discovery looks for as many companies outside the industries as inside, and for more per run.

## Migration from the personal install

- `sidedoor import-legacy <old checkout> [--resume-dir ~/Code/resume]` copies (never moves)
  everything: tables column by column, settings mapped to the new shape (the tuned title/location
  regexes are kept as is), meta bookkeeping, secrets, profile documents, and every resume parsed
  from the old HTML template with its `data-id`s. Old queued/running tasks become cancelled
  history. Tailoring on already-sent applications counts as reviewed. Resumes in a layout the
  parser can't read start as a copy of the main resume, with the original PDF attached.

## Developing while using it

- **The everyday install is built from a commit, not an installer** (`pnpm ship`, Linux). Packaging
  takes minutes; a plain build takes seconds, so a change reaches the app you use in about ten.
  It runs from `~/Code/sidedoor-daily`, which nobody edits, so work in progress in a checkout
  can't break it.
- **Two build slots, not one.** A build overwrites its output, so building over the live one
  would leave a broken app if the build failed halfway. The spare slot is built and checked
  first; switching is a symlink rename, and the previous build stays for an instant rollback.
- **A ship proves itself.** It runs the typecheck and tests in the slot, backs up the database,
  restarts, and waits for `/health` to report the shipped commit. If it doesn't, it switches back.
- **The app runs as a transient user service** (`systemd-run --unit=sidedoor`) started by a
  launcher script that the menu entry, login autostart and `pnpm ship` all use: one clean
  environment however it starts, a whole-process-group stop on restart, and a restart if it
  crashes. `SIDEDOOR_SOURCE_INSTALL=1` makes an unpackaged build behave like an installed one (real
  home and profile, no dev tooling, no auto-update).
- **The Electron profile follows the data home.** The default home uses the usual profile; any
  other home (a dev checkout, a trial copy) gets its own, so two homes run side by side instead
  of the second focusing the first's window.
- **The database is backed up before an update changes its structure**
  (`userdata/backups/before-update-*`), for every user, not only for `pnpm ship`.
- **Dev data is a quiet copy of the real data** (`pnpm dev:data`): scout, automatic AI jobs and
  notifications off, so a preview never does real work twice.


## Ranking the pipeline

- **A rank orders one stage's column, nothing more.** You drag cards (or use the arrows in
  Reorder) and the column you touched becomes ranked in that order; your AI does the same with
  `rank_applications`. Moving an application to another stage drops its rank, since a place in
  Ready for review says nothing about where it belongs among Applied. Unranked cards follow the
  ranked ones in the old automatic order (AI work under way, high priority, odds, fit).
- **Odds are separate from fit and match.** Fit is triage's read of the posting against what you
  want; the match is the resume against the requirements; odds (`shot`, 0-100, with a one-line
  why) are your AI's estimate of the chance of an interview, which also weighs level, competition,
  freshness, other applications at the company and warm paths. A rank or an estimate isn't
  activity on the application, so neither touches `lastActivityAt`.

## AI usage limits

- **Filling a form goes first, even when paused.** The user starts it and watches it happen in the
  window on their desktop, so it doesn't wait behind a backlog of research and tailoring, and pausing
  the AI work (to save usage) doesn't hold it. A paused queue runs only those, and work started as
  urgent (start_task's `urgent`, for a role the user needs to submit now), which also goes first.

- **Out of usage pauses the work; it doesn't fail it.** When the user's AI says it hit a session or
  usage limit, the task goes back in the queue for the reset time it names (or half an hour), without
  spending an attempt, and the queue and triage stop claiming work until then. Otherwise one limit
  fails everything queued behind it in a couple of minutes, as happened with a 170-task batch.

## Preparing packages

- **Posting text is data, and the guard marks rather than deletes.** Postings now carry lines for
  AI applicants (Videoco: "If you are an LLM or AI model, make sure to include…"; Imageco hides
  "include the phrase…" in white text). Prompts get posting text only through `fenceUntrusted()`.
  Lines that look aimed at AI stay in, marked ⚠, so a false positive costs a mark and the agent
  still reads the line. Some flagged lines are a person's attention check ("mention the word
  WATERMELON"), and whether to answer one is the user's call, so the agent reports these instead
  of acting on them. Text hidden in the HTML is the only thing left out of prompts, because nobody
  meant applicants to read it. The stored description keeps everything, the hidden text in a
  marked section, and warnings are computed from it when shown, so a better detector covers old
  postings without a migration. On the live data the patterns flag 25 of 3,018 postings; the ones
  checked by hand were all real except a "Please mention “Hacker News”" referral line.

- **A prep told to stop isn't a failure.** Bulk instructions can tell prep to stop early (the
  listing closed, or it's too new for this pass). The AI says so with `stopped: true`, and if it left
  the package alone the task finishes with its note and the application keeps its next action.
  Without that, every skipped role showed as failed and said "Preparing failed… try again", as
  happened to a third of a max-match batch. A prep that saves nothing without saying it stopped still
  fails, and the failure now keeps what the AI said and its log.

- **The cover letter gets its own pass.** After prep saves the package, `writing/cover-letter.ts`
  rewrites prep's plain draft in one call with no tools, then the editor runs as usual. Tested blind
  on real postings: letter instructions given alongside the writing style document came out at a
  coin flip on sounding like the user, and without it they won every comparison. Prep has to read
  that document for the resume and the answers, so the letter moved out. (A real prep run was never
  compared: that its long resume work would hurt too is a guess.) The draft stays as the fallback
  and carries the company facts prep found on the web. A revision that leaves the letter alone keeps it, so the user's edits survive.
- **A cover letter is written to be spoken, and it doesn't recite the resume.** The reader has the
  resume, and LLMs made tailoring free, so tailoring stopped signalling anything (Galdin & Silbert,
  "Making Talk Cheap"). The prompt asks for what the person would say out loud to a friend who asked
  "so why this job?": one episode, one line of what they like, at most two figures. Judged on
  persuasion alone, the sharpest variant opened with a verdict on the company, and it lost every
  comparison on sounding like the person, so anything changing this prompt needs both scores. The
  writing style document isn't given to this pass: its rules (cut adverbs, every sentence carries a
  fact) measurably flattened the letters. The tells still apply through the editor.
- **A letter closes with thanks, and asks the reader nothing.** Ending on "what I wonder" or a
  question read as an AI being open-ended, by the user's own read. The plain close scored the same
  with judges, so it costs nothing.
- **Other voices are a flip on the letter, never the default.** Spunky and Milady rewrite the letter
  in the Review box, or through `restyle_cover_letter`, and save nothing. In testing, restraint
  decided it: a Milady letter with scene slang throughout read as a costume to crypto-native readers
  and cost screens, and at most two scene words with the style carried by lowercase and rhythm
  fixed that. Slang stays out of Spunky outside crypto for the same reason. Milady still hurts with
  a non-crypto reader, and a hardcore level hurt with both, so hardcore isn't offered.
- **Cover letter templates are filled slot by slot, and Sidedoor puts the user's text back.** The
  user kept rewriting letters, so they can write their own (Settings → Cover letters): plain text
  is theirs, `[instruction]` is a part the AI writes, `{their words}` is a part it may adapt a
  little (it can hold a `[hint]`), `\[` keeps a bracket. Square and curly brackets because they're
  easy to type and rarely appear in a letter; no existing template language had the "adapt"
  idea. The AI sees the template with numbered slots and returns only the slots
  (`prompts/cover-letter-template.md`); `fillTemplate` assembles the letter, so their own text is
  exact by construction rather than by asking. A missing adapt keeps their words, a missing write
  fails the pass. One template can be the default, and then prep's letter pass writes from it
  instead of writing freely; any template can be used on a letter in review, and like the voices
  that saves nothing. Templates live in settings (`coverLetters`), with MCP tools to list, save,
  delete and set the default.
- **Voice comes from the user's own lines.** "How I actually sound" in the writing style holds
  things they really said, and `voiceSamples` hands those to the letter. The letter with them beat
  the letter without them. The editor pass stays as it was: telling it to leave the letter alone
  was tried, and its few small edits scored better than none.

## Questions for you

- **One row per question and application** (`questions` table, `services/questions.ts`). Prep
  (`ask_questions`), a form fill's `needsYou`, and any agent ask through the same command, and
  `save_package` turns a package's "Questions for …" section into rows too. On first boot after the
  migration, the sections already in unsent packages are imported once (meta `questionsImported`);
  ones marked "**Answered …**" in the package come in answered, by `package`. Before this, answers
  lived only as text appended to each package, with no record of which question was answered, when,
  or by whom, and the same question was asked again elsewhere.
- **"For every application" is the user's call, suggested by the question.** Questions about the
  user (`about: 'you'`) default to it; ones about the job don't. An answer for every application
  answers the same question open in other applications, is reused for any application that asks
  it later (`askQuestions` returns it with `known: true` and records it answered there), and is
  kept as one line in its own section, `## Answers to questions`, of Standard answers (form answers)
  or Experience (facts about past work). It's upserted by question, so changing an answer changes
  the line, and reopening or dismissing takes it out: reviewable, not appended blind.
- **Dedupe is exact on the words, semantic in the prompt.** The key drops case, punctuation,
  markdown and parenthetical hints like "(yes/no)". Prep phrases the same doubt differently per
  package (145 distinct keys among 146 live questions), so prep is also given every answer already
  given (`KNOWN_ANSWERS`) and told not to ask those again. A fuzzy matcher was not worth the false
  merges.
- **Answers stay in the package whatever prep writes.** Each answer is a `### question` block under
  `## Your answers to questions` (the old `## Answers to the other form questions` heading is still
  recognized), and `savePackage` puts answered blocks back after the AI replaces the package.
- **Applying answers is targeted, and only on request.** "Update the package with N answers"
  (`reviseWithAnswers`, or `answer_user_questions` with `revise`) sends a prep revision whose notes
  are only the new answers and say to change only what they affect; the match check reruns after,
  as with any prep. It's not automatic because a revision spends the user's AI usage. The one
  automatic step: when Grok Bot's submit stopped for a form's questions and the user answers the
  last open one in the app, the fill is queued again, as `answer_questions` already did, and only
  while "Let it submit" is on.
- **`answer_questions` goes through the store.** Each answer is matched to the question the fill
  asked (or recorded as a new one), `reusable` means for every application in Standard answers,
  and the source is `grokbot`. The other tools record the caller as `relayedBy` (default `agent`);
  answers in the app are `you`.
## Resume match score

- **The score is stable by construction, not by sampling.** None of the four providers lets us set
  temperature (they're CLIs), and averaging N calls costs N times as much and still drifts. So the model
  judges only each requirement's kind, area and level, and a fixed rubric (v2, `MATCH_RUBRIC_VERSION`)
  turns those into points: must-have skills 40, seniority/scope 25, domain 15, logistics 10,
  nice-to-haves 10, with an absent criterion's budget shared out in proportion. A check fingerprints
  the rubric, posting and resume lines, and an identical re-check keeps the stored result without
  calling the AI. While the posting stays the same, the requirement list is frozen (no items added or
  dropped), and a requirement keeps its verdict unless a line it cited, or now cites, changed. Before
  this, the same resume and posting moved 1-3 points between runs and the list grew and shrank (15 vs
  16 items), so a "loop until the score stops rising" pass was chasing noise.
- **Prep stores the score its pass ended on.** The prep used to queue a separate match task that
  asked the model again, so the stored score (79) disagreed with the pass's own summary (82). Now prep
  checks the final resume itself: that's free when the pass's last check already covered it. It also
  rewrites the "match X -> Y" in the summary to the stored score (or adds it).
- **Noise margin.** `check_resume_match` reports `scoreChange` and `improvedBeyondNoise` (more than
  `MATCH_NOISE_MARGIN`, 3 points). Loops that raise the score stop when a round doesn't clear it.
- Checks from before v2 keep their stored score. They have no breakdown until they're re-checked,
  and the first v2 check re-judges everything.

## Getting applications out

- **Forms get attached PDFs, not files from anywhere.** Some forms require a portfolio or a cover
  letter file, and the fill could only upload the resume, so those stopped for a question nobody
  could answer in words. An application now keeps attachments (`attachFile`): PDFs only, checked by
  their first bytes, 15 MB at most, one per label, copied under `files/attachments/<id>`. The fill
  copies them into its upload folder beside the resume, and the browser can only upload from that
  folder. An agent attaches with `attach_file` from a path on this computer; because only a real PDF
  gets through, it can't hand a form a key or a dotfile.
- **Form windows have no File System Access picker.** Gem's upload box (react-dropzone) calls
  `window.showOpenFilePicker` when the browser has it, instead of clicking its `<input type=file>`.
  That picker isn't a file chooser Playwright can answer, so the fill's `browser_file_upload` always
  failed with "no related modal state" and Gem applications stopped without a resume. The submit
  guard, which runs before every form page's own scripts, removes `showOpenFilePicker`; drop zones
  then fall back to the input, as they do in Firefox and Safari. Uploading by hand in the window
  still works the same way. Setting files straight on a hidden input was the other option, but it
  would give the agent a second upload path to police, and the chooser path already checks the
  folder.
- **One page, in the order the work happens.** Reviewing meant opening each application and hunting
  through its tabs for what was left, with 58 of them waiting. `/review` shows one application at a
  time as four steps, with Next. It's a page rather than a list you expand, because the job is to
  finish one and move on. Today shows only the counts per step, and those applications no longer
  also appear in Up next.
- **Steps warn, they don't block.** An untuned resume or an open decision is the user's call, so
  Approve & submit stays available and names what's open first. What can't be overridden is the
  form check: nothing goes in on an answer they haven't confirmed.
- **Pressing Approve & submit submits.** This relaxes "nothing submits but Grok Bot". The press is
  a per-application decision by the user, in the app, so it needs no setting. Agents still can't do
  it: `by: 'you'` is set only by the `approveAndSubmit` RPC, and no MCP tool reaches it. An agent can
  relay an answer that lets a submit the user started carry on, but can't start one.
- **The AI the user talks to may submit, when they turn it on and ask.** Pressing the button on 47
  applications was the slow part they wanted gone, so "Let your AI submit" (off by default) gives
  connected apps and the chat the same tools Grok Bot has. This supersedes "agents can't start one"
  above for those two only.
- **Background jobs can't submit, and the token enforces it.** Prep, tune and research read postings
  and web pages unattended, so a line in a posting mustn't be able to reach a form. They shared a
  token and endpoint with connected apps, so a tool-list check couldn't tell them apart: connected
  apps and the chat now have their own token, and the tools hang off that. An HTTP client set up with
  the old token keeps working without the submit tools until it's given the new one. The tool
  descriptions also say a request must come from the user, but that's a request to the model, and
  a connected agent that reads an injected posting while the switch is on is the remaining risk.
  What bounds it: only finished packages can go, and every check below still runs.
- **An AI can't stand in for the review.** Steps warn the user but block their AI: an unchecked
  written answer, an open question or decision, or a package or resume still being worked on keeps
  an application out of its submit (`reviewHold`), reported as `blockedBy: 'review'`. The user clears
  these, or tells the AI to. An untuned resume with no tuning queued doesn't hold it back, since
  that costs fit, not accuracy. Grok Bot's path is unchanged. No agent can change the switch itself.
- **Only what something waits on holds an application.** An audit on 2026-11-05 found 39 of 40
  applications parked on "Questions": 161 open questions and 174 open decisions. 130 of the
  questions were the AI asking whether the user had done something a posting named. Of the 36 such
  questions the user had dealt with, half were dismissed, and only 6 answers ever reached a
  revision. Those questions can't make an application wrong, because nothing unconfirmed is claimed,
  so a fact about past work that no form asked for is optional (`holdsApplication`). This is worked
  out from the question, not stored, so it applied to the backlog with no migration. It's the one
  exception to the rule above: an open optional question doesn't stop their AI either. A form's own
  question always holds, even when it reads like a fact about the past.
- **Tuning's limit is in code.** The prompt said "at most 5" and got exactly 5 on about half the
  applications, including ones already at 93. The AI now proposes questions in its output and
  `worthAsking` keeps four at most, each tied to a requirement still short, the most points first.
  They were two, must-haves only and none at 90 or above, while they sat with the questions that
  hold an application. Now they're folded under the resume on the Review page ("N questions that
  could raise the match"), so they interrupt nothing, and the user asked for more of them: questions
  an interviewer would ask to draw out a true line, not a list of the posting's tools. An answer is
  kept in Experience, so it feeds every later pass, and answers given since the last pass let a
  re-tune ("Tune again with N answers") run past the 95 target instead of stopping at once.
- **Passing on a question is remembered.** Keys match wording only, and the wording changes with
  each posting, so the same few topics came back (meetup talks four times, GCP and BigQuery four
  times, and topics already dismissed). Prep and tuning now see what's been asked and not answered,
  and a fact dismissed on one application isn't asked of another in the same words. A form still
  can, since it has a field to fill.
- **A decision is a required answer or a real call, nothing else.** Most of the 174 were notes, or
  sign-offs on wording built from confirmed facts, or restated Standard answers. Those now go under
  "Changes vs. main resume" or "Submission notes", which hold nothing up.
- **Self-identification answers are about the user.** They were kept per application, so each form
  asked again. "Man" on a form also now matches "Male" in Standard answers, as a whole answer only.
- **Tuning is measured by Sidedoor, not reported by the AI.** The start and finish scores come from
  the match check itself, and a pass that ends lower is undone, so "raised from 80 to 91" can be
  trusted. The AI stops at 95, or when two rounds don't beat the noise margin, and after 4 rounds at
  most. It stops short of inventing anything: what's left becomes questions.
- **A check-off belongs to the text.** If the AI revises an essay after the user checked it, the
  check would otherwise vouch for words they never read, so it's stored as a mark of the text.
- **An application's chat costs nothing to open.** Its first message is built from stored data, not
  an AI turn, so the 58 chats that could exist don't cost usage and don't fill the chat list until
  opened. A newer tuning pass adds its findings to the same chat.
## Profile documents

- **Correct in place; every change keeps a revision.** Agents could only append to a profile
  document, so a fact the user corrected stayed in Experience next to the correction ("has used
  OpenTelemetry" on Oct 23, "only familiar with it" on Oct 30), and prep could read either. Now
  `edit_profile_doc` replaces exact text (which must match once, so an edit never lands in the
  wrong place), a section by heading, or inserts under a heading, and the prompts say to fix the
  stale line instead of appending. Every write to a document, from the editor, an agent or
  Sidedoor itself, records the text before and after, who and why (`document_revisions`), so any
  change can be reviewed on the document's page or with `list_profile_doc_revisions` and undone.
  Reverting puts back the exact earlier text, and asks first when later changes would be undone too.
- **Large deletions need confirming.** An agent's edit that would remove more than a quarter of a
  document (and more than 200 characters) is refused unless it passes `confirmLargeDeletion`, so a
  truncated rewrite or a wrong section can't silently wipe Experience. The revision would let it
  be undone, but nobody may notice in time. The user's own saves in the editor aren't held to it.
## Stale drafts

- **A profile change checks what hasn't gone out yet.** Saving Experience, Standard answers or the
  Story bank (from the page, an agent's `update_profile_doc`, anything through `setDoc`) queues a
  `stale-check` task. It reads unsent outreach drafts and the cover letters, answers and rest of the
  package of applications still in Interested, Ready for review or Approved, and flags sentences the
  change contradicts or leaves unsupported, with what the document says now and a corrected sentence
  when the fix is clear. Sent drafts and submitted applications are history and aren't checked.
  Prompted by outreach that still said "haven't built on Yjs" after Experience said otherwise.
- **Cheap by design.** The check diffs the document against the version the last check saw (kept
  in meta `staleChecked:<doc>`), sentence by sentence, and only sends the changed sentences plus the
  pieces that share a distinctive word with them (tool names, companies, numbers; common job-search
  words don't count). An edit nothing unsent mentions never calls the AI. The trade-off: a
  contradiction that shares no word with the change ("never done real-time work" vs. "built CRDT
  editing") is missed; `check_stale_drafts` with `full: true` compares against the whole document.
  Saves within two minutes share one check.
- **Flags never change the text.** The AI's sentence must be found in the piece or it's dropped.
  The user (Use suggestion opens the editor with it; Dismiss) or an agent (`list_stale_drafts`, then
  `update_draft` / `save_package`, or `clear_stale_flag`) deals with it. A flag resolves by itself
  once its sentence is gone, or its draft is sent or discarded, or its application is submitted.
  One line is one flag: two checks quoted the same checklist line with and without its `- [x]` and
  its last sentence, and both showed. Quotes match without list markers, and one containing the
  other (30+ characters) counts as the same; a later repeat already open resolves itself.
## Posted dates and whether a listing is up

- **Ask the ATS about the one job, not the page.** `jobs/listing-check.ts` asks each ATS's public
  API about the job itself: Greenhouse and Lever per-job endpoints, Workable `api/v2/.../jobs/<code>`,
  SmartRecruiters `postings/<id>`, Workday `wday/cxs/.../job/...` (`canApply`), and the Ashby board
  list (Ashby has no per-job API). A page's text misreads both ways: a closed Ashby job still serves
  a 200 with JSON-LD, and a live description can say "no longer needs to ask". Pages are read only
  for hosts with no API here, for their JSON-LD `datePosted` and a closed notice in whole sentences.
- **Closing needs a clear signal or two misses.** A 404 from the ATS's API, Workable `state` other
  than published, SmartRecruiters `active: false` or Workday `canApply: false` closes the listing at
  once. A miss that could be a misread (gone from the Ashby board, a page 404 or closed notice)
  makes it "suspect", rechecked within 4 hours; two in a row close it. A rate limit, an outage or a
  network error counts for nothing and doesn't reset the count. An open check clears it all.
- **The result lives on the application.** Many applications have no posting (created from a link
  by an agent), so `posted_at` (with `posted_at_source` and `posted_at_exact`) and the `listing_*`
  fields are on `applications`. The check also keeps the linked posting in step: it fills a missing
  `posted_at` and sets or clears `closed_at`. The application's check decides whether its listing is
  closed, unless the scout saw the posting go after that check (`listingClosedAt`).
- **Dates rank by how much they say.** The ATS's own exact date beats JSON-LD or the scout's list
  date, which beat an estimate (Workday's "Posted 30+ Days Ago", Greenhouse `updated_at`). A check
  never replaces a better date with a worse one.
- **A check writes only those fields.** Not the stage, notes, `updatedAt` or `lastActivityAt`, so the
  backfill (`check_listing` with `all`) can run over every open application. Acting on a closed
  listing is still `reconcile`'s job: it closes applications you'd only marked interested and flags
  prepared ones, as it did for postings the scout saw close.
- **Paced, a few at a time.** The scheduler checks up to 20 watched applications (interested,
  review, approved) every half hour, each at most daily. Calls to one host are at least 1.5 s apart,
  and one Ashby board read answers for all its jobs in a run.
- **Why Taskly's Engineering Manager (Frontend) showed closed.** Its application was linked to the
  Jobicy copy of the posting, not the Ashby one. The scout built before 2026-10-28 closed any
  posting missing from its source's latest read, feeds included, and Jobicy's feed had rolled it
  off. The current scout never closes feed postings, but nothing reopened that one until it
  reappeared in the feed. Now the application's own Ashby check decides.
- **A capped board list closes nothing.** Workday is read up to 200 jobs and SmartRecruiters up to
  300, newest first (`LIST_CAP`). On a bigger board an older posting just falls off the pages read,
  so a read that reached its cap doesn't close anything; the listing check covers those.
## Your rules

- **Hard rules are checked in code, not by the AI.** Remote-only, a total comp floor and target
  band, and citizenship / export-control / clearance asks are settings (Settings → Search → Your
  rules, or `update_rules`), checked by `packages/shared/src/rules.ts` against the posting's
  location, pay fields and description. Triage and prep had the same information and still
  prepared 13 of 49 roles that broke these rules, so a prompt isn't enough. The result is stored
  on the application (`rules_json`) with the posting's own words for every finding.
- **Fail, flag, pass; unknown never fails.** Only clear evidence fails: a hybrid or office
  schedule this role requires, "within N miles of", relocation, "not remote", or a listing marked
  only Hybrid / On-site; pay whose top is under the floor. Ambiguity flags: a listing that offers
  both remote and hybrid, hybrid talk in a listing that says remote, a city with no word on remote,
  "starting at" pay, pay at exactly the floor, or a base just under it (within
  `equityAllowancePct`, 15% by default) when the posting offers equity or a bonus. Pay in
  another currency, or none, is unknown. Several ranges (by location or level) count by the most
  generous, so only roles clearly under the floor fail. Citizenship and clearance asks flag by
  default; the user can make them block. Equal-opportunity lines and visa sponsorship don't count.
- **Checked when tracked, before prep and twice before submit.** A fail nobody overrode isn't
  prepared (the task finishes with the reasons, not as a failure) and `requestSubmit` refuses it.
  The fill that submits checks once more with the form's own questions, since citizenship and
  clearance asks often appear only on the form, and holds back the submit click. A dry run may
  still fill. Flags go to the prep AI and show on the application.
- **An override covers the rules that failed when it was given.** "Go ahead anyway" (the
  application page or `override_rules`) records who and why; if a different rule fails later (the
  form asks for a clearance the user blocks), it's stopped again.
- **The company limit applies to your own press too.** Batches already stop at a company's limit
  (Settings → AI → Grok Bot). A limit is usually the company's rule, so it matters however the
  application goes in, and Approve & submit refuses with the count rather than spend a slot.
- **Help with an answer fills the box and saves nothing.** Draft and Clean up return text to the
  Review page, and what was there is one Undo away, because these are the words the user chose to
  own. A check-off still takes their press. Cleanup's promise is that it adds nothing, so a number
  they didn't say makes it fail and leaves their text alone. A draft works from Experience and
  stories, so a number not found there is flagged rather than refused, along with what the facts
  didn't cover. Both are one text call with no tools: they can't touch anything.
- **The review card has its own job summary, not triage's.** Triage's line is about fit, and more
  than half of what's waiting has no linked posting, so it can't answer "what is this job?". A
  small `brief` task reads the listing (the lookup tools, so it can't change anything) and writes a
  sentence and a few highlights. The scheduler queues one for anything waiting without one, so
  there's no separate path for new and existing applications. It gets one try each: a listing it
  can't read shouldn't cost a call every minute, and Summarize on the card asks again.
- **Stats counts what happened, not what the columns say.** Stage history lives in `stage_changes`,
  written by `updateApplication` (so every path records it) and backfilled from the activity log.
  A move put right within the hour doesn't count, because clicking through the stages left false
  Offers and a false `appliedAt` behind. A rejection is read from `closedReason`, falling back to the
  latest note when it's blank, since agents often closed one with no reason and noted the email
  instead; `update_application` now asks for the reason. A submission is anything in Applied or
  later, or closed after going in, so moved-back cards drop out and a recruiter's role counts.
  The funnel and Heard back follow the applications sent in the period; Rejected counts rejections
  that arrived in it, so a recent period can show rejections and 0% heard back at once.
  A call or meeting logged on an application (not one only booked or scheduled) counts as an
  interview, and so as talking to someone, whatever stage it was left in: agents logged recruiter
  screens and then closed the application without ever moving it to Screening, so the stages alone
  missed real interviews.
- **VC portfolio boards are aggregators that list in full.** A fund's job board (Getro or Consider,
  on its own host like jobs.somefund.com) lists every open job at its portfolio companies, each
  linking to the company's ATS. So they take the aggregator path: the company comes from the
  listing, and a listing that passes the filters is resolved to the company's own posting and
  board, which gets the full description and becomes a watched source. Unlike feeds, a board read
  is complete and its listings stay up while open, so they get the board age limit and a job gone
  from a full read is closed. The board page is read for a description only when the apply link
  isn't an ATS Sidedoor reads, since resolving fills the rest. Both APIs return a whole board in a
  few requests, but boards run to thousands of jobs that change over days, so they're polled at
  most every four hours. Add one by its URL: the host gives nothing away, so the page is fetched
  and recognized before following its links, which point at portfolio companies' boards.
- **Only originals are scored.** An aggregator listing (a feed, a VC board) waits until resolving
  matches it to the company's own posting, and is scored as that. A listing whose apply link is the
  company's own careers page counts as the original. One found only as a repost (LinkedIn, another
  job site) is set aside as "no original" rather than scored on a teaser. HN posts are the
  employer's own words, so they count. This also stops the same job, listed on a company board and
  three VC boards, from being scored four times.
- **Remote is checked before scoring, in plain code.** A third of scoring calls went to postings the
  AI then marked as somewhere the user can't work: "Remote, Latin America", or a US office with
  "hybrid, 3 days in SF" in the description. When remote is the only work mode, a posting must
  show it's remote (`scout/workplace.ts`): hybrid, on-site or office days in the listing or
  description, or no mention of remote anywhere, set it aside as "not remote". Listed remote but
  asking for office days goes to scoring to judge. Places are read one by one against every country
  and region, and the ones the user's place pattern doesn't cover count as foreign. The check runs
  again on waiting postings just before scoring, so the backlog and changed filters are covered.
  Checked against 2,444 scored postings: it catches about two thirds of the AI's "no"s and drops
  about 1% of its "ok"s, all low-fit ones whose descriptions never say remote.
- **A lead at a company sweeps its board.** When a posting is queued or tracked, the company's own
  board is watched and read straight away, and the sweep lets through engineering titles the title
  filters drop: the company is already known to be worth a look, and the best role there may be
  titled oddly ("AI Lead - Product Engineering"). Place and remote still apply. Once a week per
  company. A role that scores above the application already open there is flagged as a better fit.
  Scoring is told that a different role at the same company isn't a duplicate, and that missing pay
  or an old posting date isn't a fit gap.
- **Agency reposts are skipped.** A recruiting firm posting for an unnamed client (Jobgether lists thousands on its own board, and it sits on VC boards as a portfolio company) passes every "original" check, since the board is the agency's own. Scoring is told to skip those and say so; the role, if it's real, turns up on the employer's board.
- **Outreach drafts come when asked.** Drafting is a long AI run per application and most drafts
  went unused, so research no longer queues it. Settings → AI has a switch to turn it back on.
- **Work on the newest first.** Applying in a listing's first days gets you ahead of the pile, so the
  order you work in weighs newness most: half the work-on-first score is how new the listing is
  (halving every four days), a quarter fit, a quarter pay against the user's minimum salary. A
  missing date, fit or salary gets a middling-low value, so an unpublished salary doesn't bury a job
  but doesn't beat one that shows a good one (`shared/queue-score.ts`). The pipeline, the review
  list and background prep all go by it, after any order the user set by hand. Newness changes by
  the hour, so waiting prep is re-scored every minute. Its priority stays 0-9, under the 10 that
  user-requested work gets, so the cap on packages awaiting review still holds.
