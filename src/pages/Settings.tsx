import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { JiraSettings } from '../components/settings/JiraSettings'
import { GithubSettings } from '../components/settings/GithubSettings'
import { ClaudeSettings } from '../components/settings/ClaudeSettings'
import { RegistrySettings } from '../components/registry/RegistrySettings'
import { Field, FieldRow, SettingsCard, cleanError } from '../components/settings/parts'

type Theme = 'dark' | 'light' | 'system'

export default function Settings() {
  useEffect(() => {
    window.axon?.window?.setTitle?.('AXON — Settings')
  }, [])

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Accounts, registry sync and your local environment.</p>
      </div>

      <Tabs defaultValue="accounts" className="gap-6">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="registry">Registry</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="flex flex-col gap-6">
          <JiraSettings />
          <GithubSettings />
          <ClaudeSettings />
        </TabsContent>

        <TabsContent value="registry"><RegistrySettings /></TabsContent>
        <TabsContent value="workspace"><WorkspaceSettings /></TabsContent>
        <TabsContent value="preferences"><PreferenceSettings /></TabsContent>
        <TabsContent value="about"><AboutSettings /></TabsContent>
      </Tabs>
    </div>
  )
}

function WorkspaceSettings() {
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.axon.settings.get('workspaceRoot').then((v) => setPath(typeof v === 'string' ? v : '')).catch(() => {})
  }, [])

  async function browse() {
    const dir = await window.axon.dialog.openDirectory()
    if (dir) setPath(dir)
  }

  async function save() {
    setSaving(true)
    try {
      await window.axon.settings.set('workspaceRoot', path.trim())
      toast.success('Workspace folder saved')
    } catch (e) {
      toast.error(cleanError(e, 'Could not save the workspace folder'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Workspace"
      description="Repositories for your deliveries are cloned under this folder. Avoid cloud-synced folders such as OneDrive."
      footer={
        <>
          {path && (
            <Button variant="outline" onClick={() => void window.axon.shell.openPath(path)}><ExternalLink /> Open in Explorer</Button>
          )}
          <Button onClick={save} disabled={!path.trim() || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <Field label="Root directory" htmlFor="ws-root">
        <div className="flex gap-2">
          <Input id="ws-root" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\dev" spellCheck={false} className="font-mono" />
          <Button variant="outline" onClick={browse}><FolderOpen /> Browse</Button>
        </div>
      </Field>
    </SettingsCard>
  )
}

function PreferenceSettings() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [snapshotKb, setSnapshotKb] = useState('50')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.axon.settings.getAll().then((all) => {
      setTheme(((all.theme as string) || 'dark') as Theme)
      setSnapshotKb(String((all.maxContextSnapshotSizeKb as number) || 50))
    }).catch(() => {})
  }, [])

  async function save() {
    const kb = Math.round(Number(snapshotKb))
    if (!Number.isFinite(kb) || kb < 1) { toast.error('Snapshot size must be at least 1 KB'); return }
    setSaving(true)
    try {
      await window.axon.settings.set('theme', theme)
      await window.axon.settings.set('maxContextSnapshotSizeKb', kb)
      toast.success('Preferences saved')
    } catch (e) {
      toast.error(cleanError(e, 'Could not save preferences'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Preferences"
      description="Appearance and how much step data AXON keeps inline."
      footer={<Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>}
    >
      <FieldRow>
        <Field label="Theme" htmlFor="pref-theme">
          <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
            <SelectTrigger id="pref-theme" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Max inline snapshot size (KB)" htmlFor="pref-snapshot" hint="Step input/output above this size is written to a file instead of being stored inline.">
          <Input id="pref-snapshot" type="number" min={1} value={snapshotKb} onChange={(e) => setSnapshotKb(e.target.value)} />
        </Field>
      </FieldRow>
    </SettingsCard>
  )
}

function AboutSettings() {
  const { data } = useQuery({ queryKey: ['system-info'], queryFn: () => window.axon.system.getInfo(), staleTime: Infinity })
  return (
    <SettingsCard title="About" description="Build information for support and bug reports.">
      <FieldRow>
        <Field label="AXON version" htmlFor="about-version"><Input id="about-version" readOnly value={data?.appVersion ?? ''} /></Field>
        <Field label="Platform" htmlFor="about-platform"><Input id="about-platform" readOnly value={data?.platform ?? ''} /></Field>
        <Field label="Electron" htmlFor="about-electron"><Input id="about-electron" readOnly value={data?.electronVersion ?? ''} /></Field>
        <Field label="Node" htmlFor="about-node"><Input id="about-node" readOnly value={data?.nodeVersion ?? ''} /></Field>
      </FieldRow>
    </SettingsCard>
  )
}
