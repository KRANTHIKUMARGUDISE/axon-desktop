// One palette for every delivery / step / lane status, used by badges, labels, graph nodes, lists and the legend,
// so a status looks the same on every screen. Change a colour here and it changes everywhere.

const HEX = {
  Pending: '#64748b',
  Running: '#3b82f6',
  Completed: '#22c55e',
  /** Needs a person: a gate waiting, or a delivery paused/queued. */
  Waiting: '#f59e0b',
  Failed: '#ef4444',
  Cancelled: '#be123c',
  Interrupted: '#a78bfa',
  Superseded: '#94a3b8',
} as const

type Canonical = keyof typeof HEX

const ALIAS: Record<string, Canonical> = {
  Success: 'Completed',
  Done: 'Completed',
  Paused: 'Waiting',
  AwaitingApproval: 'Waiting',
  'Awaiting approval': 'Waiting',
  Skipped: 'Pending',
  // lane states
  pending: 'Pending', running: 'Running', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
}

const canonical = (status: string): Canonical => (status in HEX ? (status as Canonical) : ALIAS[status] ?? 'Pending')

/** Solid colour (text, dots, rings, progress bars). */
export const statusColor = (status: string): string => HEX[canonical(status)]
/** Soft fill behind a badge. */
export const statusBg = (status: string): string => `${statusColor(status)}1f`
export const statusBorder = (status: string): string => `${statusColor(status)}44`

/** Inline style for a status badge. */
export const statusBadgeCss = (status: string): { color: string; background: string; border: string } => ({
  color: statusColor(status),
  background: statusBg(status),
  border: `1px solid ${statusBorder(status)}`,
})

/** { Status: colour } for the statuses a screen lists, for code that indexes a record. */
export const statusColorMap = <K extends string>(keys: readonly K[]): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, statusColor(k)])) as Record<K, string>
export const statusBgMap = <K extends string>(keys: readonly K[]): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, statusBg(k)])) as Record<K, string>

/** Legend entries for the Live View graph. */
export const GRAPH_LEGEND: readonly (readonly [string, string])[] = [
  ['Pending', statusColor('Pending')], ['Running', statusColor('Running')], ['Success', statusColor('Completed')],
  ['Awaiting approval', statusColor('Waiting')], ['Failed', statusColor('Failed')],
  ['Cancelled', statusColor('Cancelled')], ['Interrupted', statusColor('Interrupted')],
]

export const ALL_STATUS_KEYS = [
  'Pending', 'Running', 'Completed', 'Paused', 'Waiting', 'Failed', 'Cancelled', 'Interrupted', 'Superseded',
] as const
