export function parseSkillFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return null

  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = value
  }
  return result
}
