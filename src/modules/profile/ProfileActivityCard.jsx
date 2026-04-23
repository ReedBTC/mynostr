import { useEffect, useState } from 'react'
import { formatCount, formatSats } from '../../lib/utils.js'
import InfoDot from './InfoDot.jsx'

/**
 * ProfileActivityCard — zap + engagement summary for the viewed user.
 *
 * Data sources:
 *   - `stats` (kind 10000105 UserStats): sent totals (total_zap_count,
 *     total_satszapped), received zap count (content_zap_count),
 *     time_joined, media_count, relay_count.
 *   - `zapAggregates` (user_zaps_by_satszapped): total sats received,
 *     paints in a second pass.
 *
 * Layout: header + "since" pill → mirrored balance sheet (zapped/earned)
 * → zap count bars → media/relays tiles.
 */
export default function ProfileActivityCard({ stats, zapAggregates, loading, zapLoading, onRefresh }) {
  const joined       = stats?.time_joined
  const satsSent     = stats?.total_satszapped
  const zapsSent     = stats?.total_zap_count
  const zapsReceived = stats?.content_zap_count

  const satsReceived = zapAggregates?.satsReceived ?? null

  const maxZaps = Math.max(zapsSent || 0, zapsReceived || 0)

  // Instant visual feedback that doesn't depend on parent state propagation —
  // mirrors the pattern in PostingCadenceCard so clicks always register
  // visibly even if the parent's loading flag arrives slightly late. Cleared
  // as soon as the parent's loading/zapLoading flips true; a 1.5s safety
  // timer catches cache-hit paths where parent never signals loading.
  const [forceSkeleton, setForceSkeleton] = useState(false)
  useEffect(() => {
    if (!forceSkeleton) return
    if (loading || zapLoading) {
      setForceSkeleton(false)
      return
    }
    const t = setTimeout(() => setForceSkeleton(false), 1500)
    return () => clearTimeout(t)
  }, [forceSkeleton, loading, zapLoading])
  function handleRefreshClick() {
    if (loading || zapLoading) return
    setForceSkeleton(true)
    onRefresh?.()
  }

  const busy = loading || zapLoading || forceSkeleton

  return (
    <div className={`border rounded-lg bg-neutral-950 overflow-hidden transition-colors ${
      forceSkeleton ? 'border-purple-600/60' : 'border-neutral-800'
    }`}>

      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 gap-3">
        <h2 className="text-sm font-semibold text-neutral-200 inline-flex items-center gap-1.5">
          Activity
          <InfoDot align="left">
            <p>
              Zap counts and sats totals come from Primal's indexer. The
              indexed count can lag real activity, so counts may be lower
              than reality until Primal catches up. Hit refresh to retry.
            </p>
          </InfoDot>
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          {busy ? (
            <span className="text-[11px] text-purple-300 inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
              Refreshing…
            </span>
          ) : (
            <JoinedBadge ts={joined} loading={false} />
          )}
          {onRefresh && (
            <button
              onClick={handleRefreshClick}
              disabled={busy}
              aria-label="Refresh activity"
              title="Refresh — Primal's index can lag; retry to pull fresh totals"
              className={`${busy ? 'text-purple-300' : 'text-neutral-500 hover:text-neutral-200'} disabled:cursor-not-allowed transition-colors p-1 -m-1`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={busy ? 'animate-spin' : ''}
              >
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <BalanceSheet
        satsSent={satsSent}
        satsReceived={satsReceived}
        loading={(loading && satsSent == null) || forceSkeleton}
        zapLoading={zapLoading || forceSkeleton}
      />

      <div className="px-4 py-4 border-t border-neutral-800 space-y-3">
        <ZapBar
          label="Zaps sent"
          count={zapsSent}
          max={maxZaps}
          colorClass="bg-amber-500"
          loading={(loading && zapsSent == null) || forceSkeleton}
        />
        <ZapBar
          label="Zaps received"
          count={zapsReceived}
          max={maxZaps}
          colorClass="bg-emerald-500"
          loading={(loading && zapsReceived == null) || forceSkeleton}
        />
      </div>
    </div>
  )
}

function JoinedBadge({ ts, loading }) {
  if (loading) {
    return <span className="inline-block w-24 h-3 bg-neutral-800 rounded animate-pulse" />
  }
  if (!ts) return <span className="text-[11px] text-neutral-600">—</span>
  const when = new Date(ts * 1000)
  const label = when.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  return (
    <span className="text-[11px] text-neutral-400">
      on Nostr since <span className="text-neutral-200">{label}</span>
    </span>
  )
}

function BalanceSheet({ satsSent, satsReceived, loading, zapLoading }) {
  const left  = satsSent || 0
  const right = satsReceived || 0
  const max   = Math.max(left, right)
  const leftPct  = max > 0 ? (left  / max) * 100 : 0
  const rightPct = max > 0 ? (right / max) * 100 : 0

  return (
    <div className="px-4 py-4">

      <div className="flex items-baseline justify-between mb-2 gap-2 text-xs">
        <div className="flex items-baseline gap-1.5">
          <span className="text-amber-400">⚡</span>
          <span className="text-neutral-400">Zapped forward</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-neutral-400">Earned</span>
          <span className="text-emerald-400">💰</span>
        </div>
      </div>

      <div className="h-2 relative bg-neutral-900 rounded-full overflow-hidden">
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-neutral-700 z-10" />
        <div
          className="absolute top-0 bottom-0 bg-amber-500 rounded-l-full transition-all duration-500"
          style={{ right: '50%', width: `${leftPct / 2}%` }}
        />
        <div
          className="absolute top-0 bottom-0 bg-emerald-500 rounded-r-full transition-all duration-500"
          style={{ left: '50%', width: `${rightPct / 2}%` }}
        />
      </div>

      <div className="flex items-baseline justify-between mt-2 gap-2 text-sm font-semibold tabular-nums">
        <span className="text-amber-400">
          {loading ? (
            <span className="inline-block w-16 h-4 bg-neutral-800 rounded animate-pulse" />
          ) : satsSent == null ? (
            <span className="text-neutral-600">—</span>
          ) : (
            <>{formatSats(satsSent)} <span className="text-[11px] text-neutral-500 font-normal">sats</span></>
          )}
        </span>
        <span className="text-emerald-400">
          {zapLoading && satsReceived == null ? (
            <span className="inline-block w-16 h-4 bg-neutral-800 rounded animate-pulse" />
          ) : satsReceived == null ? (
            <span className="text-neutral-600">—</span>
          ) : (
            <>{formatSats(satsReceived)} <span className="text-[11px] text-neutral-500 font-normal">sats</span></>
          )}
        </span>
      </div>
    </div>
  )
}

function ZapBar({ label, count, max, colorClass, loading }) {
  const pct = count != null && max > 0 ? Math.max(2, (count / max) * 100) : 0
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <span className="text-xs font-medium text-neutral-300">{label}</span>
        <span className="text-xs font-semibold text-neutral-100 tabular-nums">
          {loading ? (
            <span className="inline-block w-10 h-3 bg-neutral-800 rounded animate-pulse" />
          ) : count == null ? (
            <span className="text-neutral-600">—</span>
          ) : (
            formatCount(count)
          )}
        </span>
      </div>
      <div className="h-2 bg-neutral-900 rounded-full overflow-hidden">
        <div
          className={`h-full ${colorClass} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

