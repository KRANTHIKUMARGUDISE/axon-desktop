import { z } from 'zod'

// S5 Part B: a Human Gate node keeps its settings in PipelineNode.config, so they are pinned with the
// published pipeline version (no per-run bypass).
export const GATE_MODES = ['Pause', 'NotifyOnly'] as const
export type GateMode = (typeof GATE_MODES)[number]

export const GateConfigSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  checklist: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  mode: z.enum(GATE_MODES).default('Pause'),
})
export type GateConfig = z.infer<typeof GateConfigSchema>

export interface ParsedGateConfig {
  reason: string
  checklist: string[]
  mode: GateMode
}

/** Lenient read used at run time and in the UI: missing pieces become empty/default. */
export function readGateConfig(config: Record<string, unknown> | undefined): ParsedGateConfig {
  const reason = typeof config?.reason === 'string' ? config.reason.trim() : ''
  const checklist = Array.isArray(config?.checklist)
    ? (config?.checklist as unknown[]).filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    : []
  const mode: GateMode = config?.mode === 'NotifyOnly' ? 'NotifyOnly' : 'Pause'
  return { reason, checklist, mode }
}
