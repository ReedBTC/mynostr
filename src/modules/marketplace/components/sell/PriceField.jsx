import { useEffect, useState } from 'react'
import {
  SUPPORTED_FIATS,
  prefetchRates,
  getCachedRates,
  satsToFiat,
  fiatToSats,
  formatAmount,
} from '../../../../lib/currency.js'

/**
 * PriceField — sats/fiat dual-mode price input with a "Fix price in"
 * radio.
 *
 * Mental model:
 *   • Two editable-looking inputs (sats + fiat).
 *   • The "Fix in" radio picks which side is the source of truth.
 *   • The other side is computed live from the current BTC rate.
 *
 * What's emitted upward (`onChange`):
 *   { amount, currency }
 *     where amount is the numeric value in the fixed side, and
 *     currency is 'SATS' when fixed=sats or the fiat code when
 *     fixed=fiat. This matches gamma.encodeProduct's price expected
 *     shape.
 *
 * Rate handling:
 *   • Cached rates render instantly; stale-while-revalidate on mount.
 *   • If rates are entirely unavailable (offline + cold cache), the
 *     non-fixed input shows "—" instead of bogus values, and the
 *     emitted price still reflects what the user typed.
 */
export default function PriceField({ value, onChange }) {
  // value: { amount, currency }, where currency is SATS or a fiat code
  const initialSide = value?.currency === 'SATS' || !value?.currency ? 'sats' : 'fiat'
  const [fixIn, setFixIn] = useState(initialSide)
  const [sats, setSats] = useState(
    initialSide === 'sats' && Number.isFinite(value?.amount) ? String(value.amount) : ''
  )
  const [fiatAmount, setFiatAmount] = useState(
    initialSide === 'fiat' && Number.isFinite(value?.amount) ? String(value.amount) : ''
  )
  const [fiatCurrency, setFiatCurrency] = useState(
    initialSide === 'fiat' && value?.currency ? value.currency : 'USD'
  )
  const [rates, setRates] = useState(() => getCachedRates())
  const ratesReady = !!rates?.rates

  useEffect(() => {
    let cancelled = false
    prefetchRates().then(() => {
      if (cancelled) return
      const next = getCachedRates()
      if (next) setRates(next)
    })
    return () => { cancelled = true }
  }, [])

  // Compute the derived (non-fixed) side. Recompute on every render so a
  // newly-arrived rate immediately fills the placeholder.
  const derivedSats = fixIn === 'fiat' && fiatAmount !== ''
    ? fiatToSats(Number(fiatAmount), fiatCurrency, rates)
    : null
  const derivedFiat = fixIn === 'sats' && sats !== ''
    ? satsToFiat(Number(sats), fiatCurrency, rates)
    : null

  // Push the canonical value upward whenever the fixed side changes.
  // Using `useEffect` instead of inline calls so onChange isn't called
  // mid-render (React would warn about state-update-during-render).
  useEffect(() => {
    if (!onChange) return
    if (fixIn === 'sats') {
      const n = sats === '' ? null : Number(sats)
      onChange({
        amount:   Number.isFinite(n) ? n : null,
        currency: 'SATS',
      })
    } else {
      const n = fiatAmount === '' ? null : Number(fiatAmount)
      onChange({
        amount:   Number.isFinite(n) ? n : null,
        currency: fiatCurrency,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixIn, sats, fiatAmount, fiatCurrency])

  function handleSatsInput(e) {
    setFixIn('sats')
    setSats(e.target.value.replace(/[^0-9]/g, ''))
  }
  function handleFiatInput(e) {
    setFixIn('fiat')
    // Allow one decimal point + digits.
    const cleaned = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
    setFiatAmount(cleaned)
  }

  // Display strings for the derived (non-fixed) side
  const satsDisplay = fixIn === 'sats'
    ? sats
    : (derivedSats !== null ? formatAmount(derivedSats, 'SATS') : '')
  const fiatDisplay = fixIn === 'fiat'
    ? fiatAmount
    : (derivedFiat !== null ? formatAmount(derivedFiat, fiatCurrency).replace(/[^\d.,]/g, '') : '')

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
        {/* Sats column */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="numeric"
            placeholder="0"
            value={satsDisplay}
            onChange={handleSatsInput}
            readOnly={fixIn !== 'sats'}
            className={`w-full px-2.5 py-1.5 text-sm rounded border bg-neutral-900 text-neutral-100 outline-none transition-colors
              ${fixIn === 'sats'
                ? 'border-purple-700 focus:border-purple-500'
                : 'border-neutral-800 text-neutral-400 cursor-default'}`}
            onClick={() => fixIn !== 'sats' && setFixIn('sats')}
          />
          <span className="text-xs text-neutral-500 px-1">sats</span>
        </div>

        {/* Equivalence dash */}
        <div className="hidden sm:flex items-center text-neutral-600 text-xs">≈</div>

        {/* Fiat column */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={fiatDisplay}
            onChange={handleFiatInput}
            readOnly={fixIn !== 'fiat'}
            className={`w-full px-2.5 py-1.5 text-sm rounded border bg-neutral-900 text-neutral-100 outline-none transition-colors
              ${fixIn === 'fiat'
                ? 'border-purple-700 focus:border-purple-500'
                : 'border-neutral-800 text-neutral-400 cursor-default'}`}
            onClick={() => fixIn !== 'fiat' && setFixIn('fiat')}
          />
          <select
            value={fiatCurrency}
            onChange={(e) => setFiatCurrency(e.target.value)}
            className="text-xs px-1.5 py-1.5 rounded border border-neutral-800 bg-neutral-900 text-neutral-300"
          >
            {SUPPORTED_FIATS.map(code => <option key={code} value={code}>{code}</option>)}
          </select>
        </div>
      </div>

      {/* Fix-in radio + rate freshness */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <span>Fix price in:</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="fix-price-in"
              value="sats"
              checked={fixIn === 'sats'}
              onChange={() => setFixIn('sats')}
              className="accent-purple-600"
            />
            <span>Sats</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="fix-price-in"
              value="fiat"
              checked={fixIn === 'fiat'}
              onChange={() => setFixIn('fiat')}
              className="accent-purple-600"
            />
            <span>Fiat</span>
          </label>
        </div>
        <RateAge rates={rates} ratesReady={ratesReady} />
      </div>
    </div>
  )
}

function RateAge({ rates, ratesReady }) {
  if (!ratesReady) {
    return <span className="text-xs text-amber-500">Rates unavailable</span>
  }
  const ageMs = Date.now() - (rates.fetchedAt || 0)
  const minutes = Math.floor(ageMs / 60000)
  const label = minutes < 1
    ? 'just now'
    : minutes === 1
      ? '1 minute ago'
      : `${minutes} minutes ago`
  return <span className="text-xs text-neutral-600">Rates: {label}</span>
}
