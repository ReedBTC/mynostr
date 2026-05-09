import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { searchUsers } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'
import { useIsMobile } from '../../../hooks/useIsMobile.js'

const DEBOUNCE_MS = 300

// On mobile, the soft keyboard covers the bottom of the viewport. The
// default `absolute` positioning anchors the dropdown directly under
// the textarea, which lands behind the keyboard. When VisualViewport is
// available we instead dock the dropdown to the top of the keyboard via
// `position: fixed` so it stays visible above the keyboard line. This
// is the same pattern Twitter/X web uses for its compose autocomplete.
//
// Returns the number of CSS pixels the soft keyboard occupies at the
// bottom of the layout viewport (0 when no keyboard / API unsupported).
function useKeyboardHeight() {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    function update() {
      // window.innerHeight = layout viewport (typically excludes browser
      // chrome). vv.height = currently visible portion (excludes
      // keyboard too). vv.offsetTop is non-zero when the visual viewport
      // is scrolled relative to the layout viewport — adding it cancels
      // out that scroll so the math stays in layout-viewport coords.
      const kb = window.innerHeight - vv.height - vv.offsetTop
      setHeight(Math.max(0, kb))
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return height
}

function formatFollowers(n) {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Extract the @mention query at the cursor position.
 * Returns { query, start, end } or null if no active @mention.
 */
function getMentionQuery(text, cursorPos) {
  // Walk backwards from cursor to find @
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([a-zA-Z0-9._-]*)$/)
  if (!match) return null
  const query = match[1]
  const start = before.length - match[0].length
  const end = cursorPos
  return { query, start, end }
}

/**
 * Renders a dropdown anchored below the textarea when user types @query.
 * Props:
 *   textareaRef — ref to the <textarea> element
 *   content — current textarea value
 *   cursorPos — current selectionStart
 *   onSelect(npubUri, start, end) — replace text range with nostr:npub1...
 *   onActiveChange(isActive) — notify parent when dropdown is open/closed
 */
export default function MentionAutocomplete({ textareaRef, content, cursorPos, onSelect, onActiveChange }) {
  const [mention, setMention] = useState(null) // { query, start, end }
  const [results, setResults] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef(null)
  const dropdownRef = useRef(null)
  const isMobile = useIsMobile()
  const keyboardHeight = useKeyboardHeight()
  // Mobile docking only kicks in when a keyboard is actually open AND
  // we're on a mobile viewport. Desktop and mobile-no-keyboard fall
  // through to the default `absolute`-under-textarea layout so the
  // dropdown stays anchored to the composer in normal use.
  const dockToKeyboard = isMobile && keyboardHeight > 0

  // Detect @mention at cursor
  useEffect(() => {
    const m = getMentionQuery(content, cursorPos)
    setMention(m)
    if (!m || m.query.length < 1) {
      setResults([])
      onActiveChange?.(false)
      return
    }
    onActiveChange?.(true)
    setSelectedIdx(0)

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const users = await searchUsers(m.query, 6)
        setResults(users)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(debounceRef.current)
  }, [content, cursorPos])

  // Handle keyboard navigation inside the dropdown
  const handleKeyDown = useCallback((e) => {
    if (!mention || results.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectUser(results[selectedIdx])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
      setResults([])
      onActiveChange?.(false)
    }
  }, [mention, results, selectedIdx])

  // Attach/detach keydown on the textarea
  useEffect(() => {
    const ta = textareaRef?.current
    if (!ta || !mention || results.length === 0) return

    ta.addEventListener('keydown', handleKeyDown, true)
    return () => ta.removeEventListener('keydown', handleKeyDown, true)
  }, [textareaRef, mention, results, handleKeyDown])

  function selectUser(user) {
    if (!user || !mention) return
    const name = user.display_name || user.name || nip19.npubEncode(user.pubkey).slice(0, 12)
    onSelect({ name, pubkey: user.pubkey }, mention.start, mention.end)
    setMention(null)
    setResults([])
    onActiveChange?.(false)
  }

  if (!mention || mention.query.length < 1 || (results.length === 0 && !searching)) {
    return null
  }

  // Body of the dropdown — same in both layouts. Two render paths
  // below differ only in positioning + chrome (rounded vs. flat,
  // absolute vs. fixed, portaled or not).
  const body = (
    <>
      {searching && results.length === 0 && (
        <div className="flex items-center gap-2 px-4 py-3 text-neutral-500 text-xs">
          <span className="w-3.5 h-3.5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          Searching...
        </div>
      )}
      {results.map((user, i) => {
        const fc = formatFollowers(user.followersCount)
        return (
          <button
            key={user.pubkey}
            onMouseDown={(e) => {
              e.preventDefault() // prevent textarea blur
              selectUser(user)
            }}
            className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left ${
              i === selectedIdx ? 'bg-neutral-700/80' : 'hover:bg-neutral-700/60'
            }`}
          >
            {user.picture && isSafeUrl(user.picture) ? (
              <img
                src={user.picture}
                alt=""
                className="w-8 h-8 rounded-full flex-shrink-0 object-cover"
                onError={e => { e.target.style.display = 'none' }}
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-neutral-700 flex-shrink-0 flex items-center justify-center text-xs text-neutral-500">?</div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-neutral-200 truncate">{user.name}</p>
              {fc && <p className="text-xs text-neutral-500">{fc} followers</p>}
            </div>
          </button>
        )
      })}
    </>
  )

  // Mobile + soft keyboard open → fixed-positioned overlay docked to
  // the keyboard's top edge. Portaled to <body> so it can't be clipped
  // by any composer ancestor's overflow:hidden. Loses the rounded
  // corners since it sits flush with the keyboard line. The user is
  // focused on picking a result here, so covering the bottom of the
  // textarea is the right trade.
  if (dockToKeyboard) {
    return createPortal(
      <div
        ref={dropdownRef}
        className="fixed left-0 right-0 bg-neutral-800 border-t border-neutral-700 shadow-2xl z-50 max-h-64 overflow-y-auto"
        style={{ bottom: keyboardHeight }}
      >
        {body}
      </div>,
      document.body,
    )
  }

  return (
    <div
      ref={dropdownRef}
      className="absolute left-0 right-0 bg-neutral-800 border border-neutral-700 rounded-xl shadow-2xl z-30 overflow-hidden max-h-64 overflow-y-auto"
    >
      {body}
    </div>
  )
}
