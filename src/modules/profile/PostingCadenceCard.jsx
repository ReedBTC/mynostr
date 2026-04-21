/**
 * PostingCadenceCard — weekly-bucket bar chart of the viewed user's kind 1
 * notes, sized to whatever history window Primal actually returned.
 *
 * The fetch (fetchAuthorPostingCadence) paginates backward until Primal runs
 * out of notes or we hit the safety cap — we trust that window rather than
 * picking a fixed N-day slot. Bars fill the card width using CSS flex, so
 * 6 weeks of history shows as 6 fat bars and 40 weeks shows as 40 thin bars.
 *
 * Input:
 *   cadence = {
 *     buckets: Map<"YYYY-MM-DD", count>  (daily)
 *     total, oldestTs, newestTs, capped
 *   }
 */

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Build exactly `windowWeeks` rolling 7-day buckets anchored to today, oldest
 * first. Every bar represents the same span, and the frame is identical for
 * every user — so two profiles are directly comparable.
 */
function buildWeeks(buckets, windowWeeks) {
  const result = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  let windowEnd = new Date(today)
  for (let i = 0; i < windowWeeks; i++) {
    const windowStart = new Date(windowEnd)
    windowStart.setDate(windowStart.getDate() - 6)

    let count = 0
    const day = new Date(windowStart)
    for (let j = 0; j < 7; j++) {
      count += buckets?.get(dateKey(day)) || 0
      day.setDate(day.getDate() + 1)
    }
    result.unshift({
      weekStart: new Date(windowStart),
      weekEnd:   new Date(windowEnd),
      count,
    })

    windowEnd = new Date(windowStart)
    windowEnd.setDate(windowEnd.getDate() - 1)
  }
  return result
}

export default function PostingCadenceCard({ cadence, loading, onRefresh }) {
  const windowWeeks = cadence?.windowWeeks || 52
  const weeks    = buildWeeks(cadence?.buckets, windowWeeks)
  const total    = cadence?.total  || 0
  const maxCount = weeks.reduce((m, w) => Math.max(m, w.count), 0)

  // Month boundaries: mark week columns where the month flips vs. prior week.
  const monthBoundaries = []
  let lastMonth = -1
  weeks.forEach((w, i) => {
    const m = w.weekStart.getMonth()
    if (m !== lastMonth) {
      monthBoundaries.push({ i, label: w.weekStart.toLocaleDateString(undefined, { month: 'short' }) })
      lastMonth = m
    }
  })

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-neutral-200">Posting cadence</h2>
          <span className="text-[10px] text-neutral-500 whitespace-nowrap">notes per week · past {windowWeeks} weeks</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] whitespace-nowrap">
            {loading ? (
              <span className="text-purple-300 inline-flex items-center gap-1.5">
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                Refreshing…
              </span>
            ) : total > 0 ? (
              <span className="text-neutral-500">
                {total / (windowWeeks * 7) < 0.5 ? (
                  <><span className="text-neutral-200 font-medium">&lt;1</span> note/day</>
                ) : (
                  <><span className="text-neutral-200 font-medium">~{Math.round(total / (windowWeeks * 7))}</span> notes/day</>
                )}
                {cadence?.capped && <span className="text-neutral-600"> (partial)</span>}
              </span>
            ) : (
              <span className="text-neutral-600">No posts in window</span>
            )}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh posting cadence"
              title="Refresh — Primal's paginated fetch sometimes returns partial history"
              className={`${loading ? 'text-purple-300' : 'text-neutral-500 hover:text-neutral-200'} disabled:cursor-not-allowed transition-colors p-1 -m-1`}
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
                className={loading ? 'animate-spin' : ''}
              >
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className={`px-4 py-4 relative transition-opacity ${loading && cadence ? 'opacity-40' : ''}`}>
        {loading && !cadence ? (
          <ChartSkeleton />
        ) : (
          <Chart weeks={weeks} maxCount={maxCount} monthBoundaries={monthBoundaries} />
        )}
      </div>
    </div>
  )
}

/** Pick 2–4 "nice" tick values between 0 and max (always including 0 and max). */
function niceTicks(max) {
  if (max <= 0) return [0]
  if (max === 1) return [0, 1]
  if (max <= 4) return [0, Math.ceil(max / 2), max]
  // Aim for ~4 ticks at round intervals.
  const step = niceStep(max / 4)
  const ticks = []
  for (let v = 0; v <= max; v += step) ticks.push(v)
  if (ticks[ticks.length - 1] !== max) ticks.push(max)
  return ticks
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / pow
  let step
  if (norm < 1.5)      step = 1
  else if (norm < 3.5) step = 2
  else if (norm < 7.5) step = 5
  else                 step = 10
  return step * pow
}

function Chart({ weeks, maxCount, monthBoundaries }) {
  const ticks = niceTicks(maxCount).sort((a, b) => b - a) // top to bottom
  const yScaleMax = ticks[0] || 1

  return (
    <div className="flex gap-2">
      {/* Y-axis labels */}
      <div className="relative w-6 h-28 shrink-0">
        {ticks.map((t, i) => {
          const pct = 100 - (t / yScaleMax) * 100
          return (
            <span
              key={i}
              className="absolute right-0 text-[10px] text-neutral-500 tabular-nums leading-none translate-y-[-50%]"
              style={{ top: `${pct}%` }}
            >
              {t}
            </span>
          )
        })}
      </div>

      <div className="flex-1 min-w-0">
        <div className="relative h-28 border-b border-neutral-800">
          {/* Horizontal gridlines aligned to ticks */}
          <div className="absolute inset-0 pointer-events-none">
            {ticks.map((t, i) => {
              if (t === 0) return null
              const pct = 100 - (t / yScaleMax) * 100
              return (
                <div
                  key={i}
                  className="absolute left-0 right-0 h-px bg-neutral-900"
                  style={{ top: `${pct}%` }}
                />
              )
            })}
          </div>

          {/* Bars */}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {weeks.map((w, i) => {
              const pct = yScaleMax > 0 ? (w.count / yScaleMax) * 100 : 0
              const range = `${w.weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${w.weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
              const label = `${range} — ${w.count === 1 ? '1 note' : `${w.count} notes`}`
              return (
                <div key={i} title={label} className="flex-1 flex items-end min-w-0 h-full">
                  {w.count > 0 ? (
                    <div
                      className="w-full rounded-t-sm bg-purple-500 hover:bg-purple-400 transition-colors"
                      style={{ height: `${Math.max(pct, 8)}%` }}
                    />
                  ) : (
                    <div className="w-full h-0" />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Month labels */}
        <div className="relative h-3 mt-1">
          <div className="absolute inset-0 flex gap-[2px]">
            {weeks.map((_, i) => {
              const tick = monthBoundaries.find(b => b.i === i)
              return (
                <div key={i} className="flex-1 min-w-0 text-[10px] text-neutral-500 leading-none">
                  {tick ? tick.label : ''}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div>
      <div className="h-28 flex items-end gap-[2px]">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 bg-neutral-900 rounded-sm animate-pulse"
            style={{ height: `${30 + (i * 37) % 60}%` }}
          />
        ))}
      </div>
      <div className="h-3 mt-1" />
    </div>
  )
}
