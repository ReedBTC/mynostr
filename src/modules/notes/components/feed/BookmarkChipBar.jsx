/**
 * BookmarkChipBar — horizontal chip row for switching between bookmark
 * categories. Sits above the BookmarksTab feed (owner view only).
 *
 * Layout rules (per product spec):
 *   - Width capped at feed width (max-w-xl) so chips align with cards
 *   - Flex-wrap → chips flow to multiple rows when they outgrow the row
 *     (no horizontal scrolling; the whole chip set stays readable)
 *   - Primary ("Bookmarks") chip pinned first, then 30003 categories
 *     newest-first, then a trailing "+ New" action
 *
 * Each chip: title + item count. Active chip gets a filled purple bg.
 * "+ New" becomes an inline input on tap; Enter commits, Esc cancels.
 */
import { useState, useRef, useEffect } from 'react'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'

export default function BookmarkChipBar({
  categories,
  activeCategoryId,
  onSelect,
  onCreateCategory,
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  async function commit() {
    const trimmed = name.trim()
    if (!trimmed) {
      setCreating(false)
      setName('')
      return
    }
    const cat = await onCreateCategory?.(trimmed)
    setName('')
    setCreating(false)
    // Select the new chip so the user can start adding notes to it.
    if (cat?.id) onSelect?.(cat.id)
  }

  // Sort primary first, then other categories in their existing order.
  const ordered = [...categories].sort((a, b) => {
    if (a.id === NOTE_PRIMARY_CATEGORY_ID) return -1
    if (b.id === NOTE_PRIMARY_CATEGORY_ID) return 1
    return 0
  })

  return (
    <div className="max-w-xl mx-auto px-4 py-3 border-b border-neutral-800">
      <div className="flex flex-wrap gap-2">
        {ordered.map(cat => {
          const isActive = cat.id === activeCategoryId
          return (
            <button
              key={cat.id}
              onClick={() => onSelect?.(cat.id)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-purple-700 border-purple-700 text-white'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {cat.title}
              <span className={`ml-1.5 ${isActive ? 'text-purple-200' : 'text-neutral-500'}`}>
                · {cat.items?.length || 0}
              </span>
            </button>
          )
        })}

        {creating ? (
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setCreating(false); setName('') }
            }}
            placeholder="Category name…"
            maxLength={60}
            className="text-xs px-3 py-1.5 rounded-full bg-neutral-900 border border-purple-500 text-neutral-100 focus:outline-none min-w-[140px]"
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 rounded-full border border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors whitespace-nowrap"
          >
            + New
          </button>
        )}
      </div>
    </div>
  )
}
