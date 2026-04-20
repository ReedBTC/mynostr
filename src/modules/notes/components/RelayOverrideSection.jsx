/**
 * RelayOverrideSection — inside the composer's Advanced panel.
 *
 * When enabled, the draft publishes ONLY to the listed wss:// relays,
 * bypassing the user's normal write relays. Used for private-group
 * style publishing: if the reader doesn't also read from these relays,
 * the note is invisible to them.
 *
 * URLs are validated as wss:// only; bad entries show a warning but
 * we keep the raw text (users sometimes type then fix).
 */
import { useMemo } from 'react'

function parseRelayText(text) {
  return text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

// wss-only. The UI copy promises TLS — and the whole point of this override
// is private-group publishing, so a cleartext ws:// paste would leak the note.
function validateRelay(u) {
  return /^wss:\/\/[^\s]+$/i.test(u)
}

export default function RelayOverrideSection({ relayOverride, onChange }) {
  const enabled = !!relayOverride?.enabled
  const relays = relayOverride?.relays || []

  const { validCount, invalidUrls } = useMemo(() => {
    const valid = []
    const invalid = []
    for (const r of relays) {
      if (validateRelay(r)) valid.push(r)
      else invalid.push(r)
    }
    return { validCount: valid.length, invalidUrls: invalid }
  }, [relays])

  function toggle() {
    onChange({ ...relayOverride, enabled: !enabled })
  }

  function setRelaysFromText(text) {
    onChange({ ...relayOverride, relays: parseRelayText(text) })
  }

  return (
    <div className="mt-3 pt-3 border-t border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-xs text-neutral-300 font-medium">Relay override</p>
          <p className="text-[10px] text-neutral-500">
            Publish only to specific relays (e.g. private group).
          </p>
        </div>
        <button
          onClick={toggle}
          aria-pressed={enabled}
          className={`shrink-0 px-2.5 py-1 rounded text-[11px] border transition-colors ${
            enabled
              ? 'bg-amber-900/40 border-amber-700 text-amber-300'
              : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-400'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {enabled && (
        <>
          <textarea
            value={relays.join('\n')}
            onChange={(e) => setRelaysFromText(e.target.value)}
            placeholder="wss://relay.example.com&#10;wss://private.relay.net"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-purple-600 font-mono"
          />
          {invalidUrls.length > 0 && (
            <p className="text-[10px] text-red-400 mt-1">
              Invalid (must start with wss://): {invalidUrls.join(', ')}
            </p>
          )}
          {validCount > 0 && (
            <p className="text-[10px] text-amber-400/80 mt-1">
              ⚠️ Only users reading from {validCount === 1 ? 'this relay' : 'these relays'} will see this note.
            </p>
          )}
          {validCount === 0 && invalidUrls.length === 0 && (
            <p className="text-[10px] text-neutral-500 mt-1">
              One wss:// URL per line or comma-separated.
            </p>
          )}
        </>
      )}
    </div>
  )
}
