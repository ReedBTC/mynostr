/**
 * Client-side image compression for uploads.
 *
 * Four levels, picked per-upload in ImageUploadConfirm:
 *   none   — original pixels, metadata-only strip (EXIF/XMP/IPTC removed)
 *   low    — 3840px max edge, quality 0.90 (light touch)
 *   medium — 2048px max edge, quality 0.82 (default)
 *   high   — 1280px max edge, quality 0.72 (small files, chats)
 *
 * We skip re-encoding for GIF (animation), SVG (vector), ICO, and any
 * file the browser can't decode as an ImageBitmap. Transparent PNGs stay
 * PNG to preserve alpha. Everything else re-encodes to JPEG — smaller
 * than PNG for photos.
 *
 * Privacy: every upload path strips identifying metadata. Re-encode
 * levels (low/medium/high) drop it as a side-effect of canvas re-encode;
 * level=none runs a chunk-walking stripper that removes EXIF/XMP/IPTC
 * without touching pixels. Color profiles (ICC) are preserved so colors
 * still render correctly. GIF/SVG/ICO are passed through unchanged —
 * stripping them safely without breaking animation/vectors is non-trivial
 * and out of scope.
 *
 * createImageBitmap with imageOrientation:'from-image' handles EXIF
 * orientation automatically in modern browsers, so iPhone photos don't
 * end up sideways.
 */

export const COMPRESSION_LEVELS = {
  none:   { label: 'None',   desc: 'Upload original, no changes',     maxEdge: Infinity, quality: 1.0 },
  low:    { label: 'Low',    desc: 'Light — keeps most detail',       maxEdge: 3840,     quality: 0.90 },
  medium: { label: 'Medium', desc: 'Balanced — good for most images', maxEdge: 2048,     quality: 0.82 },
  high:   { label: 'High',   desc: 'Small — fast to load',            maxEdge: 1280,     quality: 0.72 },
}

export const DEFAULT_COMPRESSION_LEVEL = 'medium'

// Types we never touch: animation/vector/icon formats where re-encoding
// breaks the content. Everything else we attempt and gracefully fall
// back to the original file if decode fails.
const SKIP_TYPES = new Set([
  'image/gif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export function isCompressible(file) {
  if (!file || !file.type) return false
  if (!file.type.startsWith('image/')) return false
  if (SKIP_TYPES.has(file.type)) return false
  return true
}

function outputTypeFor(file) {
  // Preserve alpha for PNG/WebP; everything else → JPEG.
  if (file.type === 'image/png' || file.type === 'image/webp') return file.type
  return 'image/jpeg'
}

function extForType(type) {
  if (type === 'image/png')  return 'png'
  if (type === 'image/webp') return 'webp'
  return 'jpg'
}

function renameWithExt(name, type) {
  const base = (name || 'image').replace(/\.[^./\\]+$/, '')
  return `${base}.${extForType(type)}`
}

/**
 * JPEG metadata stripper — walks segments and drops APP1 (EXIF/XMP),
 * APP13 (IPTC/Photoshop), and COM (comment). Keeps APP2 (ICC profile),
 * APP14 (Adobe color), and all structural segments (DQT, DHT, SOF, SOS).
 * Returns a new ArrayBuffer, or the input if the file isn't valid JPEG.
 */
function stripJpegMetadata(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return buffer

  const view = new DataView(buffer)
  const chunks = [bytes.subarray(0, 2)] // SOI
  let i = 2

  while (i < bytes.length) {
    if (bytes[i] !== 0xFF) return buffer // malformed; bail with original
    const marker = bytes[i + 1]

    // SOS — copy entrypoint + entropy-coded scan + EOI verbatim.
    if (marker === 0xDA) { chunks.push(bytes.subarray(i)); break }

    // Standalone markers (no length payload). Shouldn't appear pre-SOS,
    // but guard so we don't read past the buffer.
    if (marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      chunks.push(bytes.subarray(i, i + 2))
      i += 2
      continue
    }

    if (i + 4 > bytes.length) return buffer
    const segLen = view.getUint16(i + 2)
    const segEnd = i + 2 + segLen
    if (segEnd > bytes.length) return buffer

    // APP1 (EXIF/XMP), APP13 (IPTC/Photoshop), COM (comment).
    const drop = marker === 0xE1 || marker === 0xED || marker === 0xFE
    if (!drop) chunks.push(bytes.subarray(i, segEnd))
    i = segEnd
  }

  return concatChunks(chunks).buffer
}

/**
 * PNG metadata stripper — walks chunks and drops textual + EXIF + tIME.
 * Keeps iCCP (color profile), gAMA, cHRM, sRGB, sBIT, and pixel data.
 */
function stripPngMetadata(buffer) {
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 8) return buffer
  for (let k = 0; k < 8; k++) if (bytes[k] !== PNG_SIG[k]) return buffer

  const view = new DataView(buffer)
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])
  const chunks = [bytes.subarray(0, 8)]
  let i = 8

  while (i + 12 <= bytes.length) {
    const len = view.getUint32(i)
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    const chunkEnd = i + 8 + len + 4 // length(4) + type(4) + data + crc(4)
    if (chunkEnd > bytes.length) return buffer

    if (!DROP.has(type)) chunks.push(bytes.subarray(i, chunkEnd))
    i = chunkEnd
    if (type === 'IEND') break
  }

  return concatChunks(chunks).buffer
}

/**
 * WebP metadata stripper — walks RIFF chunks, drops EXIF and XMP, keeps
 * ICCP (color profile) and pixel data. Patches the VP8X feature flags
 * to reflect the dropped chunks, and rewrites the RIFF size in the
 * header.
 */
function stripWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 12) return buffer
  const ascii4 = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
  if (ascii4(0) !== 'RIFF' || ascii4(8) !== 'WEBP') return buffer

  const view = new DataView(buffer)
  const chunks = [bytes.subarray(0, 12)] // RIFF + size + WEBP (size patched below)
  let i = 12
  let dropped = false

  while (i + 8 <= bytes.length) {
    const fourcc = ascii4(i)
    const size = view.getUint32(i + 4, true)
    const padded = size + (size & 1) // chunks pad to even length
    const chunkEnd = i + 8 + padded
    if (chunkEnd > bytes.length) return buffer

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      dropped = true
    } else if (fourcc === 'VP8X' && size >= 1) {
      // Clear EXIF (0x08) + XMP (0x04) feature flag bits so decoders
      // don't expect chunks we just removed. ICC + alpha + animation
      // bits are preserved.
      const copy = new Uint8Array(bytes.subarray(i, chunkEnd))
      copy[8] = copy[8] & ~0x0C
      chunks.push(copy)
    } else {
      chunks.push(bytes.subarray(i, chunkEnd))
    }
    i = chunkEnd
  }

  if (!dropped) return buffer
  const result = concatChunks(chunks)
  new DataView(result.buffer).setUint32(4, result.length - 8, true)
  return result.buffer
}

function concatChunks(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

/**
 * Strip identifying metadata from a File without re-encoding pixels.
 * Handles JPEG, PNG, WebP — everything else (including GIF/SVG/ICO and
 * non-images) returns the original File unchanged. Never throws; upload
 * callers should never be blocked by metadata stripping.
 */
export async function stripImageMetadata(file) {
  if (!file || !file.type) return file
  const t = file.type
  if (t !== 'image/jpeg' && t !== 'image/jpg' && t !== 'image/png' && t !== 'image/webp') {
    return file
  }
  try {
    const buffer = await file.arrayBuffer()
    let stripped
    if (t === 'image/jpeg' || t === 'image/jpg') stripped = stripJpegMetadata(buffer)
    else if (t === 'image/png') stripped = stripPngMetadata(buffer)
    else stripped = stripWebpMetadata(buffer)

    if (stripped === buffer || stripped.byteLength >= buffer.byteLength) return file
    return new File([stripped], file.name, { type: t, lastModified: Date.now() })
  } catch {
    return file
  }
}

/**
 * Compress a File according to the given level. Returns the compressed
 * File, or the original if the file isn't a raster image we can
 * re-encode, or decoding fails. At level='none' the pixels are left
 * untouched but EXIF/XMP/IPTC metadata is still stripped. Never throws —
 * upload callers should never be blocked by compression.
 */
export async function compressImage(file, level = DEFAULT_COMPRESSION_LEVEL) {
  if (!file) return file
  if (!COMPRESSION_LEVELS[level]) return file
  if (!isCompressible(file)) return file
  if (level === 'none') return stripImageMetadata(file)

  const { maxEdge, quality } = COMPRESSION_LEVELS[level]

  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file // Browser couldn't decode — hand back original.
  }

  try {
    const { width: srcW, height: srcH } = bitmap
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
    const dstW = Math.max(1, Math.round(srcW * scale))
    const dstH = Math.max(1, Math.round(srcH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = dstW
    canvas.height = dstH
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, dstW, dstH)

    const outType = outputTypeFor(file)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, outType, quality))
    if (!blob) return file

    // Don't hand back a bigger file than we were given — if the chosen
    // level somehow produced larger bytes (rare, mostly with tiny PNGs
    // of text/UI), keep the original.
    if (blob.size >= file.size && scale === 1) return file

    return new File([blob], renameWithExt(file.name, outType), {
      type: outType,
      lastModified: Date.now(),
    })
  } finally {
    bitmap.close?.()
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
