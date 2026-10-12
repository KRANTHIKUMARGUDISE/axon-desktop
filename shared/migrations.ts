import { SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION } from './schemas'

// Schema-version policy: every file has `schemaVersion`; the reader tolerates N-1 (upgrading in
// memory) and refuses anything newer than this build understands.

export class SchemaVersionError extends Error {
  constructor(public readonly found: number, public readonly kind: 'newer' | 'older') {
    super(
      kind === 'newer'
        ? `Document schemaVersion ${found} is newer than this app supports (${SCHEMA_VERSION}); update AXON.`
        : `Document schemaVersion ${found} is older than the minimum readable version (${MIN_READABLE_SCHEMA_VERSION}).`,
    )
  }
}

type Doc = Record<string, unknown>
type DocKind = 'block' | 'pipeline' | 'other'

// v1 -> v2: documents that predate registry scope were all edited-in-place local docs, so they
// are treated as Published personal documents.
const steps: Record<number, (doc: Doc, kind: DocKind) => Doc> = {
  1: (doc, kind) =>
    kind === 'other'
      ? doc
      : { ...doc, scope: doc.scope ?? 'Personal', owner: doc.owner ?? '', status: doc.status ?? 'Published' },
}

/** Upgrades a parsed document to SCHEMA_VERSION. Throws SchemaVersionError when it can't be read. */
export function migrateDoc(raw: unknown, kind: DocKind = 'other'): Doc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Document is not an object')
  let doc = raw as Doc
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1
  if (v > SCHEMA_VERSION) throw new SchemaVersionError(v, 'newer')
  if (v < MIN_READABLE_SCHEMA_VERSION) throw new SchemaVersionError(v, 'older')
  while (v < SCHEMA_VERSION) {
    doc = steps[v](doc, kind)
    v += 1
  }
  return { ...doc, schemaVersion: SCHEMA_VERSION }
}
