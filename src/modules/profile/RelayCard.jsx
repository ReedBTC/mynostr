/**
 * RelayCard — per-user relay dashboard shown under the posting cadence chart.
 *
 * Loads the user's kind 10002 relay list (read/write), then fetches each
 * relay's NIP-11 info document in parallel and renders:
 *
 *   Desktop: table with columns Name · R/W · Status · Software · flags · NIPs
 *   Mobile:  stacked cards with the same fields reflowed
 *
 * NIP columns flag support for five user-facing capabilities (articles,
 * events, market, right-to-vanish, search). Each column header carries a
 * ? tooltip that works on hover (desktop) and click (mobile). A collapsible
 * FAQ at the bottom teaches the concepts most users don't know about relays.
 */
import { useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { fetchNip11, fetchUserRelayList } from '../../lib/relayInfo.js'
import RelayFAQ from './RelayFAQ.jsx'

// NIP columns we surface as checkmark/dash. Order matches the header row.
// Keep this list tight — mobile width is the limiting factor.
const NIP_COLUMNS = [
  { nip: 23, name: 'Articles',        desc: 'NIP-23 — Long-form articles (kind 30023). Required for publishing & reading full posts with titles, cover images, and markdown.' },
  { nip: 52, name: 'Events',          desc: 'NIP-52 — Calendar events (kind 31922/31923). Needed to publish and discover dated events.' },
  { nip: 99, name: 'Market',          desc: 'NIP-99 — Classified listings (kind 30402). Used by marketplace clients to list and buy items.' },
  { nip: 62, name: 'Right to Vanish', desc: 'NIP-62 — Request to vanish (kind 62). Relays that support this MUST permanently delete your events when asked. Compare to NIP-09 which is only a best-effort "SHOULD delete".' },
  { nip: 50, name: 'Search',          desc: 'NIP-50 — Full-text search. Relays without NIP-50 can only filter by author, tag, or kind — they cannot answer keyword queries.' },
]

// Short human name for a relay URL. Uses NIP-11 `name` if present, else the
// host portion of the URL (wss://relay.damus.io → relay.damus.io).
function displayName(url, info) {
  if (info?.name && typeof info.name === 'string') return info.name.slice(0, 40)
  try { return new URL(url).host } catch { return url }
}

// NIP support is reported as an array of numbers in NIP-11. Cross-check
// against both the top-level supported_nips and any aliases relays sometimes
// use (strings, decimal numbers, etc.).
function supportsNip(info, nip) {
  if (!info || info._error) return null // unknown
  const list = Array.isArray(info.supported_nips) ? info.supported_nips : null
  if (!list) return null
  return list.some(n => Number(n) === nip)
}

export default function RelayCard({ pubkey }) {
  const isMobile = useIsMobile()
  const [relays, setRelays] = useState([])
  const [loading, setLoading] = useState(true)
  const [infoByUrl, setInfoByUrl] = useState({}) // url -> NIP-11 or {_error}

  // Load the user's relay list whenever the viewed pubkey changes, then
  // fan out NIP-11 fetches in parallel. Failures are individual — one bad
  // relay doesn't block the rest.
  useEffect(() => {
    if (!pubkey) { setRelays([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setInfoByUrl({})
    ;(async () => {
      const list = await fetchUserRelayList(pubkey)
      if (cancelled) return
      setRelays(list)
      setLoading(false)
      // Kick off NIP-11 fetches. Update state per-relay as each resolves
      // so the first ones paint fast even if one is slow.
      for (const r of list) {
        fetchNip11(r.url).then(info => {
          if (cancelled) return
          setInfoByUrl(prev => ({ ...prev, [r.url]: info }))
        })
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  const readCount  = relays.filter(r => r.read).length
  const writeCount = relays.filter(r => r.write).length

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-neutral-200">Relays</h2>
          <span className="text-[10px] text-neutral-500 whitespace-nowrap">
            where their notes live
          </span>
        </div>
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
      </div>

      {loading ? (
        <RelaySkeleton />
      ) : relays.length === 0 ? (
        <div className="p-4 text-xs text-neutral-500">
          This user hasn't published a kind 10002 relay list, so we can't show which
          relays they use. Their notes may still reach anyone on the network — see the FAQ below.
        </div>
      ) : isMobile ? (
        <MobileList relays={relays} infoByUrl={infoByUrl} />
      ) : (
        <DesktopTable relays={relays} infoByUrl={infoByUrl} />
      )}

      <RelayFAQ />
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

function NipCell({ supports }) {
  if (supports === null || supports === undefined) {
    return <span className="text-neutral-700 tabular-nums">—</span>
  }
  return supports
    ? <span className="text-green-400" aria-label="supported">✓</span>
    : <span className="text-neutral-700" aria-label="not supported">–</span>
}

// Colored dot only. Title carries the longform explanation for hover/A11y.
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

function isPaidRelay(info) {
  if (!info || info._error) return false
  const lim = info.limitation || {}
  return Boolean(info.payments_url || lim.payment_required || (info.fees && Object.keys(info.fees).length))
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

function DesktopTable({ relays, infoByUrl }) {
  return (
    <table className="w-full text-[10px] table-fixed">
      <colgroup>
        <col style={{ width: '180px' }} />
        <col />
        {NIP_COLUMNS.map(c => <col key={c.nip} style={{ width: '36px' }} />)}
      </colgroup>
      <thead className="text-[10px] uppercase tracking-wider text-neutral-500">
        <tr className="border-b border-neutral-800">
          <th className="text-left  font-medium px-2 py-1.5">Relay</th>
          <th className="text-left  font-medium px-1.5 py-1.5">Use</th>
          <th colSpan={NIP_COLUMNS.length} className="text-center font-medium px-1 py-1.5 border-l border-neutral-800">
            NIP
          </th>
        </tr>
        <tr className="border-b border-neutral-800 text-neutral-400">
          <th colSpan={2} />
          {NIP_COLUMNS.map(c => (
            <th key={c.nip} className="px-1 py-1 font-medium border-l border-neutral-900 text-center">
              <HoverTip label={`NIP-${c.nip} — ${c.name}`} body={c.desc}>
                <span className="tabular-nums cursor-help underline decoration-dotted decoration-neutral-600 underline-offset-2">{c.nip}</span>
              </HoverTip>
            </th>
          ))}
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
                </span>
              </td>
              {NIP_COLUMNS.map(c => (
                <td key={c.nip} className="px-1 py-1.5 text-center border-l border-neutral-900 tabular-nums">
                  <NipCell supports={supportsNip(info, c.nip)} />
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MobileList({ relays, infoByUrl }) {
  return (
    <div className="divide-y divide-neutral-900">
      {relays.map(r => {
        const info = infoByUrl[r.url]
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
                <StatusDot info={info} />
                <RWBadge read={r.read} write={r.write} />
              </div>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0 mr-1">NIP</span>
              {NIP_COLUMNS.map(c => (
                <HoverTip key={c.nip} label={`NIP-${c.nip} — ${c.name}`} body={c.desc}>
                  <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 cursor-help">
                    <span className="text-[10px] text-neutral-400 tabular-nums">{c.nip}</span>
                    <NipCell supports={supportsNip(info, c.nip)} />
                  </span>
                </HoverTip>
              ))}
            </div>
          </div>
        )
      })}
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
