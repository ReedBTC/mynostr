# MyNostr

A personal Nostr portal for publishing, managing, and analyzing your own content across every Nostr event kind. Unlike feed-first clients, MyNostr treats **your data as the product** — your page, your lists, your activity.

**Live at [mynostr.app](https://mynostr.app)** · alpha.

## What it does

Every Nostr account gets a page at `mynostr.app/<npub>/<module>`. Visitors see a read-only view of whatever the page owner has published; the owner logs in to edit. Bech32 share URLs (`mynostr.app/<naddr>`, `mynostr.app/<nevent>`) redirect to the canonical app URL and unfurl with rich previews on iMessage, Telegram, Discord, X, and Slack.

| Module | Kinds | Status |
|---|---|---|
| **Profile** | 0 (metadata), 10002 (relays), 10050 (DM relays), 3 (contacts) | Live |
| **Notes** | 1 (short notes), 6/16 (reposts), 7 (reactions), 9735 (zaps), 10003/30001/30003 (bookmarks) | Live |
| **Articles** | 30023 (long-form), 31023 (drafts) | Live |
| **Events** | 31922/31923 (calendar events), 31924 (calendars), 31925 (RSVPs), 1111 (comments) | Live |
| **Marketplace** | 30402 (NIP-99 listings), 30405 (collections), 30406 (shipping options), 31989 (NIP-89 app recommendation), 5 (deletions) | Live |

### Profile

Read view of kind 0 with identity, lud16, NIP-05, banner, picture, website, about. Owner edit mode with preview-before-publish. **Stats card** aggregates notes, reactions, zaps, followers, follows via Primal cache with click-through to filtered Notes feeds. **Posting cadence chart** shows weekly buckets of the user's kind 1 output. **Relay card** manages NIP-65 read/write relays with onboarding for users missing kind 10002. **DM relay card** manages NIP-17 kind-10050 relays separately, with NIP-42 / gift-wrap status indicators.

### Notes

Multi-draft composer with localStorage persistence and a sidebar tray. Rich composer — @mention autocomplete, inline image upload via Blossom (with size-aware compression picker), reply/quote by note ID, JSON import/export, NIP-10 threading. **Scheduler** — pre-sign a kind 1 + ship it to a Cloudflare Worker that publishes on a 15-minute cron tick, with a `viewingScheduled` lock-mode that lets you cancel and edit. **Per-note zap-comments** — IO-driven count fetch + click-to-expand inline panel. **Bookmarks** — NIP-51 kind 10003 + 30001 + 30003 unified into named categories with public/private buckets (NIP-44 encrypted), bulk move/remove, cross-device delete via tombstones, foreign-list read-only. **Search** — author-scoped Notes or Bookmarks via a pill toggle.

### Articles

Markdown editor for kind 30023 with cover image, summary, hashtags, and draft persistence (replaceable kind 31023). **My Articles + Collection + Search** tabs. **Reader panel** — Like/Zap/Comment/Repost/Bookmark with inline move-to/copy-to, three-dots menu, ePub export. On mobile the reader's header rows retract on scroll-down for prose-first reading. Author pfp/name links to that author's articles feed. Cross-author imports treat the source as a fresh starting point (the dTag is stripped, no accidental same-slug overwrite of your own work).

### Events

Multi-draft composer for date-based (31922) and time-based (31923) events with markdown body, location, geohash, hashtags, and participants. **Calendars** (kind 31924) group your events into named collections; events can belong to multiple. **RSVPs** (kind 31925) with an `accepted/declined/tentative` toggle, free-busy hints, and counts that publish to both your outbox and the host's read relays. **Comments** are NIP-22 kind 1111 (read kind 1 too for legacy compatibility). **Add to calendar** — Google Calendar / Outlook deep links plus an `.ics` download (RFC 5545, with VEVENT + GEO + ATTENDEE rows) covering Apple Calendar, Fantastical, Thunderbird, etc.

### Marketplace

Single-stream composer for NIP-99 kind 30402 listings — title, summary, markdown description, images (compression picker, up to 8 per listing), price, stock, visibility, status, shipping, hashtags. **Collections** (kind 30405) for grouping listings — toggle membership inline from the composer. **Pre-publish relay check** advises the user when their kind 10002 is missing `wss://relay.plebeian.market` or their kind 10050 has no DM inbox; one-click adds with confirmation. **Edit / replace** preserves the listing's dTag; cross-author imports get a fresh dTag so you can't accidentally overwrite your own listings. **Delete** uses NIP-09 with a scan-then-target step that hits every relay actually serving the listing, not just the user's current outbox (relays drift, deletions need to reach the surface area).

**Gamma checkout interop** (NIP-99 + [Gamma Markets spec](https://github.com/GammaMarkets/market-spec)) — MyNostr publishes listings in a shape that's natively checkout-ready in third-party marketplace apps like Shopstr and Plebeian Market, without doing checkout itself. **Shipping Options** (kind 30406, reusable per-seller) attach to listings via `shipping_option` refs — multiple per listing, so a seller can offer "US Standard" + "Local Pickup" side by side. **Payment preference** (`payment_preference` tag on kind 0) tells buyers' clients to route to your Lightning address, eCash, or fall back to manual DM checkout. **NIP-89 app recommendation** (kind 31989) lets you point buyers at your preferred Nostr marketplace app. **Compliance check** in My Selling scans your whole shop, flags listings still using free-text shipping, and migrates them in one click — bulk-apply moves multiple listings to the same shipping setup. Per-listing dots and a header score chip show what's checkout-ready at a glance.

## Authentication

Login is a modal you can open from anywhere — `useLoginModal().openLogin()` — so the URL and browsing state survive the auth round-trip.

- **NIP-07 browser extension** (Alby, nos2x, Nostore, keys.band) — desktop primary
- **NIP-46 Nostr Connect**:
  - Desktop QR for Amber / nsec.app / Primal scans
  - Mobile "Open in Signer App" deep link for Amber on Android
  - `bunker://` paste for any signer
  - Live elapsed-seconds counter + retry path during the relay round-trip
- **nsec direct entry** — held in memory only, never persisted to disk
- **npub read-only mode** — browse without signing; publish flows are gated

If you don't have a Nostr key yet, generate one with `nstart.me` or `nsec.app` first, then sign in here. (We deliberately don't generate keys in-app until we have a proper backup-or-you-lose-it onboarding flow.)

## Publishing model

Two helper paths in `lib/ndk.js` cover every publish:

- **`publishToOwnOutbox(event)`** — replaceables (kinds 0, 3, 10003/30001/30003, 30023, 30402, 31922-31925, etc). Sends only to the user's NIP-65 write relays so future edits and deletes reach every copy. Used for everything where "stale copies elsewhere" would be a footgun.
- **`publishToPool(event)`** — reach events (kinds 1, 6/16, 7, 1111). Builds an explicit relay set from `(write relays ∪ FALLBACK_RELAYS)` and waits for ACKs from each, so slow relays whose WS handshake hadn't completed don't get silently skipped.

**Never** call `event.publish()` with no relay set — that path was the source of "the note didn't reach all my relays" complaints. Both helpers are documented in `feedback_publish_conventions.md`.

Every user-authored event gets a `['client', 'mynostr']` tag for cross-client attribution.

## SEO + sharing

Cloudflare Pages Function (`functions/_middleware.js`) intercepts requests for shareable entity URLs and injects per-entity OG / Twitter / JSON-LD before serving the SPA's `index.html`:

- Articles, profiles, notes, events, calendars, marketplace listings — each gets its own meta-tag template
- Image URLs are proxied through `wsrv.nl` (free image transformer) so a 5MB profile pic lands as a ~200KB JPG and unfurls without breaking WhatsApp's 600KB cap
- WebSocket race across `relay.primal.net`, `relay.damus.io`, `nos.lol`, `purplepag.es` for entity fetches; cached in CF Cache API for 1h
- Homepage carries `WebSite` + `Organization` + `SoftwareApplication` + `FAQPage` JSON-LD so search engines can render rich result cards

## Stack

- **Frontend:** React 18, Vite, Tailwind CSS, React Router
- **Nostr:** NDK (Nostr Dev Kit), nostr-tools (with `BunkerSigner` wrapped for NDK)
- **Data:** Primal cache API (WebSocket), direct relay connections, Cloudflare Cache API
- **Storage:** Blossom (blossom.primal.net) for image uploads, localStorage for drafts/scheduled-mirror/preferences (per-pubkey scoped)
- **Hosting:** Cloudflare Pages (static + middleware functions) + Workers (scheduler, relay-info) + KV (scheduled-note storage)
- **Relay:** `relay.mynostr.app` — strfry on a VPS with a custom write-policy plugin (alpha-tag gate + 10/hr/pubkey rate limit)
- **Lightning:** NWC (NIP-47) + WebLN as peer wallets for zap / boost / V4V flows
- **Other:** Recharts, TanStack Virtual, JSZip, DOMPurify, Marked, MDEditor, qrcode.react, html5-qrcode

## Development

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production build → dist/
```

Pre-deploy: see [`SMOKE_TEST.md`](SMOKE_TEST.md). Always run section 1 ("critical path"); run the others when their area changed.

## Architecture

- **URL-driven.** `/<npub>/<module>` is canonical. `ownerContext` splits `sessionUser` (logged-in identity with signer) from `viewedUser` (whose page is on screen); `isOwner` gates every write affordance. Bech32 URLs (`/<naddr>`, `/<nevent>`, `/<npub>`) decode and redirect to the canonical app URL.
- **Lazy-loaded modules.** `React.lazy` + Suspense means only the active tab's code is fetched.
- **Responsive baseline.** Desktop top bar (logo, scrollable module tabs, share/avatar) on ≥md; mobile gets a hamburger + active-module label + slide-in drawer.
- **Shared NDK singleton** (`src/lib/ndk.js`) across all modules, with `resetNDK` on logout to release the signer and close relay connections.
- **Primal WebSocket cache** (`src/lib/primal.js`) for profile resolution, user search, article discovery, posting cadence, zap totals — fall back to direct relay fetch only when the cache can't answer.
- **Cross-device-aware replaceable writes** — bookmark/reading-list/calendar deletes publish tombstones so a stale copy on another device's cache doesn't resurrect the entry on merge.
- **Manual refresh path for note comments + zaps** — three-dot menu entry that bypasses Primal's index, queries the user's NIP-65 read relays directly (including read-only relays NDK's pool doesn't connect to), and primes the in-memory caches the UI reads from.
- **Bug reports** — kind 1 with `["t", "mynostr-alpha"]` published to a single dedicated relay (`relay.mynostr.app`); a 10-min systemd-timer cron pulls them and opens GitHub Issues with sanitized content.

## Security

- CSP in `index.html` restricts script/style sources
- `isSafeUrl()` validation on every external URL (no innerHTML, no `javascript:`, no `data:`)
- LRU caches capped at sane limits (no unbounded growth from streaming reads)
- Image uploads size-checked + compressed pre-upload
- nsec entry is in-memory only and cleared on logout
- Per-pubkey scoping for all user-specific localStorage keys (`mynostr_<feature>_<npub>`) so logout-as-A then login-as-B doesn't leak A's draft into B's view

## Bug reports

In-app: floating bug-report button → modal → kind 1 to `relay.mynostr.app`. Reports surface as GitHub Issues automatically (sanitized for secrets, @-mentions, image links).

GitHub: [github.com/ReedBTC/mynostr/issues](https://github.com/ReedBTC/mynostr/issues)

## License

MIT
