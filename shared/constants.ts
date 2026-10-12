// Same six tools offered in CreateBlockForm's checklist — never WebSearch/WebFetch/AskUserQuestion.
export const AGENTIC_TOOL_OPTIONS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const
export type AgenticTool = (typeof AGENTIC_TOOL_OPTIONS)[number]
export const AGENTIC_TOOL_CEILING: readonly string[] = AGENTIC_TOOL_OPTIONS

export const LOCAL_USER = 'local-user'
export const DS1_DEFAULT_THRESHOLD_BYTES = 50_000
