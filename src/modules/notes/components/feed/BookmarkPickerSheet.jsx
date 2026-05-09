/**
 * BookmarkPickerSheet — mobile bottom sheet for managing a note's
 * bookmarks. Mirrors the desktop NoteActionBar dropdown surface so
 * mobile users can both ADD to and REMOVE from categories from the
 * same sheet — previously this surface was add-only and a
 * mobile-only user had no way to un-bookmark a note from the feed.
 *
 * Sections (in order):
 *   - Save-as pill (Public / Private) — drives the privacy of any
 *     subsequent add and toggles which bucket counts the categories
 *     show.
 *   - "In:" — categories currently holding the note (per-bucket).
 *     Tap → remove from that bucket. Hidden when the note isn't
 *     bookmarked anywhere.
 *   - "Add to:" — categories the note isn't yet in (in the active
 *     privacy bucket). Tap → add.
 *   - New-collection input pinned to the bottom.
 *
 * Portals to <body> so the parent card's absolute positioning can't
 * clip the sheet.
 *
 * Props:
 *   open, onClose,
 *   categories,                // [{ id, title, items, privateItems, ... }]
 *   containingRows,            // [{ cat, privacy }] — note's current memberships
 *   onPick(categoryId, privacy),
 *   onRemove(categoryId, privacy),
 *   onCreate(name, privacy),
 *   pending                    // truthy while an add/remove is in flight
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'

export default function BookmarkPickerSheet({
  open,
  onClose,
  categories,
  containingRows = [],
  onPick,
  onRemove,
  onCreate,
  pending,
}) {
  const [newName, setNewName] = useState('')
  const [privacy, setPrivacy] = useState('public')
  const sheetRef = useRef(null)

  // Reset privacy target whenever the sheet reopens so the prior target
  // doesn't silently persist. Matches the desktop submenu's behavior.
  useEffect(() => { if (!open) setPrivacy('public') }, [open])

  // Lock body scroll while the sheet is open so the user's drag-to-scroll
  // lands on the sheet's own list, not the feed behind it.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const ordered = [...categories].sort((a, b) => {
    if (a.id === NOTE_PRIMARY_CATEGORY_ID) return -1
    if (b.id === NOTE_PRIMARY_CATEGORY_ID) return 1
    return 0
  })

  // Drop categories already holding the note in the *active* privacy
  // bucket from the "Add to:" list — same logic the desktop dropdown
  // uses (see NoteActionBar.addableCategories). Without this filter, a
  // bookmarked note's category would appear in BOTH the "In:" remove
  // section AND the "Add to:" list, and tapping the latter would no-op.
  const addable = ordered.filter(cat => {
    const held = privacy === 'private'
      ? containingRows.some(r => r.cat.id === cat.id && r.privacy === 'private')
      : containingRows.some(r => r.cat.id === cat.id && r.privacy === 'public')
    return !held
  })

  function handleCreate() {
    const name = newName.trim()
    if (!name) return
    onCreate?.(name, privacy)
    setNewName('')
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={sheetRef}
        className="relative w-full bg-neutral-900 border-t border-neutral-800 rounded-t-2xl max-h-[75vh] flex flex-col"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-medium text-neutral-200">Add to bookmarks</h3>
          <button
            onClick={onClose}
            className="text-xs text-neutral-500 hover:text-neutral-200 px-2 py-1"
          >
            Cancel
          </button>
        </header>

        <div className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Save as</span>
          <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
            <button
              type="button"
              onClick={() => setPrivacy('public')}
              className={`text-xs px-3 py-1 rounded-full transition-colors ${
                privacy === 'public' ? 'bg-purple-700 text-white' : 'text-neutral-400'
              }`}
            >
              Public
            </button>
            <button
              type="button"
              onClick={() => setPrivacy('private')}
              title="NIP-51 encrypted — visible only to you"
              className={`text-xs px-3 py-1 rounded-full transition-colors inline-flex items-center gap-1 ${
                privacy === 'private' ? 'bg-purple-700 text-white' : 'text-neutral-400'
              }`}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
              </svg>
              Private
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {ordered.length === 0 && (
            <p className="px-4 py-6 text-xs text-neutral-500 text-center italic">
              No collections yet. Create one below.
            </p>
          )}

          {/* "In:" — current memberships across both privacy buckets.
              Tap removes from that specific bucket. Owner-only by
              construction (containingRows is only populated when the
              session user owns the bookmark categories). */}
          {containingRows.length > 0 && (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-500">In</p>
              {containingRows.map(({ cat, privacy: rowPrivacy }) => (
                <button
                  key={`in-${cat.id}-${rowPrivacy}`}
                  onClick={() => onRemove?.(cat.id, rowPrivacy)}
                  disabled={!!pending}
                  className="w-full text-left px-4 py-3 text-sm text-amber-400 border-b border-neutral-800 hover:bg-neutral-800 transition-colors disabled:opacity-50 flex items-center justify-between gap-2"
                  title={`Remove from ${cat.title}${rowPrivacy === 'private' ? ' (private)' : ''}`}
                >
                  <span className="truncate inline-flex items-center gap-2 min-w-0">
                    {rowPrivacy === 'private' && (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="flex-shrink-0">
                        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                      </svg>
                    )}
                    <span className="truncate">{cat.title}</span>
                  </span>
                  <span className="text-xs text-neutral-500 shrink-0">remove</span>
                </button>
              ))}
            </>
          )}

          {addable.length > 0 && (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                {containingRows.length > 0 ? 'Add to' : ''}
              </p>
              {addable.map(cat => {
                const count = privacy === 'private'
                  ? (cat.privateItems?.length || 0)
                  : (cat.items?.length || 0)
                return (
                  <button
                    key={cat.id}
                    onClick={() => onPick?.(cat.id, privacy)}
                    disabled={!!pending}
                    className="w-full text-left px-4 py-3 text-sm text-neutral-200 border-b border-neutral-800 hover:bg-neutral-800 transition-colors disabled:opacity-50 flex items-center justify-between"
                  >
                    <span className="truncate">{cat.title}</span>
                    <span className="text-xs text-neutral-500 ml-2 shrink-0">
                      {count}
                    </span>
                  </button>
                )
              })}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-800 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            placeholder="New collection name…"
            maxLength={60}
            disabled={!!pending}
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-purple-500 disabled:opacity-50"
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || !!pending}
            className="text-sm px-4 py-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
            aria-label="Add new collection"
          >
            ✓
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
