// The repoCatalog context field (agent standard: opt-in, compact, no URLs, no credentials).
export interface AgentCatalogRepo {
  name: string
  description?: string
  tags?: string[]
}

export const CATALOG_DESCRIPTION_MAX = 200

export interface RepoCatalogText {
  /** One line per repo: `<name>: <description> [<tags>]`. */
  text: string
  repos: number
  /** Rough size (4 chars/token). */
  approxTokens: number
}

/** `catalogTags` (when non-empty) keeps only repos with at least one of those tags (case-insensitive). */
export function buildRepoCatalogText(entries: AgentCatalogRepo[], catalogTags?: string[]): RepoCatalogText {
  const want = new Set((catalogTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))
  const picked = want.size === 0 ? entries : entries.filter((e) => (e.tags ?? []).some((t) => want.has(t.toLowerCase())))
  const text = picked
    .map((e) => `${e.name}:${e.description ? ` ${e.description}` : ''}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`)
    .join('\n')
  return { text, repos: picked.length, approxTokens: Math.ceil(text.length / 4) }
}
