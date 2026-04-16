import { useState, useCallback, useEffect, useRef } from 'react'
import { nip19 } from 'nostr-tools'
import { fetchProfiles, searchUsers } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 350

function formatFollowers(n) {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ─── Owner Row (always visible, gets remainder) ──────────────────────────────

function OwnerRow({ profile, pubkey, pct }) {
  const name = profile?.display_name || profile?.name || 'You'
  const pic = profile?.picture

  return (
    <div className="flex items-center gap-2.5 bg-neutral-800/60 rounded-xl px-3 py-2.5">
      {pic && isSafeUrl(pic) ? (
        <img src={pic} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" onError={e => { e.target.style.display = 'none' }} />
      ) : (
        <div className="w-9 h-9 rounded-full bg-neutral-700 flex items-center justify-center text-sm text-neutral-400 flex-shrink-0">?</div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-200 truncate">{name} <span className="text-neutral-500 text-xs">(you)</span></p>
      </div>
      <span className="text-sm font-medium text-yellow-400 tabular-nums">{pct}%</span>
    </div>
  )
}

// ─── Recipient Row (editable percentage, removable) ──────────────────────────

function RecipientRow({ split, profile, onRemove, onPctChange }) {
  const name = profile?.display_name || profile?.name || nip19.npubEncode(split.pubkey).slice(0, 14) + '...'
  const pic = profile?.picture

  return (
    <div className="flex items-center gap-2.5 bg-neutral-800/60 rounded-xl px-3 py-2.5">
      {pic && isSafeUrl(pic) ? (
        <img src={pic} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" onError={e => { e.target.style.display = 'none' }} />
      ) : (
        <div className="w-9 h-9 rounded-full bg-neutral-700 flex items-center justify-center text-sm text-neutral-400 flex-shrink-0">?</div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-200 truncate">{name}</p>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          value={split.pct || ''}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '')
            if (raw === '') { onPctChange(0); return }
            onPctChange(Math.min(99, Number(raw)))
          }}
          placeholder="%"
          className="w-14 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-sm text-neutral-200 text-center tabular-nums focus:outline-none focus:border-purple-600 [appearance:textfield]"
        />
        <span className="text-sm text-neutral-500">%</span>
      </div>
      <button
        onClick={onRemove}
        className="text-neutral-600 hover:text-red-400 transition-colors p-1 -mr-1"
        title="Remove"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
          <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
        </svg>
      </button>
    </div>
  )
}

// ─── User Search ─────────────────────────────────────────────────────────────

function UserSearch({ onSelect, excludePubkeys }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const debounceRef = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleInput(e) {
    const q = e.target.value
    setQuery(q)
    setError('')
    clearTimeout(debounceRef.current)

    if (!q.trim()) {
      setSuggestions([])
      setOpen(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const results = await searchUsers(q.trim(), 8)
        // Filter out already-added users
        const filtered = results.filter(u => !excludePubkeys.has(u.pubkey))
        setSuggestions(filtered)
        setOpen(filtered.length > 0)
      } catch {
        setSuggestions([])
        setOpen(false)
      } finally {
        setSearching(false)
      }
    }, DEBOUNCE_MS)
  }

  function handleSelect(user) {
    onSelect(user.pubkey)
    setQuery('')
    setSuggestions([])
    setOpen(false)
  }

  function handleKeyDown(e) {
    if (e.key !== 'Enter') return
    const val = query.trim()
    if (!val) return

    try {
      let pubkey = val
      if (val.startsWith('npub1')) {
        const decoded = nip19.decode(val)
        if (decoded.type !== 'npub') throw new Error('Not an npub')
        pubkey = decoded.data
      } else if (!/^[0-9a-f]{64}$/.test(val)) {
        return
      }
      if (excludePubkeys.has(pubkey)) return
      onSelect(pubkey)
      setQuery('')
      setSuggestions([])
      setOpen(false)
    } catch (err) {
      setError(err.message || 'Invalid npub')
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Add a recipient — search or paste npub..."
          className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-purple-600"
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <span className="w-4 h-4 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          </span>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded-xl shadow-2xl z-30 overflow-hidden">
          {suggestions.map(user => {
            const fc = formatFollowers(user.followersCount)
            return (
              <button
                key={user.pubkey}
                onClick={() => handleSelect(user)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-700/60 transition-colors text-left"
              >
                {user.picture && isSafeUrl(user.picture) ? (
                  <img
                    src={user.picture}
                    alt=""
                    className="w-9 h-9 rounded-full flex-shrink-0 object-cover"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-neutral-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-neutral-200 truncate">{user.name}</p>
                  {fc && (
                    <p className="text-xs text-neutral-500">{fc} followers</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  )
}

// ─── Zap Splits Section ──────────────────────────────────────────────────────

export default function ZapSplitsSection({ zapSplits, onZapSplitsChange, userPubkey }) {
  const [profiles, setProfiles] = useState(new Map())
  const profileCacheRef = useRef(new Map())

  // Resolve profiles for all participants (including the user)
  useEffect(() => {
    const allPubkeys = [userPubkey, ...zapSplits.map(z => z.pubkey)].filter(Boolean)
    const needed = allPubkeys.filter(pk => !profileCacheRef.current.has(pk))
    if (needed.length === 0) return

    fetchProfiles(needed).then(fetched => {
      for (const [pk, p] of fetched) profileCacheRef.current.set(pk, p)
      setProfiles(new Map(profileCacheRef.current))
    })
  }, [zapSplits, userPubkey])

  const othersTotal = zapSplits.reduce((sum, z) => sum + (z.pct || 0), 0)
  const userPct = Math.max(0, 100 - othersTotal)

  // Set of pubkeys already in splits (including self) for search exclusion
  const excludePubkeys = new Set([userPubkey, ...zapSplits.map(z => z.pubkey)].filter(Boolean))

  const handleAdd = useCallback((pubkey) => {
    if (excludePubkeys.has(pubkey)) return
    // Even split: total people = existing recipients + new one + the user
    const totalPeople = zapSplits.length + 1 + 1
    const evenPct = Math.floor(100 / totalPeople)
    const updated = zapSplits.map(z => ({ ...z, pct: evenPct }))
    updated.push({ pubkey, relay: '', pct: evenPct })
    onZapSplitsChange(updated)
  }, [zapSplits, onZapSplitsChange, excludePubkeys])

  const handleRemove = useCallback((idx) => {
    const remaining = zapSplits.filter((_, i) => i !== idx)
    if (remaining.length === 0) {
      onZapSplitsChange([])
      return
    }
    // Re-split evenly: remaining recipients + the user
    const totalPeople = remaining.length + 1
    const evenPct = Math.floor(100 / totalPeople)
    onZapSplitsChange(remaining.map(z => ({ ...z, pct: evenPct })))
  }, [zapSplits, onZapSplitsChange])

  const handlePctChange = useCallback((idx, pct) => {
    const updated = [...zapSplits]
    updated[idx] = { ...updated[idx], pct }
    // Cap total others at 99% so user always gets at least 1%
    const total = updated.reduce((sum, z) => sum + z.pct, 0)
    if (total > 99) {
      const over = total - 99
      updated[idx] = { ...updated[idx], pct: Math.max(1, pct - over) }
    }
    onZapSplitsChange(updated)
  }, [zapSplits, onZapSplitsChange])

  // Split bar colors
  const barColors = ['bg-purple-500', 'bg-orange-500', 'bg-blue-500', 'bg-green-500', 'bg-pink-500', 'bg-cyan-500']

  return (
    <div className="mt-5">
      {/* Search */}
      <UserSearch onSelect={handleAdd} excludePubkeys={excludePubkeys} />

      {/* Recipients list */}
      <div className="flex flex-col gap-2 mt-3">
        {/* Owner — always first, always visible */}
        <OwnerRow
          pubkey={userPubkey}
          profile={profiles.get(userPubkey)}
          pct={userPct}
        />

        {/* Other recipients */}
        {zapSplits.map((split, i) => (
          <RecipientRow
            key={split.pubkey}
            split={split}
            profile={profiles.get(split.pubkey)}
            onRemove={() => handleRemove(i)}
            onPctChange={(pct) => handlePctChange(i, pct)}
          />
        ))}

        {/* Split bar */}
        {zapSplits.length > 0 && (
          <div className="flex h-1.5 rounded-full overflow-hidden bg-neutral-800 mt-1">
            <div className="bg-yellow-500" style={{ width: `${userPct}%` }} />
            {zapSplits.map((z, i) => (
              <div key={z.pubkey} className={barColors[i % barColors.length]} style={{ width: `${z.pct}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
