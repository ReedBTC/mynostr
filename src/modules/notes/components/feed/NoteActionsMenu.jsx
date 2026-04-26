/**
 * NoteActionsMenu — three-dot menu attached to each NoteCard.
 *
 * Sections:
 *   - Copy nevent
 *   - Copy URL (njump.me/nevent)
 *   - Export JSON  — downloads the raw kind 1 event as a .json file,
 *     same shape NoteComposer accepts for JSON upload.
 *
 * Bookmark actions live in NoteActionBar's dedicated pill directly
 * below the card (one surface, one place) — no redundant copy here.
 *
 * The component owns only the popup; the parent (NoteCard) owns the
 * trigger button inside a relatively-positioned container. Closed via
 * onClose from the parent (outside-click handler + after each action).
 */
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { copyToClipboard } from '../../../../lib/utils.js'
import { Z } from '../../../../lib/zIndex.js'

export default function NoteActionsMenu({ open, onClose, note, triggerRef }) {
  const [copied, setCopied] = useState(null)

  // Portal position — fixed coords derived from the trigger's rect.
  // Recomputed whenever the menu opens. We close on scroll/resize
  // rather than reposition; dropdowns typically dismiss on outside
  // interaction and re-anchoring mid-scroll is the wrong mental model.
  // Anchors below the trigger by default. When the trigger sits near the
  // viewport bottom and the menu wouldn't fit there, flips to anchor
  // above via `bottom` instead of `top`. Caps maxHeight to available
  // space so the menu can't extend past either viewport edge.
  const [menuPos, setMenuPos] = useState(null)
  useEffect(() => {
    if (!open || !triggerRef?.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const ESTIMATED_HEIGHT = 300
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

  // Setup must reset to true — React 18 StrictMode runs setup → cleanup
  // → setup again on mount; a no-body setup would leave `current`
  // permanently false and silently gate every async completion callback.
  //
  // `copyTimerRef` tracks the copy-flash closer so we can clear it on
  // unmount (avoids a pending timer ticking after the menu is gone) and
  // before scheduling a new one (avoids two copies racing if the user
  // clicks Copy twice quickly).
  const mountedRef   = useRef(true)
  const copyTimerRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimerRef.current) { clearTimeout(copyTimerRef.current); copyTimerRef.current = null }
    }
  }, [])

  if (!open || !note?.id) return null

  let nevent = ''
  try { nevent = nip19.neventEncode({ id: note.id, author: note.pubkey }) } catch {}

  async function handleCopy(kind) {
    if (!nevent) return
    const text = kind === 'url' ? `https://njump.me/${nevent}` : nevent
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null
      if (!mountedRef.current) return
      setCopied(null)
      onClose?.()
    }, 1100)
  }

  function handleExportJson() {
    const event = {
      kind: 1,
      id: note.id,
      pubkey: note.pubkey,
      created_at: note.created_at,
      content: note.content || '',
      tags: note.tags || [],
      sig: note.sig || '',
    }
    const blob = new Blob([JSON.stringify(event, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `note-${note.id.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
    onClose?.()
  }

  // Wait for the position calc to land before rendering — avoids a
  // flash in the top-left corner on first open.
  if (!menuPos) return null

  const menuContent = (
    <div
      data-note-actions-menu="true"
      className={`fixed bg-neutral-800 border border-neutral-700 rounded shadow-xl ${Z.portaledMenu} w-[240px] max-h-[70vh] overflow-y-auto`}
      style={menuPos}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <button
        onClick={() => handleCopy('nevent')}
        disabled={!nevent}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {copied === 'nevent' ? '✓ Copied!' : 'Copy nevent'}
      </button>
      <button
        onClick={() => handleCopy('url')}
        disabled={!nevent}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {copied === 'url' ? '✓ Copied!' : 'Copy URL'}
      </button>

      <div className="border-t border-neutral-700" />

      <button
        onClick={handleExportJson}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
      >
        Export JSON
      </button>
    </div>
  )

  return createPortal(menuContent, document.body)
}
