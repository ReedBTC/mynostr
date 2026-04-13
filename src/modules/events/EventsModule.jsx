/**
 * EventsModule — Module 3 (Week 5–6)
 * Kind 31923 event publisher with scheduler (Cloudflare Worker backend).
 * Supports title, description, datetimes, location, geohash, capacity,
 * future publish time, and pre-event kind 1 reminder notes.
 */
export default function EventsModule() {
  return <ComingSoon module="Events" week="5–6" description="Kind 31923 event publisher with Cloudflare-backed scheduler. Set a future publish time and send pre-event reminders automatically." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">📅</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
