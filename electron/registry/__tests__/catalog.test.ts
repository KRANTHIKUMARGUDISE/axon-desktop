import { describe, it, expect } from 'vitest'
import { parseCatalogDetailed } from '../catalog'

describe('catalog description and tags', () => {
  it('reads description and tags', () => {
    const c = parseCatalogDetailed('repositories:\n  - name: web\n    url: https://github.com/a/web.git\n    description: UI\n    tags: [frontend]\n')
    expect(c.entries[0]).toMatchObject({ description: 'UI', tags: ['frontend'] })
    expect(c.warnings).toEqual([])
  })
  it('truncates a description over 200 characters and warns', () => {
    const c = parseCatalogDetailed(`repositories:\n  - name: web\n    url: https://github.com/a/web.git\n    description: ${'d'.repeat(300)}\n`)
    expect(c.entries[0].description).toHaveLength(200)
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings[0]).toMatchObject({ name: 'web', index: 1 })
    expect(c.warnings[0].reason).toMatch(/truncated to 200/)
    expect(c.dropped).toEqual([])
  })
})
