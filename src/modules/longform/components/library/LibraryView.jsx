import { useState } from 'react'
import ReadingListSection from './ReadingListSection.jsx'
import ExportMenu from './ExportMenu.jsx'

export default function LibraryView({ lists, loading, createList, removeArticle, deleteList }) {
  const [selected,    setSelected]    = useState(new Set())  // Set of aTags
  const [newListName, setNewListName] = useState('')
  const [creating,    setCreating]    = useState(false)
  const [showInput,   setShowInput]   = useState(false)

  function handleToggle(aTag, on) {
    setSelected(prev => {
      const next = new Set(prev)
      on ? next.add(aTag) : next.delete(aTag)
      return next
    })
  }

  async function handleCreate(e) {
    e.preventDefault()
    const name = newListName.trim()
    if (!name) return
    setCreating(true)
    try {
      await createList(name)
      setNewListName('')
      setShowInput(false)
    } finally {
      setCreating(false)
    }
  }

  // Build array of selected article metadata (for ExportMenu)
  const allArticles   = lists.flatMap(l => l.articles)
  const selectedMetas = allArticles.filter(a => selected.has(a.aTag))

  // Find the list title for single-list selection (or fall back to generic)
  const selectedListTitle = (() => {
    if (!selectedMetas.length) return 'Reading List'
    const sourceLists = lists.filter(l => l.articles.some(a => selected.has(a.aTag)))
    return sourceLists.length === 1 ? sourceLists[0].title : 'Reading List'
  })()

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Export bar — shown only when articles are selected */}
      <ExportMenu
        selectedArticles={selectedMetas}
        listTitle={selectedListTitle}
        onClearSelection={() => setSelected(new Set())}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : lists.length === 0 && !showInput ? (
          <div className="text-center py-12 space-y-2">
            <p className="text-sm text-neutral-500">No reading lists yet.</p>
            <button
              onClick={() => setShowInput(true)}
              className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
            >
              + Create your first list
            </button>
          </div>
        ) : (
          lists.map(list => (
            <ReadingListSection
              key={list.id}
              list={list}
              selected={selected}
              onToggle={handleToggle}
              onRemoveArticle={removeArticle}
              onDeleteList={deleteList}
            />
          ))
        )}

        {/* New list form */}
        {showInput ? (
          <form onSubmit={handleCreate} className="flex gap-2">
            <input
              autoFocus
              type="text"
              value={newListName}
              onChange={e => setNewListName(e.target.value)}
              placeholder="List name…"
              maxLength={80}
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 placeholder-neutral-600"
            />
            <button
              type="submit"
              disabled={!newListName.trim() || creating}
              className="px-3 py-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white text-sm transition-colors"
            >
              {creating ? '…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => { setShowInput(false); setNewListName('') }}
              className="px-3 py-2 rounded border border-neutral-700 text-neutral-500 hover:text-neutral-300 text-sm transition-colors"
            >
              Cancel
            </button>
          </form>
        ) : (
          lists.length > 0 && (
            <button
              onClick={() => setShowInput(true)}
              className="w-full py-2 border border-dashed border-neutral-800 rounded text-xs text-neutral-600 hover:text-neutral-400 hover:border-neutral-600 transition-colors"
            >
              + New list
            </button>
          )
        )}
      </div>
    </div>
  )
}
