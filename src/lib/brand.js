// Single source of truth for all branding.
//
// Every brand-name, localStorage namespace, NIP-89 client tag, and canonical
// URL lives here so the rest of the tree stays brand-agnostic. The NostrMD
// fork rebrands by changing ONLY this file (plus the visual assets in
// public/) — which also keeps feature commits free of brand literals so they
// cherry-pick cleanly between MyNostr and the fork. Keep it that way: never
// hard-code "mynostr"/"MyNostr"/"mynostr.app" elsewhere.

// Human-readable product name (UI labels, aria-labels, epub publisher).
export const APP_NAME = 'MyNostr'

// Short pitch used alongside the name.
export const APP_TAGLINE = 'Personal Nostr portal'

// Default <title> / document-title fallback.
export const APP_TITLE = 'MyNostr — Personal Nostr portal: notes, articles, events'

// NIP-89 client tag stamped on every event we publish: ['client', CLIENT_TAG].
export const CLIENT_TAG = 'mynostr'

// localStorage namespace. Build every persisted key with storageKey('<suffix>')
// so the entire namespace moves by editing STORAGE_PREFIX alone. The trailing
// underscore is part of the prefix.
export const STORAGE_PREFIX = 'mynostr_'
export const storageKey = (suffix) => `${STORAGE_PREFIX}${suffix}`

// Canonical web origin, no trailing slash. Used for shareable links, epub
// attribution, and the boostagram page URL.
export const SITE_URL = 'https://mynostr.app'

// Bare host (no scheme) for display in prose/link text.
export const SITE_HOST = 'mynostr.app'

// Wordmark/logo asset in public/. Swap the file + this path to rebrand.
export const LOGO_SRC = '/mynostr.png'
