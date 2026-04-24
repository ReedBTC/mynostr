import { useState, useCallback, useEffect, useRef } from 'react'

/**
 * ShareButton — copies a page URL to the clipboard.
 * Default: the current page URL (the whole "MyNostr is your web page" idea).
 * Pass `url` to override — used e.g. by RelayCard to always share the
 * /profile/relays anchor even when the user is viewing /profile.
 *
 * variant="button" — full pill with label (desktop top bar / card headers)
 * variant="icon"   — square icon only (mobile top bar)
 */
export default function ShareButton({ variant = 'button', url: urlOverride }) {
  const [copied, setCopied] = useState(false)
  // Track the "copied" reset timer so we can cancel it on unmount —
  // otherwise the setState fires after unmount and React warns in the
  // console. Also lets repeated clicks restart the window cleanly.
  const resetTimerRef = useRef(null)
  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
  }, [])

  const handleCopy = useCallback(async () => {
    const url = urlOverride || (typeof window !== 'undefined' ? window.location.href : '')
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Fallback for older browsers / insecure contexts
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        return
      }
    }
    setCopied(true)
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null
      setCopied(false)
    }, 2000)
  }, [urlOverride])

  if (variant === 'icon') {
    return (
      <button
        onClick={handleCopy}
        className="text-neutral-500 hover:text-neutral-200 p-1.5 rounded transition-colors"
        aria-label={copied ? 'Link copied' : 'Share page'}
        title={copied ? 'Link copied!' : 'Share'}
      >
        {copied ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        )}
      </button>
    )
  }

  return (
    <button
      onClick={handleCopy}
      className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
      aria-label={copied ? 'Link copied' : 'Share page'}
    >
      {copied ? 'Link copied!' : 'Share'}
    </button>
  )
}
