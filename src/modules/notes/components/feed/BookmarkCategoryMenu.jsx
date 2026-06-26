/**
 * BookmarkCategoryMenu — collapsible header dropdown for switching between
 * bookmark categories.
 *
 * Header bar (always visible):
 *   📁 <active title> · <count> bookmarks    <total> groups  ▾
 *
 * The folder icon + "N groups" subscript are the load-bearing cues that
 * the chevron is a list expander, not just a label. Without them users
 * stared at "Ungrouped · 2 bookmarks ▾" wondering what the dropdown was for.
 *
 * Dropdown panel (open):
 *   - Active category first, marked with ✓
 *   - Then everything else sorted by recency (multi-entry MRU) → then by
 *     bookmark count desc. So 0-count groups land at the bottom unless
 *     they were just visited.
 *   - Each editable row has a three-dot menu on the right that reveals
 *     inline Rename / Hide / Delete actions in place of the count. No
 *     separate manage-mode toggle — actions are always one click away.
 *   - Hidden categories are filtered by default; "+N hidden" footer link
 *     toggles them visible (session-scoped) so users can unhide.
 *   - Footer holds "+ New category".
 *
 * MRU persistence: per-pubkey list of category IDs in last-visited order
 * (oldest pushed off when capacity is hit). localStorage key
 * storageKey(`bookmarks_mru_<npub>`).
 */

import { storageKey } from '../../../../lib/brand.js'
import { useState, useRef, useEffect, useMemo } from 'react'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'

const MRU_PREFIX = storageKey('bookmarks_mru_')
const MRU_MAX    = 8

function mruKey(pubkey) { return `${MRU_PREFIX}${pubkey || 'anon'}` }
function loadMRU(pubkey) {
  try {
    const raw = localStorage.getItem(mruKey(pubkey))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(x => typeof x === 'string').slice(0, MRU_MAX)
      : []
  } catch { return [] }
}
function saveMRU(pubkey, list) {
  try { localStorage.setItem(mruKey(pubkey), JSON.stringify(list.slice(0, MRU_MAX))) } catch {}
}
function bumpMRU(list, id) {
  return [id, ...list.filter(i => i !== id)].slice(0, MRU_MAX)
}

export default function BookmarkCategoryMenu({
  categories,
  activeCategoryId,
  onSelect,
  onCreateCategory,
  readOnly = false,
  // Manage-mode props are accepted for back-compat but no longer drive
  // a separate toggle — three-dot per-row replaces them.
  onRenameCategory,
  onDeleteCategory,
  hiddenIds,
  onHideCategory,
  onUnhideCategory,
  privacyView = 'public',
  pubkey,
}) {
  const [open, setOpen] = useState(false)
  const headerRef = useRef(null)
  const panelRef = useRef(null)

  // ── MRU memory ──
  const [mru, setMru] = useState(() => loadMRU(pubkey))
  const lastActiveRef = useRef(activeCategoryId)
  useEffect(() => {
    if (lastActiveRef.current && lastActiveRef.current !== activeCategoryId) {
      // Bump the previous-active to the front of the MRU. Don't bump the
      // newly-active one — it's already at the top of the list as
      // "currently visible" via the active-row pin in the dropdown.
      const prev = lastActiveRef.current
      setMru(curr => {
        const next = bumpMRU(curr, prev)
        saveMRU(pubkey, next)
        return next
      })
    }
    lastActiveRef.current = activeCategoryId
  }, [activeCategoryId, pubkey])

  // ── Per-row state ──
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const newInputRef = useRef(null)
  const [openActionsId, setOpenActionsId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renameName, setRenameName] = useState('')
  const renameInputRef = useRef(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [pendingRow, setPendingRow] = useState({ id: null, action: null, error: '' })
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => { if (creating) newInputRef.current?.focus() }, [creating])
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renamingId])

  // Closing the dropdown also clears any in-flight per-row sub-state.
  useEffect(() => {
    if (open) return
    setOpenActionsId(null)
    if (renamingId) { setRenamingId(null); setRenameName('') }
    if (confirmDeleteId) setConfirmDeleteId(null)
    if (creating) { setCreating(false); setName('') }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Click-outside / Esc to close.
  useEffect(() => {
    if (!open) return
    function onPointer(e) {
      if (panelRef.current?.contains(e.target)) return
      if (headerRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function countFor(cat) {
    if (!cat) return 0
    return privacyView === 'private'
      ? (cat.privateItems?.length || 0)
      : (cat.items?.length || 0)
  }

  // ── Visible rows: filter by hidden state, then sort.
  const orderedRows = useMemo(() => {
    const visibleMask = (c) => showHidden || !hiddenIds?.has(c.id)
    const visible = categories.filter(visibleMask)
    const active = visible.find(c => c.id === activeCategoryId) || null
    const others = visible.filter(c => c.id !== activeCategoryId)

    const mruIdx = (id) => {
      const i = mru.indexOf(id)
      return i === -1 ? Infinity : i
    }
    others.sort((a, b) => {
      const ai = mruIdx(a.id)
      const bi = mruIdx(b.id)
      if (ai !== bi) return ai - bi  // recent first
      return countFor(b) - countFor(a)  // then by count desc
    })
    return { active, others }
  }, [categories, activeCategoryId, mru, hiddenIds, showHidden, privacyView])

  const hiddenCount = useMemo(
    () => (hiddenIds && hiddenIds.size) ? categories.filter(c => hiddenIds.has(c.id)).length : 0,
    [categories, hiddenIds],
  )

  // ── Handlers
  async function commitNew() {
    const trimmed = name.trim()
    if (!trimmed) { setCreating(false); setName(''); return }
    const cat = await onCreateCategory?.(trimmed)
    setName('')
    setCreating(false)
    if (cat?.id) {
      onSelect?.(cat.id)
      setOpen(false)
    }
  }

  function startRename(cat) {
    setOpenActionsId(null)
    setRenamingId(cat.id)
    setRenameName(cat.title)
  }

  async function commitRename() {
    if (!renamingId) return
    const trimmed = renameName.trim()
    const original = categories.find(c => c.id === renamingId)?.title || ''
    if (!trimmed || trimmed === original) {
      setRenamingId(null); setRenameName('')
      return
    }
    const id = renamingId
    setPendingRow({ id, action: 'renaming', error: '' })
    try {
      const ok = await onRenameCategory?.(id, trimmed)
      if (ok === false) {
        setPendingRow({ id, action: null, error: 'Rename failed' })
        setTimeout(() => setPendingRow(prev => prev.error === 'Rename failed' ? { id: null, action: null, error: '' } : prev), 3500)
        return
      }
      setPendingRow({ id: null, action: null, error: '' })
      setRenamingId(null); setRenameName('')
    } catch {
      setPendingRow({ id, action: null, error: 'Rename failed' })
      setTimeout(() => setPendingRow(prev => prev.error === 'Rename failed' ? { id: null, action: null, error: '' } : prev), 3500)
    }
  }

  async function runDelete(catId) {
    setPendingRow({ id: catId, action: 'deleting', error: '' })
    try {
      const ok = await onDeleteCategory?.(catId)
      if (ok === false) {
        setPendingRow({ id: catId, action: null, error: 'Delete failed' })
        setTimeout(() => setPendingRow(prev => prev.error === 'Delete failed' ? { id: null, action: null, error: '' } : prev), 3500)
        return
      }
      setPendingRow({ id: null, action: null, error: '' })
      setConfirmDeleteId(null)
      setOpenActionsId(null)
    } catch {
      setPendingRow({ id: catId, action: null, error: 'Delete failed' })
      setTimeout(() => setPendingRow(prev => prev.error === 'Delete failed' ? { id: null, action: null, error: '' } : prev), 3500)
    }
  }

  function handleSelect(catId) {
    onSelect?.(catId)
    setOpen(false)
  }

  function handleHide(catId) {
    onHideCategory?.(catId)
    setOpenActionsId(null)
  }
  function handleUnhide(catId) {
    onUnhideCategory?.(catId)
    setOpenActionsId(null)
  }

  // ── Empty state — no categories yet.
  if (categories.length === 0) {
    return (
      <div className="max-w-xl mx-auto w-full px-4 py-3 border-b border-neutral-800">
        {!readOnly && (creating ? (
          <input
            ref={newInputRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={commitNew}
            onKeyDown={e => {
              if (e.key === 'Enter') commitNew()
              if (e.key === 'Escape') { setCreating(false); setName('') }
            }}
            placeholder="Category name…"
            maxLength={60}
            className="w-full text-sm px-3 py-2 rounded-lg bg-neutral-900 border border-purple-500 text-neutral-100 focus:outline-none"
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full text-sm px-3 py-2 rounded-lg border border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors"
          >
            + New category
          </button>
        ))}
      </div>
    )
  }

  const activeCat = orderedRows.active
  const activeCount = countFor(activeCat)
  const totalGroups = categories.length
  const visibleGroupCount = totalGroups - (hiddenIds?.size || 0)

  return (
    <div className="max-w-xl mx-auto w-full px-4 py-3 border-b border-neutral-800">
      {/* ── Header bar ── */}
      <button
        ref={headerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-neutral-800 bg-neutral-900 hover:border-neutral-700 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <FolderIcon className="text-purple-400 shrink-0" />
          <span className="text-sm text-neutral-200 truncate">
            {activeCat?.title || 'No category'}
          </span>
          <span className="text-sm text-neutral-500 shrink-0">
            · {activeCount} bookmark{activeCount === 1 ? '' : 's'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0 text-xs text-neutral-500">
          <span>{visibleGroupCount} group{visibleGroupCount === 1 ? '' : 's'}</span>
          <svg
            width="14" height="14" viewBox="0 0 16 16"
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
          >
            <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {/* ── Dropdown panel ── */}
      {open && (
        <div
          ref={panelRef}
          role="listbox"
          className="mt-2 rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden"
        >
          {orderedRows.active && (
            <CategoryRow
              cat={orderedRows.active}
              isActive
              count={countFor(orderedRows.active)}
              hidden={!!hiddenIds?.has(orderedRows.active.id)}
              actionsOpen={openActionsId === orderedRows.active.id}
              onToggleActions={() => setOpenActionsId(prev => prev === orderedRows.active.id ? null : orderedRows.active.id)}
              renamingId={renamingId}
              renameName={renameName}
              renameInputRef={renameInputRef}
              setRenameName={setRenameName}
              commitRename={commitRename}
              cancelRename={() => { setRenamingId(null); setRenameName('') }}
              startRename={startRename}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              runDelete={runDelete}
              pendingRow={pendingRow}
              onHide={handleHide}
              onUnhide={handleUnhide}
              onSelect={handleSelect}
            />
          )}
          {orderedRows.others.map(cat => (
            <CategoryRow
              key={cat.id}
              cat={cat}
              count={countFor(cat)}
              hidden={!!hiddenIds?.has(cat.id)}
              actionsOpen={openActionsId === cat.id}
              onToggleActions={() => setOpenActionsId(prev => prev === cat.id ? null : cat.id)}
              renamingId={renamingId}
              renameName={renameName}
              renameInputRef={renameInputRef}
              setRenameName={setRenameName}
              commitRename={commitRename}
              cancelRename={() => { setRenamingId(null); setRenameName('') }}
              startRename={startRename}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              runDelete={runDelete}
              pendingRow={pendingRow}
              onHide={handleHide}
              onUnhide={handleUnhide}
              onSelect={handleSelect}
            />
          ))}

          {/* Hidden-categories toggle — only when there's something hidden */}
          {hiddenCount > 0 && !readOnly && (
            <button
              type="button"
              onClick={() => setShowHidden(s => !s)}
              className="w-full px-3 py-2 text-[11px] text-neutral-500 hover:text-neutral-300 border-t border-neutral-800/60 text-left transition-colors"
            >
              {showHidden
                ? `▾ Hide ${hiddenCount} hidden categor${hiddenCount === 1 ? 'y' : 'ies'}`
                : `▸ Show ${hiddenCount} hidden categor${hiddenCount === 1 ? 'y' : 'ies'}`}
            </button>
          )}

          {/* Footer — "+ New category" only; manage toggle is gone */}
          {!readOnly && (
            <div className="border-t border-neutral-800 px-3 py-2">
              {creating ? (
                <input
                  ref={newInputRef}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onBlur={commitNew}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitNew()
                    if (e.key === 'Escape') { setCreating(false); setName('') }
                  }}
                  placeholder="Category name…"
                  maxLength={60}
                  className="w-full text-xs px-2 py-1.5 rounded bg-neutral-950 border border-purple-500 text-neutral-100 focus:outline-none"
                />
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="text-xs px-2 py-1 rounded border border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors"
                >
                  + New category
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FolderIcon({ className = '' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M1.5 4.5a1 1 0 011-1h3.5l1.5 1.5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7.5z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * One row of the dropdown list. Renders in one of four states:
 *   - default: title + count + three-dot (editable rows only)
 *   - actions open: inline action buttons (Rename / Hide / Delete) replacing count
 *   - renaming: inline text input
 *   - confirming delete: "Delete? Yes / No" cluster
 */
function CategoryRow({
  cat, isActive = false, count, hidden,
  actionsOpen, onToggleActions,
  renamingId, renameName, renameInputRef, setRenameName, commitRename, cancelRename, startRename,
  confirmDeleteId, setConfirmDeleteId, runDelete,
  pendingRow,
  onHide, onUnhide,
  onSelect,
}) {
  const isPrimary = cat.id === NOTE_PRIMARY_CATEGORY_ID
  const isEditable = !isPrimary && !cat.readOnly
  const isRenaming = renamingId === cat.id
  const isConfirmingDelete = confirmDeleteId === cat.id
  const isPending = pendingRow.id === cat.id

  if (isRenaming) {
    const isPendingRename = isPending && pendingRow.action === 'renaming'
    const hasErr = isPending && pendingRow.error === 'Rename failed'
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-t border-neutral-800/60 first:border-t-0 bg-neutral-950/40">
        <input
          ref={renameInputRef}
          type="text"
          value={renameName}
          onChange={e => setRenameName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') cancelRename()
          }}
          disabled={isPendingRename}
          maxLength={60}
          className="flex-1 text-sm px-2 py-1 rounded bg-neutral-900 border border-purple-500 text-neutral-100 focus:outline-none disabled:opacity-60"
        />
        {isPendingRename && (
          <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Saving…
          </span>
        )}
        {hasErr && <span className="text-[11px] text-red-400">⚠️ Failed</span>}
      </div>
    )
  }

  if (isConfirmingDelete) {
    const isPendingDelete = isPending && pendingRow.action === 'deleting'
    const hasErr = isPending && pendingRow.error === 'Delete failed'
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-t border-neutral-800/60 first:border-t-0 bg-red-950/20">
        <span className="text-sm text-neutral-200 truncate flex-1">{cat.title}</span>
        {isPendingDelete ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
            <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Deleting…
          </span>
        ) : hasErr ? (
          <>
            <span className="text-[11px] text-red-400">⚠️ Failed</span>
            <button onClick={() => runDelete(cat.id)} className="text-[11px] text-red-300 hover:text-red-200 px-1">Retry</button>
            <button onClick={() => setConfirmDeleteId(null)} className="text-[11px] text-neutral-400 hover:text-neutral-200 px-1">Cancel</button>
          </>
        ) : (
          <>
            <span className="text-[11px] text-neutral-400">Delete?</span>
            <button onClick={() => runDelete(cat.id)} className="text-[11px] text-red-400 hover:text-red-300 px-1">Yes</button>
            <button onClick={() => setConfirmDeleteId(null)} className="text-[11px] text-neutral-400 hover:text-neutral-200 px-1">No</button>
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-t border-neutral-800/60 first:border-t-0 transition-colors ${
        isActive ? 'bg-purple-950/40' : 'hover:bg-neutral-800/40'
      } ${hidden ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSelect(cat.id)}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        role="option"
        aria-selected={isActive}
      >
        <span className={`shrink-0 w-3.5 inline-flex items-center justify-center text-xs ${
          isActive ? 'text-purple-300' : 'text-transparent'
        }`} aria-hidden="true">
          {isActive ? '✓' : ''}
        </span>
        <span className={`text-sm truncate ${isActive ? 'text-purple-200 font-medium' : 'text-neutral-200'}`}>
          {cat.title}
        </span>
      </button>

      {/* Right-side cluster: either the inline actions (when open) or count + three-dot */}
      {actionsOpen && isEditable ? (
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => startRename(cat)}
            aria-label={`Rename ${cat.title}`}
            title="Rename"
            className="p-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M11.5 2.5l2 2L5 13l-3 1 1-3 8.5-8.5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => (hidden ? onUnhide : onHide)?.(cat.id)}
            aria-label={hidden ? `Show ${cat.title}` : `Hide ${cat.title}`}
            title={hidden ? 'Show in list' : 'Hide from list'}
            className="p-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
          >
            {hidden ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M2 2l12 12" strokeLinecap="round" />
                <path d="M6.5 4.2A7.4 7.4 0 018 4c4.5 0 7 4 7 4a13 13 0 01-2 2.4M11 11.6A7.4 7.4 0 018 12c-4.5 0-7-4-7-4a13 13 0 012.6-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.6 6.6a2 2 0 002.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="8" cy="8" r="2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDeleteId(cat.id)}
            aria-label={`Delete ${cat.title}`}
            title="Delete (bookmarks move to Ungrouped)"
            className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-neutral-800"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onToggleActions}
            aria-label="Close actions"
            title="Close"
            className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-neutral-500">{count}</span>
          {isEditable && (
            <button
              type="button"
              onClick={onToggleActions}
              aria-label={`Actions for ${cat.title}`}
              title="Actions"
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3" cy="8" r="1.4" />
                <circle cx="8" cy="8" r="1.4" />
                <circle cx="13" cy="8" r="1.4" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
