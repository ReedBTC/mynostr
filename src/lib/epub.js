import JSZip from 'jszip'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { nip19 } from 'nostr-tools'
import { titleToSlug, isSafeUrl, parseDateString } from './utils.js'

// ─── Source-link / recipe helpers ───────────────────────────────────────────
// Used by the credits page in chapterized exports to render per-article
// links back to a Nostr reader. Recipe articles route to zap.cooking;
// everything else routes to Primal. Detection mirrors DiscoverView's
// `isRecipeArticle` predicate (zap.cooking writes `t=zapcooking`,
// nostr.cooking writes `t=nostrcooking`, and bare `recipe`/`recipes` is
// a friendly catch-all). Kept in sync deliberately — if we ever broaden
// the predicate, broaden it in both places.

const RECIPE_EXACT_TAGS = new Set(['recipe', 'recipes'])

// Articles passed to chapterized exports carry their t-tags via
// `metadata.tags` (just the values, not the full ['t', x] tuples). Both
// shapes accepted here for resilience.
function isRecipeChapter(chapter) {
  const tagValues = chapter?.metadata?.tags
  if (!Array.isArray(tagValues)) return false
  for (const v of tagValues) {
    const norm = String(v || '').toLowerCase()
    if (norm.startsWith('zapcooking') || norm.startsWith('nostrcooking')) return true
    if (RECIPE_EXACT_TAGS.has(norm)) return true
  }
  return false
}

// Build the `naddr` + reader URL for a chapter. Returns null if we can't
// assemble a valid naddr (missing pubkey or d-tag). Caller should treat
// nulls as "skip the source-link line for this chapter."
function buildChapterSourceLinks(chapter) {
  const { pubkey, dTag } = chapter || {}
  if (!pubkey || !dTag) return null
  let naddr
  try {
    naddr = nip19.naddrEncode({ kind: 30023, pubkey, identifier: dTag })
  } catch {
    return null
  }
  const isRecipe = isRecipeChapter(chapter)
  const viewUrl = isRecipe
    ? `https://zap.cooking/recipe/${naddr}`
    : `https://primal.net/a/${naddr}`
  return { naddr, viewUrl, isRecipe }
}

function safeAuthorNpub(pubkey) {
  if (!pubkey) return ''
  try { return nip19.npubEncode(pubkey) } catch { return '' }
}

// Convert markdown to sanitized XHTML-compatible HTML for epub content.
// DOMPurify handles all XSS vectors (script injection, event handlers,
// dangerous elements) far more reliably than regex stripping.
function mdToXhtml(markdown) {
  const html = marked.parse(markdown || '')
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button'],
    FORBID_ATTR: ['style'],
  })
  // Fix self-closing void elements for XHTML compliance
  return clean
    .replace(/<br>/gi, '<br/>')
    .replace(/<hr>/gi, '<hr/>')
    .replace(/<img([^>]*?)(?<!\/)>/gi, '<img$1/>')
    .replace(/<input([^>]*?)(?<!\/)>/gi, '<input$1/>')
}

// Minimal XML character escaping for metadata fields
function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Word-wrap text onto canvas, returns the y position after the last line
function canvasWrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ')
  let line = ''
  let currentY = y
  for (const word of words) {
    const test = line ? line + ' ' + word : word
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, currentY)
      line = word
      currentY += lineHeight
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, x, currentY)
  return currentY
}

// Measure how many lines the word-wrapped text will occupy
function countLines(ctx, text, maxWidth) {
  const words = text.split(' ')
  let line = ''
  let count = 1
  for (const word of words) {
    const test = line ? line + ' ' + word : word
    if (ctx.measureText(test).width > maxWidth && line) {
      count++
      line = word
    } else {
      line = test
    }
  }
  return count
}

// Generate a cover image (800×1200) as a JPEG Blob.
// Uses the supplied cover as background if available, then overlays
// title + byline text. Falls back to gradient when no cover supplied.
//
// `options.requireImage` controls failure handling for the URL path:
//   • false (default) — used by single-article exports where the
//     article's hero image is incidental. Silent fallback to gradient
//     on fetch error so the export still produces a valid book.
//   • true — used by chapterized exports where the user explicitly
//     supplied a cover. Throws on fetch failure so the caller can
//     show an actionable error instead of silently substituting a
//     gradient — the most common cause is the URL's host blocking
//     cross-origin reads (CORS), which the user can fix by uploading
//     the file locally or using a Blossom server that sends ACAO.
async function generateCoverBlob(title, author, coverUrl, { requireImage = false } = {}) {
  const W = 800, H = 1200
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // ── Background ────────────────────────────────────────────────────────────
  // Fetch the cover image as a blob and create a blob:// URL.
  // This sidesteps the browser CORS cache-poisoning problem: the preview pane
  // loads the same URL via a plain <img> (no crossOrigin), which caches the
  // response without CORS headers. A subsequent canvas drawImage with
  // crossOrigin='anonymous' against that cached response taints the canvas and
  // causes toBlob() to fail silently. A blob:// URL is always same-origin, so
  // the canvas accepts it without any CORS check.
  //
  // Two callers feed `coverUrl`:
  //   • Single-article export: an http(s) URL pulled from the article
  //     event's `image` tag — must go through `isSafeUrl` to block
  //     `javascript:` / `data:` etc.
  //   • Chapterized export with a user-uploaded local file: a `blob:`
  //     URL minted from a File via `URL.createObjectURL`. Trusted by
  //     construction (we made it ourselves) and not http(s), so
  //     `isSafeUrl` would otherwise reject it and silently fall through
  //     to the gradient — that was a real bug in v1.
  let usedPhoto = false
  let mintedBlobUrl = null
  let imageError = null
  const isBlob = !!(coverUrl && coverUrl.startsWith('blob:'))
  const isHttp = !!(coverUrl && isSafeUrl(coverUrl))
  if (isBlob || isHttp) {
    try {
      let imgSrc
      if (isBlob) {
        // Local-file path: the URL was minted by us from a File via
        // URL.createObjectURL — same-origin, never tainted, no need
        // for the fetch+re-blob dance. Load straight into <Image>.
        imgSrc = coverUrl
      } else {
        // Cross-origin path: server may or may not send Access-Control-
        // Allow-Origin. If it doesn't, the fetch throws TypeError. We
        // can't render the image to a clean canvas without CORS, so
        // we surface the failure instead of silently substituting
        // gradient (which made Reed's "URL pasted, no image rendered"
        // bug look like a generic gradient fallback).
        const res = await Promise.race([
          fetch(coverUrl),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ])
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        mintedBlobUrl = URL.createObjectURL(blob)
        imgSrc = mintedBlobUrl
      }

      const img = await new Promise((resolveImg, rejectImg) => {
        const i = new Image()
        i.onload  = () => resolveImg(i)
        i.onerror = () => rejectImg(new Error('Image failed to decode'))
        i.src = imgSrc
      })

      // Cover-fill: scale to fill canvas, crop to centre.
      const scale = Math.max(W / img.width, H / img.height)
      const sw = img.width * scale
      const sh = img.height * scale
      ctx.drawImage(img, (W - sw) / 2, (H - sh) / 2, sw, sh)
      usedPhoto = true
    } catch (err) {
      imageError = err
    } finally {
      if (mintedBlobUrl) URL.revokeObjectURL(mintedBlobUrl)
    }
  }

  // If the user explicitly supplied an image and it didn't render,
  // raise rather than silently substituting gradient. The most common
  // cause for HTTP URLs is a CORS-blocked host; surface that as the
  // hint so the user knows what to do.
  if (!usedPhoto && requireImage && coverUrl) {
    const isCorsLikely = isHttp && imageError instanceof TypeError
    const hint = isCorsLikely
      ? "The image host blocked the cross-origin request. Upload the file directly, or paste a URL from a Blossom server that allows CORS."
      : (imageError?.message || 'unknown error')
    throw new Error(`Couldn't load cover image — ${hint}`)
  }

  if (!usedPhoto) {
    // Dark gradient fallback
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, '#1a1a2e')
    grad.addColorStop(1, '#0d0d1a')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)
  }

  // ── Text overlay ──────────────────────────────────────────────────────────
  // Semi-transparent band across the bottom third for legibility
  const bandH = H * 0.42
  const bandY = H - bandH
  const grad2 = ctx.createLinearGradient(0, bandY, 0, H)
  grad2.addColorStop(0, 'rgba(0,0,0,0)')
  grad2.addColorStop(0.3, 'rgba(0,0,0,0.75)')
  grad2.addColorStop(1, 'rgba(0,0,0,0.92)')
  ctx.fillStyle = grad2
  ctx.fillRect(0, bandY, W, bandH)

  // Layout: title and byline are pinned to separate vertical anchors
  // rather than centred together as one block. Title's last line sits
  // around 80% down; the byline (subtitle / author) is pushed further
  // down to ~93% so it reads as a footer line at the bottom of the
  // cover. Previously they were stacked as one centred block which
  // pinned the subtitle right under the title — too crowded, and made
  // the cover feel top-heavy.
  const padding = 56
  const maxTextW = W - padding * 2
  const titleSize = 58
  const bylineSize = 34
  const titleLineH = titleSize * 1.25
  const bylineLineH = bylineSize * 1.4
  const titleBottomY  = H * 0.80
  const bylineBottomY = H * 0.93

  ctx.font = `bold ${titleSize}px Georgia, serif`
  const titleLines = countLines(ctx, title || 'Untitled', maxTextW)
  const titleStartY = titleBottomY - (titleLines - 1) * titleLineH

  ctx.font = `${bylineSize}px Georgia, serif`
  const bylineLines = author ? countLines(ctx, author, maxTextW) : 0
  const bylineStartY = bylineBottomY - (bylineLines - 1) * bylineLineH

  // Title
  ctx.font = `bold ${titleSize}px Georgia, serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 8
  canvasWrapText(ctx, title || 'Untitled', W / 2, titleStartY, maxTextW, titleLineH)

  // Byline (subtitle on chapterized exports, author on single-article)
  if (author) {
    ctx.font = `${bylineSize}px Georgia, serif`
    ctx.fillStyle = 'rgba(255,255,255,0.78)'
    canvasWrapText(ctx, author, W / 2, bylineStartY, maxTextW, bylineLineH)
  }

  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92))
}

function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
}

function contentOpf({ bookId, title, author, description, subjects, lang, date, modified, hasCover, naddr }) {
  const creatorTag = author ? `\n    <dc:creator>${esc(author)}</dc:creator>` : ''
  const descTag = description ? `\n    <dc:description>${esc(description)}</dc:description>` : ''
  const subjectTags = subjects.map(s => `\n    <dc:subject>${esc(s)}</dc:subject>`).join('')
  const publisherTag = '\n    <dc:publisher>MyNostr</dc:publisher>'
  const createdTag = date ? `\n    <meta property="dcterms:created">${esc(date)}</meta>` : ''
  const sourceTag = naddr ? `\n    <dc:source>https://njump.me/${esc(naddr)}</dc:source>` : ''
  const coverMeta = hasCover ? '\n    <meta name="cover" content="cover-image"/>' : ''
  const coverManifest = hasCover
    ? '\n    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>'
    : ''
  const coverSpine = hasCover ? '\n    <itemref idref="cover-page" linear="no"/>' : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>${creatorTag}${descTag}${subjectTags}${publisherTag}${sourceTag}
    <dc:language>${esc(lang)}</dc:language>
    <dc:date>${esc(date)}</dc:date>${createdTag}
    <meta property="dcterms:modified">${esc(modified)}</meta>${coverMeta}
  </metadata>
  <manifest>
    <item id="nav"     href="nav.xhtml"     media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx"     href="toc.ncx"       media-type="application/x-dtbncx+xml"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    <item id="style"   href="style.css"     media-type="text/css"/>${coverManifest}
  </manifest>
  <spine toc="ncx">${coverSpine}
    <itemref idref="content"/>
  </spine>
</package>`
}

function coverXhtml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Cover</title>
  <style>body { margin: 0; padding: 0; } img { width: 100%; height: 100%; }</style>
</head>
<body>
  <img src="cover.jpg" alt="Cover"/>
</body>
</html>`
}

function tocNcx({ bookId, title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${esc(title)}</text></navLabel>
      <content src="content.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
}

function navXhtml({ title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol><li><a href="content.xhtml">${esc(title)}</a></li></ol>
  </nav>
</body>
</html>`
}

// Minimal epub stylesheet — readable on most ereaders
function styleCss() {
  return `body {
  font-family: Georgia, serif;
  font-size: 1em;
  line-height: 1.6;
  margin: 1em 1.5em;
  color: #1a1a1a;
}
h1 { font-size: 1.8em; line-height: 1.2; margin-bottom: 0.3em; }
h2 { font-size: 1.4em; margin-top: 1.5em; }
h3 { font-size: 1.2em; margin-top: 1.2em; }
p  { margin: 0.8em 0; }
blockquote {
  border-left: 3px solid #ccc;
  margin: 1em 0;
  padding-left: 1em;
  color: #555;
  font-style: italic;
}
code {
  font-family: monospace;
  font-size: 0.9em;
  background: #f4f4f4;
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
pre {
  background: #f4f4f4;
  padding: 1em;
  overflow-x: auto;
  border-radius: 4px;
}
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; }
a { color: #333; }
hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
.subtitle  { font-size: 1.1em; color: #555; margin-top: 0.2em; font-style: italic; }
.meta      { font-size: 0.85em; color: #777; margin: 0.5em 0 1.5em; }
.source    { font-size: 0.9em; color: #555; font-style: italic; margin-bottom: 1.5em; }

/* Credits page — front matter between cover and TOC */
.credits-page .credits-title { margin-bottom: 0.4em; }
.credits-page .credits-curator { font-size: 1.05em; margin: 0.3em 0; }
.credits-page .credits-date { color: #666; margin: 0.2em 0 1.2em; }
.credits-page .credits-subtitle { color: #555; margin-bottom: 1.5em; }
.credits-page .credits-npub {
  font-family: monospace;
  font-size: 0.78em;
  color: #777;
  word-break: break-all;
}
.credits-articles { padding-left: 1.5em; }
.credits-article { margin-bottom: 1.4em; padding-bottom: 0.6em; border-bottom: 1px solid #eee; }
.credits-article-title { font-weight: bold; margin-bottom: 0.2em; }
.credits-article-author { font-size: 0.92em; color: #555; margin: 0.1em 0; }
.credits-article-link { font-size: 0.9em; margin: 0.3em 0 0.1em; }
.credits-article-naddr {
  font-family: monospace;
  font-size: 0.7em;
  color: #888;
  word-break: break-all;
  margin-top: 0.1em;
}
.credits-identifiers { font-size: 0.92em; color: #555; }`
}

function contentXhtml({ title, metadata, source, bodyHtml }) {
  const dateStr = metadata.publishedAtDate
    ? parseDateString(metadata.publishedAtDate).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : ''

  const subtitle = metadata.summary
    ? `<p class="subtitle">${esc(metadata.summary)}</p>`
    : ''

  const dateLine = dateStr
    ? `<p class="meta">${esc(dateStr)}</p>`
    : ''

  let sourceLine = ''
  if (source?.name) {
    const nameEsc = esc(source.name)
    const urlEsc = source.url && isSafeUrl(source.url) ? esc(source.url) : ''
    sourceLine = urlEsc
      ? `<p class="source">Originally published at <a href="${urlEsc}">${nameEsc}</a>${dateStr ? ` on ${esc(dateStr)}` : ''}</p>`
      : `<p class="source">Originally published at ${nameEsc}${dateStr ? ` on ${esc(dateStr)}` : ''}</p>`
  }

  const divider = (title || metadata.summary || source?.name) ? '<hr/>' : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${esc(title)}</title>
  <meta charset="UTF-8"/>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${subtitle}
  ${dateLine}
  ${sourceLine}
  ${divider}
  ${bodyHtml}
</body>
</html>`
}

// Simple UUID v4 — crypto.randomUUID() requires HTTPS; Math.random() is fine for epub book IDs
function uuid4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

// ─── Chapterized epub helpers ─────────────────────────────────────────────────

function chapterizedOpf({ bookId, title, subtitle, author, lang, date, modified, hasCover, hasCredits, includeToc, chapters }) {
  const chapterManifest = chapters.map((_, i) =>
    `\n    <item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('')
  const chapterSpine = chapters.map((_, i) =>
    `\n    <itemref idref="ch${i + 1}"/>`
  ).join('')
  const coverMeta      = hasCover ? '\n    <meta name="cover" content="cover-image"/>' : ''
  const coverManifest  = hasCover
    ? '\n    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>'
    : ''
  const coverSpine = hasCover ? '\n    <itemref idref="cover-page" linear="no"/>' : ''
  const creditsManifest = hasCredits
    ? '\n    <item id="credits" href="credits.xhtml" media-type="application/xhtml+xml"/>'
    : ''
  const creditsSpine = hasCredits ? '\n    <itemref idref="credits"/>' : ''
  // The nav file is itself a manifest entry; without it, EPUB 3 readers
  // still validate but lose the in-spine navigable TOC. Skipping when
  // includeToc=false matches the user's explicit toggle. EPUB 2 NCX
  // remains in the manifest in either case so reader compatibility
  // stays intact even without the EPUB 3 nav.
  const navManifest = includeToc
    ? '\n    <item id="nav"   href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    : ''
  // Author metadata only emitted when supplied — a stale empty
  // <dc:creator/> in the OPF makes some readers display "by " with
  // nothing after it.
  const creatorMeta = author
    ? `\n    <dc:creator>${esc(author)}</dc:creator>`
    : ''
  const subtitleMeta = subtitle
    ? `\n    <dc:description>${esc(subtitle)}</dc:description>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>${creatorMeta}${subtitleMeta}
    <dc:publisher>MyNostr</dc:publisher>
    <dc:language>${esc(lang)}</dc:language>
    <dc:date>${esc(date)}</dc:date>
    <meta property="dcterms:modified">${esc(modified)}</meta>${coverMeta}
  </metadata>
  <manifest>${navManifest}
    <item id="ncx"   href="toc.ncx"   media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css"  media-type="text/css"/>${coverManifest}${creditsManifest}${chapterManifest}
  </manifest>
  <spine toc="ncx">${coverSpine}${creditsSpine}${chapterSpine}
  </spine>
</package>`
}

function chapterizedNcx({ bookId, title, chapters }) {
  const navPoints = chapters.map((ch, i) => `
    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${esc(ch.title || `Chapter ${i + 1}`)}</text></navLabel>
      <content src="ch${i + 1}.xhtml"/>
    </navPoint>`).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>${navPoints}
  </navMap>
</ncx>`
}

// Credits / front-matter page for chapterized exports. Sits between the
// cover and the TOC in the spine. Carries:
//   • Curator attribution (name + npub link to mynostr profile + date)
//   • Per-article entries: title, author npub link, naddr, view link
//     (Primal for longform / zap.cooking for recipes — link policy
//     centralized in buildChapterSourceLinks)
//   • Boilerplate "About" block — one paragraph nostr explainer + a
//     soft pitch for mynostr.app. Same copy on every export.
function buildCreditsXhtml({ title, subtitle, author, curatedBy, curatedDate, chapters }) {
  const headerLines = []
  if (curatedBy?.name) {
    const nameSafe = esc(curatedBy.name)
    if (curatedBy.npub) {
      const npubLink = `https://mynostr.app/${encodeURIComponent(curatedBy.npub)}/profile`
      headerLines.push(
        `<p class="credits-curator">Curated by <a href="${esc(npubLink)}">${nameSafe}</a><br/>` +
        `<span class="credits-npub">${esc(curatedBy.npub)}</span></p>`
      )
    } else {
      headerLines.push(`<p class="credits-curator">Curated by ${nameSafe}</p>`)
    }
  } else if (author) {
    headerLines.push(`<p class="credits-curator">Curated by ${esc(author)}</p>`)
  }
  if (curatedDate) {
    headerLines.push(`<p class="credits-date">${esc(curatedDate)}</p>`)
  }
  if (subtitle) {
    headerLines.push(`<p class="credits-subtitle"><em>${esc(subtitle)}</em></p>`)
  }

  // Per-chapter rows. Each row includes original author npub link, the
  // full naddr (printed verbatim so a reader can paste it anywhere),
  // and a one-click view link via Primal/zap.cooking. If we can't build
  // a naddr (missing pubkey/dTag), the row gracefully degrades to just
  // the title — no broken-looking placeholder URLs.
  const articleRows = chapters.map((ch, i) => {
    const sources = buildChapterSourceLinks(ch)
    const titleEsc = esc(ch.title || `Chapter ${i + 1}`)
    let authorBlock = ''
    if (ch.pubkey) {
      const npub = safeAuthorNpub(ch.pubkey)
      if (npub) {
        const profileUrl = `https://mynostr.app/${encodeURIComponent(npub)}/profile`
        const nameLine = ch.author
          ? `<a href="${esc(profileUrl)}">${esc(ch.author)}</a>`
          : `<a href="${esc(profileUrl)}">${esc(npub)}</a>`
        authorBlock = `<div class="credits-article-author">by ${nameLine}` +
          (ch.author ? `<br/><span class="credits-npub">${esc(npub)}</span>` : '') +
          `</div>`
      } else if (ch.author) {
        authorBlock = `<div class="credits-article-author">by ${esc(ch.author)}</div>`
      }
    } else if (ch.author) {
      authorBlock = `<div class="credits-article-author">by ${esc(ch.author)}</div>`
    }

    let linkBlock = ''
    if (sources) {
      const viewLabel = sources.isRecipe ? 'View on zap.cooking' : 'View on Primal'
      linkBlock = `
      <div class="credits-article-link">
        <a href="${esc(sources.viewUrl)}">${viewLabel}</a>
      </div>
      <div class="credits-article-naddr">${esc(sources.naddr)}</div>`
    }

    return `
    <li class="credits-article">
      <div class="credits-article-title">${titleEsc}</div>
      ${authorBlock}${linkBlock}
    </li>`
  }).join('')

  // Boilerplate. Same copy every export — easy to iterate later if
  // wording needs tightening.
  const boilerplate = `
    <h2>About this collection</h2>
    <p>This collection was published by <a href="https://mynostr.app">mynostr.app</a> for free. Consider publishing your own articles or curations on mynostr.app; donate or zap bitcoin to your favorite authors on any nostr app.</p>
    <p>Nostr (notes and other stuff transmitted by relays) is a decentralized free and open protocol to host and discover information like notes, articles, recipes, events or marketplace items over the internet — publish your own work on any nostr app for free with no ads, no email, no ID, no paywalls.</p>
    <p class="credits-identifiers">
      <strong>About the identifiers above:</strong><br/>
      <code>npub</code> — public identifier for a Nostr user.<br/>
      <code>naddr</code> — permanent address for a piece of long-form content.<br/>
      Open any of them in a Nostr client like <a href="https://primal.net">Primal</a>, or paste them into <a href="https://njump.me">njump.me</a> for a universal viewer.
    </p>`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>About — ${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body class="credits-page">
  <h1 class="credits-title">${esc(title)}</h1>
  ${headerLines.join('\n  ')}

  <h2>Articles in this collection</h2>
  <ol class="credits-articles">${articleRows}
  </ol>

  ${boilerplate}
</body>
</html>`
}

function chapterizedNav({ title, chapters }) {
  const items = chapters.map((ch, i) =>
    `\n      <li><a href="ch${i + 1}.xhtml">${esc(ch.title || `Chapter ${i + 1}`)}</a></li>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>${items}
    </ol>
  </nav>
</body>
</html>`
}

/**
 * Export multiple articles as a single chapterized .epub file.
 *
 * `options` is the modern shape (curated metadata, cover, toggles).
 * Passing a string in its place is supported as a back-compat shim:
 * legacy callers `exportChapterizedEpub(articles, 'My Articles')`
 * still work and just get default behavior on everything else.
 *
 * Per-chapter input shape (from callers):
 *   {
 *     content, author, metadata,
 *     pubkey, dTag,    // optional — needed for credits-page source links
 *   }
 *
 * @param {Array} articles  chapter objects (see above)
 * @param {object|string} [options]
 *   {
 *     title:           string,         // default 'Reading List'
 *     subtitle:        string,         // optional, shown on cover + credits
 *     author:          string,         // EPUB <dc:creator>
 *     coverSource:     { url } | { blob } | null,
 *     includeToc:      boolean = true,
 *     includeCredits:  boolean = true,
 *     curatedBy:       { name, npub } | null,
 *     curatedDate:     ISO-date string | null,
 *   }
 */
export async function exportChapterizedEpub(articles, options = {}) {
  // Back-compat: legacy callers passed a plain string.
  if (typeof options === 'string') options = { title: options }

  const {
    title          = 'Reading List',
    subtitle       = '',
    author         = '',
    coverSource    = null,
    includeToc     = true,
    includeCredits = true,
    curatedBy      = null,
    curatedDate    = null,
  } = options

  const zip      = new JSZip()
  const bookId   = uuid4()
  const lang     = 'en'
  const date     = new Date().toISOString().split('T')[0]
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const slug     = titleToSlug(title) || 'mynostr-collection'

  const chapters = articles.map(a => ({
    title:    a.metadata?.title || 'Untitled',
    author:   a.author || '',
    content:  a.content || '',
    metadata: a.metadata || {},
    pubkey:   a.pubkey || '',
    dTag:     a.dTag || '',
  }))

  // Cover image — caller may supply a Blob (local upload), a URL
  // (Blossom or any public image), or nothing (gradient fallback).
  // generateCoverBlob already accepts a URL parameter; we feed Blobs
  // through the same path by minting a blob: URL.
  let coverImageUrl = null
  let blobUrlToRevoke = null
  if (coverSource?.blob) {
    blobUrlToRevoke = URL.createObjectURL(coverSource.blob)
    coverImageUrl = blobUrlToRevoke
  } else if (coverSource?.url && isSafeUrl(coverSource.url)) {
    coverImageUrl = coverSource.url
  }
  const coverByline = subtitle
    || `${chapters.length} article${chapters.length !== 1 ? 's' : ''}`
  // requireImage=true when user explicitly supplied a cover so a CORS-
  // or network-failure surfaces as an error in the UI rather than a
  // silent gradient substitution. When no cover supplied, we'd want
  // gradient anyway so the falsy coverImageUrl skips both branches.
  const coverBlob = await generateCoverBlob(
    title,
    coverByline,
    coverImageUrl,
    { requireImage: !!coverImageUrl },
  )
  if (blobUrlToRevoke) URL.revokeObjectURL(blobUrlToRevoke)
  const hasCover = !!coverBlob

  // Credits page — sits between cover and TOC. Houses the curator
  // attribution, per-article source links + author npubs, and the
  // MyNostr / Nostr explainer block. Skippable via options.
  const creditsHtml = includeCredits
    ? buildCreditsXhtml({ title, subtitle, author, curatedBy, curatedDate, chapters })
    : null
  const hasCredits = !!creditsHtml

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', containerXml())
  zip.file('OEBPS/content.opf', chapterizedOpf({
    bookId, title, subtitle, author, lang, date, modified,
    hasCover, hasCredits, includeToc, chapters,
  }))
  zip.file('OEBPS/toc.ncx',    chapterizedNcx({ bookId, title, chapters }))
  zip.file('OEBPS/style.css',  styleCss())

  if (includeToc) {
    zip.file('OEBPS/nav.xhtml',  chapterizedNav({ title, chapters }))
  }

  if (hasCover) {
    zip.file('OEBPS/cover.jpg',   coverBlob)
    zip.file('OEBPS/cover.xhtml', coverXhtml())
  }
  if (hasCredits) {
    zip.file('OEBPS/credits.xhtml', creditsHtml)
  }

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    zip.file(`OEBPS/ch${i + 1}.xhtml`, contentXhtml({
      title:    ch.title,
      metadata: ch.metadata,
      source:   null,
      bodyHtml: mdToXhtml(ch.content),
    }))
  }

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = slug + '.epub'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Export multiple articles as a single chapterized Markdown file.
 *
 * Same `options` shape as `exportChapterizedEpub`, with the same
 * back-compat shim: passing a string is treated as the title.
 *
 * Markdown output structure when full options provided:
 *
 *   # {Title}
 *   *{Subtitle}*
 *
 *   *Curated by [Name](mynostr-url) — `npub1...` — {date}*
 *
 *   ## Articles in this collection                ← credits section
 *   1. **{Article 1 title}**
 *      by [Original Author](mynostr-url) — `npub1...`
 *      [View on Primal](primal-url)
 *      `naddr1...`
 *   ...
 *
 *   ## About this collection                       ← boilerplate
 *   ...
 *
 *   ---
 *
 *   ## Contents                                    ← hyperlinked TOC
 *   - [Article 1](#article-1-slug)
 *   - [Article 2](#article-2-slug)
 *
 *   ---
 *
 *   <a id="article-1-slug"></a>                    ← explicit anchor
 *   # {Article 1 title}
 *   {content}
 *   ...
 *
 * Explicit anchors via `<a id="...">` complement GitHub-style auto-
 * slugified header anchors. Most renderers honor at least one; both
 * present means the export works in GitHub, GitLab, Obsidian, and
 * Pandoc without any "header doesn't link" surprises.
 */
export function exportChapterizedMd(articles, options = {}) {
  if (typeof options === 'string') options = { title: options }
  const {
    title          = 'Reading List',
    subtitle       = '',
    author         = '',
    includeToc     = true,
    includeCredits = true,
    curatedBy      = null,
    curatedDate    = null,
  } = options

  const count = articles.length
  const chapters = articles.map(a => ({
    title:    a.metadata?.title || 'Untitled',
    author:   a.author || '',
    content:  a.content || '',
    metadata: a.metadata || {},
    pubkey:   a.pubkey || '',
    dTag:     a.dTag || '',
  }))

  // Pre-compute per-chapter anchor slugs so the TOC and the inline
  // anchor IDs stay in lockstep. Disambiguate dupes by appending an
  // index — two chapters titled "Untitled" would otherwise share an
  // anchor and the TOC link would always jump to the first.
  const anchors = []
  const seenAnchors = new Set()
  for (let i = 0; i < chapters.length; i++) {
    let base = titleToSlug(chapters[i].title) || `chapter-${i + 1}`
    let candidate = base
    let n = 2
    while (seenAnchors.has(candidate)) {
      candidate = `${base}-${n}`
      n++
    }
    seenAnchors.add(candidate)
    anchors.push(candidate)
  }

  const sections = []

  // Header — title + optional subtitle + curator line.
  let header = `# ${title}\n`
  if (subtitle) header += `\n*${subtitle}*\n`

  const curatorParts = []
  if (curatedBy?.name) {
    if (curatedBy.npub) {
      const profileUrl = `https://mynostr.app/${encodeURIComponent(curatedBy.npub)}/profile`
      curatorParts.push(`Curated by [${curatedBy.name}](${profileUrl})`)
      curatorParts.push(`\`${curatedBy.npub}\``)
    } else {
      curatorParts.push(`Curated by ${curatedBy.name}`)
    }
  } else if (author) {
    curatorParts.push(`Curated by ${author}`)
  }
  if (curatedDate) curatorParts.push(curatedDate)
  if (curatorParts.length) {
    header += `\n*${curatorParts.join(' — ')}*\n`
  } else {
    header += `\n*${count} article${count !== 1 ? 's' : ''} — exported from MyNostr*\n`
  }
  sections.push(header)

  // Credits section — articles list with author + naddr + view link,
  // followed by the standard about-MyNostr boilerplate.
  if (includeCredits) {
    const articleLines = chapters.map((ch, i) => {
      const titleLine = `${i + 1}. **${ch.title}**`
      const lines = [titleLine]
      if (ch.pubkey) {
        const npub = safeAuthorNpub(ch.pubkey)
        if (npub) {
          const profileUrl = `https://mynostr.app/${encodeURIComponent(npub)}/profile`
          if (ch.author) {
            lines.push(`   by [${ch.author}](${profileUrl}) — \`${npub}\``)
          } else {
            lines.push(`   by [${npub}](${profileUrl})`)
          }
        } else if (ch.author) {
          lines.push(`   by ${ch.author}`)
        }
      } else if (ch.author) {
        lines.push(`   by ${ch.author}`)
      }
      const sources = buildChapterSourceLinks(ch)
      if (sources) {
        const viewLabel = sources.isRecipe ? 'View on zap.cooking' : 'View on Primal'
        lines.push(`   [${viewLabel}](${sources.viewUrl})`)
        lines.push(`   \`${sources.naddr}\``)
      }
      return lines.join('\n')
    }).join('\n\n')

    sections.push(`## Articles in this collection\n\n${articleLines}`)

    sections.push(
      `## About this collection\n\n` +
      `This collection was published by [mynostr.app](https://mynostr.app) for free. ` +
      `Consider publishing your own articles or curations on mynostr.app; donate or zap bitcoin to your favorite authors on any nostr app.\n\n` +
      `Nostr (notes and other stuff transmitted by relays) is a decentralized free and open protocol to host and discover information like notes, articles, recipes, events or marketplace items over the internet — publish your own work on any nostr app for free with no ads, no email, no ID, no paywalls.\n\n` +
      `**About the identifiers above:**  \n` +
      `\`npub\` — public identifier for a Nostr user.  \n` +
      `\`naddr\` — permanent address for a piece of long-form content.  \n` +
      `Open any of them in a Nostr client like [Primal](https://primal.net), or paste them into [njump.me](https://njump.me) for a universal viewer.`
    )
  }

  // TOC — hyperlinked. Renderers that don't honor the auto-anchor
  // fall back to the explicit `<a id>` tag we emit above each chapter.
  if (includeToc) {
    const tocLines = chapters.map((ch, i) =>
      `- [${ch.title}](#${anchors[i]})`
    ).join('\n')
    sections.push(`## Contents\n\n${tocLines}`)
  }

  // Chapters with explicit anchor IDs.
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const lines = [`<a id="${anchors[i]}"></a>`, '', `# ${ch.title}`]
    const metaParts = []
    if (ch.author) metaParts.push(`*by ${ch.author}*`)
    if (ch.metadata?.publishedAtDate) metaParts.push(`*${ch.metadata.publishedAtDate}*`)
    if (metaParts.length) lines.push('', metaParts.join(' · '))
    lines.push('', ch.content)
    sections.push(lines.join('\n'))
  }

  const text = sections.join('\n\n---\n\n')
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = (titleToSlug(title) || 'mynostr-collection') + '.md'
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Single-article export ────────────────────────────────────────────────────

/**
 * Build a single-article epub and return the Blob without triggering a download.
 * Useful when bundling multiple individual epubs into a ZIP.
 */
export async function buildEpubBlob(content, metadata, source, author = '', naddr = '') {
  const zip = new JSZip()

  const bookId   = uuid4()
  const title    = metadata.title || 'Untitled'
  const lang     = 'en'
  const date     = metadata.publishedAtDate || new Date().toISOString().split('T')[0]
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const bodyHtml = mdToXhtml(content)
  const coverUrl = metadata.image && isSafeUrl(metadata.image) ? metadata.image : null
  const coverBlob = await generateCoverBlob(title, author, coverUrl)
  const hasCover  = !!coverBlob

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', containerXml())
  zip.file('OEBPS/content.opf', contentOpf({
    bookId, title, author,
    description: metadata.summary || '',
    subjects:    metadata.tags    || [],
    lang, date, modified, hasCover, naddr,
  }))
  zip.file('OEBPS/toc.ncx',      tocNcx({ bookId, title }))
  zip.file('OEBPS/nav.xhtml',    navXhtml({ title }))
  zip.file('OEBPS/style.css',    styleCss())
  zip.file('OEBPS/content.xhtml', contentXhtml({ title, metadata, source, bodyHtml }))

  if (hasCover) {
    zip.file('OEBPS/cover.jpg',   coverBlob)
    zip.file('OEBPS/cover.xhtml', coverXhtml())
  }

  return await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })
}

export async function exportEpub(content, metadata, source, author = '', naddr = '') {
  const blob = await buildEpubBlob(content, metadata, source, author, naddr)
  const slug = titleToSlug(metadata.title || 'Untitled') || 'mynostr-export'
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = slug + '.epub'
  a.click()
  URL.revokeObjectURL(url)
}
