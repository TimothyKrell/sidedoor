# Questions to review together

Things I decided provisionally or couldn't decide alone, roughly by how soon they matter.

## Before publishing

1. **Where it lives: decided** (Oct 28). `TimothyKrell/sidedoor`, public, with `main` starting
   from a fresh commit (the branch's early commits held personal prompts). The personal app's
   history and the full development history of this branch live in the private
   `TimothyKrell/sidedoor-personal`.
2. **License: decided, MIT** (Oct 28). `LICENSE` names you as the copyright holder.
   `THIRD_PARTY_NOTICES.md` carries T3 Code's license for the adapted `cdp-relay.ts`. Every
   installer ships `THIRD_PARTY_LICENSES.txt`, generated at build time from the 288 libraries it
   includes (all permissive; the Claude Agent SDK is under Anthropic's own terms). Future versions
   can still move to another license; released versions stay MIT.
2a. **Claude subscriptions.** Anthropic's Agent SDK docs say third-party products may not offer
   claude.ai login or rate limits without approval, and should use API keys. Sidedoor works like
   T3 Code: it drives the user's own `claude` CLI and sign-in and never handles a login itself.
   That's defensible for a free release, but a paid version should ask Anthropic first. Also worth
   adding an "Anthropic API key" option in Settings. Codex, Grok and OpenCode sign-in policies are
   not checked yet.
2b. **Branding: decided** (Oct 28). The app says "Claude", not "Claude Code" (see DECISIONS.md).
3. **Name, app id, contact.** "Sidedoor", app id `app.sidedoor.desktop`, maintainer email
   `hello@sidedoor.app` are placeholders. Is there a domain?
4. **Code signing.** Unsigned builds work but warn: on macOS, Apple Silicon users may see "damaged"
   until they right-click → Open or run `xattr -cr`; Windows shows SmartScreen. Signing needs an
   Apple Developer account ($99/yr; secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_*`) and
   a Windows certificate or Azure Trusted Signing. The release workflow already reads them. Note:
   on macOS, automatic updates only work for signed builds (Squirrel.Mac refuses unsigned ones).
5. **macOS and Windows builds are untested here** (this machine is Linux). CI builds and
   smoke-tests all three on every PR. Running it on your private repo uses Actions minutes (macOS
   minutes count 10x). OK to push the branch and let it run once?
6. **The starter source catalog** (`apps/server/defaults/sources.json`) is built from your
   working company boards (139, tagged AI / crypto / devtools / fintech) plus general feeds. It's
   public information, but it does hint at what you were targeting. Keep, trim, or broaden it?
7. **Your writing rules** are distilled from a paid course, so the app ships an original default
   guide instead, and the importer brings yours over. Agree?

## Product

8. **Grok Bot: decided** (Oct 28). It means xAI's Grok Bot desktop agent, not only the Grok Build
   CLI. Its Bots run on a cloud computer, so it reaches Sidedoor's MCP endpoint at a public address
   (Tailscale Funnel on `/mcp` only, with its own revocable token), and it takes research work
   from a queue in Sidedoor that a Grok Bot routine checks. Grok Bot has no API for starting a
   task from another app.
9. **New-user defaults.** Auto-prep, auto-research and the funding radar start off (they spend the
   user's subscription); triage and daily discovery start on. Your migrated settings keep yours
   (auto-prep on). Right defaults?
10. **Phone access** is now "allow devices on my network" + an optional public address (your
    Tailscale name) + a pairing QR code. Tailscale itself isn't configured by the app any more. Is
    that enough, or do you want the old `--tailscale` serve setup back as an option?
11. **Gmail.** Still open from before: sending through the Gmail API and detecting replies would
    make follow-ups update themselves. Worth building now that others will use it (OAuth app
    verification is a real chore for a public app)?

14. **Interested items pile up.** Many Interested applications go untouched for weeks. Today now offers "Archive untouched" (with Undo) instead of clearing
    follow-up dates. Should it archive them on its own after, say, 30 days, or keep asking?
15. **Closed listings.** A company board that drops a posting for a day now closes untouched
    Interested items. Prepared ones are flagged and you're notified, never closed. Aggregator
    feeds never close anything. Is that the right line?

## Switching you over

12. **Changes on `master` after Oct 27: resolved.** Checked at the switch: the last `master`
    commit (Oct 27, 12:45) predates the standalone app, and its changes are in it.
13. **When to switch: done (Oct 28).** [MIGRATION.md](MIGRATION.md) records what the switch did and
    how to go back.
