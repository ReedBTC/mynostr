// HTML escape, URL validation, and content-shaping helpers for the OG
// meta-tag worker. Every value flowing from a Nostr event into the HTML
// response goes through here — Nostr content can contain `<script>` tags,
// hostile URLs, and malformed UTF-8.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
}

// Allow only http/https for og:image. Nostr profiles in the wild include
// data:, javascript:, file:, even ipfs:// — none belong in a meta tag that
// social unfurlers will fetch.
export function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function truncate(str, max) {
  if (!str) return ''
  const s = String(str).replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

// Strip Nostr-protocol noise from kind 1 content before using it as a
// description. Bech32 references and lightning invoices are useless to a
// human reading an unfurl preview; stripping them lets the actual prose
// surface in the 200-char window.
export function stripNoteContent(content) {
  if (!content) return ''
  return content
    .replace(/nostr:(npub|nprofile|nevent|note|naddr)1[a-z0-9]+/gi, '')
    .replace(/lnbc[a-z0-9]+/gi, '')
    .replace(/lnurl[a-z0-9]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif)(\?[^\s<>"']*)?$/i

// First image URL embedded in a kind-1 note body. Used as og:image when
// available so visual notes get a `summary_large_image` Twitter card.
export function extractFirstImage(content) {
  if (!content) return null
  const matches = content.match(/https?:\/\/[^\s<>"']+/g) || []
  for (const url of matches) {
    if (IMAGE_EXT_RE.test(url)) return url
  }
  return null
}
