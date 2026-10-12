import type { AgentOutput } from '../../shared'
import { createClaudePromptRunner } from './claudePrompt'
import { runAgenticBlock } from './claudeAgentic'
import { runAxonNative } from './axonNative'
import { runCodex } from './codex'
import type { Runner, RunnerInput } from './types'

export function createRunner(getClaudeKey: () => string): Runner {
  const prompt = createClaudePromptRunner(getClaudeKey)
  return async (input: RunnerInput): Promise<AgentOutput> => {
    switch (input.block.agentRuntime) {
      case 'Axon':
        return runAxonNative(input)
      case 'Claude':
        return input.block.executionType === 'Agentic'
          ? runAgenticBlock(input, getClaudeKey())
          : prompt(input)
      case 'Codex':
        return runCodex(input)
      default:
        throw new Error(`Unsupported agent runtime: ${String(input.block.agentRuntime)}`)
    }
  }
}
