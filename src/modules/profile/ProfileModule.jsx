/**
 * ProfileModule — Module 4 (Week 7)
 * Kind 0 replaceable event editor.
 * All standard profile fields with a live preview of the profile card,
 * and a confirmation guard before overwriting the existing profile.
 */
export default function ProfileModule() {
  return <ComingSoon module="Profile" week="7" description="Edit every kind 0 field — name, bio, picture, banner, NIP-05, lightning address — with a live preview before publishing." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">👤</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
