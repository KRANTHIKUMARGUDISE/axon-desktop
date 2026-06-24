import type { AgentRuntime } from '../types'
import claudeIcon from '../assets/runtimes/Claude-ai-icon.png'
import codexIcon from '../assets/runtimes/codex-ai-icon.png'
import axonRuntimeIcon from '../assets/runtimes/axon-icon.png'

export function getRuntimeIcon(runtime: AgentRuntime): string {
  const iconMap: Record<AgentRuntime, string> = {
    Claude: claudeIcon,
    Codex: codexIcon,
    Axon: axonRuntimeIcon,
  }
  return iconMap[runtime]
}

export const RUNTIME_COLORS: Record<AgentRuntime, string> = {
  Claude: '#22d3b8',
  Codex: '#38bdf8',
  Axon: '#fbbf24',
}

export const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  Claude: 'Claude',
  Codex: 'Codex',
  Axon: 'Axon',
}
