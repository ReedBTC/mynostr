/**
 * EventsModule — Module 3 (Week 1)
 * Kind 31923 event publisher, editor, and manager with .ics exporting.
 */
export default function EventsModule() {
  return <ComingSoon module="Events" week="1" description="Kind 31923 event publisher, editor, and manager. Includes .ics exporting." />
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
