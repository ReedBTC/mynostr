/**
 * useShippingOptions — fetch + mutate a user's kind 30406 shipping options.
 *
 * Modeled directly on useEventCalendars (kind 31924) and useCollections
 * (kind 30405). Replaceable per (30406, pubkey, dTag); writing only makes
 * sense when pubkey === sessionUser.pubkey — mutators sign with the NDK
 * signer and the relay drops mismatched-author publishes.
 *
 * Multi-tab mutation race (known limitation, accepted): same shape as
 * useEventCalendars. Last-writer-wins on a same-second edit from two
 * tabs. Symptom is "the second tab's edit overwrote the first." Revisit
 * if it becomes a real complaint.
 */
import { useCallback, useEffect, useState } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  KIND_SHIPPING_OPTION,
  decodeShippingOption,
} from './gamma.js'
import { publishShippingOption } from './publishShippingOption.js'

// d-tags must be stable across edits — listings reference options by
// 30406:pubkey:dTag coord. Use a 16-hex-char random rather than a slug
// of the title so renames don't break refs. Same pattern as eventPublish's
// randomDTag().
function generateShippingDTag() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0')
}

async function fetchAllShippingOptions(pubkey) {
  if (!pubkey) return []
  const ndk = getNDK()
  try {
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds:   [KIND_SHIPPING_OPTION],
        authors: [pubkey],
      }),
      8000,
      'fetch-timeout',
    )
    // Replaceable kind — dedupe by dTag, keep newest by created_at.
    const byDTag = new Map()
    for (const ev of events) {
      const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
      if (!dTag) continue
      const existing = byDTag.get(dTag)
      if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
        byDTag.set(dTag, ev)
      }
    }
    const out = []
    for (const ev of byDTag.values()) {
      const decoded = decodeShippingOption(ev)
      if (decoded) out.push({ event: ev, decoded })
    }
    out.sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
    return out
  } catch {
    return []
  }
}

export function useShippingOptions(pubkey) {
  const [options, setOptions] = useState([])  // [{ event, decoded }]
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [token,   setToken]   = useState(0)
  const [pending, setPending] = useState(false)

  const reload = useCallback(() => setToken(t => t + 1), [])

  useEffect(() => {
    if (!pubkey) {
      setOptions([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const all = await fetchAllShippingOptions(pubkey)
        if (cancelled) return
        setOptions(all)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Shipping options load failed.')
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, token])

  const find = useCallback((dTag) => {
    if (!dTag) return null
    return options.find(o => o.decoded.dTag === dTag) || null
  }, [options])

  // Build the addressable coord for a shipping option owned by the
  // current user — the shape listings reference via shipping_option tags.
  const buildCoord = useCallback((dTag) => {
    if (!pubkey || !dTag) return ''
    return `${KIND_SHIPPING_OPTION}:${pubkey}:${dTag}`
  }, [pubkey])

  // Update local state by dTag, preserving array shape.
  const upsertLocal = useCallback((decoded, eventOverride) => {
    setOptions(prev => {
      const others = prev.filter(o => o.decoded.dTag !== decoded.dTag)
      const entry = {
        event: eventOverride || (prev.find(o => o.decoded.dTag === decoded.dTag)?.event) || null,
        decoded,
      }
      const next = [...others, entry]
      next.sort((a, b) => ((b.event?.created_at) || 0) - ((a.event?.created_at) || 0))
      return next
    })
  }, [])

  // ── Mutators ──────────────────────────────────────────────────────────

  /**
   * Create a new shipping option. Auto-generates a stable d-tag.
   * @returns {Promise<{ ok: boolean, dTag?: string, error?: string }>}
   */
  const createOption = useCallback(async (form) => {
    if (pending) return { ok: false, reason: 'busy' }
    if (!form?.title?.trim()) return { ok: false, error: 'Title required' }
    setPending(true)
    setError(null)
    try {
      const dTag = generateShippingDTag()
      const decoded = {
        dTag,
        title:     form.title.trim(),
        price:     form.price || { amount: null, currency: 'SATS' },
        countries: form.countries || [],
        regions:   form.regions || [],
        service:   form.service || '',
        carrier:   form.carrier || '',
        location:  form.location || '',
        geohash:   form.geohash || '',
        tTags:     form.tTags || [],
        _extraTags: [],
      }
      // publishShippingOption now returns the signed NDKEvent so we
      // can hand it straight to upsertLocal — saves a relay round-trip
      // we used to do just to recover created_at after publish.
      const { event } = await publishShippingOption(decoded)
      upsertLocal(decoded, event)
      return { ok: true, dTag }
    } catch (e) {
      setError(e?.message || 'Create failed.')
      return { ok: false, error: e?.message || 'Create failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, pubkey, upsertLocal])

  /**
   * Update an existing shipping option by dTag. Patch is shallow-merged
   * into the existing decoded shape; pass only the fields to change.
   * Preserves _extraTags so cross-client tag additions survive.
   */
  const updateOption = useCallback(async (dTag, patch) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    setPending(true)
    setError(null)
    try {
      const existing = options.find(o => o.decoded.dTag === dTag)?.decoded
      if (!existing) return { ok: false, error: 'Option not found' }
      const next = {
        ...existing,
        ...patch,
        dTag,
        title: (patch.title ?? existing.title)?.trim() || existing.title || 'Shipping option',
      }
      const { event } = await publishShippingOption(next)
      upsertLocal(next, event)
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Update failed.')
      return { ok: false, error: e?.message || 'Update failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, options, pubkey, upsertLocal])

  /**
   * Archive a shipping option via NIP-09 kind 5. Listings that already
   * reference the option keep their ref — third-party clients fall back
   * gracefully to the cached option or to "manual checkout" if the
   * option is no longer reachable. We don't auto-rewrite listings on
   * archive; that surface lives in the Compliance panel (Phase 3).
   */
  const archiveOption = useCallback(async (dTag) => {
    if (!dTag || pending) return { ok: false, reason: 'busy-or-empty' }
    const ndk = getNDK()
    if (!ndk?.signer) return { ok: false, error: 'Not signed in' }
    const me = ndk.activeUser?.pubkey
    if (!me) return { ok: false, error: 'No active user' }
    const target = options.find(o => o.decoded.dTag === dTag)
    if (!target) return { ok: true, alreadyAbsent: true }

    setPending(true)
    setError(null)
    try {
      const tags = []
      if (target.event?.id) tags.push(['e', target.event.id])
      tags.push(['a', `${KIND_SHIPPING_OPTION}:${me}:${dTag}`])
      tags.push(['k', String(KIND_SHIPPING_OPTION)])
      tags.push(['client', 'mynostr'])
      const ev = new NDKEvent(ndk, {
        kind: 5,
        content: '',
        tags,
        created_at: Math.floor(Date.now() / 1000),
      })
      await signWithTimeout(ev)
      await publishToOwnOutbox(ev)
      // Drop locally regardless of relay propagation.
      setOptions(prev => prev.filter(o => o.decoded.dTag !== dTag))
      return { ok: true }
    } catch (e) {
      setError(e?.message || 'Archive failed.')
      return { ok: false, error: e?.message || 'Archive failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, options])

  return {
    options,
    loading,
    error,
    pending,
    reload,
    find,
    buildCoord,
    createOption,
    updateOption,
    archiveOption,
  }
}
