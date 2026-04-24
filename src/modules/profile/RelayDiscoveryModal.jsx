/**
 * RelayDiscoveryModal — search any user, view their NIP-65 + NIP-17 relay
 * lists in-place, and cherry-pick relays to add to your own list without
 * leaving your own `/profile/relays` page.
 *
 * Why: relay management across Nostr is terrible and social discovery
 * ("what are other people running?") is almost nonexistent. This modal
 * is the anti-follow-list version of that — search, peek, copy, done.
 *
 * Layout:
 *   - Desktop: centered dialog, wide (RelayCard's desktop table needs
 *     real estate) with click-outside + Esc to close.
 *   - Mobile: full-viewport slide-up sheet with top-right X.
 *
 * States:
 *   - Empty: UserSearch field, autofocused.
 *   - Picked: the chosen user's RelayCard + DmRelayCard stacked, wrapped
 *     in a forked OwnerProvider so `useRelayCopier` sees sessionUser ≠
 *     viewedUser and the per-row + buttons activate.
 *
 * The copy-a-relay confirm modal (AddRelayConfirm) renders at a higher
 * z-index (60 vs our 50) so nested confirmations layer correctly.
 */
import { useEffect, useMemo, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { OwnerProvider } from '../../lib/ownerContext.jsx'
import { isSafeUrl, truncateNpub } from '../../lib/utils.js'
import { Z } from '../../lib/zIndex.js'
import UserSearch from '../../components/UserSearch.jsx'
import RelayCard from './RelayCard.jsx'
import DmRelayCard from './DmRelayCard.jsx'

export default function RelayDiscoveryModal({ open, onClose, sessionUser }) {
  const isMobile = useIsMobile()
  // `picked` holds the user whose relays we're currently viewing. Null =
  // empty state (search field). Clearing it returns to the search view.
  const [picked, setPicked] = useState(null)

  // Esc closes; matches LoginModal convention. Wrapping onClose in a
  // handler that also resets the picked user means the parent only has
  // to think about open/close — reset-to-empty-state is this modal's
  // responsibility. (Keeping the reset in a useEffect triggered re-
  // renders after close, which was wasted work.)
  const handleClose = () => {
    setPicked(null)
    onClose()
  }

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Lock body scroll while open so swipes land on the modal's own
  // scroll container, not the profile behind it.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Minimal user shape for OwnerProvider. RelayCard/DmRelayCard only
  // need `pubkey`; the profile block is used by the identity strip we
  // render above the cards so the user knows whose list they're on.
  const viewedUser = useMemo(() => {
    if (!picked) return null
    let npub = ''
    try { npub = nip19.npubEncode(picked.pubkey) } catch {}
    return {
      pubkey: picked.pubkey,
      npub,
      profile: {
        displayName: picked.name || '',
        image: picked.picture || '',
      },
      readOnly: true,
    }
  }, [picked])

  function handlePick({ pubkey, name, picture }) {
    if (!pubkey) return
    setPicked({ pubkey, name, picture })
  }

  if (!open) return null

  const body = picked && viewedUser ? (
    <>
      <button
        type="button"
        onClick={() => setPicked(null)}
        className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100 mb-3 transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="8" x2="3" y2="8" />
          <polyline points="6 5 3 8 6 11" />
        </svg>
        <span>Search another user</span>
      </button>

      <PickedHeader user={viewedUser} />

      <OwnerProvider sessionUser={sessionUser} viewedUser={viewedUser}>
        <div className="space-y-3">
          <RelayCard pubkey={viewedUser.pubkey} />
          <DmRelayCard pubkey={viewedUser.pubkey} />
        </div>
      </OwnerProvider>
    </>
  ) : (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-neutral-100">Search a user</h3>
      <UserSearch
        onPickAuthor={handlePick}
        placeholder="Name, npub, or nprofile…"
        autoFocus
      />
      <p className="text-[11px] text-neutral-500">
        Pick anyone to inspect their relay + DM relay lists. Use the + on each row
        to add relays to your own list — it won't affect theirs.
      </p>
    </div>
  )

  if (isMobile) {
    return (
      <>
        <div className={`fixed inset-0 bg-black/70 ${Z.modal}`} onClick={handleClose} />
        <div
          className={`fixed inset-0 bg-neutral-950 ${Z.modalContent} overflow-y-auto`}
          role="dialog"
          aria-modal="true"
          aria-label="Search relays"
        >
          <button
            type="button"
            onClick={handleClose}
            className={`fixed top-3 right-3 ${Z.modalCloseBtn} text-neutral-400 hover:text-neutral-100 p-2 rounded transition-colors`}
            aria-label="Close"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
          <div className="px-4 pt-10 pb-8">
            {body}
          </div>
        </div>
      </>
    )
  }

  return (
    <div
      // Offset 240px from the left so the overlay covers only the content
      // pane (the w-60 sidebar in AppShell stays visible and interactive).
      // Matches how the rest of the profile feed is centered.
      className={`fixed inset-y-0 right-0 left-60 bg-black/70 flex items-start justify-center ${Z.modal} p-4 overflow-y-auto`}
      onMouseDown={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search relays"
    >
      <div
        className="relative bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl w-full max-w-xl my-8"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-2 right-2 z-10 text-neutral-400 hover:text-neutral-100 p-2 rounded transition-colors"
          aria-label="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
        <div className="p-6">
          {body}
        </div>
      </div>
    </div>
  )
}

/** Identity strip shown above the relay cards in the picked state so the
 *  user knows whose list they're looking at. */
function PickedHeader({ user }) {
  const { profile, npub } = user
  const displayName = profile?.displayName || profile?.name || 'Anonymous'
  const image = profile?.image && isSafeUrl(profile.image) ? profile.image : null
  return (
    <div className="flex items-center gap-3 mb-3 pb-3 border-b border-neutral-800">
      {image ? (
        <img
          src={image}
          alt=""
          className="w-8 h-8 rounded-full object-cover bg-neutral-800 shrink-0"
          onError={e => { e.target.style.display = 'none' }}
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-neutral-800 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-100 truncate">{displayName}</p>
        <p className="text-[10px] text-neutral-500 font-mono truncate">{truncateNpub(npub || '')}</p>
      </div>
    </div>
  )
}
