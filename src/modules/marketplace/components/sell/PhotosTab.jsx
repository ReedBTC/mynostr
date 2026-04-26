import { useRef, useState } from 'react'
import { uploadToBlossom } from '../../../../lib/blossom.js'
import { isSafeUrl } from '../../../../lib/utils.js'

const MAX_IMAGES = 8

/**
 * Photos tab — image management.
 *
 * Supports two add modes:
 *   • Paste/type URL — for sellers using their own host or an existing
 *     image already on the web.
 *   • Upload — files go to Blossom (primal.net), URL added on success.
 *
 * Up/down arrows reorder; first image is the cover by Gamma convention.
 * No drag-and-drop in alpha — keyboard-accessible button reordering is
 * simpler to implement and works on every device.
 */
export default function PhotosTab({ form, updateForm }) {
  const [urlDraft, setUrlDraft] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const images = form.images || []
  const atCap = images.length >= MAX_IMAGES

  function pushImage(url) {
    if (!url) return
    if (!isSafeUrl(url)) {
      setError('That URL doesn\'t look like a safe image link.')
      return
    }
    if (images.some(i => i.url === url)) {
      setError('That image is already in the list.')
      return
    }
    if (atCap) {
      setError(`Up to ${MAX_IMAGES} images per listing.`)
      return
    }
    setError('')
    updateForm({ images: [...images, { url, dims: '', sort: images.length }] })
    setUrlDraft('')
  }

  async function handleFile(file) {
    if (!file) return
    if (atCap) {
      setError(`Up to ${MAX_IMAGES} images per listing.`)
      return
    }
    setError('')
    setUploading(true)
    try {
      const url = await uploadToBlossom(file)
      pushImage(url)
    } catch (e) {
      setError(e?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function removeAt(idx) {
    const next = images.slice()
    next.splice(idx, 1)
    // Re-stamp sort so manifest order matches array order on encode.
    next.forEach((img, i) => { img.sort = i })
    updateForm({ images: next })
  }

  function move(idx, delta) {
    const target = idx + delta
    if (target < 0 || target >= images.length) return
    const next = images.slice()
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    next.forEach((img, i) => { img.sort = i })
    updateForm({ images: next })
  }

  return (
    <div className="space-y-4 max-w-2xl">

      <p className="text-xs text-neutral-500">
        First image is the cover. Up to {MAX_IMAGES} images per listing.
      </p>

      {/* Add row */}
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pushImage(urlDraft.trim()) } }}
          placeholder="Paste image URL"
          disabled={atCap}
          className="flex-1 px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors disabled:opacity-40"
        />
        <button
          onClick={() => pushImage(urlDraft.trim())}
          disabled={!urlDraft.trim() || atCap}
          className="text-xs px-3 py-2 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
        >
          Add URL
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || atCap}
          className="text-xs px-3 py-2 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''  // reset so re-uploading the same file re-fires onChange
          }}
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Grid of images */}
      {images.length === 0 ? (
        <div className="text-xs text-neutral-600 border border-dashed border-neutral-800 rounded p-6 text-center">
          No images yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {images.map((img, i) => (
            <li
              key={img.url}
              className="flex items-center gap-3 px-2 py-2 rounded border border-neutral-800 bg-neutral-900"
            >
              <img
                src={img.url}
                alt=""
                className="w-14 h-14 object-cover rounded border border-neutral-800 flex-shrink-0"
                onError={(e) => { e.currentTarget.style.opacity = '0.3' }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-neutral-500 truncate">{img.url}</div>
                {i === 0 && <div className="text-xs text-purple-400 mt-0.5">Cover</div>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="text-xs w-6 h-6 rounded border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 disabled:opacity-30 transition-colors"
                  title="Move up"
                >↑</button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === images.length - 1}
                  className="text-xs w-6 h-6 rounded border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 disabled:opacity-30 transition-colors"
                  title="Move down"
                >↓</button>
                <button
                  onClick={() => removeAt(i)}
                  className="text-xs w-6 h-6 rounded border border-neutral-700 text-neutral-500 hover:text-red-400 hover:border-red-700 transition-colors"
                  title="Remove"
                >✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
