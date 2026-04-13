import JSZip from 'jszip'
import { marked } from 'marked'
import { titleToSlug, isSafeUrl, parseDateString } from './utils.js'

// Convert markdown to XHTML-compatible HTML for epub content
function mdToXhtml(markdown) {
  const html = marked.parse(markdown || '')
  // Epub content must be valid XHTML — fix self-closing void elements
  return html
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

// Generate a cover image (800×1200) as a PNG Blob.
// Uses the article cover image as background if available (falls back to gradient).
// Title and author are overlaid at the bottom.
async function generateCoverBlob(title, author, coverUrl) {
  const W = 800, H = 1200
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // ── Background ────────────────────────────────────────────────────────────
  let usedPhoto = false
  if (coverUrl && isSafeUrl(coverUrl)) {
    try {
      const img = await Promise.race([
        new Promise((res, rej) => {
          const i = new Image()
          i.crossOrigin = 'anonymous'
          i.onload = () => res(i)
          i.onerror = rej
          i.src = coverUrl
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ])
      // Cover-fill: scale to fill canvas, crop to centre
      const scale = Math.max(W / img.width, H / img.height)
      const sw = img.width * scale
      const sh = img.height * scale
      ctx.drawImage(img, (W - sw) / 2, (H - sh) / 2, sw, sh)
      usedPhoto = true
    } catch {
      // CORS or timeout — fall through to gradient
    }
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

  // Measure text block height so we can vertically centre it in the lower third
  const padding = 56
  const maxTextW = W - padding * 2
  const titleSize = 58
  const authorSize = 34
  const titleLineH = titleSize * 1.25
  const authorLineH = authorSize * 1.4
  const gap = 20  // space between title block and author

  ctx.font = `bold ${titleSize}px Georgia, serif`
  const titleLines = countLines(ctx, title || 'Untitled', maxTextW)
  const titleBlockH = titleLines * titleLineH

  ctx.font = `${authorSize}px Georgia, serif`
  const authorLines = author ? countLines(ctx, author, maxTextW) : 0
  const authorBlockH = authorLines * authorLineH

  const totalH = titleBlockH + (author ? gap + authorBlockH : 0)
  // Place block so its centre sits 35% up from the bottom
  const blockCentreY = H - H * 0.22
  let y = blockCentreY - totalH / 2

  // Title
  ctx.font = `bold ${titleSize}px Georgia, serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 8
  y = canvasWrapText(ctx, title || 'Untitled', W / 2, y, maxTextW, titleLineH) + gap

  // Author
  if (author) {
    ctx.font = `${authorSize}px Georgia, serif`
    ctx.fillStyle = 'rgba(255,255,255,0.78)'
    canvasWrapText(ctx, author, W / 2, y + titleLineH * 0.1, maxTextW, authorLineH)
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
  const publisherTag = '\n    <dc:publisher>NostrMD</dc:publisher>'
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
.source    { font-size: 0.9em; color: #555; font-style: italic; margin-bottom: 1.5em; }`
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

export async function exportEpub(content, metadata, source, author = '', naddr = '') {
  const zip = new JSZip()

  const bookId = uuid4()
  const title = metadata.title || 'Untitled'
  const lang = 'en'
  const date = metadata.publishedAtDate || new Date().toISOString().split('T')[0]
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const slug = titleToSlug(title) || 'nostrmd-export'

  const bodyHtml = mdToXhtml(content)

  // Generate cover image — always produced (photo bg or gradient fallback)
  const coverUrl = metadata.image && isSafeUrl(metadata.image) ? metadata.image : null
  const coverBlob = await generateCoverBlob(title, author, coverUrl)
  const hasCover = !!coverBlob

  // mimetype must be first and stored uncompressed — epub spec requirement
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', containerXml())
  zip.file('OEBPS/content.opf', contentOpf({
    bookId, title, author,
    description: metadata.summary || '',
    subjects: metadata.tags || [],
    lang, date, modified, hasCover, naddr,
  }))
  zip.file('OEBPS/toc.ncx', tocNcx({ bookId, title }))
  zip.file('OEBPS/nav.xhtml', navXhtml({ title }))
  zip.file('OEBPS/style.css', styleCss())
  zip.file('OEBPS/content.xhtml', contentXhtml({ title, metadata, source, bodyHtml }))

  if (hasCover) {
    zip.file('OEBPS/cover.jpg', coverBlob)
    zip.file('OEBPS/cover.xhtml', coverXhtml())
  }

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = slug + '.epub'
  a.click()
  URL.revokeObjectURL(url)
}
