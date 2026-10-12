import fs from 'fs/promises'
import path from 'path'
import { atomicWrite } from '../store/atomic'

// DS1 — large payload storage. Anything at/over the threshold goes to
// {runsDir}/{deliveryId}/{inputs|outputs}/{nodeId}-{ts}.json instead of inline in the
// delivery document. This lives under userData, never inside the target repo worktree.

export interface StoredResult {
  value: Record<string, unknown>
  isTruncated: boolean
  fileRef?: string
}

export async function storeIfLarge(opts: {
  runsDir: string
  deliveryId: string
  subfolder: 'inputs' | 'outputs'
  nodeId: string
  data: Record<string, unknown>
  thresholdBytes: number
  now: () => Date
}): Promise<StoredResult> {
  const serialized = JSON.stringify(opts.data)
  const size = Buffer.byteLength(serialized, 'utf-8')
  if (size < opts.thresholdBytes) return { value: opts.data, isTruncated: false }

  const safeNode = opts.nodeId.replace(/[^A-Za-z0-9_-]/g, '_')
  const fileRef = `${opts.subfolder}/${safeNode}-${opts.now().getTime()}.json`
  // A failed write must fail the step: silently sending/persisting an oversize payload
  // inline would defeat the point of DS1.
  await atomicWrite(path.join(opts.runsDir, opts.deliveryId, fileRef), serialized)
  return {
    value: { truncated: true, sizeBytes: size, note: `Full content stored locally — ${fileRef}` },
    isTruncated: true,
    fileRef,
  }
}

export function resolveStoredPath(runsDir: string, deliveryId: string, fileRef: string): string {
  const base = path.resolve(runsDir, deliveryId)
  const full = path.resolve(base, fileRef)
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Invalid stored-file reference')
  return full
}

export async function readStored(runsDir: string, deliveryId: string, fileRef: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(resolveStoredPath(runsDir, deliveryId, fileRef), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}
