import { useState, useEffect, useRef } from 'react'
import { nip19 } from 'nostr-tools'
import { fetchProfiles } from '../../../lib/primal.js'
import { isSafeUrl } from '../../../lib/utils.js'

const CACHE_MAX = 500
const profileCache = new Map()
function cacheSet(key, value) {
  if (profileCache.size >= CACHE_MAX) profileCache.delete(profileCache.keys().next().value)
  profileCache.set(key, value)
}

export default function ZapSplitDisplay({ zapSplits, compact = false }) {
  const [profiles, setProfiles] = useState(new Map())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const pubkeys = zapSplits.map(z => z.pubkey).filter(pk => !profileCache.has(pk))
    if (pubkeys.length === 0) {
      const cached = new Map()
      for (const z of zapSplits) {
        const p = profileCache.get(z.pubkey)
        if (p) cached.set(z.pubkey, p)
      }
      setProfiles(cached)
      return
    }

    fetchProfiles(pubkeys).then(fetched => {
      if (!mounted.current) return
      for (const [pk, p] of fetched) cacheSet(pk, p)
      const all = new Map()
      for (const z of zapSplits) {
        const p = profileCache.get(z.pubkey)
        if (p) all.set(z.pubkey, p)
      }
      setProfiles(all)
    })
  }, [zapSplits])

  if (zapSplits.length === 0) return null

  return (
    <div className="border border-neutral-800 rounded p-2 mt-2">
      <p className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide mb-1.5">Zap Splits</p>

      {/* Segmented bar */}
      <div className="flex h-1 rounded-full overflow-hidden mb-2 bg-neutral-800">
        {zapSplits.map((z, i) => {
          const colors = ['bg-yellow-500', 'bg-orange-500', 'bg-purple-500', 'bg-blue-500', 'bg-green-500', 'bg-pink-500']
          return (
            <div
              key={z.pubkey}
              className={`${colors[i % colors.length]}`}
              style={{ width: `${z.pct || 0}%` }}
            />
          )
        })}
      </div>

      {/* Recipients */}
      <div className="flex flex-wrap gap-2">
        {zapSplits.map((z, i) => {
          const profile = profiles.get(z.pubkey)
          const name = profile?.display_name || profile?.name || nip19.npubEncode(z.pubkey).slice(0, 12) + '...'
          const pic = profile?.picture
          const colors = ['text-yellow-400', 'text-orange-400', 'text-purple-400', 'text-blue-400', 'text-green-400', 'text-pink-400']

          return (
            <div key={z.pubkey} className="flex items-center gap-1.5">
              {pic && isSafeUrl(pic) ? (
                <img src={pic} alt="" className="w-5 h-5 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
              ) : (
                <div className="w-5 h-5 rounded-full bg-neutral-700 flex items-center justify-center text-[9px] text-neutral-400">?</div>
              )}
              {!compact && (
                <span className="text-xs text-neutral-400">{name}</span>
              )}
              <span className={`text-[10px] font-medium ${colors[i % colors.length]}`}>{z.pct || 0}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
