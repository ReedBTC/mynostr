import { useState } from 'react'
import { isSafeUrl } from '../../../../lib/utils.js'

function formatDate(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function ReadingListSection({
  list,
  selected,
  onToggle,
  onRemoveArticle,
  onDeleteList,
}) {
  const [collapsed,       setCollapsed]       = useState(false)
  const [confirmDelete,   setConfirmDelete]   = useState(false)
  const [deleteTimer,     setDeleteTimer]     = useState(null)
  const allSelected = list.articles.length > 0 && list.articles.every(a => selected.has(a.aTag))

  function handleSelectAll() {
    for (const a of list.articles) onToggle(a.aTag, !allSelected)
  }

  function handleConfirmDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      const t = setTimeout(() => setConfirmDelete(false), 3000)
      setDeleteTimer(t)
    } else {
      clearTimeout(deleteTimer)
      onDeleteList(list.id)
    }
  }

  return (
    <div className="border border-neutral-800 rounded-lg overflow-hidden">
      {/* Section header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-neutral-900">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-neutral-600 hover:text-neutral-400 transition-colors flex-shrink-0"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
          <span className="text-sm font-medium text-neutral-200 truncate">{list.title}</span>
          <span className="text-xs text-neutral-600 flex-shrink-0">
            {list.articles.length} {list.articles.length === 1 ? 'article' : 'articles'}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {list.articles.length > 0 && (
            <button
              onClick={handleSelectAll}
              className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
            >
              {allSelected ? 'deselect all' : 'select all'}
            </button>
          )}
          <button
            onClick={handleConfirmDelete}
            className={`text-xs transition-colors ${
              confirmDelete
                ? 'text-red-400 hover:text-red-300'
                : 'text-neutral-700 hover:text-red-500'
            }`}
          >
            {confirmDelete ? 'Delete?' : '✕'}
          </button>
        </div>
      </div>

      {/* Article rows */}
      {!collapsed && (
        <div>
          {list.articles.length === 0 ? (
            <p className="px-4 py-3 text-xs text-neutral-600 italic">
              No articles yet — add some from the Discover tab.
            </p>
          ) : (
            list.articles.map(article => (
              <div
                key={article.aTag}
                className="flex items-center gap-3 px-4 py-2.5 border-t border-neutral-800/60 hover:bg-neutral-800/30 transition-colors"
              >
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={selected.has(article.aTag)}
                  onChange={e => onToggle(article.aTag, e.target.checked)}
                  className="flex-shrink-0 accent-purple-600"
                />

                {/* Thumbnail */}
                {article.image && isSafeUrl(article.image) ? (
                  <img
                    src={article.image}
                    alt=""
                    className="w-10 h-10 rounded flex-shrink-0 object-cover bg-neutral-800"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ) : (
                  <div className="w-10 h-10 rounded flex-shrink-0 bg-neutral-800 flex items-center justify-center text-neutral-600 text-sm">
                    ✍️
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-neutral-200 truncate">{article.title}</p>
                  <p className="text-xs text-neutral-600 truncate">
                    {article.author}{article.author && article.addedAt ? ' · ' : ''}{formatDate(article.addedAt)}
                  </p>
                </div>

                {/* Remove */}
                <button
                  onClick={() => onRemoveArticle(list.id, article.aTag)}
                  className="text-neutral-700 hover:text-red-500 transition-colors text-sm flex-shrink-0"
                  aria-label="Remove from list"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
