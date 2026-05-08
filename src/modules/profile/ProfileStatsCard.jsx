import { useNavigate } from 'react-router-dom'
import { formatCount } from '../../lib/utils.js'
import InfoDot from './InfoDot.jsx'

/**
 * ProfileStatsCard — two labeled sections:
 *
 *   POSTS             Notes · Comments · Articles · Events · Market
 *   PUBLIC CURATION   Notes · Articles · Events · Market
 *
 * Public Curation is a hybrid:
 *   - Notes / Articles → counts come from the user's NIP-51 bookmarks
 *     (kind 10003 / 30001 / 30003); sublabel = "N categories" (number
 *     of distinct lists containing items of that kind).
 *   - Events → counts come from the user's Calendars (kind 31924);
 *     value = total event refs across all calendars; sublabel = "N
 *     Calendars".
 *   - Market → counts come from the user's Collections (kind 30405);
 *     value = total listing refs across all collections; sublabel =
 *     "N Collections".
 *
 * Each cell deep-links to its module's actual public-curation surface
 * (bookmarks page for Notes/Articles, Calendars tab for Events,
 * Collections tab for Market). Followers/Following live on the profile
 * card above this one.
 */
export default function ProfileStatsCard({ user, stats, contentCounts, bookmarkCounts, publicListCounts, loading }) {
  const navigate = useNavigate()
  const npub = user?.npub

  const postCells = [
    {
      key: 'notes',
      label: 'Notes',
      value: stats?.note_count,
      icon: <NoteIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes`) : null,
    },
    {
      key: 'comments',
      label: 'Comments',
      value: stats?.reply_count,
      icon: <CommentIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes/comments`) : null,
    },
    {
      key: 'articles',
      label: 'Articles',
      value: contentCounts?.articles,
      icon: <ArticleIcon />,
      onClick: npub ? () => navigate(`/${npub}/articles/mine`) : null,
    },
    {
      key: 'events',
      label: 'Events',
      value: contentCounts?.events,
      icon: <EventIcon />,
      onClick: null,
    },
    {
      key: 'market',
      label: 'Market',
      value: contentCounts?.listings,
      icon: <MarketIcon />,
      onClick: null,
    },
  ]

  // Two semantic sources mixed into one row:
  //   - Notes / Articles → NIP-51 bookmarks (the existing fetch)
  //   - Events / Market → kind 31924 / 30405 named public lists. These
  //     are the actual curation surfaces those modules expose (the
  //     bookmark-counts source had numbers but no module-side bookmark
  //     view to link to, so the cells were dead-ends before).
  const bookmarkCells = [
    {
      key: 'bm-notes',
      label: 'Notes',
      value: bookmarkCounts?.notes,
      categories: bookmarkCounts?.noteCategories,
      categoryLabel: 'category',
      icon: <NoteIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes/bookmarks`) : null,
    },
    {
      key: 'bm-articles',
      label: 'Articles',
      value: bookmarkCounts?.articles,
      categories: bookmarkCounts?.articleCategories,
      categoryLabel: 'category',
      icon: <ArticleIcon />,
      onClick: npub ? () => navigate(`/${npub}/articles/collection`) : null,
    },
    {
      key: 'bm-events',
      label: 'Events',
      value: publicListCounts?.calendarItems,
      categories: publicListCounts?.calendarLists,
      categoryLabel: 'Calendar',
      icon: <EventIcon />,
      onClick: npub ? () => navigate(`/${npub}/events/calendars`) : null,
    },
    {
      key: 'bm-market',
      label: 'Market',
      value: publicListCounts?.collectionItems,
      categories: publicListCounts?.collectionLists,
      categoryLabel: 'Collection',
      icon: <MarketIcon />,
      onClick: npub ? () => navigate(`/${npub}/marketplace/collections`) : null,
    },
  ]

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <Section
        label="Posts"
        cells={postCells}
        loading={loading}
        info={(
          <p>
            Counts come from Primal's indexer (Notes / Comments / Articles)
            and related counts for Events / Market. Primal's index can lag
            new activity by minutes to hours, so very recent content may not
            show up yet.
          </p>
        )}
      />
      <div className="border-t border-neutral-800" />
      <Section
        label="Public Curation"
        sublabel="Public Bookmarks and Curated Collections"
        cells={bookmarkCells}
        loading={loading}
        variant="curation"
        info={(
          <p>
            Notes and Articles count NIP-51 public bookmarks (kind 10003
            / 30001 / 30003). Events count refs across this user's
            public Calendars (kind 31924); Market counts refs across
            their Collections (kind 30405). Numbers reflect whatever
            our relay pool can reach — a list that hasn't propagated
            everywhere may undercount.
          </p>
        )}
      />
    </div>
  )
}

function Section({ label, sublabel, cells, loading, variant, info }) {
  const isCuration = variant === 'curation'
  return (
    <div className={`px-4 py-3 ${isCuration ? 'bg-purple-950/10' : ''}`}>
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <div className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium flex items-center gap-1.5">
          {isCuration && <BookmarkIcon className="w-3 h-3 text-purple-400" />}
          {label}
          {info && <InfoDot align="left">{info}</InfoDot>}
        </div>
        {sublabel && (
          <div className="text-[10px] text-neutral-500 normal-case tracking-normal">{sublabel}</div>
        )}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
        {cells.map(c => (
          <StatCell
            key={c.key}
            label={c.label}
            value={c.value}
            categories={c.categories}
            categoryLabel={c.categoryLabel}
            icon={c.icon}
            loading={loading && c.value == null}
            onClick={c.onClick}
            variant={variant}
          />
        ))}
      </div>
    </div>
  )
}

function StatCell({ label, value, categories, categoryLabel, icon, loading, onClick, variant }) {
  const clickable = Boolean(onClick)
  const isCuration = variant === 'curation'
  const hasCats = typeof categories === 'number' && categories > 0 && value > 0
  // Default sublabel reads "category / categories" — overridden per
  // cell for the named-list cases ("Calendar" → "Calendars" plural,
  // "Collection" → "Collections" plural). Pluralization is naive
  // (just append 's') because both current overrides take a clean 's'.
  const catLabelSingular = categoryLabel || 'category'
  const catLabelPlural   = categoryLabel === 'category'
    ? 'categories'
    : `${catLabelSingular}s`

  const body = (
    <>
      <div className="flex items-center justify-center gap-1.5 text-neutral-400 group-hover:text-purple-300 transition-colors">
        <span className="relative w-3.5 h-3.5 inline-flex items-center justify-center">
          {icon}
          {isCuration && (
            <BookmarkIcon className="absolute -top-1 -right-1.5 w-2.5 h-2.5 text-purple-400" />
          )}
        </span>
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="text-lg sm:text-xl font-semibold text-neutral-100 leading-tight mt-1 tabular-nums">
        {loading ? (
          <span className="inline-block w-10 h-5 bg-neutral-800 rounded animate-pulse" />
        ) : (
          formatCount(value)
        )}
      </div>
      {isCuration && !loading && (
        <div className="text-[10px] text-neutral-500 leading-none mt-1 tabular-nums min-h-[1em]">
          {hasCats ? `${categories} ${categories === 1 ? catLabelSingular : catLabelPlural}` : ''}
        </div>
      )}
    </>
  )

  const baseBg = isCuration ? 'bg-purple-950/20' : 'bg-neutral-900/40'
  const base = `group flex flex-col items-center justify-center py-2.5 px-2 rounded-md border border-neutral-800 ${baseBg} text-center`
  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={isCuration ? `View bookmarked ${label.toLowerCase()}` : `View ${label.toLowerCase()}`}
        className={`${base} hover:border-purple-700/60 hover:bg-purple-950/30 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600`}
      >
        {body}
      </button>
    )
  }
  return <div className={base}>{body}</div>
}

function BookmarkIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M4 2.5h8a.5.5 0 01.5.5v11l-4.5-2.5-4.5 2.5V3a.5.5 0 01.5-.5z" />
    </svg>
  )
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="w-full h-full">
      <path d="M3 3h8l2 2v8H3V3z" strokeLinejoin="round" />
      <path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3" strokeLinecap="round" />
    </svg>
  )
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="w-full h-full">
      <path
        d="M2.5 4.5a1.5 1.5 0 011.5-1.5h8a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 01-1.5 1.5H7.5L4.5 13.5v-3H4a1.5 1.5 0 01-1.5-1.5v-4.5z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArticleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="w-full h-full">
      <path d="M3 2.5h7l3 3v8H3V2.5z" strokeLinejoin="round" />
      <path d="M10 2.5v3h3" strokeLinejoin="round" />
      <path d="M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3.5" strokeLinecap="round" />
    </svg>
  )
}

function EventIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="w-full h-full">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" strokeLinejoin="round" />
      <path d="M5.5 2.5v2M10.5 2.5v2M2.5 6.5h11" strokeLinecap="round" />
    </svg>
  )
}

function MarketIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="w-full h-full">
      <path d="M3.5 5.5h9l-1 7.5h-7l-1-7.5z" strokeLinejoin="round" />
      <path d="M5.5 5.5a2.5 2.5 0 015 0" strokeLinecap="round" />
    </svg>
  )
}

