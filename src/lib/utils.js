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
  if (!url) return true
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
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
