/**
 * EventActionsMenu — three-dot popover for kind 31922/31923 events.
 *
 * Mirrors ArticleActionsMenu's chrome: portaled to body, positions
 * itself off the trigger's bounding rect, flips above when there's
 * not enough room below, dismisses on scroll/resize. Single trigger
 * lives at the top of EventDetail next to the Back button.
 *
 * Sections (each conditional on its props):
 *   • Copy naddr        — addressable identifier for replaceable kinds
 *   • Copy share link   — mynostr URL on the author's npub
 *   • Load in editor    — owner-only; seeds the composer via
 *                         localStorage and navigates to /events/write
 *   • Export JSON       — clean spec-compliant kind 31922/31923 file
 *   • View on njump.me  — universal NIP-19 viewer
 *   • View on Plektos   — Plektos meetup client (route confirmed at
 *                         derekross/plektos repo: `/event/:eventId`
 *                         accepts naddr1…)
 *   • Delete            — owner-only; kind-5 deletion request
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '../../../lib/zIndex.js'
import { copyToClipboard, titleToSlug } from '../../../lib/utils.js'
import { formToEventTemplate, eventToForm } from '../../../lib/eventForm.js'
import { deleteCalendarEvent } from '../../../lib/eventPublish.js'
import { downloadEventIcs } from '../../../lib/ics.js'
import AddToCalendarModal from './AddToCalendarModal.jsx'

export default function EventActionsMenu({
  open,
  onClose,
  parsed,                  // parseCalendarEvent shape
  triggerRef,              // anchor for portaled position
  isOwner = false,
  sessionUser = null,      // gates the "Save to calendar" item to logged-in users
  onLoadInEditor,          // optional — owner-only; ({ snapshot, naddr })
  onDeleted,               // optional — fires after a successful kind-5
}) {
  const [copied, setCopied] = useState(null) // 'naddr' | 'url' | null
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [showCalendarPicker, setShowCalendarPicker] = useState(false)

  const mountedRef = useRef(true)
  const copyTimerRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  // Portal positioning — same heuristic as ArticleActionsMenu.
  // Anchors below the trigger, flips above when there's more room up
  // than down. Caps maxHeight so the menu never overflows the viewport.
  const [menuPos, setMenuPos] = useState(null)
  useEffect(() => {
    if (!open || !triggerRef?.current) { setMenuPos(null); return }
    const rect = triggerRef.current.getBoundingClientRect()
    const ESTIMATED_HEIGHT = 280
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const flipAbove  = spaceBelow < ESTIMATED_HEIGHT && spaceAbove > spaceBelow
    const maxHeight = Math.max(120, (flipAbove ? spaceAbove : spaceBelow) - 8)
    setMenuPos(flipAbove
      ? { bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right, maxHeight }
      : { top: rect.bottom + 4, right: window.innerWidth - rect.right, maxHeight })
    function dismiss() { onClose?.() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, triggerRef, onClose])

  // Click-outside / Escape close. Stop propagation on the menu itself
  // so clicks inside don't bubble to the document listener.
  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (triggerRef?.current?.contains(e.target)) return
      if (e.target.closest && e.target.closest('[data-event-actions-menu="true"]')) return
      onClose?.()
    }
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, triggerRef])

  // Don't bail early when only the menu is closed — the calendar
  // picker outlives the menu (the menu closes the moment the user
  // clicks "Save to calendar…", but the modal needs to stay open
  // until the user dismisses it).
  if (!open && !showCalendarPicker) return null
  // The menu itself still respects open + position. Below, only the
  // calendar modal renders when !open.
  const menuVisible = open && (!triggerRef || menuPos)

  const naddr = parsed?.naddr || ''
  // Short-form share URL — the bech32 resolver at /:identifier decodes
  // the naddr and redirects to the canonical /<authorNpub>/events/<naddr>
  // page. Cleaner to paste in tweets/DMs than the long form, and the
  // recipient lands on the same place either way.
  const shareUrl = (typeof window !== 'undefined' && naddr)
    ? `${window.location.origin}/${naddr}`
    : ''

  async function handleCopy(kind) {
    const text = kind === 'url' ? shareUrl : naddr
    if (!text) return
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null
      if (!mountedRef.current) return
      setCopied(null)
      onClose?.()
    }, 1200)
  }

  function handleExport() {
    if (!parsed) return
    try {
      // Round-trip through eventToForm → formToEventTemplate so the
      // exported file is identical in shape to one produced by the
      // composer's Export action. Strip nothing — exporting a fully
      // realized event keeps its dTag (we strip on import; see
      // EventComposer.handleImportFile).
      const snapshot = eventToForm({
        id: parsed.id,
        pubkey: parsed.pubkey,
        kind: parsed.kind,
        tags: rebuildTags(parsed),
        content: parsed.content,
        created_at: parsed.createdAt,
      })
      if (!snapshot) return
      const ev = formToEventTemplate(snapshot, { pubkey: parsed.pubkey })
      const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const slug = titleToSlug(parsed.title) || 'event'
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Encoding failures shouldn't blow up the menu — silently no-op.
    }
    onClose?.()
  }

  function handleLoadInEditor() {
    if (!onLoadInEditor || !parsed) return
    const snapshot = eventToForm({
      id: parsed.id,
      pubkey: parsed.pubkey,
      kind: parsed.kind,
      tags: rebuildTags(parsed),
      content: parsed.content,
      created_at: parsed.createdAt,
    })
    if (!snapshot) return
    onLoadInEditor({ snapshot, naddr })
    onClose?.()
  }

  async function handleDelete() {
    if (deleting || !parsed) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteCalendarEvent({ kind: parsed.kind, eventId: parsed.id, dTag: parsed.dTag })
      if (mountedRef.current) {
        setDeleting(false)
        setConfirmDelete(false)
        onClose?.()
      }
      onDeleted?.()
    } catch (e) {
      if (mountedRef.current) {
        setDeleting(false)
        setDeleteError(e?.message || 'Delete failed.')
      }
    }
  }

  const njumpUrl   = naddr ? `https://njump.me/${naddr}` : ''
  const plektosUrl = naddr ? `https://plektos.app/event/${naddr}` : ''

  const menu = (
    <div
      data-event-actions-menu="true"
      className={
        triggerRef
          ? `fixed bg-neutral-800 border border-neutral-700 rounded shadow-xl ${Z.portaledMenu} w-[240px] max-h-[70vh] overflow-y-auto`
          : 'absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 w-[240px] max-h-[70vh] overflow-y-auto'
      }
      style={triggerRef ? menuPos : undefined}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {naddr && (
        <>
          <button
            onClick={() => handleCopy('naddr')}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            {copied === 'naddr' ? '✓ Copied!' : 'Copy naddr'}
          </button>
          {shareUrl && (
            <button
              onClick={() => handleCopy('url')}
              className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              {copied === 'url' ? '✓ Copied!' : 'Copy share link'}
            </button>
          )}
        </>
      )}

      {(isOwner && onLoadInEditor) || parsed ? <div className="border-t border-neutral-700" /> : null}

      {parsed && sessionUser?.pubkey && (
        <button
          onClick={() => { setShowCalendarPicker(true); onClose?.() }}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Save to calendar…
        </button>
      )}
      {parsed && (
        <button
          onClick={() => { downloadEventIcs(parsed); onClose?.() }}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Export .ics
        </button>
      )}
      {isOwner && onLoadInEditor && (
        <button
          onClick={handleLoadInEditor}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Load in editor
        </button>
      )}
      {parsed && (
        <button
          onClick={handleExport}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Export JSON
        </button>
      )}

      {(njumpUrl || plektosUrl) && <div className="border-t border-neutral-700" />}

      {njumpUrl && (
        <a
          href={njumpUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onClose?.()}
          className="block w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          View on njump.me ↗
        </a>
      )}
      {plektosUrl && (
        <a
          href={plektosUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onClose?.()}
          className="block w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          View on Plektos ↗
        </a>
      )}

      {isOwner && (
        <>
          <div className="border-t border-neutral-700" />
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-950/40 transition-colors"
            >
              Delete event
            </button>
          ) : (
            <div className="px-3 py-2 space-y-2">
              <p className="text-[11px] text-neutral-300">Delete this event?</p>
              {deleteError && (
                <p className="text-[10px] text-red-400">{deleteError}</p>
              )}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => { setConfirmDelete(false); setDeleteError('') }}
                  disabled={deleting}
                  className="flex-1 text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex-1 text-[11px] px-2 py-1 rounded border border-red-700 bg-red-950/40 text-red-200 hover:bg-red-900/60 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                >
                  {deleting ? (
                    <>
                      <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                      <span>Deleting…</span>
                    </>
                  ) : 'Confirm'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )

  // Wrap so menu and the calendar picker can co-exist. The picker
  // outlives the menu — clicking "Save to calendar" closes the menu
  // and opens the modal alongside it.
  const composed = (
    <>
      {menuVisible && menu}
      {showCalendarPicker && (
        <AddToCalendarModal
          parsed={parsed}
          sessionUser={sessionUser}
          onClose={() => setShowCalendarPicker(false)}
        />
      )}
    </>
  )

  return triggerRef ? createPortal(composed, document.body) : composed
}

/**
 * The parsed event shape doesn't carry the raw tags array — the
 * round-trip helpers (eventToForm / formToEventTemplate) need one.
 * Reconstruct just enough so eventToForm can read what it cares
 * about (d, title, summary, start, end, tzids, image, location, g, t).
 */
function rebuildTags(parsed) {
  const tags = []
  if (parsed.dTag) tags.push(['d', parsed.dTag])
  if (parsed.title) tags.push(['title', parsed.title])
  if (parsed.start) tags.push(['start', parsed.start])
  if (parsed.end) tags.push(['end', parsed.end])
  if (parsed.startTzid) tags.push(['start_tzid', parsed.startTzid])
  if (parsed.endTzid && parsed.endTzid !== parsed.startTzid) tags.push(['end_tzid', parsed.endTzid])
  if (parsed.summary) tags.push(['summary', parsed.summary])
  if (parsed.image) tags.push(['image', parsed.image])
  if (parsed.location) tags.push(['location', parsed.location])
  if (parsed.geohash) tags.push(['g', parsed.geohash])
  for (const t of parsed.hashtags || []) tags.push(['t', t])
  for (const r of parsed.references || []) tags.push(['r', r])
  for (const p of parsed.participants || []) {
    const row = ['p', p.pubkey]
    if (p.relay) row.push(p.relay)
    if (p.role)  row.push(p.role || '')
    tags.push(row)
  }
  return tags
}
