/**
 * useRelayCopier — "steal this relay from your friend" flow.
 *
 * Used by RelayCard and DmRelayCard to offer a `+` button on each of the
 * viewed user's relays when the session user is viewing someone *else's*
 * profile. Clicking + opens a confirm modal; confirming publishes a fresh
 * kind 10002 (for kind='main') or kind 10050 (for kind='dm') with the
 * picked URL appended to the viewer's own list.
 *
 * Design notes:
 *   - One hook per card. Each instance fetches the viewer's own list once
 *     when `canCopy` flips true, then owns that list locally for dedupe and
 *     optimistic updates after publish.
 *   - `canCopy` = logged in, not read-only, and viewedUser !== sessionUser.
 *     Wrapped ProfileView's OwnerProvider fork means viewedUser reflects
 *     preview state correctly — no extra plumbing needed here.
 *   - W/R flags (main only): we pass through whatever flags the source
 *     declared. If they read+write, you will too; if they only read, you
 *     copy it as read. Users can edit after if they want different flags.
 *   - The modal is rendered from the hook (same pattern as
 *     useImageUploadFlow) — consumers just render `{modalElement}` once.
 */
import { useState, useEffect } from 'react'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import {
  fetchUserRelayList,
  fetchUserDmRelays,
  publishRelayList,
  publishDmRelayList,
} from '../../lib/relayInfo.js'

/**
 * Cross-component refresh signal — fired any time we publish a fresh
 * kind 10002 (kind: 'main') or kind 10050 (kind: 'dm'). RelayCard /
 * DmRelayCard / sibling useRelayCopier instances listen for it and
 * refetch their own snapshots so a relay added from the discovery
 * modal shows up on the parent profile without a page reload.
 *
 * Detail shape: `{ pubkey, kind }` where pubkey is the author whose
 * list just changed. Listeners ignore events for other pubkeys.
 */
export const RELAYS_CHANGED_EVENT = 'mynostr:relays-changed'

function dispatchRelaysChanged(pubkey, kind) {
  if (typeof window === 'undefined' || !pubkey) return
  try {
    window.dispatchEvent(new CustomEvent(RELAYS_CHANGED_EVENT, {
      detail: { pubkey, kind },
    }))
  } catch {}
}

/**
 * @param {object} opts
 * @param {'main'|'dm'} opts.kind
 * @param {boolean} [opts.allowOwn=false] — when true, the +/✓ controls
 *   render on the user's own page too. Used by the marketplace Sell
 *   composer to suggest popular marketplace relays for the user's
 *   own kind 10002. The default (false) preserves the original
 *   "steal a relay from someone else's profile" behavior.
 */
export function useRelayCopier({ kind, allowOwn = false }) {
  const { sessionUser, viewedUser } = useOwnerContext()
  const canCopy = !!(
    sessionUser?.pubkey &&
    !sessionUser.readOnly &&
    (allowOwn || (viewedUser?.pubkey && sessionUser.pubkey !== viewedUser.pubkey))
  )

  // main: [{url, read, write}, ...]  |  dm: [url, ...]  |  null: not yet loaded
  const [myList, setMyList] = useState(null)
  const [pending, setPending] = useState(null) // { url, read, write }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Refetch token bumped by either (a) sessionUser pubkey changing or
  // (b) a sibling component publishing a new relay list and dispatching
  // RELAYS_CHANGED_EVENT for our pubkey + kind. Without this, a copy
  // performed by one useRelayCopier instance leaves other instances
  // (e.g. the +/✓ buttons on a friend's profile a tab away) showing
  // stale +'s for relays the user already added.
  const [refetchToken, setRefetchToken] = useState(0)
  useEffect(() => {
    if (!canCopy) return
    function onChanged(e) {
      const detail = e?.detail
      if (!detail) return
      if (detail.pubkey !== sessionUser?.pubkey) return
      if (detail.kind !== kind) return
      setRefetchToken(t => t + 1)
    }
    window.addEventListener(RELAYS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(RELAYS_CHANGED_EVENT, onChanged)
  }, [canCopy, kind, sessionUser?.pubkey])

  useEffect(() => {
    if (!canCopy) { setMyList(null); return }
    let cancelled = false
    ;(async () => {
      try {
        if (kind === 'main') {
          const { relays } = await fetchUserRelayList(sessionUser.pubkey)
          if (!cancelled) setMyList(relays || [])
        } else {
          const { relays } = await fetchUserDmRelays(sessionUser.pubkey)
          if (!cancelled) setMyList(relays || [])
        }
      } catch {
        if (!cancelled) setMyList([])
      }
    })()
    return () => { cancelled = true }
  }, [canCopy, kind, sessionUser?.pubkey, refetchToken])

  function viewerHas(url) {
    if (!myList) return false
    if (kind === 'main') return myList.some(r => r.url === url)
    return myList.includes(url)
  }

  function askToAdd({ url, read = true, write = true }) {
    if (!canCopy) return
    setError('')
    setPending({ url, read: !!read, write: !!write })
  }

  function cancelAdd() {
    if (busy) return
    setPending(null)
    setError('')
  }

  async function confirmAdd() {
    if (!pending || busy) return
    setBusy(true)
    setError('')
    try {
      // Re-fetch right before publishing so a list the user edited in another
      // tab (or a stale snapshot from minutes ago) isn't overwritten. We still
      // fall back to the local cache if the fresh fetch fails, on the theory
      // that a stale list is better than silently dropping a failed fetch.
      let current
      if (kind === 'main') {
        try {
          const fresh = await fetchUserRelayList(sessionUser.pubkey)
          current = fresh.relays || []
        } catch {
          current = myList || []
        }
        if (current.some(r => r.url === pending.url)) {
          setMyList(current); setPending(null); return
        }
        const next = [...current, { url: pending.url, read: pending.read, write: pending.write }]
        await publishRelayList({ relays: next })
        setMyList(next)
      } else {
        try {
          const fresh = await fetchUserDmRelays(sessionUser.pubkey)
          current = fresh.relays || []
        } catch {
          current = myList || []
        }
        if (current.includes(pending.url)) {
          setMyList(current); setPending(null); return
        }
        const next = [...current, pending.url]
        await publishDmRelayList({ relays: next })
        setMyList(next)
      }
      // Notify siblings — RelayCard / DmRelayCard on the parent profile,
      // and any other useRelayCopier instances pinned to this user —
      // so they refetch and reflect the new list without a page reload.
      dispatchRelaysChanged(sessionUser.pubkey, kind)
      setPending(null)
    } catch (e) {
      setError(e?.message || 'Publish failed. Check your signer and try again.')
    } finally {
      setBusy(false)
    }
  }

  const modalElement = pending ? (
    <AddRelayConfirm
      url={pending.url}
      kind={kind}
      busy={busy}
      error={error}
      onConfirm={confirmAdd}
      onCancel={cancelAdd}
    />
  ) : null

  return { canCopy, viewerHas, askToAdd, modalElement }
}

/**
 * CopyButton — the per-row + (or ✓) button. Hidden when !canCopy.
 * Spread a hook result into this component directly: `{...copier}` plus url/read/write.
 */
export function CopyButton({ url, read = true, write = true, canCopy, viewerHas, askToAdd }) {
  if (!canCopy) return null
  const has = viewerHas(url)
  if (has) {
    return (
      <span
        title="Already in your list"
        className="inline-flex items-center justify-center w-4 h-4 rounded text-[10px] text-green-400 border border-green-900/60 bg-green-950/30 leading-none"
      >
        ✓
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); askToAdd({ url, read, write }) }}
      title="Add this relay to your list"
      className="inline-flex items-center justify-center w-4 h-4 rounded text-[11px] text-neutral-400 border border-neutral-700 hover:text-purple-300 hover:border-purple-700 hover:bg-purple-950/30 leading-none focus:outline-none focus:ring-1 focus:ring-purple-600"
    >
      +
    </button>
  )
}

function AddRelayConfirm({ url, kind, busy, error, onConfirm, onCancel }) {
  const isMobile = useIsMobile()

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  const listLabel = kind === 'main' ? 'relay list' : 'DM relay list'
  const body = (
    <>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-neutral-100">Add to your {listLabel}?</h3>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-neutral-500 hover:text-neutral-200 text-lg leading-none disabled:opacity-50"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>
      <div className="mb-3 px-3 py-2 rounded bg-neutral-950 border border-neutral-800 font-mono text-[11px] text-neutral-200 break-all">
        {url}
      </div>
      <p className="text-[11px] text-neutral-500 mb-4">
        {kind === 'main'
          ? 'This will publish a new kind 10002 event with this relay appended (read and write).'
          : 'This will publish a new kind 10050 event with this relay appended to your DM inbox list.'}
      </p>
      {error && (
        <div className="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-900/60 rounded px-2.5 py-1.5 mb-3">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-50"
        >
          {busy ? 'Publishing…' : 'Add relay'}
        </button>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <>
        <div className="fixed inset-0 bg-black/60 z-[60]" onClick={busy ? undefined : onCancel} />
        <div
          className="fixed bottom-0 left-0 right-0 bg-neutral-900 border-t border-neutral-700 rounded-t-lg z-[61] p-4 pb-6"
          style={{ maxHeight: '85vh', overflowY: 'auto' }}
        >
          {body}
        </div>
      </>
    )
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      onMouseDown={busy ? undefined : onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  )
}
