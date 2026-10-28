# Moving the personal install to the standalone app

**Done on Oct 28, 2026.** The everyday app is now the standalone build (`pnpm ship`, see the
README), with its data in `~/.sidedoor`. This records what the switch did and how to undo it.

## What the switch did

1. Stopped and disabled the old services: `systemctl --user disable --now sidedoor-web sidedoor-worker`
   (their unit files are still in `~/.config/systemd/user`). `~/Code/sidedoor`, its database and
   `~/Code/resume` were only read, never changed.
2. Imported into the real home: `node apps/server/dist/bin.mjs import-legacy ~/Code/sidedoor`
   (it refuses if `~/.sidedoor` already has applications; `--force` imports over one).
3. Set **Address other devices use** to the Tailscale URL from `~/.config/sidedoor/env`
   (`https://<machine>.<tailnet>.ts.net:8443`) and pointed Tailscale at the new app:
   `tailscale serve --bg --https=8443 http://127.0.0.1:4848`. The ntfy topic carried over.
4. `pnpm ship` built the first daily build and started it.

## Still to do by hand

- **Settings → AI: Add Sidedoor to Claude Code.** That replaces the old in-process
  tools. It adds Sidedoor to your Claude Code config.
- **Settings → Appearance: Start when I log in.**
- **Phone:** Settings → Phone & other devices, scan the pairing code (the old app's sign-in
  doesn't carry over).
- **Job-site sign-ins** in the old Chromium profile (`~/Code/sidedoor/data/browser-profile`) don't
  carry over; sign in again the first time a form needs it.

## Going back to the old app

Anything added in the new app after the switch stays in `~/.sidedoor`; it doesn't flow back.

```bash
systemctl --user stop sidedoor                         # the new app
systemctl --user enable --now sidedoor-web sidedoor-worker
tailscale serve --bg --https=8443 http://127.0.0.1:4747
```

## Trying an import on a copy first

```bash
SIDEDOOR_HOME=/tmp/sidedoor-trial node apps/server/dist/bin.mjs import-legacy ~/Code/sidedoor
SIDEDOOR_HOME=/tmp/sidedoor-trial SIDEDOOR_NO_JOBS=1 <Sidedoor AppImage or electron apps/desktop>
```

A home other than `~/.sidedoor` gets its own Electron profile, so a trial runs next to the
everyday app. `SIDEDOOR_NO_JOBS=1` keeps the scout and AI jobs off.

## What doesn't carry over

- **Two tailored resumes in a one-off layout** (highlight cards) start as a copy of the main resume;
  their original PDFs are attached.
- **Files in `~/Code/resume`** after the import. Edit your profile in the app from then on; the
  folder is no longer read.
