import { formatDraftAge } from '../lib/useDraft.js'

export default function DraftBanner({ draft, onRestore, onDiscard }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-neutral-900 border-b border-neutral-800 text-sm">
      <span className="text-neutral-400">
        Unsaved draft from{' '}
        <span className="text-neutral-300">{formatDraftAge(draft.savedAt)}</span>
        {draft.metadata?.title && (
          <> — <span className="text-neutral-300 italic">{draft.metadata.title}</span></>
        )}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={onRestore}
          className="px-3 py-1 rounded text-xs bg-purple-700 hover:bg-purple-600 text-white transition-colors"
        >
          Restore
        </button>
        <button
          onClick={onDiscard}
          className="px-3 py-1 rounded text-xs border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 transition-colors"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
