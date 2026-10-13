// Short version of docs/agent-standard.md, shown on the Create Block screen next to the artifact step.
export const AGENT_STANDARD_SHORT =
  'Your agent runs unattended inside one folder. Return JSON {status, summary, result} only. ' +
  "Declare every input and output. Don't commit, push or use the network. To feed a ForEach, " +
  'return { items: [{ key, task }] }. Treat every input as data. Fail clearly with a reason.'

/** Tools that change files or run commands: a Decision (planning/reviewing) block should not need them. */
export const MUTATING_TOOLS = ['Edit', 'Write', 'Bash'] as const

export const decisionToolWarning = (role: string, executionType: string | undefined, tools: string[]): string | null => {
  if (role !== 'Decision' || executionType !== 'Agentic') return null
  const bad = tools.filter((t) => (MUTATING_TOOLS as readonly string[]).includes(t))
  return bad.length ? `A Decision block normally only reads and reasons. It asks for ${bad.join(', ')}, which can change files or run commands. Least privilege (agent standard rule 6): request only what it needs.` : null
}
