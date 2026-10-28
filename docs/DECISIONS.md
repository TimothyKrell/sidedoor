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

