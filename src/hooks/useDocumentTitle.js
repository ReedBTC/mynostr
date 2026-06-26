import { APP_TITLE, APP_NAME } from '../lib/brand.js'
import { useEffect } from 'react'

const DEFAULT_TITLE = APP_TITLE
const SUFFIX = ` — ${APP_NAME}`

/**
 * Sets `document.title` for as long as the calling component is mounted,
 * restoring whatever was set previously when it unmounts. Used by module
 * shells so a tab parked on /<npub>/articles reads "Articles by Alice —
 * MyNostr" instead of the static homepage title baked into index.html.
 *
 * Pass a single string OR an array of parts. The hook joins parts with
 * " · ", trims to a sensible length, and appends " — MyNostr" so every
 * title carries the brand at the end. Pass null/empty to reset to the
 * default (unmount cleanup happens automatically; this is for in-place
 * resets, e.g. closing a detail view).
 *
 * Crawlers do render JS (Google specifically), so per-route titles
 * eventually flow into the index. Worker-rendered titles for share
 * URLs still take precedence for unfurlers — this hook is for human
 * navigation inside the app.
 */
export function useDocumentTitle(parts) {
  useEffect(() => {
    const previous = document.title

    let body = ''
    if (Array.isArray(parts)) {
      body = parts.filter(Boolean).join(' · ').trim()
    } else if (typeof parts === 'string') {
      body = parts.trim()
    }

    document.title = body ? `${truncate(body, 64)}${SUFFIX}` : DEFAULT_TITLE

    return () => {
      // On unmount, hand back the title that was active when we mounted.
      // The next route's hook will overwrite it; this just covers the
      // gap between routes (and the case where a component unmounts
      // without another taking over).
      document.title = previous
    }
  }, [Array.isArray(parts) ? parts.join('|') : (parts || '')])
}

function truncate(str, max) {
  if (!str || str.length <= max) return str
  return str.slice(0, max - 1).trimEnd() + '…'
}
