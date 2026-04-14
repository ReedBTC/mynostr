import { useState, useRef, useEffect } from 'react'
import { searchUsers } from '../../../../lib/primal.js'
import { isSafeUrl } from '../../../../lib/utils.js'

const DEBOUNCE_MS = 350

function formatFollowers(n) {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export default function AuthorSearch({ onSelectAuthor, expanded }) {
  const [query,       setQuery]       = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [open,        setOpen]        = useState(false)
  const [searching,   setSearching]   = useState(false)
  const debounceRef  = useRef(null)
  const containerRef = useRef(null)

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

  function handleInput(e) {
    const q = e.target.value
    setQuery(q)
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
        setSuggestions(results)
        setOpen(results.length > 0)
      } catch {
        setSuggestions([])
        setOpen(false)
      } finally {
        setSearching(false)
      }
    }, DEBOUNCE_MS)
  }

  function handleSelect(user) {
    onSelectAuthor(user)
    setQuery('')
    setSuggestions([])
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleInput}
          placeholder="Search authors..."
          className={`${expanded ? 'w-full' : 'w-48'} bg-neutral-800 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500 placeholder-neutral-600`}
        />
        {searching && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          </span>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className={`absolute ${expanded ? 'left-0' : 'right-0'} top-full mt-1 w-72 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 overflow-hidden`}>
          {suggestions.map(user => {
            const fc = formatFollowers(user.followersCount)
            return (
              <button
                key={user.pubkey}
                onClick={() => handleSelect(user)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-neutral-700 transition-colors text-left"
              >
                {user.picture && isSafeUrl(user.picture) ? (
                  <img
                    src={user.picture}
                    alt=""
                    className="w-7 h-7 rounded-full flex-shrink-0 object-cover"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-neutral-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <p className="text-xs text-neutral-200 truncate">{user.name}</p>
                  {fc && (
                    <p className="text-xs text-neutral-500 flex-shrink-0">{fc} followers</p>
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
