/**
 * UserSearch — shared author-only search dropdown.
 *
 * Accepts:
 *   - free text → Primal user_search (ranked by followers)
 *   - npub / nprofile → resolve to that one author as a single result
 *
 * Callers that also want to accept nevent/note1/naddr wrap this component
 * and intercept those prefixes in their own search before falling through
 * here. Keeping this component author-only is intentional — it matches the
 * callsites where only a user makes sense (Profile, Events, Marketplace)
 * and keeps the dropdown semantics simple (every row is a user).
 *
 * Lifecycle notes:
 *   - Debounced (350ms) to avoid a user_search request per keystroke.
 *   - reqIdRef guards against out-of-order responses: only the last issued
 *     request is allowed to write back to state.
 *   - Outside-click closes the dropdown via pointerdown+capture so clicks
 *     on overlay elements (modals, popovers) still dismiss it.
 */
import { useState, useRef, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { searchUsers, fetchProfiles } from '../lib/primal.js'
import { isSafeUrl } from '../lib/utils.js'

const DEBOUNCE_MS = 350

function formatFollowers(n) {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// Pure classifier — decodes bech32 if present, otherwise returns free text.
// No network. Anything that isn't npub/nprofile is rejected as invalid so
// callers can wrap this component and handle other prefixes upstream.
function classifyInput(raw) {
  const q = raw.trim()
  if (!q) return { kind: 'empty' }
  const lower = q.toLowerCase()
  const looksBech32 =
    lower.startsWith('npub1') ||
    lower.startsWith('nprofile1')
  if (looksBech32) {
    try {
      const decoded = nip19.decode(q)
      if (decoded.type === 'npub')     return { kind: 'npub', pubkey: decoded.data }
      if (decoded.type === 'nprofile') return { kind: 'npub', pubkey: decoded.data.pubkey }
      return { kind: 'invalid' }
    } catch {
      return { kind: 'invalid' }
    }
  }
  return { kind: 'text', value: q }
}

export default function UserSearch({
  onPickAuthor,
  placeholder = 'Search users, npub, or nprofile…',
  inputClassName = 'w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 placeholder-neutral-600',
  dropdownClassName = 'absolute left-0 top-full mt-1 w-full bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 overflow-hidden',
  autoFocus = false,
}) {
  const [query,     setQuery]     = useState('')
  const [items,     setItems]     = useState([])
  const [open,      setOpen]      = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef  = useRef(null)
  const containerRef = useRef(null)
  const reqIdRef     = useRef(0)

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handleClick, true)
    return () => document.removeEventListener('pointerdown', handleClick, true)
  }, [])

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  function handleInput(e) {
    const q = e.target.value
    setQuery(q)
    clearTimeout(debounceRef.current)
    const cls = classifyInput(q)
    if (cls.kind === 'empty') { setItems([]); setOpen(false); setSearching(false); return }
    if (cls.kind === 'invalid') {
      setItems([{ type: 'error', message: 'Invalid Nostr identifier' }])
      setOpen(true); setSearching(false)
      return
    }
    debounceRef.current = setTimeout(() => resolve(cls), DEBOUNCE_MS)
  }

  async function resolve(cls) {
    const reqId = ++reqIdRef.current
    setSearching(true)
    try {
      if (cls.kind === 'text') {
        const results = await searchUsers(cls.value, 8)
        if (reqIdRef.current !== reqId) return
        setItems(results.map(u => ({
          type: 'author',
          pubkey: u.pubkey,
          name: u.name,
          picture: u.picture,
          followersCount: u.followersCount,
        })))
        setOpen(results.length > 0)
        return
      }

      if (cls.kind === 'npub') {
        const profiles = await fetchProfiles([cls.pubkey])
        if (reqIdRef.current !== reqId) return
        const p = profiles.get(cls.pubkey)
        setItems([{
          type: 'author',
          pubkey: cls.pubkey,
          name: p?.display_name || p?.name || 'Unknown author',
          picture: p?.picture || '',
          followersCount: null,
        }])
        setOpen(true)
      }
    } catch {
      if (reqIdRef.current !== reqId) return
      setItems([{ type: 'error', message: 'Lookup failed — try again' }])
      setOpen(true)
    } finally {
      if (reqIdRef.current === reqId) setSearching(false)
    }
  }

  function handlePick(item) {
    if (item.type === 'error') return
    onPickAuthor?.({ pubkey: item.pubkey, name: item.name, picture: item.picture })
    setQuery('')
    setItems([])
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleInput}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={inputClassName}
        />
        {searching && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          </span>
        )}
      </div>

      {open && items.length > 0 && (
        <div className={dropdownClassName}>
          {items.map((item, i) => {
            if (item.type === 'error') {
              return (
                <div key={`err-${i}`} className="px-3 py-2.5 text-xs text-neutral-500 italic">
                  {item.message}
                </div>
              )
            }
            const fc = formatFollowers(item.followersCount)
            return (
              <button
                key={`author-${item.pubkey}`}
                onClick={() => handlePick(item)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-neutral-700 transition-colors text-left"
              >
                {item.picture && isSafeUrl(item.picture) ? (
                  <img
                    src={item.picture}
                    alt=""
                    className="w-7 h-7 rounded-full flex-shrink-0 object-cover"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-neutral-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs text-neutral-200 truncate">{item.name}</p>
                    {fc && <p className="text-[10px] text-neutral-500 shrink-0">{fc} followers</p>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
