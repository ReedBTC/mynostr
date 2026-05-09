/**
 * RelayCard — per-user relay dashboard shown under the posting cadence chart.
 *
 * Loads the user's relay list (NIP-65 kind 10002, falling back to legacy
 * kind 3), fetches each relay's NIP-11 info document in parallel, and
 * renders columns that are both user-meaningful and actually declared in
 * the wild:
 *
 *   Desktop: Relay · Use · Auth · Search · Vanish · Software
 *   Mobile:  stacked cards with the same fields reflowed
 *
 * When the logged-in user is viewing their own profile, an Edit button
 * flips the table into a per-row edit mode (W/R toggles + delete + add-new
 * input) and a Save button publishes a fresh kind 10002. Saving is also
 * the upgrade path for users on legacy kind 3 — an amber banner prompts
 * them, and the same Save path replaces their kind 3 with NIP-65.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import ShareButton from '../../components/ShareButton.jsx'
import RelayDiscoveryModal from './RelayDiscoveryModal.jsx'
import {
  fetchNip11,
  fetchUserRelayList,
  publishRelayList,
  normalizeRelayUrl,
  isPaidRelay,
  paidRelayInfoUrl,
} from '../../lib/relayInfo.js'
import RelayFAQ from './RelayFAQ.jsx'
import { useRelayCopier, CopyButton, RELAYS_CHANGED_EVENT } from './useRelayCopier.jsx'

const FEATURES = [
  {
    key:   'auth',
    label: 'Auth',
    title: 'Auth — private or gated relay',
    desc:  'The relay requires NIP-42 authentication or restricts writes to an allowlist, meaning you may not be able to read or post here without permission. When you do have access, your client signs the auth challenge automatically.',
    check: info => {
      if (!info || info._error) return null
      const lim = info.limitation
      if (!lim || typeof lim !== 'object') return false
      return Boolean(lim.auth_required || lim.restricted_writes)
    },
  },
  {
    key:   'search',
    label: 'Search',
    title: 'Search — NIP-50 full-text',
    desc:  'The relay indexes event content for keyword search. Relays without NIP-50 can only filter by author, tag, or kind — they cannot answer "find me every event that mentions X". Useful if you want to grep your own history.',
    check: info => supportsNip(info, 50),
  },
  {
    key:   'vanish',
    label: 'Vanish',
    title: 'Vanish — NIP-62 right to delete',
    desc:  'The relay commits to permanently deleting every event tied to your pubkey when you request it. Most relays do not declare NIP-62 — they only support NIP-09, which is a polite SHOULD-delete that relays can ignore. If right-to-delete matters to you, prefer Vanish relays.',
    check: info => supportsNip(info, 62),
  },
]

function supportsNip(info, nip) {
  if (!info || info._error) return null
  const list = Array.isArray(info.supported_nips) ? info.supported_nips : null
  if (!list) return null
  return list.some(n => Number(n) === nip)
}

const KNOWN_SOFTWARE = [
  { match: 'strfry',         label: 'strfry'    },
  { match: 'khatru',         label: 'khatru'    },
  { match: 'nostream',       label: 'nostream'  },
  { match: 'nostr-rs-relay', label: 'nostr-rs'  },
  { match: 'ditto',          label: 'ditto'     },
  { match: 'citrine',        label: 'citrine'   },
  { match: 'nosflare',       label: 'nosflare'  },
  { match: 'rnostr',         label: 'rnostr'    },
  { match: 'akasha',         label: 'akasha'    },
  { match: 'relayer',        label: 'relayer'   },
  { match: 'nostrpony',      label: 'nostrpony' },
  { match: 'satellite',      label: 'satellite' },
]

function relaySoftware(info) {
  if (!info || info._error) return null
  const sw = info.software
  if (typeof sw !== 'string' || !sw) return null
  const lower = sw.toLowerCase()
  for (const k of KNOWN_SOFTWARE) {
    if (lower.includes(k.match)) return k.label
  }
  const stripped = lower.replace(/\.git$/, '')
  const parts = stripped.split('/').filter(Boolean)
  return (parts[parts.length - 1] || lower).slice(0, 10)
}

function displayName(url, info) {
  if (info?.name && typeof info.name === 'string') return info.name.slice(0, 40)
  try { return new URL(url).host } catch { return url }
}

// Accept user input like "relay.damus.io", "wss://relay.damus.io", or a full
// URL with a path. Returns the normalized wss URL on success, or an error.
function validateRelayInput(raw) {
  const trimmed = (raw || '').trim()
  if (!trimmed) return { error: 'Enter a relay URL.' }
  let candidate = trimmed
  if (!/^wss?:\/\//i.test(candidate)) candidate = 'wss://' + candidate
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
      return { error: 'Relay URLs must start with wss://' }
    }
    if (!u.host || !u.host.includes('.')) {
      return { error: 'Relay host looks wrong.' }
    }
    return { url: normalizeRelayUrl(candidate) }
  } catch {
    return { error: 'Not a valid URL.' }
  }
}

export default function RelayCard({ pubkey }) {
  const isMobile = useIsMobile()
  const { isOwner, sessionUser } = useOwnerContext()
  const copier = useRelayCopier({ kind: 'main' })

  // Relay-discovery modal — "Search" button in the header (owner only)
  // pops this over the page so the user can inspect someone else's
  // relay + DM relay lists and cherry-pick add-ons without leaving
  // their own profile.
  const [searchOpen, setSearchOpen] = useState(false)

  // Share URL always points at the /profile/relays anchor — so clicking the
  // card's share button from anywhere on the profile page sends recipients
  // straight to this section rather than the top of the page.
  const shareUrl = useMemo(() => {
    if (!pubkey || typeof window === 'undefined') return null
    try {
      const npub = nip19.npubEncode(pubkey)
      return `${window.location.origin}/${npub}/profile/relays`
    } catch { return null }
  }, [pubkey])
  const [relays, setRelays] = useState([])
  const [source, setSource] = useState('none')
  const [loading, setLoading] = useState(true)
  const [infoByUrl, setInfoByUrl] = useState({})
  const [mode, setMode] = useState('view')     // 'view' | 'edit'
  const [draft, setDraft] = useState([])        // local edits before save
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState(null)

  // Refetch token bumped by sibling components (RelayDiscoveryModal's
  // useRelayCopier instance, in particular) when they publish a new
  // kind 10002 for this user. Without this hook the parent card would
  // show stale relays after closing the discovery modal — the user
  // had to manually refresh before the just-added relay appeared.
  const [refetchToken, setRefetchToken] = useState(0)
  useEffect(() => {
    if (!pubkey) return
    function onChanged(e) {
      const detail = e?.detail
      if (!detail || detail.kind !== 'main') return
      if (detail.pubkey !== pubkey) return
      setRefetchToken(t => t + 1)
    }
    window.addEventListener(RELAYS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(RELAYS_CHANGED_EVENT, onChanged)
  }, [pubkey])

  // Load the user's relay list whenever the viewed pubkey changes (or
  // a refetchToken bump signals an external publish), then fan out
  // NIP-11 fetches in parallel. One bad relay doesn't block the rest.
  useEffect(() => {
    if (!pubkey) { setRelays([]); setSource('none'); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setInfoByUrl({})
    setMode('view')
    setSaveNotice(null)
    setSaveError('')
    ;(async () => {
      const { relays: list, source: src } = await fetchUserRelayList(pubkey)
      if (cancelled) return
      setRelays(list)
      setSource(src)
      setLoading(false)
      for (const r of list) {
        fetchNip11(r.url).then(info => {
          if (cancelled) return
          setInfoByUrl(prev => ({ ...prev, [r.url]: info }))
        })
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, refetchToken])

  function enterEdit() {
    // Deep-copy into draft so toggling W/R flags doesn't mutate the live list
    setDraft(relays.map(r => ({ url: r.url, read: !!r.read, write: !!r.write })))
    setAddInput('')
    setAddError('')
    setSaveError('')
    setSaveNotice(null)
    setMode('edit')
  }

  function cancelEdit() {
    setMode('view')
    setAddInput('')
    setAddError('')
    setSaveError('')
  }

  function toggleRW(url, key) {
    setDraft(d => d.map(r => r.url === url ? { ...r, [key]: !r[key] } : r))
  }
  function removeRelay(url) {
    setDraft(d => d.filter(r => r.url !== url))
  }
  function addRelay() {
    const v = validateRelayInput(addInput)
    if (v.error) { setAddError(v.error); return }
    if (draft.some(r => r.url === v.url)) {
      setAddError('That relay is already in the list.')
      return
    }
    setDraft(d => [...d, { url: v.url, read: true, write: true }])
    setAddInput('')
    setAddError('')
  }

  async function handleSave() {
    if (saving) return
    // At least one read+write pair is required to avoid publishing a useless
    // list. Users who really want zero relays should just not have a list.
    const keep = draft.filter(r => r.read || r.write)
    if (keep.length === 0) {
      setSaveError('Keep at least one relay with read or write enabled.')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const { relays: confirmedTo } = await publishRelayList({ relays: keep })
      // Optimistically adopt the new list as the source of truth and fetch
      // NIP-11 for any newly-added relays.
      setRelays(keep)
      setSource('nip65')
      setMode('view')
      setSaveNotice({
        kind: 'ok',
        msg: `Relay list published to ${confirmedTo.length} relay${confirmedTo.length === 1 ? '' : 's'}.`,
      })
      // Kick NIP-11 fetches for any new URLs we don't already have info for
      for (const r of keep) {
        if (!infoByUrl[r.url]) {
          fetchNip11(r.url).then(info => {
            setInfoByUrl(prev => ({ ...prev, [r.url]: info }))
          })
        }
      }
    } catch (e) {
      setSaveError(e?.message || 'Publish failed. Check your signer and try again.')
    } finally {
      setSaving(false)
    }
  }

  const readCount  = relays.filter(r => r.read).length
  const writeCount = relays.filter(r => r.write).length
  const emptyForOwner = !loading && relays.length === 0 && isOwner
  const inEdit = mode === 'edit'

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <div className="flex flex-col gap-2 px-4 py-3 border-b border-neutral-800 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-neutral-200">Relays</h2>
          <span className="text-[10px] text-neutral-500 whitespace-nowrap">
            where their notes live
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-neutral-500 whitespace-nowrap">
            {loading ? (
              <span className="inline-block w-24 h-3 bg-neutral-800 rounded animate-pulse" />
            ) : relays.length > 0 ? (
              <>
                <span className="text-neutral-200 font-medium">{writeCount}</span> write
                <span className="mx-1.5 text-neutral-700">·</span>
                <span className="text-neutral-200 font-medium">{readCount}</span> read
              </>
            ) : (
              <span className="text-neutral-600">No relay list published</span>
            )}
          </span>
          {shareUrl && <ShareButton variant="button" url={shareUrl} />}
          {isOwner && !loading && !inEdit && (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Search another user's relays"
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 hover:border-purple-700/60 hover:text-purple-200 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
            >
              Search
            </button>
          )}
          {isOwner && !loading && !inEdit && relays.length > 0 && (
            <button
              type="button"
              onClick={enterEdit}
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 hover:border-purple-700/60 hover:text-purple-200 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {source === 'kind3' && !inEdit && !loading && (
        <UpgradeBanner onUpgrade={enterEdit} />
      )}
      {isOwner && !inEdit && !loading && sessionUser?.pubkey && (
        <RelayTipsCard pubkey={sessionUser.pubkey} />
      )}
      {saveNotice && (
        <div className="px-4 py-2 text-[11px] text-green-300 bg-green-950/30 border-b border-green-900/60 flex items-center justify-between gap-3">
          <span>{saveNotice.msg}</span>
          <button
            type="button"
            onClick={() => setSaveNotice(null)}
            className="text-green-500 hover:text-green-300 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <RelaySkeleton />
      ) : inEdit ? (
        <EditList
          draft={draft}
          addInput={addInput}
          addError={addError}
          saveError={saveError}
          saving={saving}
          source={source}
          onToggleRW={toggleRW}
          onRemove={removeRelay}
          onAddChange={v => { setAddInput(v); setAddError('') }}
          onAdd={addRelay}
          onSave={handleSave}
          onCancel={cancelEdit}
        />
      ) : emptyForOwner ? (
        <EmptyOwnerPrompt onStart={() => { setDraft([]); setMode('edit') }} />
      ) : relays.length === 0 ? (
        <div className="p-4 text-xs text-neutral-500">
          This user hasn't published a kind 10002 relay list, so we can't show which
          relays they use. Their notes may still reach anyone on the network — see the FAQ below.
        </div>
      ) : isMobile ? (
        <MobileList relays={relays} infoByUrl={infoByUrl} copier={copier} />
      ) : (
        <DesktopTable relays={relays} infoByUrl={infoByUrl} copier={copier} />
      )}

      <RelayFAQ />
      {copier.modalElement}
      <RelayDiscoveryModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        sessionUser={sessionUser}
      />
    </div>
  )
}

function UpgradeBanner({ onUpgrade }) {
  return (
    <div className="px-4 py-2.5 text-[11px] text-amber-200 bg-amber-950/30 border-b border-amber-900/60 flex items-center justify-between gap-3">
      <span>
        <span className="font-semibold">Legacy relay list.</span>{' '}
        Your relays are stored in the old kind 3 contact-list format. Modern
        clients (and this one) prefer NIP-65 (kind 10002). Upgrading keeps your
        current list and makes it visible to more clients.
      </span>
      <button
        type="button"
        onClick={onUpgrade}
        className="shrink-0 text-[11px] px-2 py-1 rounded border border-amber-700/70 text-amber-100 hover:bg-amber-900/40 focus:outline-none focus:ring-1 focus:ring-amber-600"
      >
        Upgrade →
      </button>
    </div>
  )
}

/**
 * RelayTipsCard — TL;DR for editing your own relay list. Owner-only,
 * starts open with an up-arrow to collapse to just the title.
 * Collapse state persists per-pubkey in localStorage so a user who
 * dismissed it stays dismissed across sessions, but a different login
 * starts fresh. Sits below the header + UpgradeBanner so the legacy-
 * kind-3 nudge is still the first thing the user sees in that case.
 */
function RelayTipsCard({ pubkey }) {
  const storageKey = `mynostr_relay_tips_collapsed_${pubkey}`
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1' } catch { return false }
  })
  function toggle() {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(storageKey, next ? '1' : '0') } catch {}
      return next
    })
  }
  return (
    <div className="text-[11px] text-neutral-300 bg-purple-950/15 border-b border-purple-900/40 leading-relaxed">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-purple-950/25 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
      >
        <span className="text-purple-200 font-semibold">Tips for a healthy relay list</span>
        <span className={`text-purple-300/70 text-[10px] transition-transform ${collapsed ? '' : 'rotate-180'}`}>
          ▼
        </span>
      </button>
      {!collapsed && (
        <ul className="list-disc pl-8 pr-4 pb-2.5 space-y-0.5 text-neutral-400">
          <li>
            Aim for{' '}
            <span className="text-neutral-200">3–5 write</span> and{' '}
            <span className="text-neutral-200">5–10 read</span> relays.
          </li>
          <li>
            Mix operators — pair a big one (e.g.,{' '}
            <span className="text-neutral-200">relay.primal.net</span>,{' '}
            <span className="text-neutral-200">relay.damus.io</span>) with a smaller
            community or paid one (e.g.,{' '}
            <span className="text-neutral-200">nostr.wine</span>,{' '}
            <span className="text-neutral-200">nos.lol</span>, your own).
          </li>
          <li>
            Include a <span className="text-neutral-200">paid relay</span> for
            spam resistance and one with <span className="text-neutral-200">NIP-50 search</span>{' '}
            so you can search your own history later.
          </li>
        </ul>
      )}
    </div>
  )
}

function EmptyOwnerPrompt({ onStart }) {
  return (
    <div className="p-5 text-center">
      <div className="text-[13px] text-neutral-200 mb-1">You haven't published a relay list yet.</div>
      <div className="text-[11px] text-neutral-500 mb-3">
        Without a relay list, other clients guess where to find your notes.
        Publishing one lets everyone discover you reliably.
      </div>
      <button
        type="button"
        onClick={onStart}
        className="text-[12px] px-3 py-1.5 rounded border border-purple-700 bg-purple-950/40 text-purple-200 hover:bg-purple-900/60 focus:outline-none focus:ring-1 focus:ring-purple-600"
      >
        Create a relay list
      </button>
    </div>
  )
}

function RelaySkeleton() {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-8 bg-neutral-900 rounded animate-pulse" />
      ))}
    </div>
  )
}

function RWBadge({ read, write }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold leading-none">
      {write && (
        <span className="px-1 py-0.5 rounded bg-purple-950/40 text-purple-300 border border-purple-900/60" title="Write — user publishes to this relay">W</span>
      )}
      {read && (
        <span className="px-1 py-0.5 rounded bg-neutral-900 text-neutral-300 border border-neutral-700" title="Read — user reads from this relay">R</span>
      )}
    </span>
  )
}

function FeatureCell({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-neutral-700 tabular-nums" aria-label="unknown">—</span>
  }
  return value
    ? <span className="text-green-400" aria-label="yes">✓</span>
    : <span className="text-neutral-700" aria-label="no">–</span>
}

function SoftwareCell({ info }) {
  const sw = relaySoftware(info)
  if (info?._error) return <span className="text-neutral-700">—</span>
  if (!sw) return <span className="text-neutral-600 italic text-[10px]">unknown</span>
  const hoverBody = typeof info?.software === 'string'
    ? info.software
    : 'Relay software declared in NIP-11. See the FAQ for what each stack implies.'
  return (
    <HoverTip label={`Software — ${sw}`} body={hoverBody}>
      <span className="text-neutral-300 font-mono text-[10px] cursor-help block truncate">{sw}</span>
    </HoverTip>
  )
}

function StatusDot({ info }) {
  let cls = 'bg-neutral-600 animate-pulse'
  let title = 'Checking relay…'
  if (info?._error) {
    cls = 'bg-rose-500'
    title = info._error === 'timeout' ? 'Offline — no response within 5s' : `Offline — ${info._error}`
  } else if (info) {
    cls = 'bg-green-500'
    title = 'Online — responded with a NIP-11 info document'
  }
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" title={title}>
      <span className={`block w-full h-full rounded-full ${cls}`} />
    </span>
  )
}

function PaidBadge({ info }) {
  if (!isPaidRelay(info)) return null
  return (
    <span
      title="Paid relay — charges for write access (NIP-11 payments_url or fees)."
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded text-[9px] font-semibold bg-amber-950/50 text-amber-300 border border-amber-900/70 leading-none"
    >
      P
    </span>
  )
}

// Small "Join" pill rendered next to PaidBadge — links out to where the
// user can see what they get, sign up, or check on a subscription. Sized
// to match the W/R/P pills so the row stays one tidy line of badges.
function JoinLink({ info, relayUrl }) {
  if (!isPaidRelay(info)) return null
  const href = paidRelayInfoUrl(info, relayUrl)
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      title="Open the relay's site to see pricing, sign up, or manage your subscription."
      className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold leading-none bg-amber-950/40 text-amber-300 border border-amber-900/70 hover:bg-amber-900/50 hover:text-amber-200 hover:border-amber-700 transition-colors"
    >
      Join
    </a>
  )
}

function DesktopTable({ relays, infoByUrl, copier }) {
  return (
    <table className="w-full text-[10px] table-fixed">
      <colgroup>
        <col style={{ width: '180px' }} />
        <col />
        {FEATURES.map(f => <col key={f.key} style={{ width: '46px' }} />)}
        <col style={{ width: '76px' }} />
        {copier.canCopy && <col style={{ width: '32px' }} />}
      </colgroup>
      <thead className="text-[10px] uppercase tracking-wider text-neutral-500">
        <tr className="border-b border-neutral-800">
          <th className="text-left  font-medium px-2 py-1.5">Relay</th>
          <th className="text-left  font-medium px-1.5 py-1.5">Use</th>
          {FEATURES.map(f => (
            <th key={f.key} className="px-1 py-1.5 font-medium border-l border-neutral-900 text-center">
              <HoverTip label={f.title} body={f.desc}>
                <span className="cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2">{f.label}</span>
              </HoverTip>
            </th>
          ))}
          <th className="px-1 py-1.5 font-medium border-l border-neutral-900 text-center">
            <HoverTip
              label="Software — relay codebase"
              body="Which relay software the operator runs. Different stacks have different strengths — see the FAQ for a breakdown of strfry, khatru, nostream, ditto, and the rest."
            >
              <span className="cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2">Software</span>
            </HoverTip>
          </th>
          {/* Copy-to-my-list column — labeled "Add" so it reads as an
              action column, visually separated from the relay-data
              columns to its left. */}
          {copier.canCopy && (
            <th className="px-1 py-1.5 font-medium border-l border-neutral-900 text-center">Add</th>
          )}
        </tr>
      </thead>
      <tbody>
        {relays.map(r => {
          const info = infoByUrl[r.url]
          return (
            <tr key={r.url} className="border-b border-neutral-900 last:border-b-0 hover:bg-neutral-900/40">
              <td className="px-2 py-1.5 overflow-hidden">
                <div className="text-neutral-100 truncate leading-tight" title={displayName(r.url, info)}>
                  {displayName(r.url, info)}
                </div>
                <div className="text-[9px] text-neutral-500 truncate leading-tight" title={r.url}>
                  {r.url}
                </div>
              </td>
              <td className="px-1.5 py-1.5">
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <StatusDot info={info} />
                  <RWBadge read={r.read} write={r.write} />
                  <PaidBadge info={info} />
                  <JoinLink info={info} relayUrl={r.url} />
                </span>
              </td>
              {FEATURES.map(f => (
                <td key={f.key} className="px-1 py-1.5 text-center border-l border-neutral-900 tabular-nums">
                  <FeatureCell value={f.check(info)} />
                </td>
              ))}
              <td className="px-1.5 py-1.5 border-l border-neutral-900">
                <SoftwareCell info={info} />
              </td>
              {copier.canCopy && (
                <td className="px-1 py-1.5 border-l border-neutral-900 text-center">
                  <CopyButton url={r.url} read={r.read} write={r.write} {...copier} />
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MobileList({ relays, infoByUrl, copier }) {
  return (
    <div className="divide-y divide-neutral-900">
      {relays.map(r => {
        const info = infoByUrl[r.url]
        const sw = relaySoftware(info)
        return (
          <div key={r.url} className="px-3 py-2.5 space-y-1.5">
            <div className="flex items-start justify-between gap-2 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-neutral-100 truncate leading-tight" title={displayName(r.url, info)}>
                  {displayName(r.url, info)}
                </div>
                <div className="text-[10px] text-neutral-500 truncate leading-tight" title={r.url}>
                  {r.url}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-1.5">
                <PaidBadge info={info} />
                <JoinLink info={info} relayUrl={r.url} />
                <StatusDot info={info} />
                <RWBadge read={r.read} write={r.write} />
              </div>
              {/* Copy action, pulled out of the badge cluster with extra
                  spacing so it reads as an action, not another piece of
                  relay metadata. */}
              {copier.canCopy && (
                <div className="shrink-0 ml-1">
                  <CopyButton url={r.url} read={r.read} write={r.write} {...copier} />
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
              {FEATURES.map(f => (
                <HoverTip key={f.key} label={f.title} body={f.desc}>
                  <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 cursor-help">
                    <span className="text-[10px] text-neutral-400">{f.label}</span>
                    <FeatureCell value={f.check(info)} />
                  </span>
                </HoverTip>
              ))}
              {sw && (
                <HoverTip
                  label={`Software — ${sw}`}
                  body={typeof info?.software === 'string' ? info.software : 'Relay codebase.'}
                >
                  <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 cursor-help">
                    <span className="text-[10px] text-neutral-400">SW</span>
                    <span className="text-[10px] font-mono text-neutral-300">{sw}</span>
                  </span>
                </HoverTip>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * EditList — the inline editor shown when mode === 'edit'. Each row is a
 * relay URL with W/R checkboxes and a trash button. Below the rows is a
 * text input to add a new relay, and at the bottom Save / Cancel buttons.
 *
 * Validation, error reporting, and the publish call live in the parent so
 * the component can stay dumb (and re-used cleanly).
 */
function EditList({
  draft, addInput, addError, saveError, saving, source,
  onToggleRW, onRemove, onAddChange, onAdd, onSave, onCancel,
}) {
  function handleAddKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      onAdd()
    }
  }

  return (
    <div className="p-3 space-y-3">
      {source === 'kind3' && (
        <div className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-900/60 rounded px-2.5 py-1.5">
          Saving here will publish your list as NIP-65 (kind 10002) — that's the upgrade.
        </div>
      )}

      <div className="border border-neutral-800 rounded overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-900/40">
            <tr className="border-b border-neutral-800">
              <th className="text-left font-medium px-2 py-1.5">Relay</th>
              <th className="font-medium px-1.5 py-1.5 text-center w-12">Write</th>
              <th className="font-medium px-1.5 py-1.5 text-center w-12">Read</th>
              <th className="font-medium px-1.5 py-1.5 text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {draft.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-neutral-500 text-[11px]">
                  Your list is empty — add at least one relay below.
                </td>
              </tr>
            )}
            {draft.map(r => (
              <tr key={r.url} className="border-b border-neutral-900 last:border-b-0">
                <td className="px-2 py-1.5 overflow-hidden">
                  <div className="text-neutral-200 text-[11px] truncate leading-tight font-mono" title={r.url}>
                    {r.url}
                  </div>
                </td>
                <td className="px-1.5 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.write}
                    onChange={() => onToggleRW(r.url, 'write')}
                    className="accent-purple-600"
                    aria-label="Write to this relay"
                  />
                </td>
                <td className="px-1.5 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.read}
                    onChange={() => onToggleRW(r.url, 'read')}
                    className="accent-purple-600"
                    aria-label="Read from this relay"
                  />
                </td>
                <td className="px-1.5 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => onRemove(r.url)}
                    title="Remove this relay"
                    className="text-neutral-500 hover:text-rose-400 text-sm leading-none focus:outline-none"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={addInput}
              onChange={e => onAddChange(e.target.value)}
              onKeyDown={handleAddKey}
              placeholder="wss://relay.example.com"
              className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[12px] text-neutral-200 font-mono placeholder:text-neutral-600 focus:outline-none focus:border-purple-600"
            />
            <button
              type="button"
              onClick={onAdd}
              className="text-[11px] px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-purple-700/60 hover:text-purple-200 focus:outline-none focus:ring-1 focus:ring-purple-600"
            >
              Add
            </button>
          </div>
          {addError && (
            <div className="text-[10px] text-rose-400 mt-1">{addError}</div>
          )}
        </div>
      </div>

      {saveError && (
        <div className="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-900/60 rounded px-2.5 py-1.5">
          {saveError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="text-[12px] px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-600 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="text-[12px] px-3 py-1.5 rounded border border-purple-700 bg-purple-950/40 text-purple-200 hover:bg-purple-900/60 focus:outline-none focus:ring-1 focus:ring-purple-600 disabled:opacity-50"
        >
          {saving ? 'Publishing…' : 'Save & publish'}
        </button>
      </div>
    </div>
  )
}

/**
 * HoverTip — wraps arbitrary children and reveals a styled tooltip on hover
 * (desktop) or tap (mobile/keyboard). Dismisses on Escape and click-outside.
 * `title` attribute on the trigger acts as a graceful fallback for screen
 * readers and long-press hints.
 */
function HoverTip({ label, body, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      title={`${label}. ${body}`}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-20 w-64 max-w-[calc(100vw-2rem)] bg-neutral-950 border border-neutral-700 rounded-md shadow-lg px-3 py-2 text-[11px] text-neutral-300 leading-snug normal-case tracking-normal text-left"
          onClick={e => e.stopPropagation()}
        >
          <span className="block text-neutral-100 font-medium mb-0.5">{label}</span>
          <span>{body}</span>
        </span>
      )}
    </span>
  )
}
