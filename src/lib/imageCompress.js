/**
 * Client-side image compression for uploads.
 *
 * Four levels, picked per-upload in ImageUploadConfirm:
 *   none   — original bytes, no re-encode
 *   low    — 3840px max edge, quality 0.90 (light touch)
 *   medium — 2048px max edge, quality 0.82 (default)
 *   high   — 1280px max edge, quality 0.72 (small files, chats)
 *
 * We skip re-encoding for GIF (animation), SVG (vector), ICO, and any
 * file the browser can't decode as an ImageBitmap. Transparent PNGs stay
 * PNG to preserve alpha. Everything else re-encodes to JPEG — smaller
 * than PNG for photos, and strips EXIF (good for privacy).
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
 * Compress a File according to the given level. Returns the compressed
 * File, or the original if: level is 'none', the file isn't a raster
 * image we can re-encode, or decoding fails. Never throws — upload
 * callers should never be blocked by compression.
 */
export async function compressImage(file, level = DEFAULT_COMPRESSION_LEVEL) {
  if (!file) return file
  if (level === 'none' || !COMPRESSION_LEVELS[level]) return file
  if (!isCompressible(file)) return file

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
