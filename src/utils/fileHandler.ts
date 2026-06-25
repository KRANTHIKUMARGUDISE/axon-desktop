// Binary file extensions that should be skipped
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg',
  'pdf', 'zip', 'tar', 'gz', 'rar', '7z',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib',
  'wav', 'mp3', 'mp4', 'mov', 'avi',
])

export interface CachedFile {
  relativePath: string
  content: string
}

function isTextFile(filename: string, content: string): boolean {
  // Check file extension
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (BINARY_EXTENSIONS.has(ext)) {
    return false
  }

  // Check for null bytes (common indicator of binary data)
  if (content.includes('\0')) {
    return false
  }

  return true
}

export async function readSingleFile(
  filePath: string,
  readFile: (path: string) => Promise<string>
): Promise<{ cachedFile: CachedFile | null; skipped: boolean }> {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const fileName = normalizedPath.split('/').pop() || normalizedPath
  const content = await readFile(filePath)
  if (!isTextFile(fileName, content)) {
    return { cachedFile: null, skipped: true }
  }
  return { cachedFile: { relativePath: fileName, content }, skipped: false }
}

export async function readFilesFromFolder(
  folderPath: string,
  listFilesRecursive: (path: string, maxDepth?: number) => Promise<string[]>,
  readFile: (path: string) => Promise<string>
): Promise<{ cachedFiles: CachedFile[]; skippedFiles: string[] }> {
  const files = await listFilesRecursive(folderPath, 2)
  const cachedFiles: CachedFile[] = []
  const skippedFiles: string[] = []

  for (const filePath of files) {
    try {
      // Join path properly
      const fullPath = folderPath + (folderPath.endsWith('/') || folderPath.endsWith('\\') ? '' : '/') + filePath.replace(/\\/g, '/')

      // Read file content
      const content = await readFile(fullPath)

      // Normalize path to forward slashes
      const normalizedPath = filePath.replace(/\\/g, '/')

      // Check if it's a text file
      if (isTextFile(normalizedPath, content)) {
        cachedFiles.push({
          relativePath: normalizedPath,
          content,
        })
      } else {
        skippedFiles.push(normalizedPath)
      }
    } catch (err) {
      console.error(`Error reading file ${filePath}:`, err)
      skippedFiles.push(filePath)
    }
  }

  return { cachedFiles, skippedFiles }
}
