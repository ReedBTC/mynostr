/**
 * Bug-report publisher.
 *
 * Credit: this whole pipeline (frontend modal, dedicated relay with
 * tag-gated write policy, polling watcher → GitHub issues) is
 * inspired by Plebeian Market's bug-report widget. Same architecture
 * — kind 1 + magic tag + single relay + no backend service in the
 * middle. https://plebeian.market — thanks to that team for the
 * pattern.
 *
 * mynostr's bug-report channel is a single dedicated relay
 * (`wss://relay.mynostr.app`) that only accepts events tagged with
 * `["t", "mynostr-alpha"]` (enforced by the relay's strfry write-policy
 * plugin). Reports are kind 1 notes signed by the user's logged-in key,
 * published *only* to that one relay — never to outbox, never to the
 * pool. Isolation is the whole point: bug reports don't pollute the
 * user's normal feed and don't end up on third-party indexers. The
 * "viewer" is just `npm run bugs` from a laptop hitting the same
 * relay with the same filter.
 *
 * Anti-pattern reminders (don't break these):
 *   - DO NOT publish() through the pool. Use the explicit relay set.
 *   - DO NOT add `wss://relay.mynostr.app` to the user's read pool —
 *     bug reports would leak into feeds.
 *   - DO NOT broaden the tag without coordinating the relay's
 *     write-policy plugin (it requires the literal string).
 */
import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout } from './ndk.js'
import { withTimeout } from './utils.js'

export const BUG_RELAY = 'wss://relay.mynostr.app'
export const BUG_TAG   = 'mynostr-alpha'

const PUBLISH_TIMEOUT_MS = 10_000

/**
 * Sign + publish a bug report. Caller passes the full text; we don't
 * append metadata here because the modal already injects browser/page
 * info into the body where the user can review it before sending.
 *
 * Throws on signer failure, relay reject, or 10s timeout. Caller is
 * the modal — it surfaces the error inline.
 */
export async function publishBugReport(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Bug report is empty.')
  }
  const ndk = getNDK()
  if (!ndk?.signer) {
    throw new Error('Sign in first — bug reports are signed by your Nostr key so we can follow up.')
  }

  const ev = new NDKEvent(ndk)
  ev.kind    = 1
  ev.content = content
  ev.tags    = [['t', BUG_TAG], ['client', 'mynostr']]

  await signWithTimeout(ev)

  const relaySet = NDKRelaySet.fromRelayUrls([BUG_RELAY], ndk, false)
  const publishedTo = await withTimeout(
    ev.publish(relaySet),
    PUBLISH_TIMEOUT_MS,
    'Bug-report relay didn\'t respond. Try again in a moment.',
  )

  // NDK returns a Set of relays that accepted. An empty set covers
  // multiple failure modes (rate-limited, wrong tag, transient connect
  // failure, malformed event reject) — NDK doesn't surface the per-relay
  // NIP-20 OK reason in a structured way we can render. So we keep the
  // user-facing message neutral instead of guessing.
  if (!publishedTo || publishedTo.size === 0) {
    throw new Error('Relay didn\'t accept the report. Try again in a moment, or check your network.')
  }
  return { id: ev.id }
}
