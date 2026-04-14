import { useState, useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import ArticleFeedItem from './ArticleFeedItem.jsx'

const ROW_HEIGHT = 88

export default function ArticleFeed({
  articles,
  profiles,
  loading,
  loadingMore,
  hasMore,
  selectedId,
  checkedIds,
  onSelect,
  onToggleSelect,
  onLoadMore,
  lists,
  onAddToList,
  onCreateList,
  onLoadInEditor,
}) {
  const [openMenuId, setOpenMenuId] = useState(null)
  const parentRef    = useRef(null)

  // Close menu on any outside click
  useEffect(() => {
    if (!openMenuId) return
    function handler() { setOpenMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuId])
  // Keep onLoadMore in a ref so the effect below never needs it as a dep.
  // This prevents the effect from firing on every render (onLoadMore is a new
  // function reference every time DiscoverView re-renders).
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  const rowVirtualizer = useVirtualizer({
    count:            articles.length,
    getScrollElement: () => parentRef.current,
    estimateSize:     () => ROW_HEIGHT,
    overscan:         5,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastItem     = virtualItems[virtualItems.length - 1]

  // Trigger load more when the last rendered item is within 8 rows of the end.
  // Excludes onLoadMore from deps (handled via ref above) so the effect only
  // fires when scroll position, list length, or load state actually changes.
  useEffect(() => {
    if (!lastItem) return
    if (lastItem.index >= articles.length - 8 && hasMore && !loadingMore) {
      onLoadMoreRef.current()
    }
  }, [lastItem?.index, articles.length, hasMore, loadingMore]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <div className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!articles.length) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <p className="text-sm text-neutral-600">No articles found.</p>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="overflow-y-auto flex-1">
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualItems.map(virtualRow => {
          const article = articles[virtualRow.index]
          const profile = profiles.get(article.pubkey)
          const isMenuOpen = openMenuId === article.id
          return (
            <div
              key={virtualRow.key}
              style={{
                position:  'absolute',
                top:       0,
                left:      0,
                width:     '100%',
                height:    `${ROW_HEIGHT}px`,
                transform: `translateY(${virtualRow.start}px)`,
                zIndex:    isMenuOpen ? 20 : 0,
              }}
            >
              <ArticleFeedItem
                article={article}
                profile={profile}
                isSelected={article.id === selectedId}
                isChecked={checkedIds?.has(article.id)}
                onSelect={onSelect}
                onToggleSelect={onToggleSelect}
                lists={lists}
                onAddToList={onAddToList}
                onCreateList={onCreateList}
                onLoadInEditor={onLoadInEditor}
                menuOpen={isMenuOpen}
                onMenuToggle={(open) => setOpenMenuId(open ? article.id : null)}
              />
            </div>
          )
        })}
      </div>

      {loadingMore && (
        <div className="py-3 flex justify-center">
          <div className="w-4 h-4 border-2 border-neutral-700 border-t-purple-500 rounded-full animate-spin" />
        </div>
      )}
    </div>
  )
}
