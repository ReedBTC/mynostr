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

// Wrap a user-supplied image URL through wsrv.nl's free image proxy to
// normalize size + format. Solves the "user uploaded a 5MB profile pic"
// and "20:9 portrait broke iMessage" problems in one stroke — output is
// always JPG at the specified dimensions, well under any platform's
// og:image size cap.
//
// `cover` crops to fit exactly w×h, which is what every social unfurler
// expects (1200×630 ratio for landscape, 1:1 for square). Quality 85
// keeps file size in the 100–300 KB range on typical avatars/banners.
//
// wsrv.nl is the rebranded images.weserv.nl service — same backend,
// running since 2007, used widely in production. Worst-case outage
// degrades just the user-image previews; mynostr.app stays up because
// the worker serves the meta tags from its own cache regardless.
export function proxyImage(url, w = 1200, h = 630) {
  if (!isSafeImageUrl(url)) return ''
  const params = new URLSearchParams({
    url,
    w: String(w),
    h: String(h),
    fit: 'cover',
    output: 'jpg',
    q: '85',
  })
  return `https://wsrv.nl/?${params.toString()}`
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
