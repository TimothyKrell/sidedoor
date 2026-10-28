# Sidedoor architecture

Sidedoor is a local-first job-search app. It finds roles, tracks applications and people, and
gives *your* AI (Claude, Codex, OpenCode, Grok) a place to run your job search. Sidedoor is
not the AI: it owns the data and the workflow, and agents plug in through MCP.

T3 Code (`github.com/pingdotgg/t3code`) is the reference for how the pieces fit. We copy its
shape at the smallest size that does the job, and skip what a single-user app doesn't need.

## Processes

```
┌──────────────────────── Electron (apps/desktop) ────────────────────────┐
│ main: window, tray, single-instance lock, updater, native notifications │
│       desktop bridge (loopback HTTP, secret token):                     │
│         POST /pdf      render HTML → PDF (offscreen webContents)        │
│         POST /read     read a web page (hidden window)                  │
│         POST /tabs     open a browser window for form filling           │
│         WS   /cdp/:id  CDP relay to that window (webContents.debugger)  │
│         POST /notify   native notification                              │
│       public-only proxy (loopback) for page reads and form windows      │
│                                                                         │
│   spawns ─► server child  (process.execPath + ELECTRON_RUN_AS_NODE=1)   │
└─────────────────────────────────────────────────────────────────────────┘
                 │ bootstrap JSON on fd3: { port, token, home, bridge }
                 ▼
┌──────────────────────── Server (apps/server) ───────────────────────────┐
│ one Node process, one port, 127.0.0.1 by default                        │
│   /            built web app (SPA, index.html fallback)                 │
│   /api/rpc/*   typed RPC (zod input, inferred output) – web client      │
│   /api/events  SSE: table-change invalidations, chat streams, notices   │
│   /mcp         MCP (streamable HTTP, bearer token) – agents             │
│   /files/*     generated PDFs                                           │
│ in-process jobs: scout, triage, task queue, scheduler, digest           │
│ SQLite (node:sqlite, WAL) in ~/.sidedoor/userdata/sidedoor.sqlite       │
└─────────────────────────────────────────────────────────────────────────┘
```

The same server runs without Electron (`sidedoor serve`), for people who'd rather open it in a
browser or run it on a home server. Without the desktop bridge it falls back to a system
Chrome/Chromium/Edge (playwright-core) for PDFs and form filling.

## Why these choices

| Decision | T3 does | We do | Why |
|---|---|---|---|
| Server launch | Electron child with `ELECTRON_RUN_AS_NODE`, bootstrap on fd3 | same | no separate Node install; token never in argv/env of other processes |
| SQLite | `node:sqlite` + custom Effect SqlClient | `node:sqlite` behind a small better-sqlite3-compatible shim, Drizzle on top | no native module to rebuild per Electron ABI; keeps the existing Drizzle domain code |
| Client transport | Effect RPC over WebSocket, atoms | typed HTTP RPC + SSE invalidation, TanStack Query | the app is CRUD + live refresh; T3's own notes call Query + an invalidation stream "lighter" for this shape |
| Event sourcing | only for orchestration | none, plain tables | no replay/idempotency needs beyond the task queue |
| Settings | `settings.json` | `settings` table | one store, and settings changes flow through the same live-invalidation path |
| Secrets | `secrets/*.bin` 0600 | same | API keys (Hunter, ntfy) never go to clients |
| MCP | `/mcp` streamable HTTP, per-session bearer tokens, OAuth for outside agents | `/mcp` streamable HTTP with one long-lived agent token (rotatable in Settings), passed to agents we launch through the environment or a 0600 config, never argv; `sidedoor mcp` stdio bridge | OAuth is only needed for hosted agents; a copy-paste token is the simplest story for local CLIs |
| Providers | driver + session adapter per provider | one `Provider` interface: `probe`, `runJson`, `runAgent`, `chat` | jobs, not coding threads; each CLI already has a headless JSON mode |
| Browser | renderer `<webview>`, CDP via `webContents.debugger` relayed to server Playwright | a `BrowserWindow` per form, same debugger relay | forms must outlive whatever page the user is on; each form is its own window to review and submit |
| Background | quits when windows close (except macOS) | tray; closing the window keeps jobs running; optional launch at login | the scout is the product |
| Web UI | TanStack Router, base-ui shadcn, Tailwind v4 tokens | TanStack Router, radix shadcn, Tailwind v4 tokens | existing components are radix; same look and conventions |
| Packaging | staged dir + electron-builder, GitHub releases, electron-updater | same, one arch per OS to start | |

## Pages we don't control

Job postings and application forms are untrusted, and during a fill an agent is driving the page.

- **Network.** Page reads and form windows reach the network only through a loopback proxy
  (`packages/shared/src/public-proxy.ts`). It resolves each host itself, refuses private and local
  addresses, and connects to the address it checked. That covers every redirect hop and DNS
  rebinding. Electron sessions use it via `setProxy`, and Chrome via `--proxy-server`, with
  `<-loopback>` so localhost isn't exempt. Each request also gets a first check in the browser.
- **Browser tools.** Fill agents get an allowlist of Playwright MCP tools (`mcp/server.ts`):
  - no scripts, no file writes and no new tabs;
  - uploads only by absolute path from the fill's own folder, which is Playwright's only MCP root;
  - navigation only to public http(s) pages.
- **Submitting.** An in-page guard blocks the final submit while the agent works. A second check
  refuses clicks the agent itself labels as submitting. The user submits.
- **Windows.** No permissions; no navigation outside the web; popups stay in the same window.

## Data ownership

Everything the user creates lives in the app home (`~/.sidedoor`, override `SIDEDOOR_HOME`):

- `userdata/sidedoor.sqlite`: jobs, applications, people, drafts, tasks, chat, settings, and the
  user's **profile documents** (experience, stories, writing style, search criteria, standard
  answers) and **resumes** (structured content + theme).
- `userdata/files/`: generated PDFs and uploads.
- `userdata/secrets/`: API keys, MCP token.
- `userdata/logs/`.

Agents never touch the filesystem to change user data. They call MCP tools (`get_resume`,
`update_resume`, `save_package`, `update_profile_doc`, ...) that write through the same service
commands as the UI. That keeps every provider, and agents the user runs outside the app, on one
contract.

## Providers ("Connect your AI")

| Provider | Probe | JSON jobs | Agent jobs (tools via MCP) | Chat |
|---|---|---|---|---|
| Claude Code | `claude --version`, SDK `initializationResult()` | Agent SDK `outputFormat: json_schema` | Agent SDK, `mcpServers: {sidedoor: {type: http}}` | Agent SDK, partial messages, resume |
| Codex | `codex --version`, `codex login status` | `codex exec --output-schema` | `codex exec --json -c mcp_servers.sidedoor...` | `codex exec --json`, `exec resume` |
| Grok Build | `grok --version`, `grok models` | `grok -p --output-format json --json-schema` | `grok -p` with project `.grok/config.toml` MCP entry in the job dir | streaming-json, `-r` |
| OpenCode | `opencode --version` | `opencode run --format json` + schema in prompt | `opencode.json` MCP entry in the job dir | `--format json`, `-s` |

Each background job kind (triage, prep, research, ...) picks a provider + model in Settings, with
one default. Jobs run in an empty scratch directory per task, never in a user folder.

## Repository layout

```
apps/server     Node server, CLI (`sidedoor serve|mcp|token|import-legacy`)
apps/web        React SPA
apps/desktop    Electron shell
packages/shared code used by both server and web (resume model + themes, tells, match, formats)
docs/           this file, decisions, questions for review
```
