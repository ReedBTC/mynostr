import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { exportEpub } from '../../../../lib/epub.js'
import { titleToSlug, isSafeUrl } from '../../../../lib/utils.js'

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

function getNaddr(article) {
  try {
    const identifier = article.tags?.find(t => t[0] === 'd')?.[1] ?? ''
    return nip19.naddrEncode({ kind: 30023, pubkey: article.pubkey, identifier })
  } catch { return null }
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

  const [listSubmenu, setListSubmenu] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [epubBusy, setEpubBusy]      = useState(false)

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
  const date       = formatDate(article.created_at)

  const hasActions = lists || onLoadInEditor

  function handleExportMd() {
    const slug   = titleToSlug(title) || 'article'
    const header = [
      `# ${title}`,
      authorName ? `\n*by ${authorName}*` : '',
      date       ? `*${date}*`            : '',
      '',
    ].filter(Boolean).join('\n')
    const blob = new Blob([header + '\n' + (article.content || '')], { type: 'text/markdown;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = slug + '.md'; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleExportEpub() {
    setEpubBusy(true)
    try {
      await exportEpub(
        article.content || '',
        {
          title, summary, image,
          publishedAtDate: article.created_at
            ? new Date(article.created_at * 1000).toISOString().split('T')[0]
            : '',
          tags: article.tags?.filter(t => t[0] === 't').map(t => t[1]) || [],
        },
        null, authorName, ''
      )
    } finally { setEpubBusy(false) }
  }

  function handleLoadInEditor() {
    const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
    const publishedAtUnix = getTag(article, 'published_at')
    const publishedAtDate = publishedAtUnix
      ? new Date(parseInt(publishedAtUnix) * 1000).toISOString().split('T')[0]
      : ''
    const naddr = getNaddr(article) || ''
    onLoadInEditor({
      content: article.content || '',
      metadata: {
        title,
        summary: summary || '',
        publishedAtDate,
        image: image || '',
        tagsRaw: tTags.join(', '),
        tags: tTags,
      },
      naddr,
    })
  }

  async function handleAddToList(listId) {
    const aTag = article._aTag || `30023:${article.pubkey}:${getTag(article, 'd')}`
    const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
    await onAddToList(listId, { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags })
    setMenuOpen(false)
    setListSubmenu(false)
  }

  async function handleCreateAndAdd() {
    const name = newListName.trim()
    if (!name) return
    const newList = await onCreateList(name)
    await handleAddToList(newList.id)
    setNewListName('')
  }

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
      {hasActions && (
        <div className="flex-shrink-0 pr-2 relative" onMouseDown={e => e.stopPropagation()}>
          <button
            onClick={e => {
              e.stopPropagation()
              setMenuOpen(!menuOpen)
              setListSubmenu(false)
            }}
            className="w-7 h-7 flex items-center justify-center rounded bg-neutral-900 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors"
            title="Actions">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="3" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="13" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 min-w-[180px] max-h-[70vh] overflow-y-auto"
              onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>

              {/* Add to bookmark group */}
              {lists && onAddToList && (
                <>
                  <button onClick={() => setListSubmenu(o => !o)}
                    className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors flex items-center justify-between">
                    <span>Add to bookmarks</span>
                    <span className="text-neutral-600 text-[10px]">{listSubmenu ? '▲' : '▼'}</span>
                  </button>
                  {listSubmenu && (
                    <div className="border-t border-neutral-700">
                      {lists.map(list => (
                        <button key={list.id}
                          onClick={() => handleAddToList(list.id)}
                          className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate">
                          {list.title}
                        </button>
                      ))}
                      <div className="px-3 py-1.5 flex gap-1">
                        <input type="text" value={newListName} onChange={e => setNewListName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleCreateAndAdd(); if (e.key === 'Escape') setListSubmenu(false) }}
                          placeholder="New group…" maxLength={60}
                          className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                        <button onClick={handleCreateAndAdd} disabled={!newListName.trim()}
                          className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">✓</button>
                      </div>
                    </div>
                  )}
                  <div className="border-t border-neutral-700" />
                </>
              )}

              {/* Load in editor */}
              {onLoadInEditor && (
                <button onClick={() => { handleLoadInEditor(); setMenuOpen(false) }}
                  className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors">
                  Load in editor
                </button>
              )}

              {/* Export */}
              <button onClick={() => { handleExportMd(); setMenuOpen(false) }}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors">
                Export .md
              </button>
              <button onClick={() => { handleExportEpub(); setMenuOpen(false) }} disabled={epubBusy}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50">
                {epubBusy ? 'Exporting…' : 'Export .epub'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
