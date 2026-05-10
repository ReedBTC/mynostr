# MyNostr smoke test

Pre-deploy regression check. Aim: ~30 min total — 15 desktop, 15 mobile.
Bias to things you wouldn't notice during normal use.

**Stop short of publishing anything new.** Fill out composers and verify
form / validation / preview / drafts-chip behavior, but don't click
Publish. Once the onboarding module ships, run a full publish loop
with a fresh account.

When something fails: mark it, fix before announcing the deploy, then
add a bullet here so the regression surfaces next time.

---

## Desktop pass (~15 min)

### Cold load + share metadata (~5 min, incognito)

- [ ] Cold-load `mynostr.app` — no console errors. Login button sits
      above the search bar. Search bar autofocuses.
- [ ] Direct cold-load a known-good `naddr` / `nevent` URL —
      BechResolver redirects to the correct module + content (not
      the homepage / 404).
- [ ] Tab title updates when navigating module → module (NOT stuck
      on `MyNostr — Personal Nostr portal` everywhere).
- [ ] `/sitemap.xml` and `/robots.txt` load as raw files (NOT the
      SPA shell).
- [ ] Share an article URL + a note URL to iMessage — each unfurls
      with title, image, author. Profile URLs unfurl with
      display_name + bio + (proxied) pfp.

### Login + identity (~3 min)

- [ ] Log in with your usual signer. Lands on `/<npub>/<module>`
      within 5 sec; sidebar shows your pfp.
- [ ] Refresh — session persists, no re-sign-in needed.
- [ ] Paste another user's npub into homepage search → their
      `/notes` loads.

### Composer state without publishing (~5 min)

For each of Notes, Articles, Events, Marketplace Sell — open the
composer, fill required fields, then verify (without clicking Publish):

- [ ] Drafts chip count updates as you type / save.
- [ ] Image upload: compression picker appears for a multi-MB photo;
      chosen level uploads; URL inserts at cursor.
- [ ] Cross-author import (paste another user's `naddr`) — banner
      reads `Will publish as new` (NOT `Will replace existing`).
- [ ] Publish button enables only after validation passes.

### Marketplace owner-side regressions (~2 min)

- [ ] My Selling — header chip + banner render in neutral chrome
      (only fully-ready earns emerald). No amber walls.
- [ ] Click `Review listing` pill on a card with gaps → compliance
      panel opens scrolled to that listing's row, highlighted amber.
- [ ] Mark a listing `Not a checkout product` → row disappears
      from panel; per-card pill disappears; footer reads
      `1 listing hidden as classified-only · Show`.
- [ ] Visit someone else's marketplace tab while logged in →
      NO banner, NO score chip, NO per-card dots.

---

## Mobile pass (~15 min)

iOS Safari + Android Chrome. Run after the desktop pass.

### Cold load + install (~4 min)

- [ ] Cold-load `mynostr.app` — no zoom-in / wide-page issue;
      pinch-zoom not needed.
- [ ] Search field does NOT autofocus (no keyboard pop-up on load).
- [ ] Login button is prominent above the search bar.
- [ ] Add to Home Screen on iOS — tile uses the 180×180 icon;
      opens standalone (no Safari URL bar).
- [ ] Add to Home Screen on Android Chrome — install prompt
      appears; tile uses the 192/512 icons; opens standalone.

### Login on mobile (~2 min)

- [ ] `Open in Signer App` → Amber → approve → returns to MyNostr;
      progress copy + elapsed seconds visible during reconnect;
      login completes within ~15 sec.
- [ ] Logout → reload → lands on logged-out homepage.

### Composer chrome on mobile (~5 min)

- [ ] Note composer drafts chip shows combined drafts + scheduled
      count.
- [ ] Three-dot menu on a scheduled row near the bottom of the
      drafts tray opens fully visible (NOT clipped behind the
      import/export footer).
- [ ] Trigger mention autocomplete in a composer near the bottom
      of the viewport — dropdown docks above the keyboard, doesn't
      slip behind it.
- [ ] Profile share button — single tap copies; ✓ flash; no
      second tap required.

### Reading on mobile (~4 min)

- [ ] Open an article — header rows retract on scroll down,
      reappear on scroll up.
- [ ] Open a note thread → tap back → lands on the author's
      `/notes` feed (NOT homepage).
- [ ] Sidebar pfp tap → drawer opens; tap outside → closes.

---

## Deep dives — only if you touched these areas

Skip when unchanged. Each is ~5–10 min.

- **`lib/scheduler.js` / `cf-workers/scheduler/`** — schedule a real
  note ~16 min out, cancel it ~5 min before publish, tail
  `npx wrangler tail mynostr-scheduler --format pretty`, confirm
  `raceCancelled=` fires (or a clean publish if you didn't cancel).

- **`lib/relayInfo.js` / `DmRelayCard`** — edit DM relay list,
  remove all entries, click Save → confirm modal warns rather than
  hard-blocks. Re-add at least one before leaving.

- **`lib/gammaCompliance.js` / `CompliancePanel`** — open the panel
  on an account with NO `payment_preference`, NO kind 10050, NO
  shipping options. Walk all 3 steps; each toggles to emerald as
  you complete it. Header reads `N/3 setup steps complete`.

- **`functions/_middleware.js` / SEO worker** — re-test share-URL
  unfurls for every content type (article, note, profile, event,
  listing). Each should hit the worker, not the SPA index.

- **`components/LoginScreen.jsx`** — additionally test bunker QR
  (desktop), bunker:// paste, nsec paste, npub read-only paste.

---

## Adding to this file

When a real-world bug surfaces that this checklist would have caught,
add a bullet to the most relevant section. Delete bullets when flows
retire — stale items waste pre-deploy time.
