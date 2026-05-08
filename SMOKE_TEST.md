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
`lib/sellForm.js` / `lib/gamma*.js` / `lib/useShippingOptions.js`.

### Core listings

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

### Shipping options (kind 30406)

- [ ] **Create a shipping option** in Marketplace → Shipping: title,
      price, countries (ISO 2-letter codes — e.g. `US, GB`), service
      enum (standard/express/overnight/pickup). Save → option appears
      in the list immediately.
- [ ] **Invalid country code**: type `usa` → chip turns amber; save
      blocked with field-level error. `US` → chip is neutral, save works.
- [ ] **Edit + Archive**: open existing option → modify → save lands
      with same dTag. Archive flow confirms before publishing kind 5.
- [ ] **Cross-tab live update**: open Shipping tab in one browser tab,
      Sell composer in another. Create an option in the first tab; it
      shows up in the composer's Shipping section without a refresh.

### Sell composer — structured shipping

- [ ] **Multi-select shipping**: Sell composer's Shipping section
      offers checkboxes (not radios). Tick two options (e.g. "US
      Standard" + "Local Pickup"); publish. The published kind 30402
      carries TWO `shipping_option` tags (verify in the drawer's raw
      tags view).
- [ ] **Inline + New option**: from the Sell composer, click "+ New
      option" — the editor opens, save creates a new 30406 AND
      auto-attaches the new ref to the in-progress draft.
- [ ] **Notes still work**: free-text shipping notes (collapsed by
      default) still publish into the markdown body under "## Shipping"
      for forward-compat with non-Gamma readers.

### Compliance check + migrate flow

- [ ] **Banner shows on My Selling** when listings have shipping gaps
      (or only info-level if shop is otherwise clean). Dismiss
      persists for the session.
- [ ] **Header score chip** ("X/Y checkout-ready") clickable → opens
      the panel. Color matches state (green/amber/rose).
- [ ] **Per-card compliance dot** ("Checkout-ready" / "Manual only" /
      "Spec gap") visible only to owner; tooltip lists the gaps.
- [ ] **Migrate a free-text-only listing**: parse preview shows the
      original "## Shipping" notes. Pick an existing option (or
      create new). Save → 30402 republishes with `shipping_option`
      ref attached and "## Shipping" markdown removed.
- [ ] **Bulk apply**: when other listings are missing shipping, the
      "Also attach to my other N listings" checkbox appears. Save
      republishes each at ~600ms spacing; progress bar updates;
      partial-fail surfaces error count.
- [ ] **Multi-option migrate**: tick multiple options in the picker,
      save — listing's shipping_option tag count matches what was
      ticked.
- [ ] **Visitor-side stays clean**: open My Selling on someone else's
      profile (logged in or out). NO compliance banner, NO score chip,
      NO per-card dots.

### Profile signals

- [ ] **Payment preference** in Profile editor under Lightning address:
      Manual default, Lightning Address gated on lud16 set, eCash
      gated on a published kind 10019. Save → reload profile, the
      "Marketplace checkout: Lightning auto-pay" line appears on the
      read view (or no line at all when Manual).
- [ ] **NIP-89 checkout app** (optional): paste an `naddr1…` or
      `31990:<pubkey>:<dtag>` coord. Save → "Checkout via:" line
      appears on the read view. Clear → line disappears.
- [ ] **Profile tag round-trip**: edit your profile in MyNostr after
      setting a tag from another client (or just toggle and save
      twice in MyNostr). The previously-set tag is preserved across
      saves — `publishProfile.js` round-trips kind-0 tags rather
      than emitting an empty array.

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
