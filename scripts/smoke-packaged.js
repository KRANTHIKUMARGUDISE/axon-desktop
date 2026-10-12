// Usage: node smoke.js <path-to-AXON.exe> [port]
// Launches a PACKAGED AXON build with a debug port, runs the S2 hardening checks over CDP, then stops
// only the process that owns that port (never kills by image name: Claude desktop is Electron too).
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const exe = process.argv[2]
const port = Number(process.argv[3] || 9444)
const userData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'axon-smoke-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('no page target')
}

function ownerPid() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8' }).trim()
  return out ? Number(out) : null
}

;(async () => {
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' })
  child.unref()
  let results = {}
  try {
    const target = await getTarget()
    await sleep(2500)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    const consoleMsgs = []
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
      if (d.method === 'Runtime.consoleAPICalled' || d.method === 'Log.entryAdded') consoleMsgs.push(JSON.stringify(d.params).slice(0, 300))
    }
    await new Promise((r) => (ws.onopen = r))
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Runtime.enable'); await send('Log.enable')
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      return r.result.result?.value ?? r.result.exceptionDetails?.exception?.description ?? null
    }
    results.url = await ev('location.href.slice(0,60)')
    results.csp = (await ev(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content`))?.slice(0, 80)
    results.noNodeGlobals = await ev(`typeof window.require + '/' + typeof process + '/' + typeof module`)
    results.apiKeys = await ev(`Object.keys(window.axon).join(',')`)
    results.ipcWorks = await ev(`window.axon.system.getInfo().then(i => i.electronVersion + ' app ' + i.appVersion, e => 'ERR ' + e.message)`)
    results.blocks = await ev(`window.axon.blocks.list().then(b => b.length, e => 'ERR ' + e.message)`)
    results.readTraversal = await ev(`window.axon.workspace.readFile('../../etc/passwd').then(() => 'ALLOWED', e => 'rejected')`)
    results.badSetting = await ev(`window.axon.settings.set('workspaceRoot','relative').then(() => 'ALLOWED', () => 'rejected')`)
    results.extFile = await ev(`window.axon.shell.openExternal('file:///C:/Windows/System32/calc.exe').then(r => r.success)`)
    results.windowOpen = await ev(`String(window.open('https://example.com'))`)
    // Navigation guard: try to leave the app; the page must still be ours afterwards.
    await ev(`setTimeout(() => { location.href = 'https://example.com/' }, 0)`)
    await sleep(2500)
    results.notificationPermission = await ev(`Notification.requestPermission().then(p => p)`)
    results.geolocation = await ev(`new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('GRANTED'), (e) => res('denied:' + e.code), { timeout: 3000 }))`)
    results.afterNavigate = await ev('location.protocol')
    results.fontReq = await ev(`JSON.stringify(performance.getEntriesByType('resource').map(r => r.name).filter(n => /googleapis|gstatic|^http/.test(n)))`)
    results.consoleProblems = consoleMsgs.filter((m) => /Content Security Policy|Refused|violat/i.test(m)).slice(0, 3)
    ws.close()
    const dir = path.dirname(exe)
    results.agentBinary = fs.existsSync(path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'))
  } catch (e) {
    results.error = String(e)
  } finally {
    const pid = ownerPid()
    if (pid) try { process.kill(pid) } catch {}
    await sleep(1500)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
  console.log(JSON.stringify(results, null, 1))
  process.exit(0)
})()
