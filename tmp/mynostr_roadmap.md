# MyNostr Roadmap — "Your Web Page" Pivot

## Context

The vision (see `tmp/mynostr_vision.md`) reframes MyNostr from a **private workspace** into a **public CMS**. Today the app is a login-gated SPA: no routing, no public URLs, every module assumes you're editing your own data. The vision is that **your npub is your site**, **your nsec is the admin password**, and `mynostr.app/<npub>` is what you hand out. Every module is a sub-page of that site, with two halves: **Mine** (events you authored) + **Bookmarked** (events you curated via NIP-51). Visitors never log in. Editors log in to edit only their own page. Share = copy the URL.

This plan is a **roadmap**, not a single implementation. It defines the architectural pivot, re-orders the module backlog, and locks in the cross-cutting patterns (public URLs, Mine/Bookmarked split, viewer vs editor mode, publish-not-post language) that every module from here on must adopt.

## Decisions locked (in this session)

- **Next phase:** Shell + Profile module together (Phase A + Phase B below)
- **URL scheme:** `/:npub` as canonical (nprofile/nip-05 aliases can come later)
- **Bookmarks UX:** `Mine | Bookmarked` sub-tabs on every module (uniform)
- **npub login:** stays, but is just view-mode — if you log in with an npub, the editor UI disappears from every module; everything else still renders. Functionally equivalent to visiting `/:npub`.

## Architectural shift

Three foundational changes everything else depends on:

1. **Routing exists.** Introduce React Router (no router today). Routes: `/` (login/landing), `/:npub` (profile page), `/:npub/:module` (module view), `/:npub/:module/:id` (single-item detail for share URLs).
2. **Owner vs visitor is first-class.** A new context distinguishes `sessionUser` (who is logged in, may be null) from `viewedUser` (whose npub is in the URL). `isOwner = sessionUser?.pubkey === viewedUser?.pubkey && !sessionUser.readOnly`. Editor chrome renders iff `isOwner`.
3. **Every module has Mine + Bookmarked.** One shared component, one shared hook (extended from `src/lib/useReadingLists.js`). No per-module reinvention.

## Phase A — Routing + public shell rework (foundation)

Does **not** add new modules. Reworks the shell so existing modules render for any `/:npub`.

Critical files:
- `src/App.jsx` — add React Router, route table, `OwnerContext` provider
- `src/AppShell.jsx` — URL-driven active module (not state-driven), owner badge, "Copy page link" share button in top bar
- `src/lib/auth.js`, `src/lib/ndk.js` — separate session vs viewed user; NDK fetches keyed off URL npub, not logged-in npub
- `src/components/LoginScreen.jsx` — after NIP-07/nsec/NIP-46 login, navigate to `/<your-npub>`. After npub paste, navigate to `/:npub` in view mode
- `src/modules/longform/LongformModule.jsx` — swap all "my pubkey" reads to `useOwnerContext().viewedUser.pubkey`; hide Write tab + publish + delete when `!isOwner`
- `src/modules/notes/NotesModule.jsx` — same treatment; hide composer + import/export + delete when `!isOwner`
- New: `src/components/ShareButton.jsx` — copy `/:npub/:module/:id` (or `/:npub` for page-level share)
- New: `src/lib/ownerContext.js` — the hook + provider

Verification:
- Logged out, visit `mynostr.app/<someone's-npub>` → their long-form + notes render, no editor UI anywhere.
- Logged in (nsec), visit `/` → auto-redirect to `/<your-npub>`. Editor UI visible only on your page. Visit someone else's npub → editor UI hidden.
- Logged in (npub read-only) → editor UI hidden everywhere, everything else intact.
- Top-bar share button copies `mynostr.app/<npub>` to clipboard.

## Phase B — Profile module (the landing page)

The homepage of every `/:npub` URL. Realizes the "MyNostr is your web page" thesis visibly.

Critical files:
- `src/modules/profile/ProfileModule.jsx` — currently stub; build out
- New: `src/components/ProfileCard.jsx` — banner, avatar, display name, NIP-05 badge, lightning address, website, bio. Reuse across profile page and any per-item author headers.
- `src/lib/primal.js` — already has `fetchProfiles`; add a fast "per-kind event count" helper (e.g. `fetchCountsByKind(pubkey, [1, 30023, 31923, 30402])`) so module cards can show "12 articles", "3 events" preview counts
- Relay list rendered but de-emphasized (small, collapsible)
- Owner-only "Edit profile" button (updates kind 0); visitors see "Copy page link"
- Module cards below the profile card, one per authored-module, linking to `/:npub/:module`

Verification:
- `/:npub` renders the profile card with kind 0 data and a grid of module-preview cards with counts.
- Owner sees Edit; visitor sees Copy link.

## Phase C — Cross-cutting patterns (applied to Long Form + Notes)

Extract the patterns once, apply retroactively, lock them in for future modules.

Critical files:
- New: `src/components/MineBookmarkedTabs.jsx` — shared wrapper rendering `['Mine', 'Bookmarked']` sub-tabs. Defaults sensibly: on your own page → "Mine"; on someone else's → "Authored by them".
- Extend `src/lib/useReadingLists.js` — add `useBookmarkedByKind(pubkey, kind)` which pulls kind 10003 + 30003 for that user, filters referenced events by kind, returns enriched list. Existing hook already handles enrichment + localStorage cache — reuse that.
- `src/modules/longform/LongformModule.jsx` — wrap content in `MineBookmarkedTabs`; "Bookmarked" renders articles from the viewed user's NIP-51 lists
- `src/modules/notes/NotesModule.jsx` — same treatment, kind 1
- New: `src/lib/publishLanguage.js` — small util that exports `"Publish"` / delete warning text, so language stays consistent
- Delete-button audit in Long Form + Notes: add the "may persist on non-compliant relays" warning text

Verification:
- Long Form has `Mine | Bookmarked` sub-tabs; Bookmarked shows articles from the viewed user's bookmark list(s).
- Notes has the same structure.
- Every article/note has a share button producing `/:npub/longform/:naddr` or `/:npub/notes/:nevent`; paste into a fresh browser → renders that single item.
- "Post" replaced with "Publish" everywhere it was an authoring verb; delete buttons carry the warning.

## Phase D — Next modules (now cheap because of C)

All use the patterns from Phase C. Order:

1. **Recipes** (kind 30023 `#recipe`) — piggybacks on Long Form plumbing. Adds recipe-specific editor (ingredients, steps, image). Fast win.
2. **Events** (kind 31923) — needs CF Worker scheduler for reminders (already on backlog). Naturally URL-friendly (each event is a page).
3. **Marketplace** (kind 30402) — listings, per-item share URL. Bookmarked listings = user's curated shop / wishlist.
4. **Browse** — repurpose as a *global* cross-kind bookmarks overview, complementing the per-module Bookmarked sub-tabs.

## Phase E — Discovery-elsewhere

From vision §7. Per-module empty state and "Find content" button → external:
- Long Form → Hubla.news, Highlighter
- Recipes → zap.cooking
- Events → listr.lol
- Marketplace → shopstr.store
- Fallback → Aljaz's Nostr app list

No feeds. No discovery infrastructure. Outbound links only.

## Phase F — Onboarding + follow-packs (later)

From vision §4–5. Deferred until core CMS is solid.
- Empty-dashboard flow: "you don't have any stuff yet" with per-module "write one" shortcuts
- Relay education screen: "Nostr = publishing to relays who promise not to censor"
- Follow-pack builder (programmatic, WoT-based, fad-zapper-based)
- "Make an account" UX decision (see open questions)

## Phase G — Podcasting 2.0 (future)

From vision §8. Deferred.
- Nostr-stored favorites list per user
- Requires Fountain-or-similar cooperation, or a fork

## Cross-cutting behavioral policies (apply from Phase C onward)

- **Publish, not post** — language audit across every authoring surface
- **Delete warning** — every delete button shows "may persist on non-compliant relays; contact them directly"; surface relay contact info where publicly available
- **Recommended-relay list** — onboarding and signup flows recommend only relays that respect kind 5 deletions
- **Speed first** — Primal cache before relays, always (existing principle, preserved)

## Open questions (revisit at later phases, not blockers now)

Carried forward from vision §10:
- Primal API data coverage for follow-pack automation
- Programmatic follow-pack CRUD feasibility
- Relay public-contact availability (for delete warnings)
- Fountain fork vs cooperation (for Podcasting 2.0)
- "Make an account" UX — popup, redirect-and-return, or hand off to Primal

## What stays on the current roadmap, what shifts

| Module / Item | Was | Now |
|---|---|---|
| Long Form (30023) | Done | Retrofit with owner/visitor + Mine/Bookmarked (Phase C) |
| Notes (1) | Done | Same retrofit (Phase C) |
| Recipes (30023 #recipe) | Next | Moves after Profile (Phase D-1) |
| Events (31923) | Planned | Phase D-2 |
| Profile (kind 0) | Was last | **Now Phase B (with shell)** |
| Marketplace (30402) | Planned | Phase D-3 |
| Browse | Planned | Phase D-4, repurposed as global bookmarks view |
| Search, Stats, WoT | Planned | Unchanged, later |

The reorder is the only backlog change. Every module the user has already shipped survives — it just gets wrapped in the new shell and grows a Bookmarked sub-tab.
