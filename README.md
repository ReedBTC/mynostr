# MyNostr

A personal Nostr portal for publishing, managing, and analyzing your own content across every Nostr event kind. Unlike feed-first clients, MyNostr treats your data as the product.

**Live at [mynostr.net](https://mynostr.net)**

## What it does

MyNostr is a modular toolkit where each tab handles a different Nostr event kind:

| Module | Kind | Status |
|--------|------|--------|
| **Notes** | Kind 1 (short notes) | Live |
| **Long Form** | Kind 30023 (articles) | Live |
| **Events** | Kind 31923 (calendar events) | Coming soon |
| **Marketplace** | Kind 30402 (listings) | Coming soon |
| **Stats** | Analytics dashboard | Coming soon |

### Notes module
- Compose kind 1 notes with live preview
- @mention autocomplete via Primal search — inserts `nostr:npub1...` references
- Inline image upload to Primal blossom server
- Zap splits editor with even-split defaults and percentage-based allocation
- Import notes from JSON files or by note ID (`note1...` / `nevent1...`)
- Export notes as JSON
- Rich preview: embedded notes, mention resolution, images, video, YouTube embeds, OpenGraph link cards

### Long Form module
- Markdown editor for kind 30023 articles
- Cover image, summary, hashtags, and metadata
- Draft management with local persistence
- Publish to your relay set with automatic tag generation

## Authentication

- **NIP-07 browser extension** (recommended) — Alby, nos2x, Nostore, keys.band
- **nsec direct entry** — kept in memory only, never persisted
- **npub read-only mode** — browse without signing

## Stack

- **Frontend:** React 18, Vite, Tailwind CSS
- **Nostr:** NDK (Nostr Dev Kit), nostr-tools
- **Data:** Primal cache API (WebSocket), direct relay connections
- **Hosting:** Cloudflare Pages
- **Other:** Recharts, TanStack Virtual, JSZip, DOMPurify, Marked

## Development

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production build → dist/
```

## Architecture

- Modules are lazy-loaded via `React.lazy` + Suspense — only the active tab's code is fetched
- NDK singleton (`src/lib/ndk.js`) shared across all modules
- Primal WebSocket cache (`src/lib/primal.js`) for profile resolution, user search, and article discovery
- Blossom protocol (`src/lib/blossom.js`) for image uploads
- Content Security Policy configured in `index.html`

## License

MIT
