import { useState } from 'react'

const TIME_PERIODS = ['Last 30d', 'Last 90d', 'This sprint'] as const
type TimePeriod = typeof TIME_PERIODS[number]

/**
 * Always visible regardless of active view/tab. Static illustrative filter only —
 * held in local state, never wired to data or an API call.
 */
export function FilterBar() {
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('Last 30d')

  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
      {TIME_PERIODS.map(period => (
        <button
          key={period}
          type="button"
          onClick={() => setTimePeriod(period)}
          className={
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors ' +
            (timePeriod === period ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
          }
        >
          {period}
        </button>
      ))}
    </div>
  )
}
