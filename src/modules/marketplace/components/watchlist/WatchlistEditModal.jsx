import { useEffect, useRef, useState } from 'react'
import { Z } from '../../../../lib/zIndex.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { uploadToBlossom } from '../../../../lib/blossom.js'

/**
 * WatchlistEditModal — small modal for editing the user's watchlist
 * collection metadata (title, summary, image).
 *
 * Defaults are seeded from the existing watchlist; "Watchlist" is the
 * fallback title for a fresh / unset watchlist. The cover image
 * accepts either a pasted URL or a local file uploaded to Blossom
 * (same 5 MB cap pattern as the Sell composer's photos).
 *
 * Save calls onSave with the patch; modal stays open while the
 * publish is in flight (caller surfaces errors via the panel state),
 * closes on success.
 */
const MAX_COVER_BYTES = 5 * 1024 * 1024

export default function WatchlistEditModal({
  initialTitle = '',
  initialSummary = '',
  initialImage = '',
  onClose,
  onSave,
}) {
  const [title,   setTitle]   = useState(initialTitle)
  const [summary, setSummary] = useState(initialSummary)
  const [image,   setImage]   = useState(initialImage)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [uploadError, setUploadError] = useState('')
  const [uploading,   setUploading]   = useState(false)
  const fileInputRef = useRef(null)

  // Esc closes when not in flight.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !saving && !uploading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving, uploading])

  async function handleFile(file) {
    if (!file) return
    if (file.size > MAX_COVER_BYTES) {
      setUploadError(`Image too large — max ${Math.round(MAX_COVER_BYTES / 1024 / 1024)} MB.`)
      return
    }
    setUploadError('')
    setUploading(true)
    try {
      const url = await uploadToBlossom(file)
      setImage(url)
    } catch (e) {
      setUploadError(e?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleSave() {
    if (saving) return
    setError('')
    // Trim & validate the image URL — empty is fine (clears the image),
    // but a non-empty value must pass isSafeUrl so we don't store a
    // javascript:/data: URL on the user's relays.
    const trimmedImage = image.trim()
    if (trimmedImage && !isSafeUrl(trimmedImage) && !trimmedImage.startsWith('https://')) {
      setError('Image URL must start with https://')
      return
    }
    setSaving(true)
    try {
      const r = await onSave({
        title:   title.trim(),
        summary: summary.trim(),
        image:   trimmedImage,
      })
      if (r?.ok) onClose()
      else setError(r?.error || 'Save failed.')
    } catch (e) {
      setError(e?.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || uploading

  return (
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center p-4`}
      onMouseDown={busy ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Edit watchlist</h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-neutral-500 hover:text-neutral-200 transition-colors text-lg leading-none disabled:opacity-40"
            aria-label="Close"
          >✕</button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-4">
          <Field label="Title" hint="What you want this watchlist called.">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Watchlist"
              className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-950 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
            />
          </Field>

          <Field label="Summary" hint="Optional. Short description of what's in this list.">
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={280}
              className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-950 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
            />
          </Field>

          <Field label="Cover image" hint="Optional. URL or upload (5 MB max).">
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="https://..."
                className="flex-1 px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-950 text-neutral-100 outline-none focus:border-purple-600 transition-colors"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || saving}
                className="text-xs px-3 py-2 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
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
                  e.target.value = ''
                  if (f) handleFile(f)
                }}
              />
            </div>
            {uploadError && <p className="text-xs text-red-400 mt-1">{uploadError}</p>}

            {/* Preview when we have a usable URL */}
            {image && isSafeUrl(image) && (
              <div className="mt-2 border border-neutral-800 rounded overflow-hidden">
                <img
                  src={image}
                  alt=""
                  className="w-full max-h-32 object-cover bg-neutral-950"
                  onError={(e) => { e.currentTarget.style.opacity = '0.3' }}
                />
              </div>
            )}
          </Field>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-800">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-neutral-300 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-neutral-600 mt-1">{hint}</p>}
    </div>
  )
}
