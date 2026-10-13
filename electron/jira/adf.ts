import type { Adf } from './client'

// Atlassian Document Format helpers: rendered templates -> ADF for comments, ADF -> markdown for the Ticket Fetcher.

/** Plain text (a rendered template) to ADF: blank line = new paragraph, single newline = line break. */
export function textToAdf(text: string): Adf {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const content = (paragraphs.length ? paragraphs : ['']).map((p) => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  }))
  return { type: 'doc', version: 1, content }
}

type Ctx = { list?: 'bullet' | 'ordered'; idx?: number }
type AdfNode = { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: { href?: string } }[] }

function walk(n: unknown, ctx: Ctx = {}): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const x = n as AdfNode
  const kids = (c: Ctx = ctx) => (x.content ?? []).map((k) => walk(k, c)).join('')
  switch (x.type) {
    case 'text': {
      let t = x.text ?? ''
      if (x.marks?.some((m) => m.type === 'code')) t = `\`${t}\``
      if (x.marks?.some((m) => m.type === 'strong')) t = `**${t}**`
      const link = x.marks?.find((m) => m.type === 'link')?.attrs?.href
      return link ? `[${t}](${link})` : t
    }
    case 'hardBreak': return '\n'
    case 'paragraph': return `${kids()}\n\n`
    case 'heading': return `${'#'.repeat(Math.min(6, Number(x.attrs?.level) || 1))} ${kids()}\n\n`
    case 'bulletList': return `${(x.content ?? []).map((k) => walk(k, { list: 'bullet' })).join('')}\n`
    case 'orderedList': return `${(x.content ?? []).map((k, i) => walk(k, { list: 'ordered', idx: i + 1 })).join('')}\n`
    case 'listItem': return `${ctx.list === 'ordered' ? `${ctx.idx}. ` : '- '}${kids({}).trim().replace(/\n+/g, '\n  ')}\n`
    case 'codeBlock': return `\`\`\`\n${kids()}\n\`\`\`\n\n`
    case 'blockquote': return `${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`
    case 'mention': return String(x.attrs?.text ?? '@user')
    default: return kids()
  }
}

/** Flatten an ADF document (or plain string) to markdown-ish text. */
export function adfToMarkdown(node: unknown): string {
  return walk(node).replace(/\n{3,}/g, '\n\n').trim()
}
