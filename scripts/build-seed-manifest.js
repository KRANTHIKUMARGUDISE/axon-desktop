// Regenerates resources/seed/manifest.json (version + sha256 per seed block).
// Run after editing anything under resources/seed/blocks:  node scripts/build-seed-manifest.js
// The checksum algorithm must match electron/store/seed.ts `checksumDir`.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const YAML = require('yaml')

const root = path.join(__dirname, '..', 'resources', 'seed')
const blocksDir = path.join(root, 'blocks')

function listFiles(dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out.sort()
}

function checksumDir(dir) {
  const h = crypto.createHash('sha256')
  for (const rel of listFiles(dir)) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n'))
    h.update('\0')
  }
  return h.digest('hex')
}

const blocks = fs.readdirSync(blocksDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
  const dir = path.join(blocksDir, e.name)
  const doc = YAML.parse(fs.readFileSync(path.join(dir, 'block.yaml'), 'utf8'))
  return { id: doc.id, name: doc.name, version: doc.version, path: `blocks/${e.name}`, sha256: checksumDir(dir) }
}).sort((a, b) => a.id.localeCompare(b.id))

const bundleVersion = blocks.reduce((n, b) => n + b.version, 0)
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, bundleVersion, blocks }, null, 2) + '\n')
console.log(`seed manifest: ${blocks.length} blocks`)
