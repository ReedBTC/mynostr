# MyNostr smoke test

Pre-deploy manual checklist. Run **all of section 1** before any deploy.
Run sections that match what changed for everything else. Whole file
should take 10–20 minutes; if it's taking longer, narrow to what
actually changed.

Add new flows to this file as you discover regressions in real-world
use — the value of the checklist is what bites you, not what's
theoretically broken.

## How to use

1. **Before** pushing: open mynostr.app in two browsers — one logged in
   as you, one logged out (incognito works) — both desktop.
2. **Mobile pass:** repeat the mobile-flagged items on iOS Safari and
   Android Chrome. You can defer this to after-deploy if the change
   was desktop-only.
3. **Mark anything that fails as a TODO; ship the fix before
   announcing the deploy.**

---

## 1. Critical path (always)

Every deploy. Five minutes if everything works.

- [ ] **Cold-load homepage** (incognito): no console errors, hero
      image + search bar visible, login button visible above the
      search bar on mobile width.
- [ ] **Login** with your usual signer (extension or bunker): lands
      on /<your-npub>/<DEFAULT_MODULE> within 5 seconds, sidebar
      shows your pfp.
- [ ] **Logout**: drops you back to the homepage; sidebar pfp gone;
      search bar autofocuses on desktop, doesn't on mobile.
- [ ] **Visit another user's profile** by pasting their npub into
      the homepage search: lands on /<other-npub>/notes; their notes
      load.
- [ ] **Direct cold-load a share URL** (try a known-good naddr or
      nevent — keep one bookmarked): redirects to the canonical app
      URL via BechResolver and renders the right module + content.

## 2. Notes

If you touched anything in `modules/notes/` or `lib/useNoteDrafts.js`
/ `lib/scheduler.js` / `lib/publishNote.js`.

- [ ] **Compose + publish a kind 1**: confirmation panel shows
      "X of Y relays" with X close to Y; the note appears in your
      own notes feed within ~5 seconds.
- [ ] **Reply** to an existing note (paste an nevent in the Reply
      field): publishes; thread view shows the reply nested under
      the parent.
- [ ] **Quote** an existing note: published note renders the quoted
      note inline.
- [ ] **Image upload**: the compression picker appears, the chosen
      level uploads, the URL is inserted at the cursor position.
- [ ] **Schedule a note** for ~10 minutes in the future: shows in
      the drafts tray under "Scheduled" with the right time; the
      mobile composer chip count includes it.
- [ ] **Cancel a scheduled note**: row disappears; chip count drops.
- [ ] **JSON import**: pick a previously-exported `.json`; composer
      loads with the content + the nevent search box gets populated
      with the event's nevent.
- [ ] **Three-dot menu on a scheduled row near the bottom of the
      tray**: menu opens fully visible (no clipping behind the
      import/export footer).
- [ ] **Note thread back button** on a cold-loaded note URL:
      lands on the note author's `/notes` feed.

## 3. Articles

If you touched anything in `modules/articles/` or `lib/publish.js` /
`lib/useDraft.js`.

- [ ] **Write a new article**: title, summary, markdown body, hashtags;
      publish; appears under "My Articles" within ~10 seconds.
- [ ] **Edit a published article**: load via the three-dot menu → "Edit
      in Write tab"; modify; re-publish; the displayed version updates
      after a refresh.
- [ ] **Delete an article**: three-dot menu → Delete; confirms; article
      disappears from your feed.
- [ ] **Bookmark an article** to a list (default + a custom list);
      check that the bookmarks tab shows it.
- [ ] **Mobile reading**: open an article on a phone-width window,
      scroll down — header rows retract; scroll up — they reappear.
- [ ] **Click another author's pfp/name** while reading their article:
      navigates to their /articles feed.
- [ ] **Cross-author naddr import** (paste another user's article
      naddr into your composer): the green "Will publish as new"
      banner shows (NOT "Will replace existing").

## 4. Events

If you touched `modules/events/` or `lib/eventForm.js` / `lib/eventPublish.js`.

- [ ] **Create a date-based (all-day) event**: publishes; appears in
      "My Created"; .ics download produces a valid file.
- [ ] **Create a time-based event**: publishes with the right start
      and end timestamps.
- [ ] **RSVP "Going"** on someone else's event: count increments;
      your own status reflects.
- [ ] **Comment** on an event: publishes; appears in the comment
      thread.
- [ ] **Add to Google Calendar**: opens calendar.google.com in a new
      tab pre-filled with title, date, description, location.
- [ ] **Add to Outlook**: same flow on outlook.live.com.
- [ ] **Click the host name on an event**: lands on the host's
      /events feed (NOT /profile).
- [ ] **Calendar membership**: "Save to calendar…" opens the modal,
      toggling adds/removes the event from one of your kind 31924
      calendars.

## 5. Marketplace

If you touched `modules/marketplace/` or `lib/publishProduct.js` /
`lib/sellForm.js`.

- [ ] **Create a listing** end-to-end: title, summary, description,
      photo upload (compression picker shows), price, status. Publish.
      The pre-publish relay-check modal appears if you're missing
      Plebeian or DM relays; otherwise publishes silently.
- [ ] **Single stream layout**: composer is one continuous form (no
      Listing/Photos/Shipping tabs).
- [ ] **Photo upload**: 50MB cap; compression picker handles a
      multi-MB phone shot; uploaded image appears in the photo grid.
- [ ] **Edit a published listing**: load via "Edit", modify, re-publish;
      "Will Replace Listing" banner shows blue dot.
- [ ] **Cross-author listing import**: paste another user's naddr; banner
      shows green "Will publish as new" (NOT "Will Replace").
- [ ] **Export JSON** on an existing item from My Products → ⋯ →
      Export JSON: file downloads (does not silently no-op).
- [ ] **Delete a listing**: confirms, scans target relays, ack count
      shown.

## 6. Profile / Relays

If you touched `modules/profile/` or `lib/relayInfo.js`.

- [ ] **View your own profile + Stats & Relays card**: relays render
      with W/R indicators; counts show in the header.
- [ ] **Edit relay list**: add a new relay, save; appears in the list
      after publish.
- [ ] **DM relays**: edit, remove all, click Save → confirmation
      modal "Leave without adding any NIP-17 relays?" appears
      (NOT a hard "add at least one" block).
- [ ] **Relay tab header layout on mobile**: title row stacks above
      counts/buttons (no smooshing).
- [ ] **Share profile button** (mobile): single tap copies; ✓ flash
      shows; second tap not required.

## 7. Cross-cutting

Run if you touched OG metadata, the worker, sharing, or icons.

- [ ] **Share an article URL** to iMessage: unfurls with title, image,
      author. Description is ~2 lines.
- [ ] **Share a note URL** to iMessage: unfurls with default OG image,
      tight description.
- [ ] **Share a profile URL** (`mynostr.app/<npub>`): unfurls with
      display name + bio + profile picture (proxied through wsrv.nl).
- [ ] **Share an event URL**: unfurls with event title + date + image.
- [ ] **Tab title** updates per route (not stuck on
      "MyNostr — Personal Nostr portal" everywhere).
- [ ] **`/sitemap.xml`** loads as raw XML (not the SPA homepage).
- [ ] **`/robots.txt`** loads.

## 8. Mobile-specific

iOS Safari + Android Chrome. Run after the desktop pass.

- [ ] **Cold-load homepage**: no zoom-in / wide-page issue on
      iPhone; pinch-zoom not needed.
- [ ] **Homepage keyboard**: search field does NOT auto-focus (no
      keyboard pop-up on load).
- [ ] **Add to Home Screen** (iOS): tile uses the 180×180 icon, opens
      in standalone mode (no Safari URL bar visible).
- [ ] **Add to Home Screen** (Android Chrome): manifest install
      prompt appears; tile uses the 192/512 icons, opens standalone.
- [ ] **Note composer** on mobile: drafts chip shows the combined
      drafts + scheduled count.

## 9. Login flows

If you touched `components/LoginScreen.jsx` or `lib/sessionPersistence.js`.

- [ ] **Extension login** (desktop): Alby/nos2x prompt fires;
      successful login lands on /<npub>/<module>.
- [ ] **Bunker QR** (desktop): scan with Amber/nsec.app from phone;
      QR connect completes within ~20s; "Try again" affordance
      visible if it times out.
- [ ] **Open in Signer App** (mobile): tap → Amber opens → approve
      → return to MyNostr → spinner shows progress copy + elapsed
      seconds; login completes within ~15s.
- [ ] **Bunker paste** (both): paste a bunker:// string; connects.
- [ ] **nsec paste** (incognito): pastes; logs in; warning about
      key-in-memory shows.
- [ ] **npub paste** (read-only): logs in; "read-only" message
      appears; publish flows are gated.
- [ ] **Refresh after login**: session persists; you don't have to
      re-sign-in.
- [ ] **Logout**: clears session; subsequent reload lands on
      logged-out homepage.

---

## Adding to this file

When a real-world bug surfaces that this checklist would have caught:

1. Add a new bullet in the most relevant section.
2. Push the update with the fix.
3. Next deploy, you'll catch the same regression.

When a flow gets retired (module removed, behavior changed): just
delete the bullet. Stale items waste pre-deploy time.
