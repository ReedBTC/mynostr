import { useState, useEffect, useRef, useCallback } from 'react'
import { nip19 } from 'nostr-tools'
import { searchUsers } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'

const DEBOUNCE_MS = 300

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

  return (
    <div
      ref={dropdownRef}
      className="absolute left-0 right-0 bg-neutral-800 border border-neutral-700 rounded-xl shadow-2xl z-30 overflow-hidden max-h-64 overflow-y-auto"
    >
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
    </div>
  )
}
