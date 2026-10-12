// Generates resources/licenses.json: the third-party licenses of everything that ships in the app.
//   node scripts/generate-licenses.js          (runs automatically as part of `npm run build`)
//
// "Ships" = the production dependency closure of package.json (dependencies + the optionalDependencies that are
// actually installed, which includes the Agent SDK's native Claude Code binary package for this platform), plus
// the Electron runtime. devDependencies are excluded. Chromium's own notices (LICENSES.chromium.html) are added
// to the installer by electron-builder.
const fs = require('fs')
const path = require('path')

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.(md|txt|markdown))?$/i

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Node-style resolution of `name` as seen from `fromDir`.
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ')
  return 'UNKNOWN'
}

function licenseText(dir) {
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n---\n\n')
}

function repositoryOf(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url
  return r ? r.replace(/^git\+/, '').replace(/\.git$/, '') : undefined
}

function collectLicenses(root = path.join(__dirname, '..')) {
  const rootPkg = readJson(path.join(root, 'package.json'))
  const seen = new Map() // dir -> entry
  const queue = [
    ...Object.keys(rootPkg.dependencies || {}).map((n) => ({ name: n, from: root, optional: false })),
    // Electron is a devDependency for the build but its runtime ships inside the installer.
    { name: 'electron', from: root, optional: true },
  ]
  while (queue.length) {
    const { name, from, optional } = queue.shift()
    const dir = resolvePackageDir(name, from)
    if (!dir) {
      if (!optional) process.stderr.write(`licenses: ${name} not installed (skipped)\n`)
      continue
    }
    if (seen.has(dir)) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    if (!pkg) continue
    seen.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      repository: repositoryOf(pkg),
      text: licenseText(dir),
    })
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, from: dir, optional: false })
    // Optional deps (e.g. the per-platform native Claude Code binary) only count when installed on this build machine.
    for (const dep of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: dep, from: dir, optional: true })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

module.exports = { collectLicenses }

if (require.main === module) {
  const root = path.join(__dirname, '..')
  const packages = collectLicenses(root)
  const out = path.join(root, 'resources', 'licenses.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), packages }) + '\n')
  const noText = packages.filter((p) => !p.text).length
  console.log(`licenses: ${packages.length} packages -> resources/licenses.json (${noText} without a license file)`)
}
