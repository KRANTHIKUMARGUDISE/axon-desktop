### STORY

Continue building AXON Desktop. All features are working. This session configures the production build and generates installable packages for Windows and macOS.

**Tasks:**

1. Finalise electron-builder.config.js:
   ```javascript
   module.exports = {
     appId: 'com.company.axon',
     productName: 'AXON',
     copyright: 'CommX Team',
     directories: { output: 'release', buildResources: 'build' },
     files: [
       'dist/**/*',
       'dist-electron/**/*',
       'package.json'
     ],
     extraMetadata: { main: 'dist-electron/main.js' },
     win: {
       target: [{ target: 'nsis', arch: ['x64'] }],
       icon: 'build/icon.ico'
     },
     mac: {
       target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
       icon: 'build/icon.icns',
       category: 'public.app-category.developer-tools'
     },
     nsis: {
       oneClick: false,
       perMachine: false,
       allowToChangeInstallationDirectory: true,
       installerIcon: 'build/icon.ico',
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
   ```

2. Fix Vite config for production Electron build:
   - Renderer: build to dist/
   - Electron main: compile TypeScript to dist-electron/
   - Ensure paths resolve correctly in packaged app (no localhost references)
   - Set __dirname correctly for packaged environment

3. Fix any path issues:
   - In main.ts: use app.getPath('userData') for electron-store location
   - In workspace.ts: expand ~ to os.homedir() for cross-platform paths
   - In git.ts: use path.join for cross-platform compatibility

4. npm build scripts:
   ```json
   "build": "vite build && tsc -p tsconfig.electron.json",
   "build:win": "npm run build && electron-builder --win",
   "build:mac": "npm run build && electron-builder --mac",
   "build:all": "npm run build && electron-builder --win --mac"
   ```

5. Create placeholder icon files:
   - build/icon.png (512x512) — placeholder using AXON blue/purple gradient
   - Note in README: replace with real PNG before release, electron-builder converts to .ico and .icns

6. Test production build locally:
   - npm run build:win (on Windows) or build:mac (on macOS)
   - Install generated package
   - Verify app opens, setup wizard runs, all features work in packaged form

7. Update README.md with:
   - Prerequisites (Git only)
   - Dev setup: npm install, npm run dev
   - Build: npm run build:win or build:mac
   - What gets generated in /release

**Output expected:** npm run build:win produces a working .exe installer. npm run build:mac produces a working .dmg. Installed app runs identically to dev mode.