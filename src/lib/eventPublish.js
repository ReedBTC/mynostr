/**
 * eventPublish — NIP-52 publish helpers.
 *
 * Calendar events (31922 / 31923) and RSVPs (31925) are addressable
 * replaceables — same `(pubkey, kind, d)` produces a new revision.
 * We publish to the user's outbox so subsequent edits and kind-5
 * deletes reach the same set; FALLBACK_RELAYS only kick in when the
 * user has no kind 10002 yet.
 *
 * RSVP d-tag: we deliberately reuse the target event's coordinate
 * ("31923:authorpk:dtag") as our RSVP's d-tag. This makes the RSVP
 * naturally replaceable per (rsvp-author, target-event), so a user
 * flipping Going → Maybe just publishes and the relay replaces the
 * prior copy. NIP-52 doesn't mandate the d-tag scheme and Plektos
 * uses a UUID per RSVP (creating orphan rows that need read-side
 * dedup); both are spec-compliant. eventTypes.dedupRsvpsLatest covers
 * the read side either way.
 */
import { NDKEvent, NDKRelaySet } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout, publishToOwnOutbox, getUserReadRelays, FALLBACK_RELAYS } from './ndk.js'
import { isSafeUrl } from './utils.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  KIND_RSVP,
} from './eventTypes.js'

const FUTURE_CAP_SECONDS = 60
let _lastPublishedAt = 0

export function resetEventPublishedAtCounter() {
  _lastPublishedAt = 0
}

function nextPublishedAt() {
  const now = Math.floor(Date.now() / 1000)
  let ts = Math.max(now, _lastPublishedAt + 1)
  if (ts > now + FUTURE_CAP_SECONDS) ts = now
  _lastPublishedAt = ts
  return ts
}

function randomDTag() {
  // 16 hex chars — collision-free for an individual user's events.
  // crypto.randomUUID needs a secure context; build a substitute when
  // unavailable so localhost/HTTP dev still works.
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0')
}

/**
 * Build the tag list for a calendar event. Required tags (d, title,
 * start) come first so debug dumps read naturally; optionals follow.
 *
 * @param {object} form
 *   {
 *     dTag?: string,                  // optional override; auto-generated if omitted
 *     kind: 31922 | 31923,
 *     title: string,
 *     summary?: string,
 *     content?: string,               // body (markdown OK)
 *     start: string,                  // YYYY-MM-DD for 31922 OR unix seconds for 31923
 *     end?: string,
 *     startTzid?: string,             // 31923 only
 *     endTzid?: string,               // 31923 only
 *     image?: string,
 *     location?: string,
 *     geohash?: string,
 *     hashtags?: string[],            // bare strings, no leading #
 *     references?: string[],          // free-form r-tag URLs
 *     participants?: [{ pubkey, relay?, role? }],
 *   }
 */
function buildCalendarEventTags(form) {
  const tags = []
  const dTag = form.dTag || randomDTag()
  tags.push(['d', dTag])
  tags.push(['title', String(form.title || '').trim()])
  tags.push(['start', String(form.start)])
  if (form.end) tags.push(['end', String(form.end)])

  if (form.kind === KIND_TIME_EVENT) {
    if (form.startTzid) tags.push(['start_tzid', form.startTzid])
    if (form.endTzid && form.endTzid !== form.startTzid) tags.push(['end_tzid', form.endTzid])
    // The `D` day-bucket tag (floor(start/86400)) is in the spec for
    // efficient relay-side bucketing. Cheap to add, harmless if the
    // relay ignores it.
    const startSec = parseInt(form.start, 10)
    if (Number.isFinite(startSec)) {
      tags.push(['D', String(Math.floor(startSec / 86400))])
    }
  }

  if (form.summary) tags.push(['summary', String(form.summary).trim()])
  if (form.image && isSafeUrl(form.image)) tags.push(['image', form.image])
  if (form.location) tags.push(['location', String(form.location).trim()])
  if (form.geohash) tags.push(['g', String(form.geohash).trim()])

  for (const t of form.hashtags || []) {
    const h = String(t || '').replace(/^#/, '').trim().toLowerCase()
    if (h) tags.push(['t', h])
  }
  for (const r of form.references || []) {
    if (typeof r === 'string' && isSafeUrl(r)) tags.push(['r', r])
  }
  for (const p of form.participants || []) {
    if (!p?.pubkey || typeof p.pubkey !== 'string' || p.pubkey.length !== 64) continue
    const row = ['p', p.pubkey]
    if (p.relay) row.push(p.relay)
    if (p.role)  row.push(p.role || '')
    tags.push(row)
  }
  // Client-attribution tag, matching publishProduct / publishArticle.
  tags.push(['client', 'mynostr'])
  return { tags, dTag }
}

/**
 * Publish a calendar event (31922 or 31923).
 *
 * @param {object} form  — see buildCalendarEventTags
 * @returns {Promise<{ naddr, eventId, dTag, relays }>}
 */
export async function publishCalendarEvent(form) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (form.kind !== KIND_DATE_EVENT && form.kind !== KIND_TIME_EVENT) {
    throw new Error('Bad event kind — must be 31922 or 31923')
  }
  if (!form.title || !String(form.title).trim()) throw new Error('Title is required')
  if (!form.start) throw new Error('Start is required')

  const { tags, dTag } = buildCalendarEventTags(form)

  const event = new NDKEvent(ndk)
  event.kind = form.kind
  event.content = String(form.content || '')
  event.created_at = nextPublishedAt()
  event.tags = tags

  await signWithTimeout(event)
  const publishedTo = await publishToOwnOutbox(event)
  const confirmed = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  const relays = confirmed.length ? confirmed : [...FALLBACK_RELAYS]

  let naddr = ''
  try {
    naddr = nip19.naddrEncode({
      kind: form.kind,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: relays.slice(0, 3),
    })
  } catch {}

  return { naddr, eventId: event.id, dTag, relays }
}

/**
 * Publish an RSVP for a target calendar event. Idempotent per
 * (rsvp-author, target-event): re-publishing replaces the prior RSVP.
 *
 * @param {object} args
 *   {
 *     targetCoord: string,    // "<31922|31923>:<authorpk>:<dtag>"
 *     targetEventId?: string, // optional — pin RSVP to this revision
 *     targetAuthor?: string,  // hex pubkey of event author (p-tag for indexers)
 *     status: 'accepted' | 'declined' | 'tentative',
 *     freeBusy?: 'free' | 'busy',
 *   }
 * @returns {Promise<{ eventId, dTag, relays }>}
 */
export async function publishRsvp({ targetCoord, targetEventId = '', targetAuthor = '', status, freeBusy = '' }) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (status !== 'accepted' && status !== 'declined' && status !== 'tentative') {
    throw new Error('RSVP status must be accepted, declined, or tentative')
  }
  if (!targetCoord || !/^\d+:[0-9a-f]{64}:.+/i.test(targetCoord)) {
    throw new Error('targetCoord must be "<kind>:<authorpk>:<dtag>"')
  }

  // Reuse the target coordinate as our RSVP's d-tag — guarantees
  // replaceability per (rsvp-author, target-event). See module docstring.
  const dTag = targetCoord

  const tags = [
    ['a', targetCoord],
    ['d', dTag],
    ['status', status],
  ]
  if (targetEventId)                              tags.push(['e', targetEventId])
  if (targetAuthor && targetAuthor.length === 64) tags.push(['p', targetAuthor])
  // fb is meaningful only for non-declined RSVPs per the spec.
  if (freeBusy && status !== 'declined' && (freeBusy === 'free' || freeBusy === 'busy')) {
    tags.push(['fb', freeBusy])
  }
  tags.push(['client', 'mynostr'])

  const event = new NDKEvent(ndk)
  event.kind = KIND_RSVP
  event.content = ''
  event.created_at = nextPublishedAt()
  event.tags = tags

  await signWithTimeout(event)
  const publishedTo = await publishToOwnOutbox(event)
  const confirmed = Array.from(publishedTo).map(r => r.url).filter(Boolean)

  // Also push to the event author's read relays so the host actually
  // sees the RSVP. Outbox-only publishing means the RSVP only lands on
  // relays the RSVPer writes to — if the host reads from a different
  // set, going-counts diverge across clients. Best-effort: a missing
  // 10002 or a network error here doesn't fail the RSVP.
  const authorReadRelays = await getUserReadRelays(ndk, targetAuthor).catch(() => null)
  if (authorReadRelays && authorReadRelays.length > 0) {
    const additional = authorReadRelays.filter(u => !confirmed.includes(u))
    if (additional.length > 0) {
      try {
        const set = NDKRelaySet.fromRelayUrls(additional, ndk)
        const sentTo = await event.publish(set)
        for (const r of sentTo) {
          if (r?.url && !confirmed.includes(r.url)) confirmed.push(r.url)
        }
      } catch {
        // Author-relay leg is best-effort; the outbox leg above already
        // succeeded by the time we get here.
      }
    }
  }

  const relays = confirmed.length ? confirmed : [...FALLBACK_RELAYS]
  return { eventId: event.id, dTag, relays }
}

/**
 * Publish a kind 5 deletion request for a calendar event the session
 * user authored. Tags both the event id (`e`) and the addressable
 * coordinate (`a`) so relays that track either form will tombstone
 * the right thing. NIP-09 is advisory — relays may ignore — but most
 * mainstream clients honour it for their own UI.
 *
 * @returns {Promise<{ eventId, relays }>}
 */
export async function deleteCalendarEvent({ kind, eventId, dTag }) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (kind !== KIND_DATE_EVENT && kind !== KIND_TIME_EVENT) {
    throw new Error('Bad event kind for deletion')
  }
  if (!eventId && !dTag) throw new Error('Need eventId or dTag for deletion')

  const tags = []
  if (eventId) tags.push(['e', eventId])
  if (dTag) {
    const me = ndk.activeUser?.pubkey
    if (me) tags.push(['a', `${kind}:${me}:${dTag}`])
  }
  tags.push(['k', String(kind)])
  tags.push(['client', 'mynostr'])

  const event = new NDKEvent(ndk)
  event.kind = 5
  event.content = ''
  event.created_at = nextPublishedAt()
  event.tags = tags

  await signWithTimeout(event)
  const publishedTo = await publishToOwnOutbox(event)
  const confirmed = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  return { eventId: event.id, relays: confirmed.length ? confirmed : [...FALLBACK_RELAYS] }
}
