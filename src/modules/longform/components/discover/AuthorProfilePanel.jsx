import { useState, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK } from '../../../../lib/ndk.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import ZapModal from '../../../../components/ZapModal.jsx'

export default function AuthorProfilePanel({ profile, pubkey, user, onAuthorClick }) {
  const [zapOpen, setZapOpen]     = useState(false)
  const [copied, setCopied]       = useState(false)
  const [following, setFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [contacts, setContacts]   = useState(null) // full contact list event tags

  const readOnly = !user || user.readOnly
  const myPubkey = user?.pubkey

  // Load current user's contact list to check follow state
  useEffect(() => {
    if (!myPubkey || readOnly || !pubkey) return
    let cancelled = false
    ;(async () => {
      try {
        const ndk = getNDK()
        const events = await ndk.fetchEvents({ kinds: [3], authors: [myPubkey] })
        if (cancelled) return
        // Use the most recent contact list
        const sorted = Array.from(events).sort((a, b) => b.created_at - a.created_at)
        if (sorted.length > 0) {
          const tags = sorted[0].tags || []
          setContacts(tags)
          setFollowing(tags.some(t => t[0] === 'p' && t[1] === pubkey))
        } else {
          setContacts([])
          setFollowing(false)
        }
      } catch {
        setContacts(null)
      }
    })()
    return () => { cancelled = true }
  }, [myPubkey, pubkey, readOnly])

  async function handleToggleFollow() {
    if (!myPubkey || readOnly || contacts === null) return
    setFollowBusy(true)
    try {
      const ndk = getNDK()
      const event = new NDKEvent(ndk)
      event.kind = 3

      let newTags
      if (following) {
        // Unfollow — remove this pubkey
        newTags = contacts.filter(t => !(t[0] === 'p' && t[1] === pubkey))
      } else {
        // Follow — add this pubkey
        newTags = [...contacts, ['p', pubkey]]
      }

      event.tags = newTags
      event.content = ''
      await event.sign()
      await event.publish()

      setContacts(newTags)
      setFollowing(!following)
    } catch {} finally {
      setFollowBusy(false)
    }
  }

  if (!pubkey) return null

  const displayName = profile?.display_name || profile?.name || ''
  const name        = profile?.name || ''
  const picture     = profile?.picture || ''
  const nip05       = profile?.nip05 || ''
  const website     = profile?.website || ''
  const lud16       = profile?.lud16 || ''
  const about       = profile?.about || ''

  let npub = ''
  try { npub = nip19.npubEncode(pubkey) } catch {}

  function handleCopyNpub() {
    if (!npub) return
    navigator.clipboard.writeText(npub).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // If profile hasn't loaded yet, show minimal state
  const hasProfile = profile && (displayName || name || about)

  return (
    <>
      {zapOpen && lud16 && (
        <ZapModal
          lud16={lud16}
          recipientPubkey={pubkey}
          recipientName={displayName || name}
          targetEvent={null}
          aTag={null}
          targetKind={null}
          user={user}
          onClose={() => setZapOpen(false)}
        />
      )}

      <div className="flex flex-col h-full bg-neutral-950 overflow-y-auto">

        {!hasProfile ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-xs text-neutral-700">Loading profile...</span>
          </div>
        ) : (
          <>
            {/* Profile header */}
            <div className="flex flex-col items-center gap-3 px-4 pt-6 pb-4">
              {onAuthorClick ? (
                <button onClick={() => onAuthorClick({ pubkey, name: displayName || name, picture })}
                  className="flex flex-col items-center gap-3 hover:opacity-80 transition-opacity">
                  {picture && isSafeUrl(picture) ? (
                    <img src={picture} alt=""
                      className="w-20 h-20 rounded-full object-cover border-2 border-neutral-700"
                      onError={e => { e.target.style.display = 'none' }} />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-neutral-800 border-2 border-neutral-700 flex items-center justify-center text-neutral-600 text-2xl">
                      ?
                    </div>
                  )}
                  {displayName && (
                    <span className="text-sm font-medium text-neutral-100 text-center break-words">
                      {displayName}
                    </span>
                  )}
                  {name && name !== displayName && (
                    <span className="text-xs text-neutral-500 -mt-2">@{name}</span>
                  )}
                </button>
              ) : (
                <>
                  {picture && isSafeUrl(picture) ? (
                    <img src={picture} alt=""
                      className="w-20 h-20 rounded-full object-cover border-2 border-neutral-700"
                      onError={e => { e.target.style.display = 'none' }} />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-neutral-800 border-2 border-neutral-700 flex items-center justify-center text-neutral-600 text-2xl">
                      ?
                    </div>
                  )}
                  {displayName && (
                    <span className="text-sm font-medium text-neutral-100 text-center break-words">
                      {displayName}
                    </span>
                  )}
                  {name && name !== displayName && (
                    <span className="text-xs text-neutral-500 -mt-2">@{name}</span>
                  )}
                </>
              )}

              {/* Follow / Unfollow */}
              {!readOnly && myPubkey !== pubkey && contacts !== null && (
                <button
                  onClick={handleToggleFollow}
                  disabled={followBusy}
                  className={`text-xs px-4 py-1.5 rounded-full border transition-colors ${
                    following
                      ? 'border-neutral-600 text-neutral-400 hover:border-red-600 hover:text-red-400'
                      : 'border-purple-600 bg-purple-600/20 text-purple-300 hover:bg-purple-600/40'
                  } ${followBusy ? 'opacity-50' : ''}`}>
                  {followBusy ? '...' : following ? 'Following' : 'Follow'}
                </button>
              )}
            </div>

            {/* Details */}
            <div className="flex flex-col gap-3 px-4 pb-4">

              {nip05 && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">NIP-05</span>
                  <span className="text-xs text-purple-400 break-all">{nip05}</span>
                </div>
              )}

              {website && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">Website</span>
                  <a href={website.startsWith('http') ? website : `https://${website}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs text-purple-400 hover:text-purple-300 break-all transition-colors">
                    {website}
                  </a>
                </div>
              )}

              {lud16 && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">Lightning</span>
                  <button
                    onClick={() => setZapOpen(true)}
                    className="text-xs text-amber-400 hover:text-amber-300 text-left break-all transition-colors"
                    title="Send a zap">
                    ⚡ {lud16}
                  </button>
                </div>
              )}

              {about && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">Bio</span>
                  <p className="text-xs text-neutral-400 whitespace-pre-wrap break-words leading-relaxed">
                    {about}
                  </p>
                </div>
              )}

              {npub && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-600">Pubkey</span>
                  <button
                    onClick={handleCopyNpub}
                    className="text-[10px] text-neutral-600 hover:text-neutral-400 break-all font-mono text-left transition-colors"
                    title="Copy npub to clipboard">
                    {copied ? 'Copied!' : npub}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
