/**
 * BookmarkChipBar — horizontal chip row for switching between bookmark
 * categories. Sits above the BookmarksTab feed (owner view only).
 *
 * Layout rules (per product spec):
 *   - Width capped at feed width (max-w-xl) so chips align with cards
 *   - Flex-wrap → chips flow to multiple rows when they outgrow the row
 *     (no horizontal scrolling; the whole chip set stays readable)
 *   - Primary ("Ungrouped") chip pinned first, then 30003 categories
 *     newest-first, then a trailing "+ New" action
 *
 * Each chip: title + item count. Active chip gets a filled purple bg.
 * "+ New" becomes an inline input on tap; Enter commits, Esc cancels.
 *
 * Manage mode (owner only): when onToggleManageMode is provided, a trailing
 * "Manage" chip flips the bar into editing. Each custom chip grows inline
 * rename + delete icons; primary stays read-only (can't rename "Ungrouped"
 * or nuke the root list). "Done" exits.
 */
import { useState, useRef, useEffect } from 'react'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'

export default function BookmarkChipBar({
  categories,
  activeCategoryId,
  onSelect,
  onCreateCategory,
  readOnly = false,
  manageMode = false,
  onToggleManageMode,
  onRenameCategory,
  onDeleteCategory,
  hiddenIds,
  onHideCategory,
  onUnhideCategory,
  privacyView = 'public',
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  // Rename state: one chip at a time.
  const [renamingId, setRenamingId] = useState(null)
  const [renameName, setRenameName] = useState('')
  const renameInputRef = useRef(null)

  // Inline delete confirm: one chip at a time. Replaces the per-chip action
  // cluster with "Delete? Yes / No" until the user picks, matching the
  // longform BookmarksPanel pattern instead of a native confirm dialog.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  // Declared up front so the effect below can close over it without
  // hitting the const TDZ.
  const hasEditable = categories.some(c => c.id !== NOTE_PRIMARY_CATEGORY_ID && !c.readOnly)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renamingId])

  // Leaving manage mode cancels any in-flight rename, delete confirm, or
  // "+ New" input — all are manage-mode-only affordances. (First-run
  // users with no editable categories see "+ New" regardless of manage
  // mode, so don't stomp creating state in that case.)
  useEffect(() => {
    if (manageMode) return
    if (renamingId) {
      setRenamingId(null)
      setRenameName('')
    }
    if (confirmDeleteId) setConfirmDeleteId(null)
    if (creating && hasEditable) {
      setCreating(false)
      setName('')
    }
  }, [manageMode, renamingId, confirmDeleteId, creating, hasEditable])

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
    if (cat?.id) onSelect?.(cat.id)
  }

  async function commitRename() {
    if (!renamingId) return
    const trimmed = renameName.trim()
    const original = categories.find(c => c.id === renamingId)?.title || ''
    if (trimmed && trimmed !== original) {
      await onRenameCategory?.(renamingId, trimmed)
    }
    setRenamingId(null)
    setRenameName('')
  }

  function startRename(cat) {
    setRenamingId(cat.id)
    setRenameName(cat.title)
  }

  // Sort primary first, then other categories in their existing order.
  // Outside manage mode we also filter out hidden chips (client-side
  // visibility preference; the underlying events still exist on relays).
  const ordered = [...categories]
    .sort((a, b) => {
      if (a.id === NOTE_PRIMARY_CATEGORY_ID) return -1
      if (b.id === NOTE_PRIMARY_CATEGORY_ID) return 1
      return 0
    })
    .filter(c => manageMode || !hiddenIds?.has(c.id))

  return (
    <div className="max-w-xl mx-auto px-4 py-3 border-b border-neutral-800">
      <div className="flex flex-wrap gap-2">
        {ordered.map(cat => {
          const isActive = cat.id === activeCategoryId
          const isPrimary = cat.id === NOTE_PRIMARY_CATEGORY_ID
          const isEditable = !isPrimary && !cat.readOnly
          const isRenaming = renamingId === cat.id

          if (isRenaming) {
            return (
              <div key={cat.id} className="flex items-center gap-1">
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameName}
                  onChange={e => setRenameName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') { setRenamingId(null); setRenameName('') }
                  }}
                  maxLength={60}
                  className="text-xs px-3 py-1.5 rounded-full bg-neutral-900 border border-purple-500 text-neutral-100 focus:outline-none min-w-[140px]"
                />
              </div>
            )
          }

          const showManageActions = manageMode && isEditable
          const isConfirmingDelete = confirmDeleteId === cat.id
          const isHidden = !!hiddenIds?.has(cat.id)
          const bucketCount = privacyView === 'private'
            ? (cat.privateItems?.length || 0)
            : (cat.items?.length || 0)
          const itemCount = bucketCount

          return (
            <div
              key={cat.id}
              className={`inline-flex items-stretch rounded-full border transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-purple-700 border-purple-700 text-white'
                  : isHidden
                    ? 'bg-neutral-900 border-dashed border-neutral-700 text-neutral-500'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-300'
              } ${showManageActions ? 'pr-1' : ''}`}
            >
              <button
                onClick={() => onSelect?.(cat.id)}
                className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap ${
                  !isActive ? (isHidden ? 'hover:text-neutral-300' : 'hover:bg-neutral-700') : ''
                }`}
              >
                {cat.title}
                <span className={`ml-1.5 ${
                  isActive ? 'text-purple-200' : isHidden ? 'text-neutral-600' : 'text-neutral-500'
                }`}>
                  · {bucketCount}
                </span>
              </button>
              {showManageActions && isConfirmingDelete && (
                <div
                  className={`flex items-center pl-2 gap-1 border-l text-xs whitespace-nowrap ${
                    isActive ? 'border-purple-300/40' : 'border-neutral-600/60'
                  }`}
                  title={(() => {
                    const total = (cat.items?.length || 0) + (cat.privateItems?.length || 0)
                    return total > 0
                      ? `Its ${total} bookmark${total === 1 ? '' : 's'} will move to Ungrouped`
                      : 'Delete this empty category'
                  })()}
                >
                  <span className={isActive ? 'text-purple-100' : 'text-neutral-400'}>Delete?</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteCategory?.(cat.id)
                      setConfirmDeleteId(null)
                    }}
                    className={`px-1 ${isActive ? 'text-red-200 hover:text-red-100' : 'text-red-400 hover:text-red-300'}`}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    className={`px-1 ${isActive ? 'text-purple-200 hover:text-purple-100' : 'text-neutral-500 hover:text-neutral-300'}`}
                  >
                    No
                  </button>
                </div>
              )}
              {showManageActions && !isConfirmingDelete && (
                <div className="flex items-center pl-1 gap-0.5 border-l border-neutral-600/60">
                  <button
                    type="button"
                    onClick={() => startRename(cat)}
                    aria-label={`Rename ${cat.title}`}
                    title="Rename"
                    className={`p-1 rounded-full hover:bg-black/20 ${
                      isActive ? 'text-purple-100' : 'text-neutral-400 hover:text-neutral-100'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M11.5 2.5l2 2L5 13l-3 1 1-3 8.5-8.5z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => (isHidden ? onUnhideCategory : onHideCategory)?.(cat.id)}
                    aria-label={isHidden ? `Show ${cat.title}` : `Hide ${cat.title}`}
                    title={isHidden ? 'Show in this view' : 'Hide from this view'}
                    className={`p-1 rounded-full hover:bg-black/20 ${
                      isActive ? 'text-purple-100' : 'text-neutral-400 hover:text-neutral-100'
                    }`}
                  >
                    {isHidden ? (
                      // eye-slash → hidden, click to show
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <path d="M2 2l12 12" strokeLinecap="round" />
                        <path d="M6.5 4.2A7.4 7.4 0 018 4c4.5 0 7 4 7 4a13 13 0 01-2 2.4M11 11.6A7.4 7.4 0 018 12c-4.5 0-7-4-7-4a13 13 0 012.6-3" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M6.6 6.6a2 2 0 002.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      // eye → visible, click to hide
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="8" cy="8" r="2" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(cat.id)}
                    aria-label={`Delete ${cat.title}`}
                    title="Delete (bookmarks move back to Ungrouped)"
                    className={`p-1 rounded-full hover:bg-black/20 ${
                      isActive ? 'text-red-200' : 'text-red-400 hover:text-red-300'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {/* "+ New" is a manage-mode affordance. We also show it when the
            user has no editable categories yet — otherwise a first-run
            user has no Manage button to toggle (it only appears once a
            custom category exists) and no way to create the first one. */}
        {!readOnly && (manageMode || !hasEditable) && (creating ? (
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
        ))}

        {!readOnly && onToggleManageMode && hasEditable && (
          <button
            onClick={() => onToggleManageMode(!manageMode)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
              manageMode
                ? 'bg-neutral-700 border-neutral-600 text-neutral-100'
                : 'border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600'
            }`}
          >
            {manageMode ? 'Done' : 'Manage'}
          </button>
        )}
      </div>
    </div>
  )
}
