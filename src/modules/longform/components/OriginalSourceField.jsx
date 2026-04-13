// Collects original source info and publication date.
// The attribution line is prepended to content before signing — not stored as a separate tag.
// The publishedAtDate is stored as the NIP-23 published_at tag.
export default function OriginalSourceField({ source, onChange, metadata, onMetadataChange, readOnly }) {
  function updateSource(field, value) {
    onChange({ ...source, [field]: value })
  }

  return (
    <div className="space-y-3 p-4 border-t border-neutral-800">
      <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-widest">
        Original Source
        <span className="ml-2 font-normal normal-case text-neutral-600">(optional)</span>
      </h2>
      <p className="text-xs text-neutral-600 leading-relaxed">
        If this article was originally published elsewhere, fill this in to prepend an attribution line to your content.
      </p>

      <div className="space-y-1">
        <label htmlFor="source-name" className="block text-sm text-neutral-400">
          Original Platform / Source Name
        </label>
        <input
          id="source-name"
          type="text"
          value={source.name}
          onChange={e => updateSource('name', e.target.value)}
          placeholder="Substack, Medium, My Blog..."
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="source-url" className="block text-sm text-neutral-400">
          Original URL (optional)
        </label>
        <input
          id="source-url"
          type="url"
          value={source.url}
          onChange={e => updateSource('url', e.target.value)}
          placeholder="https://yourname.substack.com/p/article"
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 text-sm font-mono disabled:opacity-40 disabled:cursor-not-allowed"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="source-date" className="block text-sm text-neutral-400">
          Original Publication Date
        </label>
        <input
          id="source-date"
          type="date"
          value={metadata.publishedAtDate}
          onChange={e => onMetadataChange({ ...metadata, publishedAtDate: e.target.value })}
          disabled={readOnly}
          className="w-full px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 focus:outline-none focus:border-purple-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <p className="text-xs text-neutral-600">Shown as the publication date in Habla, Highlighter, etc.</p>
      </div>

      {/* Live preview of the attribution line */}
      {source.name && (
        <div className="px-3 py-2 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 italic">
          {source.url
            ? `Originally published at ${source.name} (${source.url})`
            : `Originally published at ${source.name}`
          }
        </div>
      )}
    </div>
  )
}
