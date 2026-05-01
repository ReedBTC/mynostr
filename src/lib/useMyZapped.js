import { useEffect, useState } from 'react'
import {
  subscribe,
  hasZappedEvent,
  hasZappedAddressable,
  isZapPending,
} from './myZapStore.js'

/**
 * Returns true if the session user has zapped the given target. Pass
 * either `eventId`, `addressable`, or both (articles have both — match
 * either to handle providers that only emit one of the two reference tags).
 *
 * Re-renders only when the watched target changes (or the whole store
 * resets). Listener receives the changed target keys from the store and
 * skips the setTick if neither key matches.
 */
export function useMyZapped({ eventId, addressable } = {}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribe((changed) => {
      if (!relevant(changed, eventId, addressable)) return
      setTick(n => n + 1)
    })
  }, [eventId, addressable])
  return hasZappedEvent(eventId) || hasZappedAddressable(addressable)
}

/**
 * Returns true if a NWC zap to this target is currently in flight. Lets
 * a zap button render its pulse animation while the background payment
 * lands, settling when complete (preimage in) or reverting (failure).
 */
export function useMyZapPending({ eventId, addressable } = {}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribe((changed) => {
      if (!relevant(changed, eventId, addressable)) return
      setTick(n => n + 1)
    })
  }, [eventId, addressable])
  return isZapPending({ eventId, addressable })
}

/**
 * Decide whether a store change is relevant to the watched target.
 * `changed === undefined` is the global-change signal (load complete,
 * reset) — every consumer re-renders. Otherwise compare keys.
 */
function relevant(changed, watchedEventId, watchedAddressable) {
  if (!changed) return true
  const wId = watchedEventId?.toLowerCase()
  const cId = changed.eventId?.toLowerCase()
  if (wId && cId === wId) return true
  if (watchedAddressable && changed.addressable === watchedAddressable) return true
  return false
}
