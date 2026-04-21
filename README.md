# MyNostr

A personal Nostr portal for publishing, managing, and analyzing your own content across every Nostr event kind. Unlike feed-first clients, MyNostr treats **your data as the product** — your page, your lists, your analytics.

**Live at [mynostr.app](https://mynostr.app)**

## What it does

Every Nostr account gets a page at `mynostr.app/:npub/:module`. Visitors see a read-only view of whatever the page owner has published; the owner logs in to edit. Each module handles a different event kind.

| Module | Kind | Status |
|--------|------|--------|
| **Profile** | Kind 0 (metadata) + 10002 (relays) + 10050 (DM relays) | Live |
| **Notes** | Kind 1 (short notes) | Live |
| **Articles** | Kind 30023 (long form) | Live |
| **Events** | Kind 31923 (calendar events) | Coming soon |
| **Marketplace** | Kind 30402 (listings) | Coming soon |

### Profile module
- Read view of kind 0 with identity, lud16, NIP-05, banner, picture, website, about
- Owner edit mode with preview-before-publish
- **Stats card** — aggregate notes, reactions, zaps, followers, follows via Primal cache; click-through to filtered Notes feed
- **Posting cadence chart** — weekly buckets of the user's kind 1 output with a manual refresh button for partial/paginated fetches
- **Relay card** — NIP-65 read/write relay management with add/remove and onboarding prompt when the list is missing
- **DM relay card** — NIP-17 kind-10050 DM inbox relay management, separate from the general relay set
- Previewing another user from the in-module search switches the whole view to *their* page without changing the URL

### Notes module
- Multi-draft composer with per-draft state persisted in localStorage and a sidebar tray (Cmd/Ctrl+N for a new draft)
- Rich composer — @mention autocomplete, inline image upload (Blossom), reply/quote by note ID, JSON import/export, relay override, NIP-10 reply threading that preserves the root
- Zap splits editor with percentage allocation and even-split defaults
- **My Notes feed** — virtualized kind-1 list with Notes/Comments toggle, like state persistence, and per-card Like/Zap/Comment/Repost/Bookmark action bar
- **Bookmarks** — NIP-51 kind 10003 + 30001 + 30003 unified into named categories with a chip bar, per-category privacy buckets (public/private NIP-44), bulk select + bulk move/remove, cross-device delete via tombstones
- **Thread view** — NIP-10 reply threading with inline expansion
- **Search** — author-scoped Notes or Bookmarks via a pill toggle; click a note's author on any feed to jump straight into their search view

### Articles (Long Form) module
- Markdown editor for kind 30023 with cover image, summary, hashtags, metadata, and draft persistence
- **Collection tab** — NIP-51 reading-list categories for bookmarked articles, with public/private buckets, move-between-lists, and bulk actions
- **Authors tab** — browse articles by author with inline reader panel
- **Reader panel** — Like/Zap/Comment/Repost/Bookmark, inline move-to/copy-to on bookmark, three-dots menu for privacy move/export; when viewing another author's collection the panel drops edit affordances and only offers copy-to-your-lists
- Visitor mode shows the owner's collection + authors publicly; write actions are owner-only

## Authentication

- **NIP-07 browser extension** (recommended) — Alby, nos2x, Nostore, keys.band
- **NIP-46 Nostr Connect** — QR on desktop, deep-link signer tiles on mobile (Primal always, Amber on Android); pre-generated `nostrconnect://` URI for one-tap open
- **nsec direct entry** — kept in memory only, never persisted
- **npub read-only mode** — browse without signing

All login paths wait up to 5s for the first WSS handshake (`connectAndWait`) before completing, so the first publish/fetch doesn't race against an unopened socket.

## Publishing model

- **Outbox-aware** — on login, the user's NIP-65 write relays are added to the NDK pool. Replaceables (profile, contacts, bookmarks, reading lists, deletes) publish only to the user's own write relays so later edits/deletes reach every copy. Reach-over-recall events (kind 1 notes, reactions, reposts, kind 10002) fan out to the full pool.
- **Silent-failure detection** — if kind 10002 is missing or unreadable at login, a dismissible banner warns that writes are falling back to the default pool (so the user knows their followers may not see updates).
- **Remote-signer timeouts** — NIP-46 sign calls are bounded at 20s so the UI always reaches a terminal state if a bunker request hangs.

## Stack

- **Frontend:** React 18, Vite, Tailwind CSS, React Router
- **Nostr:** NDK (Nostr Dev Kit), nostr-tools (including `BunkerSigner` wrapped for NDK)
- **Data:** Primal cache API (WebSocket), direct relay connections
- **Storage:** Blossom (blossom.primal.net) for image uploads, localStorage for drafts/tombstones
- **Hosting:** Cloudflare Pages + Workers
- **Other:** Recharts, TanStack Virtual, JSZip, DOMPurify, Marked, MDEditor

## Development

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production build → dist/
```

## Architecture

- **URL-driven.** `/:npub/:module` is canonical. `ownerContext` splits `sessionUser` (logged-in identity with signer) from `viewedUser` (whose page is on screen); `isOwner` gates every write affordance.
- **Lazy-loaded modules.** `React.lazy` + Suspense means only the active tab's code is fetched.
- **Responsive baseline.** Desktop top bar (logo, scrollable module tabs, share/avatar) on ≥md; mobile gets a hamburger + active-module label + slide-in drawer.
- **Shared NDK singleton** (`src/lib/ndk.js`) across all modules, with `resetNDK` on logout to release the signer and close relay connections.
- **Primal WebSocket cache** (`src/lib/primal.js`) for profile resolution, user search, article discovery, and posting cadence — fall back to direct relay fetch only when the cache can't answer.
- **Shared ZapModal** handles any target (article, note, profile) via `{targetEvent, targetKind, aTag}`.
- **Cross-device-aware replaceable writes** — bookmark/reading-list deletes publish tombstones so a stale copy on another device's cache doesn't resurrect the entry on merge.
- **Security** — CSP in `index.html`, `isSafeUrl` on every external URL (no innerHTML, capped LRU caches, size-limited imports).

## License

MIT
