# Sidedoor

**Your job search, run by your AI.**

Sidedoor watches the job boards you care about and catches new roles minutes after they're posted.
It scores each one against what you want, prepares a tailored application for you to review, and
fills in the form. Then it finds the person doing the hiring so you can reach them directly. That's
the side door.

It runs on your computer. It doesn't have an AI of its own: it works through the one you already
use (Claude, Codex, Grok Build or OpenCode, through its command-line tool) and the subscription
you already pay for. And your AI can reach Sidedoor too, so you can ask Claude "what follow-ups
are due?" from your terminal.

## What it does

| | |
|---|---|
| **Scout** | Polls company job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters) and job feeds every few minutes. Dream companies are polled more often. |
| **Triage** | Your AI scores every new posting 0-100 against what you want, with reasons, gaps, and whether you can work from where you live. Strong fits notify you right away. |
| **Prepare** | For a role you want: a tailored copy of your resume, every form answer, and a cover letter when the form asks for one. Facts come only from your own Experience document. You approve or request changes. |
| **Fill it for me** | Opens the application form in its own window and fills every field from the approved package, uploading your resume. It stops before submit; you review and click it. |
| **People** | Finds the hiring manager, recruiters and team, their email addresses (with honest confidence labels), LinkedIn and X. Drafts outreach in your voice. You send it. |
| **Follow-ups** | Every touchpoint schedules the next one. A morning digest says what's due. |
| **Resume designer** | Templates (Modern, Classic, Compact, Deco), live editing on the page, fit-to-pages, PDF export, and a review of every line your AI changed, to keep or undo. |
| **Resume match** | Each application lists what the posting asks for and the resume line that answers it. In the resume editor, the score, must-haves and gaps float over the page. |
| **Story bank** | Your AI interviews you, one question at a time, to capture career stories it can use later. |
| **Writing check** | Flags phrases that make writing read as AI-generated, before anything goes out. |
| **Chat** | Ask about anything ("Sarah from Ramp replied, call Thursday") and it updates the right records. |

Nothing is ever sent or submitted without you.

## Install

Download the latest release for your system from [Releases](../../releases):

- **macOS**: `Sidedoor-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel)
- **Windows**: `Sidedoor-Setup-<version>-x64.exe`
- **Linux**: `Sidedoor-<version>-linux-x86_64.AppImage`, or the `.deb`

Then install at least one AI command-line tool and sign in. Sidedoor's setup checks for each one
and shows you the commands:

| AI | Install | Sign in |
|---|---|---|
| Claude (`claude`) | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Grok Build | `npm install -g @xai-official/grok` | `grok login` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` |

Sidedoor keeps running in the tray when you close its window, so the scout keeps watching.

### Without the desktop app

The same server runs anywhere Node 24 does, for example on a home server, and you use it from a
browser:

```bash
pnpm install && pnpm build
node apps/server/dist/bin.mjs serve          # prints a sign-in link
```

PDFs and form filling then use a Chrome, Edge or Chromium installed on that machine.

## Your AI, inside Sidedoor, and Sidedoor, inside your AI

Sidedoor exposes its tools over [MCP](https://modelcontextprotocol.io). In **Settings → AI**, turn on
"Add Sidedoor to Claude" (or Codex, Grok, OpenCode; each shows once it's installed and signed
in) and it registers itself in that tool's config. Any other MCP client can connect too; the same page shows the config to paste.

**Grok Bot** (xAI's agent) is in the same list. A Bot that runs on your computer connects with a
local command, as Claude does; one on Grok Bot's own computer needs a public address (Tailscale
Funnel works). Either way it gets its own token. You can send it company research and research on
X, and a Grok Bot routine picks those up.

Agents can read your pipeline, edit your resume line by line (you review each change), draft
messages, log touchpoints, look up job boards and read JavaScript-heavy job pages. They can't send
email or submit applications.

## Your data

Everything lives in `~/.sidedoor` (`%USERPROFILE%\.sidedoor` on Windows): one SQLite database,
generated PDFs, and API keys stored as private files. Nothing goes anywhere except to the AI you
chose, the job boards it reads, and (if you turn it on) the push service for phone notifications.

## Develop

```bash
pnpm install
pnpm dev            # server + web app with live reload; prints a sign-in link
pnpm dev:data       # replace the dev data with a quiet copy of your real data (~/.sidedoor)
pnpm dev:desktop    # the Electron app against a built server
pnpm test           # server tests
pnpm typecheck
pnpm dist:desktop   # build an installer for this OS into release/dist
```

In dev, data lives in `.sidedoor-dev/` in the checkout. Each checkout picks its own free ports, so
several can run at once next to the desktop app.

### Using it while you develop it (Linux)

`pnpm ship` builds the current commit into your everyday Sidedoor and restarts it on it, in about
ten seconds. Your data stays in `~/.sidedoor`; only the code changes.

```bash
pnpm ship                         # ship HEAD (typecheck and tests first)
pnpm ship <ref>                   # ship another commit or branch
pnpm ship --rollback              # back to the previous build, instantly
pnpm ship --rollback --restore-data   # ...and the data as it was before the bad build
pnpm ship --status
```

The everyday app runs from `~/Code/sidedoor-daily` (two build slots, `a` and `b`, and `current`),
so editing a checkout never touches it. Every ship backs up the database first
(`~/.sidedoor/userdata/backups`, last 20 kept), and if the new build doesn't come up, the ship
switches back by itself. Open it from the app menu ("Sidedoor") or `~/Code/sidedoor-daily/sidedoor`.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Why things are the way they
are: [docs/DECISIONS.md](docs/DECISIONS.md).

## Credits

The process model, the desktop browser bridge and the MCP design follow
[T3 Code](https://github.com/pingdotgg/t3code); `apps/desktop/src/cdp-relay.ts` is adapted from it
(MIT, notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## License

[MIT](LICENSE). Installers also carry `THIRD_PARTY_LICENSES.txt`, the licenses of every library
Sidedoor ships (`pnpm licenses` writes it locally).
