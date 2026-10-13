import type { Delivery, DeliveryStep, StepStatus } from './schemas'

/** A step that did not finish: it failed, was cancelled by the user, or was interrupted (quit/crash). */
export const isStoppedStep = (s: { status: StepStatus }): boolean =>
  s.status === 'Failed' || s.status === 'Cancelled' || s.status === 'Interrupted'

// Before steps had their own Cancelled/Interrupted status the engine stored these as Failed with a fixed message.
const LEGACY: [RegExp, StepStatus][] = [[/^Cancelled by user/, 'Cancelled'], [/^Interrupted \(AXON /, 'Interrupted']]

/** Older deliveries are read as if they had been written with the new statuses (in memory only). */
export function normalizeStoppedSteps(d: Delivery): Delivery {
  let changed = false
  const steps = d.steps.map((s): DeliveryStep => {
    if (s.status !== 'Failed') return s
    const msg = s.output?.errorMessage ?? s.output?.summary ?? ''
    const hit = LEGACY.find(([re]) => re.test(msg))
    if (!hit) return s
    changed = true
    return { ...s, status: hit[1] }
  })
  return changed ? { ...d, steps } : d
}
