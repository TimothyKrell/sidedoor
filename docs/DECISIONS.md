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
- **Long documents are read in pages, not cut.** AI clients cap tool results, so a 51K-character
  Experience document returned whole lost its newest sections (the end, where confirmed facts are
  appended). `get_profile_doc` returns 20,000-character pages ending at line breaks, with
  `nextOffset` and a heading outline to jump by; `get_application` pages the package the same way.
  Prompts that need Experience say to read every page. Inlining the document into prep's prompt
  would have worked for prep only, and cost every prep the whole document.
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

- **A prep told to stop isn't a failure.** Bulk instructions can tell prep to stop early (the
  listing closed, or it's too new for this pass). The AI says so with `stopped: true`, and if it left
  the package alone the task finishes with its note and the application keeps its next action.
  Without that, every skipped role showed as failed and said "Preparing failed… try again", as
  happened to a third of a max-match batch. A prep that saves nothing without saying it stopped still
  fails, and the failure now keeps what the AI said and its log.
