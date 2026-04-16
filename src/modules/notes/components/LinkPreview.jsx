import { useState, useEffect, useRef } from 'react'

// In-memory cache shared across all LinkPreview instances
const CACHE_MAX = 200
const ogCache = new Map()
function ogCacheSet(key, value) {
  if (ogCache.size >= CACHE_MAX) ogCache.delete(ogCache.keys().next().value)
  ogCache.set(key, value)
}

export default function LinkPreview({ url }) {
  const [data, setData] = useState(ogCache.get(url) || null)
  const [loading, setLoading] = useState(!ogCache.has(url))
  const [error, setError] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (ogCache.has(url)) {
      setData(ogCache.get(url))
      setLoading(false)
      return
    }

    setLoading(true)
    setError(false)

    fetch(`https://jsonlink.io/api/extract?url=${encodeURIComponent(url)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(json => {
        if (!mounted.current) return
        const result = {
          title: json.title || '',
          description: json.description || '',
          image: json.images?.[0] || '',
          domain: json.domain || new URL(url).hostname,
          favicon: json.favicon || '',
        }
        ogCacheSet(url, result)
        setData(result)
        setLoading(false)
      })
      .catch(() => {
        if (!mounted.current) return
        ogCacheSet(url, null)
        setError(true)
        setLoading(false)
      })
  }, [url])

  // Error or no data — render as plain link
  if (error || (!loading && !data)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-purple-400 hover:text-purple-300 underline break-all text-sm"
      >
        {url}
      </a>
    )
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="border border-neutral-800 rounded-lg overflow-hidden animate-pulse my-2">
        <div className="flex">
          <div className="w-24 h-20 md:w-32 md:h-24 bg-neutral-800 flex-shrink-0" />
          <div className="flex-1 p-3 space-y-2">
            <div className="h-3 bg-neutral-800 rounded w-3/4" />
            <div className="h-2 bg-neutral-800 rounded w-full" />
            <div className="h-2 bg-neutral-800 rounded w-1/2" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block border border-neutral-800 rounded-lg overflow-hidden hover:border-neutral-600 transition-colors my-2 no-underline"
    >
      <div className="flex">
        {data.image && (
          <div className="w-24 h-20 md:w-32 md:h-24 flex-shrink-0 bg-neutral-900">
            <img
              src={data.image}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          </div>
        )}
        <div className="flex-1 p-3 min-w-0">
          {data.title && (
            <p className="text-sm font-medium text-neutral-200 truncate">{data.title}</p>
          )}
          {data.description && (
            <p className="text-xs text-neutral-500 mt-0.5 line-clamp-2">{data.description}</p>
          )}
          <p className="text-xs text-neutral-600 mt-1">{data.domain}</p>
        </div>
      </div>
    </a>
  )
}
