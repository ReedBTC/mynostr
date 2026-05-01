import { useEffect, useState } from 'react'
import { subscribe, hasLikedEvent, hasLikedAddressable } from './myReactionStore.js'

/**
 * Returns true if the session user has liked the given target. Re-renders
 * only when the watched target changes (or the store resets).
 */
export function useMyLiked({ eventId, addressable } = {}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribe((changed) => {
      if (!relevant(changed, eventId, addressable)) return
      setTick(n => n + 1)
    })
  }, [eventId, addressable])
  return hasLikedEvent(eventId) || hasLikedAddressable(addressable)
}

function relevant(changed, watchedEventId, watchedAddressable) {
  if (!changed) return true
  const wId = watchedEventId?.toLowerCase()
  const cId = changed.eventId?.toLowerCase()
  if (wId && cId === wId) return true
  if (watchedAddressable && changed.addressable === watchedAddressable) return true
  return false
}
