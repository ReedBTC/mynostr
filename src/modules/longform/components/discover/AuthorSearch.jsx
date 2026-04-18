import { useState, useRef, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { searchUsers, fetchProfiles } from '../../../../lib/primal.js'
import { isSafeUrl } from '../../../../lib/utils.js'

const DEBOUNCE_MS = 350

function formatFollowers(n) {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// Classify the raw input so the dropdown knows which path to render.
// Pure: no network. Bech32 decoding happens here but profile fetches don't.
function classifyInput(raw) {
  const q = raw.trim()
  if (!q) return { kind: 'empty' }
  const lower = q.toLowerCase()
  const looksBech32 =
    lower.startsWith('npub1') ||
    lower.startsWith('nprofile1') ||
    lower.startsWith('naddr1')
  if (looksBech32) {
    try {
      const decoded = nip19.decode(q)
      if (decoded.type === 'npub')     return { kind: 'npub',  pubkey: decoded.data }
      if (decoded.type === 'nprofile') return { kind: 'npub',  pubkey: decoded.data.pubkey }
      if (decoded.type === 'naddr') {
        return {
          kind: 'naddr',
          pubkey: decoded.data.pubkey,
          dTag: decoded.data.identifier,
          articleKind: decoded.data.kind,
        }
      }
      return { kind: 'invalid' }
    } catch {
      return { kind: 'invalid' }
    }
  }
  return { kind: 'text', value: q }
}

/**
 * Search input for the Longform Search tab.
 * Accepts:
 *   - free text → Primal user search (ranked by followers)
 *   - npub / nprofile → jump to that author's feed
 *   - naddr (kind 30023) → jump to that specific article
 */
export default function AuthorSearch({ onSelectAuthor, onSelectArticle, expanded }) {
  const [query,     setQuery]     = useState('')
  const [items,     setItems]     = useState([]) // { type: 'author' | 'article' | 'error', ... }
  const [open,      setOpen]      = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef  = useRef(null)
  const containerRef = useRef(null)
  const reqIdRef     = useRef(0)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Cancel any pending debounce timer on unmount so a stale resolve() can't
  // fire after this component leaves the tree.
  useEffect(() => () => clearTimeout(debounceRef.current), [])

  function handleInput(e) {
    const q = e.target.value
    setQuery(q)
    clearTimeout(debounceRef.current)

    const cls = classifyInput(q)
    if (cls.kind === 'empty') {
      setItems([]); setOpen(false); setSearching(false)
      return
    }

    // Bech32 parse errors are synchronous — surface immediately, no debounce.
    if (cls.kind === 'invalid') {
      setItems([{ type: 'error', message: 'Invalid Nostr identifier' }])
      setOpen(true); setSearching(false)
      return
    }
    if (cls.kind === 'naddr' && cls.articleKind !== 30023) {
      setItems([{ type: 'error', message: 'Not a long-form article (naddr)' }])
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
        return
      }

      if (cls.kind === 'naddr') {
        const profiles = await fetchProfiles([cls.pubkey])
        if (reqIdRef.current !== reqId) return
        const p = profiles.get(cls.pubkey)
        setItems([{
          type: 'article',
          pubkey: cls.pubkey,
          dTag: cls.dTag,
          authorName: p?.display_name || p?.name || 'Unknown author',
          picture: p?.picture || '',
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
    if (item.type === 'author') {
      onSelectAuthor({
        pubkey: item.pubkey,
        name: item.name,
        picture: item.picture,
      })
    } else if (item.type === 'article') {
      onSelectArticle?.({
        pubkey: item.pubkey,
        dTag: item.dTag,
        author: {
          pubkey: item.pubkey,
          name: item.authorName,
          picture: item.picture,
        },
      })
    }
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
          placeholder="Search authors, npub, or naddr…"
          className={`${expanded ? 'w-full' : 'w-48'} bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 placeholder-neutral-600`}
        />
        {searching && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          </span>
        )}
      </div>

      {open && items.length > 0 && (
        <div className={`absolute ${expanded ? 'left-0' : 'right-0'} top-full mt-1 w-72 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 overflow-hidden`}>
          {items.map((item, i) => {
            if (item.type === 'error') {
              return (
                <div key={`err-${i}`} className="px-3 py-2.5 text-xs text-neutral-500 italic">
                  {item.message}
                </div>
              )
            }
            const fc = item.type === 'author' ? formatFollowers(item.followersCount) : null
            const displayName = item.type === 'author' ? item.name : item.authorName
            const displayPic  = item.picture
            return (
              <button
                key={`${item.type}-${item.pubkey}-${item.dTag || ''}`}
                onClick={() => handlePick(item)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-neutral-700 transition-colors text-left"
              >
                {displayPic && isSafeUrl(displayPic) ? (
                  <img
                    src={displayPic}
                    alt=""
                    className="w-7 h-7 rounded-full flex-shrink-0 object-cover"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-neutral-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs text-neutral-200 truncate">{displayName}</p>
                    {fc && (
                      <p className="text-xs text-neutral-500 flex-shrink-0">{fc} followers</p>
                    )}
                  </div>
                  {item.type === 'article' && (
                    <p className="text-[10px] text-purple-400 mt-0.5">Open article →</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
