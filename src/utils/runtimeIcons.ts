import type { AgentRuntime } from '../types'

export function getRuntimeIcon(runtime: AgentRuntime): string {
  const iconMap: Record<AgentRuntime, string> = {
    Claude: '/src/assets/runtimes/Claude-ai-icon.png',
    Codex: '/src/assets/runtimes/codex-ai-icon.png',
    Axon: '/src/assets/runtimes/axon-icon.png',
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
