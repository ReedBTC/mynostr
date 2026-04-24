// Generates a URL-safe slug from a title string.
// Falls back to a UUID if title is empty.
export function titleToSlug(title) {
  const slug = (title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
  return slug || crypto.randomUUID()
}

// Converts a Date object to a Unix timestamp in seconds
export function toUnixTimestamp(date) {
  return Math.floor(date.getTime() / 1000)
}

// Parses a YYYY-MM-DD date string as local time.
// new Date('2023-03-10') parses as UTC midnight, which shows as the previous
// day in negative-offset timezones (e.g. US/Eastern). Splitting into parts
// and passing to the Date constructor forces local timezone interpretation.
export function parseDateString(dateStr) {
  if (!dateStr) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Truncates an npub for display: "npub1abc...xyz4"
export function truncateNpub(npub) {
  if (!npub || npub.length < 12) return npub
  return `${npub.slice(0, 8)}...${npub.slice(-4)}`
}

// Parses YAML frontmatter from a markdown string.
// Returns { frontmatter, content } where frontmatter is a key/value object
// and content is the body with the frontmatter block removed.
// Returns { frontmatter: null, content: raw } if no frontmatter is found.
export function parseFrontmatter(raw) {
  if (!raw.trimStart().startsWith('---')) return { frontmatter: null, content: raw }
  const start = raw.indexOf('---')
  const end = raw.indexOf('\n---', start + 3)
  if (end === -1) return { frontmatter: null, content: raw }

  const block = raw.slice(start + 4, end)
  const content = raw.slice(end + 4).trimStart()
  const frontmatter = {}

  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    // Handle inline arrays: tags: [writing, nostr]
    if (val.startsWith('[') && val.endsWith(']')) {
      frontmatter[key] = val.slice(1, -1).split(',').map(t => t.trim()).filter(Boolean)
    } else {
      frontmatter[key] = val
    }
  }

  return { frontmatter, content }
}

// Builds a YAML frontmatter block from metadata and source objects
export function buildFrontmatter(metadata, source) {
  const lines = ['---']
  if (metadata.title)         lines.push(`title: ${metadata.title}`)
  if (metadata.summary)       lines.push(`summary: ${metadata.summary}`)
  if (metadata.publishedAtDate) lines.push(`published_at: ${metadata.publishedAtDate}`)
  if (metadata.image)         lines.push(`image: ${metadata.image}`)
  if (metadata.tags?.length)  lines.push(`tags: [${metadata.tags.join(', ')}]`)
  if (source?.name)           lines.push(`source_name: ${source.name}`)
  if (source?.url)            lines.push(`source_url: ${source.url}`)
  lines.push('---')
  return lines.join('\n') + '\n\n'
}

// Checks if a URL uses a safe protocol (http/https only).
// Blocks javascript:, data:, vbscript:, etc.
export function isSafeUrl(url) {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

// Returns the article's published_at tag (unix seconds) when set, else
// falls back to the event's created_at. Feeds should sort and display with
// this so user-authored dates beat relay-publish times.
export function getPublishedAt(ev) {
  const tag = ev?.tags?.find(t => t[0] === 'published_at')?.[1]
  if (tag) {
    const n = parseInt(tag)
    if (!isNaN(n)) return n
  }
  return ev?.created_at || 0
}

// Returns the article's published_at as a YYYY-MM-DD string. Useful when
// pre-filling the metadata date field or building frontmatter on export.
export function getPublishedAtDate(ev) {
  const ts = getPublishedAt(ev)
  if (!ts) return ''
  const d = new Date(ts * 1000)
  if (isNaN(d)) return ''
  return d.toISOString().split('T')[0]
}

// Race a promise against a timeout. Rejects with the given label if the
// inner promise hasn't settled in `ms` milliseconds. Use for relay fetches
// that can otherwise hang indefinitely when no EOSE arrives.
//
// Clears the timer in `finally` so that when the inner promise wins, the
// timer doesn't keep ticking and fire a late rejection that nothing is
// awaiting — that's an "Unhandled promise rejection" browser warning,
// and on strict Node hosts it can terminate the process.
export function withTimeout(promise, ms, label = 'timeout') {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// Copy text to the clipboard. Tries the async Clipboard API first, then
// falls back to document.execCommand('copy') for insecure contexts (iframes,
// http://, older browsers). Returns true on success.
export async function copyToClipboard(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Compact number formatter: 1234 → "1.2k", 12345 → "12k", 1234567 → "1.2M".
// Returns "—" for null/undefined so callers can render without special-casing.
export function formatCount(n) {
  if (n == null) return '—'
  if (n < 1000)        return String(n)
  if (n < 10_000)      return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n < 1_000_000)   return Math.floor(n / 1000) + 'k'
  if (n < 10_000_000)  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  return Math.floor(n / 1_000_000) + 'M'
}

// Compact sats formatter with comma grouping under 10k for readability.
export function formatSats(n) {
  if (n == null) return '—'
  if (n < 10_000)      return n.toLocaleString()
  if (n < 1_000_000)   return Math.floor(n / 1000) + 'k'
  if (n < 10_000_000)  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n < 1_000_000_000) return Math.floor(n / 1_000_000) + 'M'
  return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B'
}

// Bounded LRU keyed by a string. Re-inserts on get/set so oldest entries
// drop first. Avoids unbounded module-level Maps accumulating across every
// profile the user views.
export function createLRU(max = 50) {
  const map = new Map()
  return {
    get(key) {
      const v = map.get(key)
      if (v !== undefined) {
        map.delete(key)
        map.set(key, v)
      }
      return v
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > max) map.delete(map.keys().next().value)
    },
    has(key) { return map.has(key) },
    clear() { map.clear() },
  }
}

// Escapes characters that have special meaning in markdown link syntax
function escapeMarkdownLink(str) {
  return (str || '').replace(/[[\]()]/g, '\\$&')
}

// Builds the "Originally published at" attribution line injected into content.
// Escapes user input to prevent markdown injection via sourceName/sourceUrl.
export function buildAttributionLine(sourceName, sourceUrl, publishedAt) {
  const dateStr = publishedAt
    ? new Date(publishedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : ''
  const safeName = escapeMarkdownLink(sourceName)
  const sourceLink = sourceUrl && isSafeUrl(sourceUrl)
    ? `[${safeName}](${escapeMarkdownLink(sourceUrl)})`
    : safeName
  return `*Originally published at ${sourceLink}${dateStr ? ` on ${dateStr}` : ''}*\n\n`
}
