# Bug-relay watcher

Polls `wss://relay.mynostr.app` every 10 minutes for kind 1 events
tagged `["t", "mynostr-alpha"]` and creates a GitHub issue per new
report in `ReedBTC/mynostr` with labels `bug` + `from-relay`.

## Files

- `watcher.js` — the polling script. All site-specific config (relay,
  tag, repo, labels) lives in the `CONFIG` object at the top.
- `systemd/mynostr-bug-watcher.service` — oneshot user-mode unit.
- `systemd/mynostr-bug-watcher.timer` — fires the service every 10 min.
- `state/` — runtime state (gitignored). Created on first run.
  - `state/seen.json` — set of nostr event ids already turned into
    issues. Delete to force a fresh seed.

## Install (Ubuntu, user-mode systemd)

```bash
# 1. Drop the unit files into the user systemd dir.
mkdir -p ~/.config/systemd/user
cp scripts/bug-watcher/systemd/mynostr-bug-watcher.service ~/.config/systemd/user/
cp scripts/bug-watcher/systemd/mynostr-bug-watcher.timer   ~/.config/systemd/user/

# 2. Reload user systemd, enable + start the timer.
systemctl --user daemon-reload
systemctl --user enable --now mynostr-bug-watcher.timer

# 3. Keep the timer alive when you're not logged into a graphical session.
loginctl enable-linger "$USER"
```

## Verify

```bash
systemctl --user status mynostr-bug-watcher.timer    # should be active (waiting)
systemctl --user list-timers | grep mynostr          # see next-fire time
journalctl --user -u mynostr-bug-watcher -f          # live logs
```

## Manual one-shot

Useful for testing without waiting for the next tick:

```bash
systemctl --user start mynostr-bug-watcher.service
journalctl --user -u mynostr-bug-watcher --since "1 minute ago"
```

## First run behavior (seeding)

On the very first run, `state/seen.json` doesn't exist. The script
fetches the last 30 days of tagged events from the relay, marks all of
them as already-handled (writes their ids to `seen.json`), and exits
**without** creating any GitHub issues. This intentionally skips the
historical test reports so triage starts fresh.

If you want issues for some of those historical events anyway: open
`state/seen.json` after the seed run, remove the ids you want
re-processed, and run the service again.

## Reusing for another site

Two changes:

1. Copy this folder into the other repo (or to a sibling location).
2. Edit `CONFIG` at the top of `watcher.js`:
   - `tag` — the magic topic tag for that site (must match the relay's
     write-policy plugin)
   - `repo` — the GitHub repo issues should land in
   - Optionally `relay`, `labels`

Each site gets its own systemd unit pair (rename the service/timer
files so they don't collide) and its own `state/` directory.

### Dependency note

`watcher.js` imports `nostr-tools` (used only for `nip19.npubEncode` /
`neventEncode`). It resolves from the parent project's `node_modules`,
so the script works as-is when it lives inside this repo. If you copy
the watcher folder somewhere with no sibling `node_modules`, either:

- run `npm init -y && npm install nostr-tools` next to `watcher.js`, or
- vendor the small bech32 helpers inline (only the two encoders are
  used) and drop the dependency entirely.

## Stop / disable

```bash
systemctl --user disable --now mynostr-bug-watcher.timer
loginctl disable-linger "$USER"   # only if no other linger-dependent services
```

## Troubleshooting

- **"Logged in to github.com account ReedBTC" — but issues aren't being
  created.** `gh` looks up auth from the user keyring; user-mode systemd
  inherits this fine on Ubuntu 24.04. If you see auth errors in the
  log, run `gh auth status` from a regular shell to confirm.
- **Timer not firing while logged out.** You need
  `loginctl enable-linger "$USER"` — without it, user services stop
  when you log out of all sessions.
- **"WS error" or timeouts.** Likely the relay is down. Check
  `wscat -c wss://relay.mynostr.app` from another shell, or check the
  VPS host running strfry.
