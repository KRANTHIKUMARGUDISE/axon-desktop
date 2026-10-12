const os = require('os')
const path = require('path')

module.exports = {
  appId: 'com.company.axon',
  productName: 'AXON',
  copyright: 'CommX Team',
  directories: { output: 'release', buildResources: 'build' },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    'build/icon.png',
    'package.json'
  ],
  extraMetadata: { main: 'dist-electron/electron/main.js' },
  // The Claude Agent SDK's platform packages (claude-agent-sdk-win32-x64, -darwin-arm64,
  // etc.) ship a native claude.exe/claude binary. Native executables can't be spawned from
  // inside an asar archive — only unpacked, on-disk files can be exec'd by the OS — so
  // these must be unpacked into app.asar.unpacked rather than packed into app.asar like
  // everything else. Without this, the binary "exists" (asar's virtual fs can stat it) but
  // fails to launch as a child process.
  asarUnpack: [
    'node_modules/@anthropic-ai/claude-agent-sdk*/**/*'
  ],
  electronDownload: {
    cache: path.join(os.tmpdir(), 'axon-electron-cache')
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png'
  },
  mac: process.platform === 'darwin' ? {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools'
  } : undefined,
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    shortcutName: 'AXON'
  },
  dmg: {
    title: 'AXON',
    contents: [
      { x: 410, y: 150, type: 'link', path: '/Applications' },
      { x: 130, y: 150, type: 'file' }
    ]
  }
}
