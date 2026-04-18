/**
 * OwnerContext — splits "who is logged in" from "whose data is on screen."
 *
 * sessionUser: the authenticated NDK user (from login). Null when logged out.
 *   This is the identity attached to ndk.signer — publishes, replies, etc.
 * viewedUser: the user whose page is being shown, resolved from the URL :npub.
 *   Carries profile metadata fetched read-only; never has a signer.
 * isOwner: sessionUser is the same person as viewedUser AND is not a read-only
 *   (npub-login) session. Write affordances should render iff isOwner.
 *
 * The goal is that every module can read this context and decide "am I showing
 * someone else's public page, or am I the owner editing my own page?"
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { connectAndWait, getNDK } from './ndk.js'
import { fetchProfiles } from './primal.js'

const OwnerContext = createContext({
  sessionUser: null,
  viewedUser: null,
  isOwner: false,
  isReadOnly: true,
})

export function OwnerProvider({ sessionUser, viewedUser, children }) {
  const value = useMemo(() => {
    const isOwner = !!(
      sessionUser?.pubkey &&
      viewedUser?.pubkey &&
      sessionUser.pubkey === viewedUser.pubkey &&
      !sessionUser.readOnly
    )
    return { sessionUser, viewedUser, isOwner, isReadOnly: !isOwner }
  }, [sessionUser, viewedUser])
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>
}

export function useOwnerContext() {
  return useContext(OwnerContext)
}

/**
 * Decode an npub (or nprofile) URL param into a hex pubkey.
 * Returns null for invalid input — NEVER throws. Safe to call on raw URL params.
 */
export function decodeNpubParam(param) {
  if (!param || typeof param !== 'string') return null
  try {
    const decoded = nip19.decode(param)
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data?.pubkey || null
    return null
  } catch {
    return null
  }
}

// Bounded profile cache keyed by hex pubkey. Avoids re-fetching on every
// navigation within the same page load.
const VIEWED_USER_CACHE = new Map()
const VIEWED_USER_CACHE_MAX = 50

function cacheGet(pubkey) {
  const cached = VIEWED_USER_CACHE.get(pubkey)
  if (cached) {
    // LRU: move to most-recent by re-inserting
    VIEWED_USER_CACHE.delete(pubkey)
    VIEWED_USER_CACHE.set(pubkey, cached)
  }
  return cached
}

function cacheSet(pubkey, user) {
  if (VIEWED_USER_CACHE.has(pubkey)) VIEWED_USER_CACHE.delete(pubkey)
  VIEWED_USER_CACHE.set(pubkey, user)
  while (VIEWED_USER_CACHE.size > VIEWED_USER_CACHE_MAX) {
    VIEWED_USER_CACHE.delete(VIEWED_USER_CACHE.keys().next().value)
  }
}

/**
 * Drop all cached viewed-user records. Profile data is public, but stale
 * entries shouldn't bleed across logins on a shared machine — call from
 * the logout path so the next session starts clean.
 */
export function clearViewedUserCache() {
  VIEWED_USER_CACHE.clear()
}

/**
 * Resolve a URL :npub param to a viewed-user object with profile metadata.
 * Primal cache first (fast), NDK relay fallback (3s cap), never blocks indefinitely.
 * Returns { viewedUser, pubkey, loading, error }.
 *
 * If the session user is the viewed user, returns the session object directly
 * so we inherit its freshly-hydrated profile without a round-trip.
 */
export function useViewedUser(npubParam, sessionUser) {
  const pubkey = useMemo(() => decodeNpubParam(npubParam), [npubParam])
  const [viewedUser, setViewedUser] = useState(() => {
    if (!pubkey) return null
    if (sessionUser?.pubkey === pubkey) return sessionUser
    return cacheGet(pubkey) || null
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Cancellation token so in-flight fetches don't clobber a later navigation.
  const loadTokenRef = useRef(0)

  useEffect(() => {
    setError(null)
    if (!pubkey) { setViewedUser(null); return }

    // Session user viewing their own page — reuse the hydrated session object.
    if (sessionUser?.pubkey === pubkey) {
      setViewedUser(sessionUser)
      return
    }

    // Cache hit — instant.
    const cached = cacheGet(pubkey)
    if (cached) { setViewedUser(cached); return }

    const token = ++loadTokenRef.current
    setLoading(true)

    ;(async () => {
      let profile = null

      // 1) Primal cache — fast path
      try {
        const map = await fetchProfiles([pubkey])
        const raw = map.get(pubkey)
        if (raw) {
          profile = {
            name: raw.name,
            displayName: raw.display_name || raw.displayName,
            image: raw.picture || raw.image,
            about: raw.about,
            nip05: raw.nip05,
            lud16: raw.lud16,
            website: raw.website,
            banner: raw.banner,
          }
        }
      } catch {
        // Primal unavailable — fall through to NDK
      }

      // 2) NDK fallback — requires at least one connected relay
      if (!profile) {
        try {
          const ndk = getNDK()
          await connectAndWait(ndk, 3000)
          const ndkUser = ndk.getUser({ pubkey })
          await Promise.race([
            ndkUser.fetchProfile(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
          ])
          profile = ndkUser.profile || null
        } catch {
          // Leave profile null — we still return a minimal user record
        }
      }

      if (loadTokenRef.current !== token) return

      const user = {
        pubkey,
        npub: nip19.npubEncode(pubkey),
        profile: profile || {},
        readOnly: true,
      }
      cacheSet(pubkey, user)
      setViewedUser(user)
      setLoading(false)
    })()
  }, [pubkey, sessionUser])

  return { viewedUser, pubkey, loading, error }
}
