import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { parseSkillFrontmatter } from '../../utils/skillParser'
import { readFilesFromFolder, type CachedFile } from '../../utils/fileHandler'


interface ArtifactData {
  folderPath: string
  cachedFiles: CachedFile[]
  entryPointPath: string
  artifactName?: string
  skillMeta?: { name?: string; description?: string }
}

interface ArtifactPopupProps {
  onAttach: (data: ArtifactData) => void
  onClose: () => void
}

export default function ArtifactPopup({ onAttach, onClose }: ArtifactPopupProps) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [cachedFiles, setCachedFiles] = useState<CachedFile[]>([])
  const [entryPointPath, setEntryPointPath] = useState<string | null>(null)
  const [skillMeta, setSkillMeta] = useState<{ name?: string; description?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skippedCount, setSkippedCount] = useState(0)


  const handleSelectFolder = async () => {
    try {
      setError(null)
      setLoading(true)
      const selected = await window.axon.dialog.openDirectory()
      if (!selected) return

      setFolderPath(selected)

      // Read all files with content
      const { cachedFiles: files, skippedFiles } = await readFilesFromFolder(
        selected,
        window.axon.workspace.listFilesRecursive,
        window.axon.workspace.readFile
      )

      // Normalize paths to forward slashes for checking
      const normalizedPaths = files.map((f) => f.relativePath.toLowerCase())
      const skillMdFile = files.find((f) => f.relativePath.toLowerCase() === 'skill.md')

      if (!skillMdFile) {
        setError('No SKILL.md found in the selected folder')
        setEntryPointPath(null)
        setSkillMeta(null)
        return
      }

      setCachedFiles(files)
      setSkippedCount(skippedFiles.length)
      setEntryPointPath(skillMdFile.relativePath)

      // Parse frontmatter from SKILL.md content (already read)
      const meta = parseSkillFrontmatter(skillMdFile.content)
      setSkillMeta(meta)
    } catch (err) {
      setError("Couldn't read that folder. Choose a different one.")
      console.error('Error selecting folder:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAttach = () => {
    if (!folderPath || !entryPointPath) {
      setError('No artifact selected')
      return
    }

    const artifactName = skillMeta?.name || 'Artifact'
    onAttach({
      folderPath,
      cachedFiles,
      entryPointPath,
      artifactName,
      skillMeta,
    })
  }

  const canAttach = !!(folderPath && entryPointPath && !error)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--axon-bg3)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          width: 450,
          maxHeight: '80vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 18px',
            borderBottom: '1px solid var(--axon-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--axon-t1)' }}>
            Attach Artifact (Skill)
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--axon-t3)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!folderPath ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--axon-t2)', margin: 0, lineHeight: 1.5 }}>
                Select a folder containing a SKILL.md file. AXON will read the skill definition and
                attach it to this block.
              </p>
              <button
                type="button"
                onClick={handleSelectFolder}
                disabled={loading}
                style={{
                  padding: '10px 14px',
                  borderRadius: 7,
                  border: '1px solid var(--axon-border2)',
                  background: 'var(--axon-bg4)',
                  color: 'var(--axon-t1)',
                  fontSize: 13,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? 'Reading…' : 'Browse Folder'}
              </button>
            </>
          ) : (
            <>
              {error && (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    color: '#ef4444',
                    fontSize: 12,
                  }}
                >
                  {error}
                </div>
              )}

              {!error && (
                <>
                  <div style={{ fontSize: 11.5, color: 'var(--axon-t3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Folder
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--axon-t1)',
                      fontFamily: 'monospace',
                      padding: '8px 10px',
                      background: 'var(--axon-bg4)',
                      borderRadius: 6,
                      border: '1px solid var(--axon-border2)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {folderPath}
                  </div>

                  {entryPointPath && (
                    <>
                      <div style={{ fontSize: 11.5, color: 'var(--axon-t3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                        Entry Point
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--axon-t1)',
                          fontFamily: 'monospace',
                          padding: '8px 10px',
                          background: 'rgba(34,211,184,0.08)',
                          borderRadius: 6,
                          border: '1px solid rgba(34,211,184,0.2)',
                        }}
                      >
                        {entryPointPath}
                      </div>

                      {skillMeta && (
                        <>
                          {skillMeta.name && (
                            <>
                              <div style={{ fontSize: 11.5, color: 'var(--axon-t3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                                Skill Name
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--axon-t1)', padding: '8px 0' }}>
                                {skillMeta.name}
                              </div>
                            </>
                          )}
                          {skillMeta.description && (
                            <>
                              <div style={{ fontSize: 11.5, color: 'var(--axon-t3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                                Description
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--axon-t2)', padding: '8px 0', lineHeight: 1.4 }}>
                                {skillMeta.description}
                              </div>
                            </>
                          )}
                        </>
                      )}

                      <div style={{ fontSize: 11.5, color: 'var(--axon-t3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                        Files
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--axon-t2)',
                          background: 'var(--axon-bg4)',
                          border: '1px solid var(--axon-border2)',
                          borderRadius: 6,
                          padding: '8px 10px',
                          maxHeight: 150,
                          overflowY: 'auto',
                        }}
                      >
                        {cachedFiles.length === 0 ? (
                          <span style={{ color: 'var(--axon-t4)' }}>No files</span>
                        ) : (
                          <>
                            {cachedFiles.map((file) => (
                              <div
                                key={file.relativePath}
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: 10,
                                  padding: '2px 0',
                                  color: file.relativePath === entryPointPath ? 'rgba(34,211,184,0.8)' : 'inherit',
                                }}
                              >
                                {file.relativePath === entryPointPath && '✓ '}
                                {file.relativePath}
                              </div>
                            ))}
                            {skippedCount > 0 && (
                              <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--axon-border)' }}>
                                {skippedCount} binary file(s) excluded
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={handleSelectFolder}
                    disabled={loading}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--axon-border2)',
                      background: 'var(--axon-bg4)',
                      color: 'var(--axon-t2)',
                      fontSize: 12,
                      cursor: loading ? 'not-allowed' : 'pointer',
                      marginTop: 4,
                    }}
                  >
                    Choose Different Folder
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--axon-border)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 7,
              border: '1px solid var(--axon-border2)',
              background: 'none',
              color: 'var(--axon-t2)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAttach}
            disabled={!canAttach || loading}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 7,
              border: 'none',
              background: canAttach && !loading ? 'var(--axon-nexus)' : 'var(--axon-bg5)',
              color: canAttach && !loading ? '#fff' : 'var(--axon-t3)',
              fontWeight: 600,
              fontSize: 13,
              cursor: canAttach && !loading ? 'pointer' : 'default',
            }}
          >
            Attach
          </button>
        </div>
      </div>
    </div>
  )
}
