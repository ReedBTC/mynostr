import JSZip from 'jszip'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { nip19 } from 'nostr-tools'
import QRCode from 'qrcode'
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
// title + subtitle + author text. Falls back to gradient when no
// cover supplied.
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
async function generateCoverBlob(title, { subtitle = '', author = '', coverUrl = null, requireImage = false } = {}) {
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

  // Layout: title, subtitle, and author are pinned to separate vertical
  // anchors rather than centred together as one block. Anchors slide
  // depending on which lines are present so a title-only cover feels
  // balanced and a title+subtitle+author cover doesn't feel crowded.
  // Previously they were stacked as one centred block which pinned the
  // subtitle right under the title — too crowded, and made the cover
  // feel top-heavy.
  const padding = 56
  const maxTextW = W - padding * 2
  const titleSize = 58
  const subtitleSize = 32
  const authorSize = 30
  const titleLineH = titleSize * 1.25
  const subtitleLineH = subtitleSize * 1.4
  const authorLineH = authorSize * 1.4

  // Anchors for the bottom of each text block. Adjusted by which
  // pieces are present to keep the layout breathing.
  let titleBottomY, subtitleBottomY, authorBottomY
  if (subtitle && author) {
    titleBottomY    = H * 0.74
    subtitleBottomY = H * 0.86
    authorBottomY   = H * 0.94
  } else if (subtitle) {
    titleBottomY    = H * 0.80
    subtitleBottomY = H * 0.93
  } else if (author) {
    titleBottomY    = H * 0.80
    authorBottomY   = H * 0.93
  } else {
    titleBottomY    = H * 0.86
  }

  ctx.font = `bold ${titleSize}px Georgia, serif`
  const titleLines = countLines(ctx, title || 'Untitled', maxTextW)
  const titleStartY = titleBottomY - (titleLines - 1) * titleLineH

  // Title
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 8
  canvasWrapText(ctx, title || 'Untitled', W / 2, titleStartY, maxTextW, titleLineH)

  // Subtitle
  if (subtitle) {
    ctx.font = `italic ${subtitleSize}px Georgia, serif`
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    const subtitleLines = countLines(ctx, subtitle, maxTextW)
    const subtitleStartY = subtitleBottomY - (subtitleLines - 1) * subtitleLineH
    canvasWrapText(ctx, subtitle, W / 2, subtitleStartY, maxTextW, subtitleLineH)
  }

  // Author
  if (author) {
    ctx.font = `${authorSize}px Georgia, serif`
    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    const authorLines = countLines(ctx, author, maxTextW)
    const authorStartY = authorBottomY - (authorLines - 1) * authorLineH
    canvasWrapText(ctx, author, W / 2, authorStartY, maxTextW, authorLineH)
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

function contentOpf({ bookId, title, author, description, subjects, lang, date, modified, hasCover, naddr, inlineManifest = [] }) {
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
  const inlineMan = inlineManifest.map(item =>
    `\n    <item id="${item.id}" href="${item.href}" media-type="${item.mime}"/>`
  ).join('')

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
    <item id="style"   href="style.css"     media-type="text/css"/>${coverManifest}${inlineMan}
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

/* Credits page — front matter between cover and TOC. Dense by design;
   target is ~10+ articles per page, with the publisher / Nostr blurb
   reading as a tiny copyright-page footer at the bottom. */
.credits-page { font-size: 0.78em; line-height: 1.35; }
.credits-page .credits-title { font-size: 1.6em; margin: 0 0 0.25em; line-height: 1.15; }
.credits-page .credits-curator { font-size: 0.92em; margin: 0.15em 0; line-height: 1.3; }
.credits-page .credits-date { color: #666; margin: 0.1em 0 0.7em; font-size: 0.85em; }
.credits-page .credits-subtitle { color: #555; margin: 0.1em 0 0.9em; font-size: 0.95em; }
.credits-page .credits-section { font-size: 1.05em; margin: 1em 0 0.4em; }
.credits-page .credits-npub {
  font-family: monospace;
  font-size: 0.85em;
  color: #777;
  word-break: break-all;
}
.credits-articles { padding-left: 1.4em; margin: 0.3em 0 0.6em; }
.credits-article {
  /* No bottom rule — the line spacing alone separates entries.
     Borders pushed every row a few px taller and crowded out the
     ~10-per-page target. */
  margin: 0 0 0.45em;
  line-height: 1.25;
}
.credits-article-title { font-weight: bold; }
/* Author + npub render at the same size as ordinary credits-page body
   text — Reed wanted the byline to read as plain text rather than the
   muted secondary look it had before. The npub override below resets
   the size so monospace digits don't drift smaller. */
.credits-article-author { font-size: 1em; }
.credits-article-author .credits-npub { font-size: 1em; }
.credits-article-naddr {
  font-family: monospace;
  font-size: 0.78em;
  color: #888;
  word-break: break-all;
}
.credits-article-naddr a { color: #888; text-decoration: none; }
.credits-article-naddr a:hover { color: #555; }

/* Publisher / Nostr-explainer block — tiny, footer-style. Looks like
   the copyright/publication page of a physical book. */
.credits-footer {
  margin-top: 1.5em;
  padding-top: 0.7em;
  border-top: 1px solid #ddd;
  font-size: 0.78em;
  line-height: 1.35;
  color: #666;
}
.credits-footer p { margin: 0.4em 0; }

/* Article title page — appears before each chapter's content. Centred,
   page-break after, with the QR + lightning address tucked in the
   bottom-right. Most modern EPUB readers honour page-break-after; the
   ones that don't will just show the title page atop the content. */
.article-title-page {
  page-break-after: always;
  text-align: center;
  padding: 2em 0;
}
.article-title-page .article-cover {
  display: block;
  max-width: 70%;
  max-height: 50vh;
  margin: 0 auto 1em;
}
.article-title-page .article-title {
  font-size: 1.7em;
  font-weight: bold;
  line-height: 1.2;
  margin: 0.3em 1em;
}
.article-title-page .article-subtitle {
  font-style: italic;
  color: #555;
  margin: 0.4em 1em 1em;
}
.article-title-page .article-meta {
  color: #666;
  font-size: 0.95em;
  margin: 0.5em 0;
  line-height: 1.4;
}
.article-title-page .article-qr {
  margin-top: 2.5em;
  text-align: center;
}
.article-title-page .article-qr img {
  width: 140px;
  height: 140px;
  display: block;
  margin: 0 auto;
}
.article-title-page .article-qr .qr-caption {
  font-size: 0.85em;
  margin: 0.3em 0 0.1em;
  color: #444;
}
.article-title-page .article-qr .qr-lud16 {
  font-family: monospace;
  font-size: 0.75em;
  color: #666;
  word-break: break-all;
}`
}

// ─── Per-chapter title page + QR helpers ───────────────────────────────────

// Convert a Nostr lud16 (e.g. "name@domain.tld") or lud06 (LNURL bech32)
// into the bech32-friendly QR payload most wallets accept. lud16 →
// "lightning:user@domain"; lud06 → already a bech32, keep as-is.
function lud16ToQrPayload(lud16) {
  if (!lud16) return ''
  const trimmed = String(lud16).trim()
  if (!trimmed) return ''
  // LNURL strings start with "lnurl1" — already bech32-encoded, wallets
  // recognise them directly.
  if (/^lnurl1/i.test(trimmed)) return trimmed
  // "user@domain" form — most wallets treat this as a Lightning Address.
  // Prefix with "lightning:" to make the QR scan into a deep link in
  // wallet apps that hook the URI scheme.
  if (/.+@.+\..+/.test(trimmed)) return `lightning:${trimmed}`
  return trimmed
}

// Render a QR for the given payload as a PNG Blob suitable for
// embedding in the EPUB's OEBPS/qr/ folder. Uses the `qrcode` package's
// canvas API and converts to PNG via canvas.toBlob. Resolves null on
// any failure (no payload, render error) so the caller can simply
// omit the QR for that chapter.
async function generateQrPngBlob(payload, size = 280) {
  if (!payload) return null
  try {
    const canvas = document.createElement('canvas')
    await QRCode.toCanvas(canvas, payload, {
      errorCorrectionLevel: 'M',
      width: size,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
    return await new Promise(res => canvas.toBlob(res, 'image/png'))
  } catch {
    return null
  }
}

// Best-effort article cover fetch. Same CORS gotcha as the collection
// cover — non-CORS hosts (e.g., Primal's r2 bucket) will fail. We skip
// the cover for that chapter rather than blocking the whole export,
// since a missing per-article cover is a small cosmetic loss.
async function fetchArticleCoverBlob(imageUrl) {
  if (!imageUrl || !isSafeUrl(imageUrl)) return null
  try {
    const res = await Promise.race([
      fetch(imageUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
    ])
    if (!res.ok) return null
    const blob = await res.blob()
    // Sanity guard — anything not an image MIME we don't trust to
    // embed (could be HTML error page, etc).
    if (blob.type && !blob.type.startsWith('image/')) return null
    return blob
  } catch {
    return null
  }
}

// Build a chapter's title page XHTML. Embedded image / QR refs are
// relative paths the OPF declares as manifest items.
function articleTitlePageXhtml({ title, subtitle, author, dateStr, coverHref, qrHref, lud16 }) {
  const coverImg = coverHref
    ? `<img class="article-cover" src="${esc(coverHref)}" alt=""/>`
    : ''
  const subtitleP = subtitle
    ? `<p class="article-subtitle">${esc(subtitle)}</p>`
    : ''
  const metaParts = []
  if (author)  metaParts.push(`by ${esc(author)}`)
  if (dateStr) metaParts.push(esc(dateStr))
  const metaP = metaParts.length
    ? `<p class="article-meta">${metaParts.join('<br/>')}</p>`
    : ''
  const qrBlock = qrHref
    ? `<div class="article-qr">
      <img src="${esc(qrHref)}" alt="Zap QR code"/>
      <p class="qr-caption">Zap this author</p>
      ${lud16 ? `<p class="qr-lud16">${esc(lud16)}</p>` : ''}
    </div>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body class="article-title-page">
  ${coverImg}
  <h1 class="article-title">${esc(title)}</h1>
  ${subtitleP}
  ${metaP}
  ${qrBlock}
</body>
</html>`
}

// Decode the handful of HTML entities likely to appear in an HTML
// attribute value. Marked + DOMPurify entity-encode `&` to `&amp;` in
// URLs; left undecoded, the literal `&amp;` ends up in the fetch URL
// and the server returns a 404 for the wrong query string.
function decodeHtmlEntitiesForUrl(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

// Embed inline `<img>` images from chapter HTML into the EPUB.
//
// Inline images in article markdown produce `<img src="https://...">`
// tags after `mdToXhtml`. Most EPUB readers won't follow those external
// URLs (offline reading, sandboxed iframes, CORS), so the user sees
// broken-image icons. To make the export self-contained we fetch each
// image, embed it as a manifest item, and rewrite the src to a relative
// path inside the EPUB.
//
// Best-effort: any fetch failure (CORS, 404, timeout) leaves the
// original src untouched — the worst case is the same broken-image
// behaviour the export had before, never a blocked export.
//
// `chapterIdx` is 1-based; pass 0 for single-article exports (the
// folder structure stays consistent either way).
async function embedInlineImages(html, chapterIdx) {
  const empty = { html, manifestItems: [], files: [] }
  if (!html || html.indexOf('<img') === -1) return empty

  // Collect every img src that's a usable http(s) URL. Only http(s)
  // resources are fetched — data: URIs are already inline and don't
  // benefit from embedding; blob:/file: are local-only and won't
  // travel in an EPUB anyway.
  //
  // The HTML-encoded src (e.g. `&amp;` in query strings) is what
  // appears in the output, so we keep the encoded form as the urlMap
  // key for the rewrite. The fetch needs the decoded URL though, or
  // the request goes to a literal `&amp;` host.
  const srcs = []
  const seen = new Set()
  // Match src attribute regardless of attribute order. The non-greedy
  // [^>]*? before src handles cases like `<img alt="…" src="…"/>`.
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"[^>]*\/?>/gi
  let m
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1]
    if (seen.has(src)) continue
    seen.add(src)
    if (!isSafeUrl(decodeHtmlEntitiesForUrl(src))) continue
    if (!/^https?:/i.test(src)) continue
    srcs.push(src)
  }
  if (srcs.length === 0) return empty

  // Fetch in parallel; cap concurrency implicitly via the count of
  // images per chapter (typically a handful). Each fetch is the same
  // best-effort path used for article covers — Blossom + most public
  // image hosts work, Primal r2 (no CORS headers) doesn't.
  const blobs = await Promise.all(srcs.map(src =>
    fetchArticleCoverBlob(decodeHtmlEntitiesForUrl(src)),
  ))

  const manifestItems = []
  const files = []
  const urlMap = new Map()
  let idx = 0
  for (let i = 0; i < srcs.length; i++) {
    const blob = blobs[i]
    if (!blob) continue
    idx++
    const { ext, mime } = imageBlobInfo(blob)
    // `inline/` keeps these out of the way of the per-article cover
    // assets that already live at `img/ch{N}.{ext}`.
    const href = `img/inline/ch${chapterIdx}-${idx}.${ext}`
    const id = `ch${chapterIdx}-inline-${idx}`
    manifestItems.push({ id, href, mime })
    files.push({ href, blob })
    urlMap.set(srcs[i], href)
  }
  if (urlMap.size === 0) return empty

  // Rewrite src attrs in HTML to relative manifest paths. Untouched
  // imgs (CORS-blocked, 404, etc.) keep their external URLs so the
  // article still reads coherently when the reader has internet.
  const rewritten = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*")([^"]+)("[^>]*\/?>)/gi,
    (match, before, src, after) => {
      const newHref = urlMap.get(src)
      return newHref ? `${before}${newHref}${after}` : match
    },
  )

  return { html: rewritten, manifestItems, files }
}

// Pick a sensible file extension + MIME for a fetched image blob.
function imageBlobInfo(blob) {
  const t = (blob?.type || '').toLowerCase()
  if (t.includes('png'))  return { ext: 'png',  mime: 'image/png' }
  if (t.includes('webp')) return { ext: 'webp', mime: 'image/webp' }
  if (t.includes('gif'))  return { ext: 'gif',  mime: 'image/gif' }
  // Default to JPEG — covers most article hero images and any unknown
  // image MIME types. Most readers cope with mismatched ext/MIME.
  return { ext: 'jpg', mime: 'image/jpeg' }
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

function chapterizedOpf({ bookId, title, subtitle, author, lang, date, modified, hasCover, hasCredits, includeToc, chapters, chapterAssets = [] }) {
  // Each chapter contributes up to several manifest entries:
  //   • ch{N}-title.xhtml          — title page (always)
  //   • ch{N}.xhtml                — chapter content (always)
  //   • img/ch{N}.{ext}            — article cover image (optional)
  //   • qr/ch{N}.png               — author zap QR (optional)
  //   • img/inline/ch{N}-K.{ext}   — embedded inline content images (0..N)
  // And two spine entries per chapter (title page → content) so
  // every reader paginates the title page distinctly.
  const chapterManifest = chapters.map((_, i) => {
    const a = chapterAssets[i] || {}
    let entries = `\n    <item id="ch${i + 1}-title" href="ch${i + 1}-title.xhtml" media-type="application/xhtml+xml"/>`
    entries += `\n    <item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    if (a.coverManifest) {
      entries += `\n    <item id="${a.coverManifest.id}" href="${a.coverManifest.href}" media-type="${a.coverManifest.mime}"/>`
    }
    if (a.qrManifest) {
      entries += `\n    <item id="${a.qrManifest.id}" href="${a.qrManifest.href}" media-type="${a.qrManifest.mime}"/>`
    }
    if (Array.isArray(a.inlineManifest)) {
      for (const item of a.inlineManifest) {
        entries += `\n    <item id="${item.id}" href="${item.href}" media-type="${item.mime}"/>`
      }
    }
    return entries
  }).join('')
  const chapterSpine = chapters.map((_, i) =>
    `\n    <itemref idref="ch${i + 1}-title"/>` +
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
// cover and the TOC in the spine. Designed to be dense — goal is ~10+
// titles per page in typical readers — and to leave the trailing
// publisher / Nostr-explainer block looking like the copyright +
// publication page of a real book (small print, footer-like).
//
// Per-article row layout:
//   1. Title bold
//   2. by AuthorName · {npub-link}
//   3. {naddr-link} (the naddr text IS the link to Primal/zap.cooking)
//
// Removed in this revision: the standalone "View on Primal" link
// (the naddr is now the link itself), and the "Open any of them in
// a Nostr client like Primal..." line (redundant with the publisher
// block).
function buildCreditsXhtml({ title, subtitle, author, curatedBy, curatedDate, chapters }) {
  const headerLines = []
  if (curatedBy?.name) {
    const nameSafe = esc(curatedBy.name)
    if (curatedBy.npub) {
      const npubLink = `https://mynostr.app/${encodeURIComponent(curatedBy.npub)}/profile`
      // Curator name + npub on one line, both linked.
      headerLines.push(
        `<p class="credits-curator">Curated by <a href="${esc(npubLink)}">${nameSafe}</a> · ` +
        `<a href="${esc(npubLink)}" class="credits-npub">${esc(curatedBy.npub)}</a></p>`
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

  const articleRows = chapters.map((ch, i) => {
    const sources = buildChapterSourceLinks(ch)
    const titleEsc = esc(ch.title || `Chapter ${i + 1}`)

    // Author + npub on the same line, npub hyperlinked.
    let authorLine = ''
    if (ch.pubkey) {
      const npub = safeAuthorNpub(ch.pubkey)
      if (npub) {
        const profileUrl = `https://mynostr.app/${encodeURIComponent(npub)}/profile`
        const namePart = ch.author ? `${esc(ch.author)} · ` : ''
        authorLine = `<div class="credits-article-author">by ${namePart}` +
          `<a href="${esc(profileUrl)}" class="credits-npub">${esc(npub)}</a></div>`
      } else if (ch.author) {
        authorLine = `<div class="credits-article-author">by ${esc(ch.author)}</div>`
      }
    } else if (ch.author) {
      authorLine = `<div class="credits-article-author">by ${esc(ch.author)}</div>`
    }

    // naddr is now the only link in the row, pointing at the Primal/
    // zap.cooking reader. Skipped entirely if we can't encode (no
    // broken placeholders).
    let naddrLink = ''
    if (sources) {
      naddrLink = `<div class="credits-article-naddr"><a href="${esc(sources.viewUrl)}">${esc(sources.naddr)}</a></div>`
    }

    return `
    <li class="credits-article">
      <div class="credits-article-title">${titleEsc}</div>
      ${authorLine}${naddrLink}
    </li>`
  }).join('')

  // Footer block — formatted like the copyright/publication page of a
  // physical book. Tiny type, tight leading, sits at the bottom as an
  // attribution rather than a feature.
  const footer = `
    <div class="credits-footer">
      <p>Published by <a href="https://mynostr.app">mynostr.app</a> for free. Consider publishing your own articles or curations on mynostr.app; donate or zap bitcoin to your favorite authors on any Nostr app.</p>
      <p>Nostr (notes and other stuff transmitted by relays) is a decentralized free and open protocol to host and discover information like notes, articles, recipes, events or marketplace items over the internet — publish your own work on any Nostr app for free with no ads, no email, no ID, no paywalls.</p>
    </div>`

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

  <h2 class="credits-section">Articles in this collection</h2>
  <ol class="credits-articles">${articleRows}
  </ol>

  ${footer}
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
    // lud16 for the per-chapter zap-QR. Callers should populate from
    // the article author's kind 0 profile when available; absent
    // value just means the QR is skipped for that chapter.
    lud16:    a.lud16 || '',
  }))

  // Per-chapter assets (article cover fetch + QR PNG generation +
  // inline image embedding) run in parallel so a 10-article export
  // doesn't take 10× the worst single-article cost. Each step is
  // best-effort; failures degrade to "no cover" / "no QR" / "external
  // img src" rather than failing the export. CORS limits apply
  // throughout — Blossom + most public hosts work, Primal r2 doesn't.
  const chapterAssets = await Promise.all(chapters.map(async (ch, i) => {
    const idx = i + 1
    const rawBodyHtml = mdToXhtml(ch.content)
    const [articleCoverBlob, qrBlob, inlineResult] = await Promise.all([
      fetchArticleCoverBlob(ch.metadata?.image),
      generateQrPngBlob(lud16ToQrPayload(ch.lud16)),
      embedInlineImages(rawBodyHtml, idx),
    ])
    const out = {
      coverHref:      null,
      qrHref:         null,
      coverManifest:  null,
      qrManifest:     null,
      bodyHtml:       inlineResult.html,
      inlineManifest: inlineResult.manifestItems,
      inlineFiles:    inlineResult.files,
    }
    if (articleCoverBlob) {
      const { ext, mime } = imageBlobInfo(articleCoverBlob)
      const href = `img/ch${idx}.${ext}`
      out.coverHref = href
      out.coverManifest = { id: `ch${idx}-img`, href, mime, blob: articleCoverBlob }
    }
    if (qrBlob) {
      const href = `qr/ch${idx}.png`
      out.qrHref = href
      out.qrManifest = { id: `ch${idx}-qr`, href, mime: 'image/png', blob: qrBlob }
    }
    return out
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
  const coverSubtitle = subtitle || 'Long Form Nostr Notes'
  // Author shown on cover only when explicitly entered. The "Various"
  // checkbox on the modal clears author to empty, and an empty/literal
  // "Various" should not appear on the cover.
  const coverAuthor = (author && author.trim() && author.trim().toLowerCase() !== 'various')
    ? author.trim()
    : ''
  // requireImage=true when user explicitly supplied a cover so a CORS-
  // or network-failure surfaces as an error in the UI rather than a
  // silent gradient substitution. When no cover supplied, we'd want
  // gradient anyway so the falsy coverImageUrl skips both branches.
  const coverBlob = await generateCoverBlob(title, {
    subtitle:     coverSubtitle,
    author:       coverAuthor,
    coverUrl:     coverImageUrl,
    requireImage: !!coverImageUrl,
  })
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
    hasCover, hasCredits, includeToc, chapters, chapterAssets,
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

  // Per-chapter: write title-page asset files (cover img, QR PNG),
  // then a separate ch{N}-title.xhtml for the title page, then
  // ch{N}.xhtml for the content. Two XHTML files per chapter is
  // intentional — gives every reader an unambiguous page break
  // between title and content even where CSS page-break-after is
  // unsupported.
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const a  = chapterAssets[i]
    if (a.coverManifest) zip.file(`OEBPS/${a.coverManifest.href}`, a.coverManifest.blob)
    if (a.qrManifest)    zip.file(`OEBPS/${a.qrManifest.href}`,    a.qrManifest.blob)
    if (Array.isArray(a.inlineFiles)) {
      for (const f of a.inlineFiles) zip.file(`OEBPS/${f.href}`, f.blob)
    }

    const dateStr = ch.metadata?.publishedAtDate
      ? parseDateString(ch.metadata.publishedAtDate).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : ''
    zip.file(`OEBPS/ch${i + 1}-title.xhtml`, articleTitlePageXhtml({
      title:    ch.title,
      subtitle: ch.metadata?.summary || '',
      author:   ch.author,
      dateStr,
      coverHref: a.coverHref,
      qrHref:    a.qrHref,
      lud16:     ch.lud16,
    }))
    zip.file(`OEBPS/ch${i + 1}.xhtml`, contentXhtml({
      title:    ch.title,
      metadata: ch.metadata,
      source:   null,
      bodyHtml: a.bodyHtml,
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

  // Credits section — compact per-article rows, then a tiny
  // copyright-page-style publisher footer at the very bottom.
  // Per-article shape mirrors the EPUB credits page:
  //   N. **Title**
  //      by AuthorName · [npub](mynostr profile)
  //      [naddr](Primal/zap.cooking — naddr text IS the link)
  if (includeCredits) {
    const articleLines = chapters.map((ch, i) => {
      const lines = [`${i + 1}. **${ch.title}**`]
      if (ch.pubkey) {
        const npub = safeAuthorNpub(ch.pubkey)
        if (npub) {
          const profileUrl = `https://mynostr.app/${encodeURIComponent(npub)}/profile`
          const namePart = ch.author ? `${ch.author} · ` : ''
          lines.push(`   by ${namePart}[\`${npub}\`](${profileUrl})`)
        } else if (ch.author) {
          lines.push(`   by ${ch.author}`)
        }
      } else if (ch.author) {
        lines.push(`   by ${ch.author}`)
      }
      const sources = buildChapterSourceLinks(ch)
      if (sources) {
        // naddr text is the link target — no separate "View on Primal" line.
        lines.push(`   [\`${sources.naddr}\`](${sources.viewUrl})`)
      }
      return lines.join('  \n')
    }).join('\n')

    sections.push(`## Articles in this collection\n\n${articleLines}`)

    // Footer block — kept short. <small> renders as smaller text
    // when the markdown viewer outputs HTML (GitHub, Obsidian, most
    // others), giving the same copyright-page look as the EPUB.
    sections.push(
      `<small>Published by [mynostr.app](https://mynostr.app) for free. ` +
      `Consider publishing your own articles or curations on mynostr.app; donate or zap bitcoin to your favorite authors on any Nostr app.</small>\n\n` +
      `<small>Nostr (notes and other stuff transmitted by relays) is a decentralized free and open protocol to host and discover information like notes, articles, recipes, events or marketplace items over the internet — publish your own work on any Nostr app for free with no ads, no email, no ID, no paywalls.</small>`
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

  const rawBodyHtml = mdToXhtml(content)
  const coverUrl = metadata.image && isSafeUrl(metadata.image) ? metadata.image : null
  const coverBlob = await generateCoverBlob(title, { author, coverUrl })
  const hasCover  = !!coverBlob

  // Inline-image embedding for single-article exports. Same best-effort
  // CORS-permitting fetch as the chapterized path; failures degrade to
  // the original external URL in the <img src>.
  const inlineResult = await embedInlineImages(rawBodyHtml, 0)
  const bodyHtml = inlineResult.html

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', containerXml())
  zip.file('OEBPS/content.opf', contentOpf({
    bookId, title, author,
    description: metadata.summary || '',
    subjects:    metadata.tags    || [],
    lang, date, modified, hasCover, naddr,
    inlineManifest: inlineResult.manifestItems,
  }))
  zip.file('OEBPS/toc.ncx',      tocNcx({ bookId, title }))
  zip.file('OEBPS/nav.xhtml',    navXhtml({ title }))
  zip.file('OEBPS/style.css',    styleCss())
  zip.file('OEBPS/content.xhtml', contentXhtml({ title, metadata, source, bodyHtml }))

  if (hasCover) {
    zip.file('OEBPS/cover.jpg',   coverBlob)
    zip.file('OEBPS/cover.xhtml', coverXhtml())
  }
  for (const f of inlineResult.files) {
    zip.file(`OEBPS/${f.href}`, f.blob)
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
