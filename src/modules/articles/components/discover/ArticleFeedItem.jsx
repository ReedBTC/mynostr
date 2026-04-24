import { useState } from 'react'
import { isSafeUrl, getPublishedAt } from '../../../../lib/utils.js'
import ArticleActionsMenu from './ArticleActionsMenu.jsx'

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function isHexOrNpub(str) {
  if (!str) return false
  return /^[a-f0-9]{6,}$/i.test(str) || str.startsWith('npub')
}

function formatDate(unixTs) {
  if (!unixTs) return ''
  return new Date(unixTs * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

export default function ArticleFeedItem({
  article,
  profile,
  isSelected,
  isChecked,
  onSelect,
  onToggleSelect,
  lists,
  onAddToList,
  onCreateList,
  onLoadInEditor,
  menuOpen: menuOpenProp,
  onMenuToggle,
}) {
  // Menu state: controlled from parent if props provided, otherwise local
  const [localMenuOpen, setLocalMenuOpen] = useState(false)
  const menuOpen = onMenuToggle ? !!menuOpenProp : localMenuOpen
  function setMenuOpen(open) {
    if (onMenuToggle) onMenuToggle(open)
    else setLocalMenuOpen(open)
  }

  const title      = getTag(article, 'title') || 'Untitled'
  const image      = getTag(article, 'image')
  const summary    = getTag(article, 'summary')
  const rawName = article._authorName
    || profile?.display_name
    || profile?.name
    || ''
  const authorName = isHexOrNpub(rawName) ? '' : rawName
  const authorPic  = article._authorPic
    || profile?.picture
    || ''
  const date       = formatDate(getPublishedAt(article))
  const tTags      = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []

  return (
    <div
      className={`w-full h-full flex items-center border-b border-neutral-800/60 transition-colors ${
        isSelected ? 'bg-purple-950/30 border-purple-900/40' : 'hover:bg-neutral-800/40'
      }`}
    >
      {/* Checkbox */}
      {onToggleSelect && (
        <div
          className="pl-3 pr-1 flex items-center flex-shrink-0"
          onClick={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={!!isChecked}
            onChange={e => onToggleSelect(article.id, e.target.checked)}
            className="accent-purple-600 cursor-pointer opacity-30 hover:opacity-80 checked:opacity-100 transition-opacity"
          />
        </div>
      )}

      {/* Main clickable area */}
      <button
        onClick={() => onSelect(article)}
        className="flex items-center gap-3 px-3 text-left flex-1 min-w-0 h-full"
      >
        {/* Thumbnail */}
        <div className="w-14 h-14 rounded flex-shrink-0 bg-neutral-800 overflow-hidden">
          {image && isSafeUrl(image) ? (
            <img
              src={image}
              alt=""
              className="w-full h-full object-cover"
              onError={e => { e.target.style.display = 'none' }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-neutral-600 text-lg">✍️</div>
          )}
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-100 truncate leading-snug">{title}</p>
          {summary && (
            <p className="text-xs text-neutral-500 mt-0.5 truncate">{summary}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1">
            {authorPic && isSafeUrl(authorPic) && (
              <img src={authorPic} alt="" className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                onError={e => { e.target.style.display = 'none' }} />
            )}
            <p className="text-xs text-neutral-600 truncate">{authorName}{authorName && date ? ' · ' : ''}{date}</p>
          </div>
        </div>
      </button>

      {/* Three-dot menu */}
      <div className="flex-shrink-0 pr-2 relative" onMouseDown={e => e.stopPropagation()}>
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
          className="w-7 h-7 flex items-center justify-center rounded bg-neutral-900 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors"
          title="Actions"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>
        <ArticleActionsMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          article={article}
          title={title}
          summary={summary}
          image={image}
          tTags={tTags}
          content={article.content || ''}
          lists={lists}
          onAddToList={onAddToList}
          onCreateList={onCreateList}
          authorName={authorName}
          authorPic={authorPic}
          onLoadInEditor={onLoadInEditor}
        />
      </div>
    </div>
  )
}
