import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

// tmp + fsync + rename so a crash mid-write never leaves a half-written document.
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await (typeof data === 'string' ? handle.writeFile(data, 'utf-8') : handle.writeFile(data))
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Windows can transiently refuse a rename over a file another process (AV, indexer) holds.
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(tmp, filePath)
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
    }
  }
  await fs.unlink(tmp).catch(() => {})
  throw lastErr
}
