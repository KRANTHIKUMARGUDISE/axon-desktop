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
  extraMetadata: { main: 'dist-electron/main.js' },
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
