import { useState } from 'react'

/**
 * DmRelayFAQ — collapsible primer attached to DmRelayCard.
 *
 * Most users don't know NIP-17 exists, and those who do often don't
 * realize the DM relay list is a separate event from their main relay
 * list. These questions cover the gap, plus the annoying reality that
 * no relay declares NIP-17 support so picking DM relays is partly a
 * guessing game.
 */

const ITEMS = [
  {
    q: 'What is a DM relay?',
    a: (
      <>
        A DM relay is a relay you've designated to receive your encrypted
        direct messages. When someone sends you a DM, their client publishes
        an encrypted event to the relays listed in your <span className="text-neutral-100">kind 10050</span>{' '}
        event — and your client checks those same relays to receive it. It's
        the equivalent of telling people "ship my mail to this PO Box."
      </>
    ),
  },
  {
    q: 'Why is the DM relay list separate from my main relay list?',
    a: (
      <>
        Because DM relays need different properties from your main relays.
        A DM relay has to accept strangers writing to it (so people can
        message you), must handle large encrypted events (gift wraps are
        bigger than notes), and should filter spam. Splitting the lists lets
        you run a chatty write relay for public notes and a quieter,
        spam-filtered relay for DMs without forcing the same set to do both
        jobs.
      </>
    ),
  },
  {
    q: 'What\'s the difference between old DMs (NIP-04) and NIP-17?',
    a: (
      <>
        <span className="text-neutral-100">NIP-04</span> was Nostr's original
        DM protocol. It encrypted the body but left the sender, recipient,
        and timestamp fully visible on every relay — effectively a
        metadata-leaking version of a private chat. Anyone watching a relay
        could see who was messaging whom, when, and how often.
        <div className="mt-2">
          <span className="text-neutral-100">NIP-17</span> (often called
          "gift-wrapped DMs") fixes this by wrapping the real message inside
          random-pubkey envelopes, so relays can't see the sender, can't see
          the recipient's pubkey in the clear, and can't tell two messages
          belong to the same conversation. Modern clients use NIP-17
          exclusively; NIP-04 is being phased out.
        </div>
      </>
    ),
  },
  {
    q: 'How should I pick my DM relays?',
    a: (
      <>
        Fewer and higher-quality is better than many. Suggested properties:
        <ul className="list-disc pl-5 mt-2 space-y-1.5">
          <li>
            <span className="text-neutral-100">Not auth-gated.</span> If a
            relay requires NIP-42 auth, strangers can't write DMs to you and
            your messages silently fail. Avoid these for DMs.
          </li>
          <li>
            <span className="text-neutral-100">Generous message limits.</span>{' '}
            Gift-wrapped events are bigger than notes. Relays with small{' '}
            <code className="text-neutral-300">max_message_length</code> caps
            may truncate or reject them.
          </li>
          <li>
            <span className="text-neutral-100">Paid is actually helpful here.</span>{' '}
            Paid relays tend to spam-filter better, which matters more for
            DMs than for public notes.
          </li>
          <li>
            <span className="text-neutral-100">Two relays is usually enough.</span>{' '}
            Unlike notes where you want broad fan-out, DMs just need to reach
            you. Two reliable inboxes beats six flaky ones.
          </li>
        </ul>
      </>
    ),
  },
  {
    q: 'Why can\'t this module detect which relays support NIP-17?',
    a: (
      <>
        Because relays don't declare it in their NIP-11 info document. NIP-17
        is encoded as a regular event kind (1059, the "gift wrap"), and any
        relay that accepts generic event kinds handles it — but operators
        don't think of it as a feature worth advertising. We can only
        eliminate relays that <em>definitely won't</em> work (auth-gated,
        write-restricted) and rely on practical experience for the rest.
        If a DM relay starts failing in practice, remove it and add a known
        alternative.
      </>
    ),
  },
  {
    q: 'What happens if I don\'t have a DM relay list?',
    a: (
      <>
        Other clients will guess where to deliver DMs to you, typically by
        using your main write relays. Some will deliver successfully, some
        won't, and you have no way of knowing which DMs arrived. Publishing
        a kind 10050 event makes delivery deterministic: any NIP-17-compliant
        client will ship DMs for you to the relays you've listed, period.
      </>
    ),
  },
]

export default function DmRelayFAQ() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-neutral-800">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-neutral-900/40 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
        aria-expanded={expanded}
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold text-neutral-200">DM Relay FAQ</span>
          <span className="text-[10px] text-neutral-500 truncate">
            NIP-17 gift-wrapped DMs, and why they need their own relay list
          </span>
        </span>
        <span className={`text-neutral-500 text-xs transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-1">
          {ITEMS.map((item, i) => (
            <FAQItem key={i} q={item.q} a={item.a} />
          ))}
        </div>
      )}
    </div>
  )
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-neutral-900 rounded-md bg-neutral-950 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-neutral-900/60 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
        aria-expanded={open}
      >
        <span className="text-xs text-neutral-200">{q}</span>
        <span className={`text-neutral-500 text-[10px] shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs text-neutral-400 leading-relaxed">
          {a}
        </div>
      )}
    </div>
  )
}
