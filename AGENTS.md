# Sidedoor

A local-first job-search app that your own AI runs. Read README.md for what it does,
docs/ARCHITECTURE.md for how it fits together, docs/DECISIONS.md for why. Keep DECISIONS.md
current when making a non-obvious call.

- `pnpm typecheck` and `pnpm test` must pass. Strict TS with noUncheckedIndexedAccess.
- `apps/server`: one Node process. People / applications / drafts / touchpoints / questions change only through
  the commands in `src/services/` (wrapped in `atomic()`); `tests/architecture.test.ts` enforces it.
  Add a command there and a test for the bookkeeping it implies.
- New web calls go in `apps/server/src/http/router.ts`; the web app calls them as `rpc.<name>()`.
- Agents change data only through MCP tools (`src/mcp/tools.ts`, `profile-tools.ts`), which call the
  same services. Anything the user can do, an agent should be able to do the same way.
- Schema changes: edit `src/db/schema.ts`, then `pnpm --filter @sidedoor/server db:generate`;
  migrations run on boot. Live updates need the table in the triggers migration (see 0001).
- Prompts live in `apps/server/prompts/`; never put a person's name, location or field in them.
- Never let an agent send email. Never let a background job submit an application. Sidedoor itself
  fills and submits a form (`jobs/fill-form.ts`) in three cases only: the user presses Approve &
  submit in the app (the `approveAndSubmit` RPC, never an MCP tool); or, off by default, the user
  turns on "Let your AI submit" and the AI they talk to (a connected app or the chat, on the
  `connected` token) calls the submit tools; or they turn on "Grok Bot can submit" and Grok Bot does.
  Background jobs use the agent token, which never reaches those tools. Nothing else submits.
- Don't run Electron on the user's display while testing: `env -u WAYLAND_DISPLAY -u DISPLAY xvfb-run -a …`.
