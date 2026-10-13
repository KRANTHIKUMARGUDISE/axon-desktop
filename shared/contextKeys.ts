// A contextRequirements entry ending in "?" is optional (e.g. "acceptanceCriteria?"): it is passed when present,
// and its absence is not reported as "missing".
export const isOptionalContext = (r: string): boolean => r.endsWith('?')
export const contextKey = (r: string): string => (isOptionalContext(r) ? r.slice(0, -1) : r)
