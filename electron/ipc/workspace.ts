import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

function expandPath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

export function registerWorkspaceHandlers() {
  ipcMain.handle('workspace:listDirs', async (_event, dirPath: string) => {
    dirPath = expandPath(dirPath)
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dirPath, e.name))
  })

  ipcMain.handle('workspace:exists', async (_event, filePath: string) => {
    filePath = expandPath(filePath)
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('workspace:readFile', async (_event, filePath: string) => {
    filePath = expandPath(filePath)
    return fs.readFile(filePath, 'utf-8')
  })

  ipcMain.handle('workspace:writeFile', async (_event, filePath: string, content: string) => {
    filePath = expandPath(filePath)
    await fs.writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('workspace:createDir', async (_event, dirPath: string) => {
    dirPath = expandPath(dirPath)
    await fs.mkdir(dirPath, { recursive: true })
  })

  ipcMain.handle('workspace:clear', async (_event, dirPath: string) => {
    dirPath = expandPath(dirPath)
    try {
      await fs.rm(dirPath, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('workspace:listFilesRecursive', async (_event, dirPath: string, maxDepth: number = 2) => {
    dirPath = expandPath(dirPath)
    const files: string[] = []
    async function walk(dir: string, depth: number) {
      if (depth > maxDepth) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relativePath = path.relative(dirPath, fullPath)
          if (entry.isFile()) {
            files.push(relativePath)
          } else if (entry.isDirectory() && depth < maxDepth) {
            await walk(fullPath, depth + 1)
          }
        }
      } catch (err) {
        console.error(`Error reading directory ${dir}:`, err)
      }
    }
    await walk(dirPath, 0)
    return files
  })
}
