import { useNavigate } from 'react-router-dom'
import { formatCount } from '../../lib/utils.js'

/**
 * ProfileStatsCard — two labeled sections:
 *
 *   POSTS      Notes · Comments · Articles · Events · Market
 *   BOOKMARKS  Notes · Articles · Events · Market
 *
 * Notes/Comments/Articles cells deep-link into NotesModule and
 * LongformModule; Events + Market are display-only until those modules
 * ship (shown here for completeness). Icons accompany every label so it's
 * always obvious what each number refers to — the old bookmark-icon-only
 * row was too ambiguous.
 *
 * Followers/Following live on the profile card above this one.
 */
export default function ProfileStatsCard({ user, stats, contentCounts, bookmarkCounts, loading }) {
  const navigate = useNavigate()
  const npub = user?.npub

  const postCells = [
    {
      key: 'notes',
      label: 'Notes',
      value: stats?.note_count,
      icon: <NoteIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes`, { state: { initialTab: 'notes', initialMode: 'notes' } }) : null,
    },
    {
      key: 'comments',
      label: 'Comments',
      value: stats?.reply_count,
      icon: <CommentIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes`, { state: { initialTab: 'notes', initialMode: 'comments' } }) : null,
    },
    {
      key: 'articles',
      label: 'Articles',
      value: contentCounts?.articles,
      icon: <ArticleIcon />,
      onClick: npub ? () => navigate(`/${npub}/longform`, { state: { initialTab: 'mine' } }) : null,
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

  const bookmarkCells = [
    {
      key: 'bm-notes',
      label: 'Notes',
      value: bookmarkCounts?.notes,
      icon: <NoteIcon />,
      onClick: npub ? () => navigate(`/${npub}/notes`, { state: { initialTab: 'bookmarks' } }) : null,
    },
    {
      key: 'bm-articles',
      label: 'Articles',
      value: bookmarkCounts?.articles,
      icon: <ArticleIcon />,
      onClick: npub ? () => navigate(`/${npub}/longform`, { state: { initialTab: 'collection' } }) : null,
    },
    {
      key: 'bm-events',
      label: 'Events',
      value: bookmarkCounts?.events,
      icon: <EventIcon />,
      onClick: null,
    },
    {
      key: 'bm-market',
      label: 'Market',
      value: bookmarkCounts?.listings,
      icon: <MarketIcon />,
      onClick: null,
    },
  ]

  return (
    <div className="border border-neutral-800 rounded-lg bg-neutral-950 overflow-hidden">
      <Section label="Posts" cells={postCells} loading={loading} />
      <div className="border-t border-neutral-800" />
      <Section label="Bookmarks" cells={bookmarkCells} loading={loading} />
    </div>
  )
}

function Section({ label, cells, loading }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2 font-medium">{label}</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
        {cells.map(c => (
          <StatCell
            key={c.key}
            label={c.label}
            value={c.value}
            icon={c.icon}
            loading={loading && c.value == null}
            onClick={c.onClick}
          />
        ))}
      </div>
    </div>
  )
}

function StatCell({ label, value, icon, loading, onClick }) {
  const clickable = Boolean(onClick)
  const body = (
    <>
      <div className="flex items-center justify-center gap-1.5 text-neutral-400 group-hover:text-purple-300 transition-colors">
        <span className="w-3.5 h-3.5 inline-flex items-center justify-center">{icon}</span>
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="text-lg sm:text-xl font-semibold text-neutral-100 leading-tight mt-1 tabular-nums">
        {loading ? (
          <span className="inline-block w-10 h-5 bg-neutral-800 rounded animate-pulse" />
        ) : (
          formatCount(value)
        )}
      </div>
    </>
  )

  const base = 'group flex flex-col items-center justify-center py-2.5 px-2 rounded-md border border-neutral-800 bg-neutral-900/40 text-center'
  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`View ${label.toLowerCase()}`}
        className={`${base} hover:border-purple-700/60 hover:bg-purple-950/30 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600`}
      >
        {body}
      </button>
    )
  }
  return <div className={base}>{body}</div>
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

