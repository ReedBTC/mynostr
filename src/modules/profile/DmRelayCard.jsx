/**
 * DmRelayCard — a compact cousin of RelayCard for NIP-17 DM relays (kind 10050).
 *
 * Rendered below RelayCard on the profile view. Intentionally smaller:
 *   - No W/R flags (DM relays are bidirectional inboxes)
 *   - No feature columns (no relay declares NIP-17 support anyway)
 *   - Status dot + Paid badge only, since "reachable" is the only live signal
 *
 * Owner affordances mirror RelayCard: an Edit button flips into an inline
 * list editor, a "Create a list" prompt appears when the user has no kind
 * 10050 yet (with suggested URLs pre-seeded from their write relays), and
 * Save publishes a fresh kind 10050.
 */
import { useEffect, useRef, useState } from 'react'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import {
  fetchNip11,
  fetchUserDmRelays,
  fetchUserRelayList,
  publishDmRelayList,
  normalizeRelayUrl,
  suggestDmRelays,
  isPaidRelay,
  paidRelayInfoUrl,
} from '../../lib/relayInfo.js'
import DmRelayFAQ from './DmRelayFAQ.jsx'
import InfoDot from './InfoDot.jsx'
import { useRelayCopier, CopyButton, RELAYS_CHANGED_EVENT } from './useRelayCopier.jsx'

function displayName(url, info) {
  if (info?.name && typeof info.name === 'string') return info.name.slice(0, 40)
  try { return new URL(url).host } catch { return url }
}

// Heuristic DM-relay quality assessment, built from NIP-11 declarations only.
// Relays that don't declare the problematic flags can still have problems in
// practice — this is a floor ("these relays definitely won't accept DMs"),
// not a ceiling. Returns { status, reason?, info? } where:
//   loading     — NIP-11 in flight, UI should show a muted pill
//   unreachable — NIP-11 fetch failed (doesn't necessarily mean the relay is
//                 dead for Nostr traffic, just that we can't assess it)
//   bad         — writes are restricted by policy (allowlist, payment on
//                 events, PoW). NIP-42 auth ALONE does NOT qualify — that's
//                 informational, since NIP-17 explicitly recommends
//                 auth-required DM relays for read-side metadata privacy
//                 (`kind:1059` served only to p-tagged users via NIP-42),
//                 and any key-holder can complete an AUTH challenge. This
//                 cost us hours of research to unwind — don't re-lump these.
//   warn        — soft issue with the DM path itself: small size cap or
//                 short retention. These are real "may lose DMs" signals.
//   ok          — no declared issues; may still fail in practice
//
// `info` is an orthogonal informational note surfaced as an (i) pill
// next to the verdict. Currently used to flag NIP-42 auth so the user
// sees the mechanism without the verdict dropping from OK to warn.
const MIN_DM_BYTES = 16 * 1024      // below this we can't trust gift-wraps to land
const MIN_RETENTION_SEC = 7 * 86400 // shorter and offline users miss DMs

const AUTH_INFO_NOTE = 'Requires NIP-42 auth on connect — standard for DM inbox relays; hides gift-wrap metadata from scrapers. Every modern DM client (Amethyst, 0xchat, Damus, Primal) handles this automatically. Only a minimal client without NIP-42 support would fail to send DMs here.'

function assessDmRelay(info) {
  if (!info) return { status: 'loading' }
  if (info._error) return { status: 'unreachable', reason: `Could not reach relay (${info._error}).` }

  const lim = info.limitation || {}
  // `restricted_writes` is the real "strangers can't write here" signal —
  // per NIP-11, it means writes have policy conditions like a pubkey
  // allowlist, payment, or PoW. `auth_required` is orthogonal (it just
  // gates the connection behind a signed challenge that any key-holder
  // can satisfy) and is surfaced as an informational note below, not a
  // verdict downgrade.
  if (lim.restricted_writes) {
    return { status: 'bad', reason: 'Restricts writes — strangers may not be able to send you DMs here.' }
  }

  // NIP-42 auth alone is the NIP-17-recommended DM inbox pattern. It does
  // not downgrade the verdict — the relay is still good for DMs, the user
  // just benefits from knowing why a relay like auth.nostr1.com asks to
  // authenticate. Attached to ok/warn alike; if size/retention warnings
  // also fire, the verdict drops to warn and the auth note sits alongside.
  const infoNote = lim.auth_required ? AUTH_INFO_NOTE : null

  const warnings = []
  const maxLen = Number(lim.max_message_length) || 0
  if (maxLen > 0 && maxLen < MIN_DM_BYTES) {
    warnings.push(`Small message cap (${Math.round(maxLen / 1024)} KB) — large DMs may be rejected.`)
  }
  if (Array.isArray(info.retention)) {
    // Flag only clearly-short retention windows that would apply to DMs.
    // `kinds` may be absent (applies to all) or list event kinds explicitly;
    // if it's present and excludes kind 1059, the policy doesn't affect DMs.
    for (const r of info.retention) {
      if (!r || typeof r !== 'object') continue
      const t = Number(r.time)
      if (!t || t <= 0) continue
      const kinds = Array.isArray(r.kinds) ? r.kinds : null
      const appliesToDms = !kinds || kinds.some(k => {
        // kinds entries can be numbers or [lo, hi] ranges
        if (typeof k === 'number') return k === 1059
        if (Array.isArray(k) && k.length === 2) return 1059 >= k[0] && 1059 <= k[1]
        return false
      })
      if (appliesToDms && t < MIN_RETENTION_SEC) {
        warnings.push(`Short retention (${Math.round(t / 86400)} days) — you may miss DMs while offline.`)
        break
      }
    }
  }
  if (warnings.length) return { status: 'warn', reason: warnings.join(' '), info: infoNote }
  return { status: 'ok', info: infoNote }
}

function summarizeAssessments(relays, infoByUrl) {
  let ok = 0, warn = 0, bad = 0, other = 0
  for (const url of relays) {
    const a = assessDmRelay(infoByUrl[url])
    if (a.status === 'ok')   ok++
    else if (a.status === 'warn') warn++
    else if (a.status === 'bad')  bad++
    else other++
  }
  return { ok, warn, bad, other }
}

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

export default function DmRelayCard({ pubkey }) {
  const { isOwner } = useOwnerContext()
  const copier = useRelayCopier({ kind: 'dm' })
  const [relays, setRelays] = useState([])           // array of URL strings
  const [source, setSource] = useState('none')        // 'nip17' | 'none'
  const [loading, setLoading] = useState(true)
  const [infoByUrl, setInfoByUrl] = useState({})
  const [suggested, setSuggested] = useState([])     // precomputed suggestions for the empty-owner prompt

  const [mode, setMode] = useState('view')
  const [draft, setDraft] = useState([])
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState(null)
  // Confirmation gate for "save with zero DM relays" — explicitly
  // removing all DM relays is a valid intent (peers see the empty list
  // and stop sending gift-wraps to a stale inbox), but it warrants a
  // confirm so an accidental All-Remove + Save can't silently leave
  // the user uncontactable.
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  // Refetch token bumped by sibling components (RelayDiscoveryModal's
  // useRelayCopier instance) when they publish a new kind 10050 for
  // this user. Same shape as the parallel listener in RelayCard for
  // kind 10002.
  const [refetchToken, setRefetchToken] = useState(0)
  useEffect(() => {
    if (!pubkey) return
    function onChanged(e) {
      const detail = e?.detail
      if (!detail || detail.kind !== 'dm') return
      if (detail.pubkey !== pubkey) return
      setRefetchToken(t => t + 1)
    }
    window.addEventListener(RELAYS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(RELAYS_CHANGED_EVENT, onChanged)
  }, [pubkey])

  // Load kind 10050 for the viewed user. When owner + empty, also load the
  // user's kind 10002 list + NIP-11 info so suggestDmRelays can filter out
  // auth-gated relays from the suggestion set.
  useEffect(() => {
    if (!pubkey) { setRelays([]); setSource('none'); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setInfoByUrl({})
    setMode('view')
    setSaveError('')
    setSaveNotice(null)
    ;(async () => {
      const { relays: list, source: src } = await fetchUserDmRelays(pubkey)
      if (cancelled) return
      setRelays(list)
      setSource(src)
      setLoading(false)
      // Kick NIP-11 on each DM relay so the status dot and Paid badge can paint.
      for (const url of list) {
        fetchNip11(url).then(info => {
          if (cancelled) return
          setInfoByUrl(prev => ({ ...prev, [url]: info }))
        })
      }
      // Suggestions are only needed when the owner is looking at an empty
      // list — no need to burn a round-trip for other viewers.
      if (list.length === 0 && isOwner) {
        const { relays: writeList } = await fetchUserRelayList(pubkey)
        if (cancelled) return
        // Race NIP-11 on the writes so we can filter out auth-gated relays.
        // 2s budget — if we don't have info we fall back to optimistic inclusion.
        const writeInfo = {}
        await Promise.all((writeList || []).map(r =>
          Promise.race([
            fetchNip11(r.url),
            new Promise(res => setTimeout(() => res(null), 2000)),
          ]).then(info => { if (info) writeInfo[r.url] = info })
        ))
        if (cancelled) return
        setSuggested(suggestDmRelays(writeList, writeInfo))
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, isOwner, refetchToken])

  function enterEdit(seed) {
    setDraft((seed || relays).slice())
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
  function removeRelay(url) {
    setDraft(d => d.filter(u => u !== url))
  }
  function addRelay() {
    const v = validateRelayInput(addInput)
    if (v.error) { setAddError(v.error); return }
    if (draft.includes(v.url)) {
      setAddError('That relay is already in the list.')
      return
    }
    setDraft(d => [...d, v.url])
    setAddInput('')
    setAddError('')
  }

  async function doSave() {
    setSaving(true)
    setSaveError('')
    try {
      const { relays: confirmedTo } = await publishDmRelayList({ relays: draft })
      setRelays(draft.slice())
      // An empty save is a valid "I have no DM inbox" signal; reflect
      // that in the source so view-mode can render the empty-state
      // copy correctly instead of "(loaded from kind 10050)".
      setSource(draft.length === 0 ? 'none' : 'nip17')
      setMode('view')
      setSaveNotice({
        msg: draft.length === 0
          ? `DM relay list cleared on ${confirmedTo.length} relay${confirmedTo.length === 1 ? '' : 's'}.`
          : `DM relay list published to ${confirmedTo.length} relay${confirmedTo.length === 1 ? '' : 's'}.`,
      })
      for (const url of draft) {
        if (!infoByUrl[url]) {
          fetchNip11(url).then(info => {
            setInfoByUrl(prev => ({ ...prev, [url]: info }))
          })
        }
      }
    } catch (e) {
      setSaveError(e?.message || 'Publish failed. Check your signer and try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    if (saving) return
    // Empty save is allowed but warned — see confirmEmpty doc on state.
    if (draft.length === 0) {
      setConfirmEmpty(true)
      return
    }
    doSave()
  }

  const inEdit = mode === 'edit'
  const emptyForOwner = !loading && relays.length === 0 && isOwner

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <div className="flex flex-col gap-2 px-4 py-3 border-b border-neutral-800 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-neutral-200">DM Relays</h2>
          <span className="text-[10px] text-neutral-500 whitespace-nowrap">
            NIP-17 inbox list (kind 10050)
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-neutral-500 whitespace-nowrap">
            {loading ? (
              <span className="inline-block w-16 h-3 bg-neutral-800 rounded animate-pulse" />
            ) : relays.length > 0 ? (
              !inEdit ? (
                <VerdictSummary relays={relays} infoByUrl={infoByUrl} />
              ) : (
                <>
                  <span className="text-neutral-200 font-medium">{relays.length}</span>{' '}
                  {relays.length === 1 ? 'relay' : 'relays'}
                </>
              )
            ) : (
              <span className="text-neutral-600">No DM relay list</span>
            )}
          </span>
          {isOwner && !loading && !inEdit && relays.length > 0 && (
            <button
              type="button"
              onClick={() => enterEdit()}
              className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 hover:border-purple-700/60 hover:text-purple-200 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
            >
              Edit
            </button>
          )}
        </div>
      </div>

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
      {isOwner && !inEdit && !loading && pubkey && (
        <DmRelayTipsCard pubkey={pubkey} />
      )}

      {loading ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-7 bg-neutral-900 rounded animate-pulse" />
          ))}
        </div>
      ) : inEdit ? (
        <EditList
          draft={draft}
          addInput={addInput}
          addError={addError}
          saveError={saveError}
          saving={saving}
          onRemove={removeRelay}
          onAddChange={v => { setAddInput(v); setAddError('') }}
          onAdd={addRelay}
          onSave={handleSave}
          onCancel={cancelEdit}
        />
      ) : emptyForOwner ? (
        <EmptyOwnerPrompt
          suggested={suggested}
          onStart={() => enterEdit(suggested)}
          onBlank={() => enterEdit([])}
        />
      ) : relays.length === 0 ? (
        <div className="p-4 text-xs text-neutral-500">
          This user hasn't published a DM relay list. Other clients will guess
          where to deliver DMs, so delivery may be inconsistent.
        </div>
      ) : (
        <RelayList relays={relays} infoByUrl={infoByUrl} copier={copier} />
      )}

      <DmRelayFAQ />
      {copier.modalElement}
      {confirmEmpty && (
        <ConfirmEmptyDmListModal
          busy={saving}
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={() => { setConfirmEmpty(false); doSave() }}
        />
      )}
    </div>
  )
}

function ConfirmEmptyDmListModal({ busy, onCancel, onConfirm }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      onMouseDown={busy ? undefined : onCancel}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md p-4"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-neutral-100">Leave without adding any NIP-17 relays?</h3>
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
        <p className="text-[11px] text-neutral-500 mb-4 leading-relaxed">
          Other users won't be able to send you NIP-17 direct messages
          until you add at least one DM relay back. This publishes an
          empty kind 10050 event so peers and clients see the change
          immediately.
        </p>
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
            {busy ? 'Publishing…' : 'Leave anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * DmRelayTipsCard — TL;DR for picking DM relays. Owner-only, starts
 * open with an up-arrow to collapse to just the title. Collapse state
 * persists per-pubkey in localStorage so different logins start fresh.
 * Parallel to RelayCard's RelayTipsCard but with NIP-17-specific
 * guidance: pick few, dedicated, gift-wrap-friendly relays rather than
 * reusing the main outbox.
 */
function DmRelayTipsCard({ pubkey }) {
  const storageKey = `mynostr_dm_relay_tips_collapsed_${pubkey}`
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
        <span className="text-purple-200 font-semibold">Tips for picking DM relays</span>
        <span className={`text-purple-300/70 text-[10px] transition-transform ${collapsed ? '' : 'rotate-180'}`}>
          ▼
        </span>
      </button>
      {!collapsed && (
        <ul className="list-disc pl-8 pr-4 pb-2.5 space-y-0.5 text-neutral-400">
          <li>
            <span className="text-neutral-200">1–2 relays is enough</span> — keep
            this list separate from your main outbox.
          </li>
          <li>
            Pick relays that explicitly support <span className="text-neutral-200">NIP-17 gift-wraps</span>{' '}
            (e.g., <span className="text-neutral-200">inbox.lol</span>,{' '}
            <span className="text-neutral-200">auth.nostr1.com</span>,{' '}
            <span className="text-neutral-200">relay.0xchat.com</span>).
          </li>
          <li>
            Big public relays vary on kind-1059 — some accept, some rate-limit,
            some opt out. A dedicated DM relay is more predictable; if you
            do reuse a general-purpose one, send yourself a test DM to confirm
            it lands.
          </li>
        </ul>
      )}
    </div>
  )
}

function EmptyOwnerPrompt({ suggested, onStart, onBlank }) {
  return (
    <div className="p-4">
      <div className="text-[13px] text-neutral-200 mb-1">You haven't published a DM relay list.</div>
      <div className="text-[11px] text-neutral-500 mb-3">
        Without one, other clients guess where to deliver your DMs — see the FAQ for why that
        matters. A good starting list is a subset of your write relays that accept messages
        from anyone (no auth required).
      </div>
      {suggested && suggested.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">Suggested</div>
          <ul className="space-y-1">
            {suggested.map(url => (
              <li key={url} className="text-[11px] font-mono text-neutral-300 truncate">{url}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onStart}
          className="text-[12px] px-3 py-1.5 rounded border border-purple-700 bg-purple-950/40 text-purple-200 hover:bg-purple-900/60 focus:outline-none focus:ring-1 focus:ring-purple-600"
        >
          Start from suggestions
        </button>
        <button
          type="button"
          onClick={onBlank}
          className="text-[12px] px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-600"
        >
          Start blank
        </button>
      </div>
    </div>
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
      title="Paid relay — charges for write access."
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded text-[9px] font-semibold bg-amber-950/50 text-amber-300 border border-amber-900/70 leading-none"
    >
      P
    </span>
  )
}

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

function RelayList({ relays, infoByUrl, copier }) {
  return (
    <div className="divide-y divide-neutral-900">
      {/* Column header + vertical dividers that match RelayCard's
          DesktopTable look. Columns:
            • Relay (status dot + name + URL)
            • DMs — composite readiness: doesn't gate writes to an
              allowlist, reasonable size + retention for gift-wraps
            • Add — per-row copy button (only when canCopy)
          Columns are explicit widths so each row's cells line up under
          the header labels. Borders live on the DMs and Add columns
          (left edge) to read as dividers between sections. */}
      {relays.length > 0 && (
        <div className="flex items-stretch py-1 border-b border-neutral-800/60 text-[10px] uppercase tracking-wider text-neutral-500">
          <span className="flex-1 pl-4 pr-2 flex items-center">Relay</span>
          <span className="shrink-0 w-[72px] px-2 border-l border-neutral-900 flex items-center justify-end">DMs</span>
          {copier.canCopy && (
            <span className="shrink-0 w-12 px-2 border-l border-neutral-900 flex items-center justify-center">Add</span>
          )}
        </div>
      )}
      {relays.map(url => {
        const info = infoByUrl[url]
        const assessment = assessDmRelay(info)
        const isBad = assessment.status === 'bad'
        return (
          <div key={url} className="flex items-stretch py-2 hover:bg-neutral-900/40">
            <div className="flex items-center gap-2 flex-1 min-w-0 pl-4 pr-2">
              <StatusDot info={info} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-neutral-100 truncate leading-tight" title={displayName(url, info)}>
                  {displayName(url, info)}
                </div>
                <div className="text-[10px] text-neutral-500 truncate leading-tight font-mono" title={url}>
                  {url}
                </div>
                {isBad && (
                  <div className="text-[10px] text-rose-400 leading-tight mt-0.5" title={assessment.reason}>
                    ⚠ {assessment.reason}
                  </div>
                )}
              </div>
            </div>
            <div className="shrink-0 w-[72px] px-2 border-l border-neutral-900 flex items-center justify-end gap-1.5">
              <PaidBadge info={info} />
              <JoinLink info={info} relayUrl={url} />
              {assessment.info && (
                <InfoDot align="right">{assessment.info}</InfoDot>
              )}
              <VerdictBadge assessment={assessment} />
            </div>
            {copier.canCopy && (
              <div className="shrink-0 w-12 px-2 border-l border-neutral-900 flex items-center justify-center">
                <CopyButton url={url} {...copier} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function VerdictBadge({ assessment }) {
  const { status, reason } = assessment
  // Matched sizing/tone to PaidBadge — same pill family, color encodes verdict.
  const map = {
    loading:     { label: '…',     cls: 'bg-neutral-900/50 text-neutral-500 border-neutral-800',         title: 'Checking relay…' },
    ok:          { label: 'OK',    cls: 'bg-green-950/40 text-green-300 border-green-900/60',           title: 'No declared issues. DMs should work — but relays don\'t advertise NIP-17 support, so this is based on what the relay does declare.' },
    warn:        { label: 'Check', cls: 'bg-amber-950/50 text-amber-300 border-amber-900/70',           title: reason || 'Soft warning — DMs may work but there are declared limits to watch.' },
    bad:         { label: 'Blocks',cls: 'bg-rose-950/50 text-rose-300 border-rose-900/70',              title: reason || 'Restricts writes — strangers may not be able to send you DMs here.' },
    unreachable: { label: '?',     cls: 'bg-neutral-900/60 text-neutral-400 border-neutral-800',        title: reason || 'Could not reach the relay to assess it.' },
  }
  const entry = map[status] || map.unreachable
  return (
    <span
      title={entry.title}
      className={`inline-flex items-center justify-center px-1.5 h-3.5 rounded text-[9px] font-semibold border leading-none ${entry.cls}`}
    >
      {entry.label}
    </span>
  )
}

function VerdictSummary({ relays, infoByUrl }) {
  const { ok, warn, bad, other } = summarizeAssessments(relays, infoByUrl)
  const total = relays.length
  // Prefer the most actionable lens: bad dominates, then warn, then "all good".
  if (bad > 0) {
    return (
      <span className="text-rose-400">
        <span className="font-medium">{bad}</span> of {total} {bad === 1 ? 'blocks' : 'block'} DMs
      </span>
    )
  }
  if (warn > 0) {
    return (
      <span className="text-amber-300">
        <span className="font-medium">{warn}</span> of {total} need a look
      </span>
    )
  }
  if (ok === total && total > 0) {
    return (
      <span className="text-green-400">
        <span className="font-medium">{total}</span> of {total} look good
      </span>
    )
  }
  // loading / all-unreachable: fall back to the simple count
  if (other === total) {
    return (
      <>
        <span className="text-neutral-200 font-medium">{total}</span>{' '}
        {total === 1 ? 'relay' : 'relays'}
      </>
    )
  }
  return (
    <span className="text-neutral-400">
      <span className="font-medium">{ok}</span> of {total} look good
    </span>
  )
}

function EditList({
  draft, addInput, addError, saveError, saving,
  onRemove, onAddChange, onAdd, onSave, onCancel,
}) {
  function handleAddKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); onAdd() }
  }
  return (
    <div className="p-3 space-y-3">
      <div className="border border-neutral-800 rounded overflow-hidden">
        {draft.length === 0 ? (
          <div className="px-3 py-4 text-center text-neutral-500 text-[11px]">
            Your DM relay list is empty — add at least one relay below.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-900">
            {draft.map(url => (
              <li key={url} className="px-3 py-2 flex items-center gap-2">
                <span className="flex-1 min-w-0 font-mono text-[11px] text-neutral-200 truncate" title={url}>
                  {url}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(url)}
                  title="Remove this relay"
                  className="text-neutral-500 hover:text-rose-400 text-sm leading-none focus:outline-none"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
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
