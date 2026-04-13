import { useRef, useState } from 'react'
import { uploadToBlossom } from '../lib/blossom.js'

export default function MetadataForm({ metadata, onChange, readOnly }) {
  const coverInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  async function handleCoverUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const url = await uploadToBlossom(file)
      onChange({ ...metadata, image: url })
    } catch (err) {
      setUploadError(err.message || 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  function update(field, value) {
    onChange({ ...metadata, [field]: value })
  }

  function handleTagsInput(raw) {
    // Parse comma-separated tags, strip leading # from each
    const tags = raw
      .split(',')
      .map(t => t.trim().replace(/^#/, ''))
      .filter(Boolean)
    onChange({ ...metadata, tagsRaw: raw, tags })
  }

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-widest">
        Article Metadata
      </h2>

      {/* Title — required */}
      <div className="space-y-1">
        <label htmlFor="meta-title" className="block text-sm text-neutral-400">
          Title <span className="text-red-500">*</span>
        </label>
        <input
          id="meta-title"
          type="text"
          value={metadata.title}
          onChange={e => update('title', e.target.value)}
          placeholder="Article title"
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          aria-required="true"
        />
      </div>

      {/* Summary / subtitle */}
      <div className="space-y-1">
        <label htmlFor="meta-summary" className="block text-sm text-neutral-400">
          Summary / Subtitle
        </label>
        <input
          id="meta-summary"
          type="text"
          value={metadata.summary}
          onChange={e => update('summary', e.target.value)}
          placeholder="Optional subtitle or summary"
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
      </div>

      {/* Cover image URL + upload */}
      <div className="space-y-1">
        <label htmlFor="meta-image" className="block text-sm text-neutral-400">
          Cover Image
        </label>
        <div className="flex gap-2">
          <input
            id="meta-image"
            type="url"
            value={metadata.image}
            onChange={e => update('image', e.target.value)}
            placeholder="https://..."
            disabled={readOnly}
            className="flex-1 min-w-0 px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm font-mono disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => coverInputRef.current?.click()}
            disabled={uploading || readOnly}
            className="px-3 py-2 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-500 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            aria-label="Upload cover image to Blossom"
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            onChange={handleCoverUpload}
            className="hidden"
            aria-hidden="true"
          />
        </div>
        {uploadError && (
          <p className="text-xs text-red-400" role="alert">{uploadError}</p>
        )}
      </div>

      {/* Tags / hashtags */}
      <div className="space-y-1">
        <label htmlFor="meta-tags" className="block text-sm text-neutral-400">
          Tags
        </label>
        <input
          id="meta-tags"
          type="text"
          value={metadata.tagsRaw}
          onChange={e => handleTagsInput(e.target.value)}
          placeholder="writing, nostr, essay"
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <p className="text-xs text-neutral-600">Comma-separated. # is optional.</p>
      </div>

    </div>
  )
}
