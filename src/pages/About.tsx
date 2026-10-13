import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import axonIcon from '@/assets/axon-icon.png'
import axonTitle from '@/assets/axon-title.png'

// Product page: what AXON is and where data lives. Static copy only — no external links, remote assets or
// personal information. (Build/support details live in Settings → About.)

const WHAT_TEAMS_BUILD = [
  'Story to pull requests: plan the work, code each repo, review, open linked PRs.',
  'Staged workflows: write the spec on one machine, code on another, review on a third. Each stage hands over through Jira and GitHub.',
  'Epic breakdown: analyse an epic and draft the stories for it.',
  'Requirement checks: assess whether a ticket is ready for agents to work on.',
  'Ticket housekeeping that needs no AI: move a ticket, add labels, comment, assign, request reviewers.',
  'Any multi-step task your agents can do, run the same way every time.',
]

const HOW_IT_WORKS: { title: string; text: string }[] = [
  { title: 'Start', text: 'by hand, or automatically by an automation rule when a Jira ticket assigned to you gets the ready label or status.' },
  { title: 'Check', text: 'AXON validates the pipeline and your Jira and GitHub access before anything runs.' },
  { title: 'Pipeline', text: "a published version of a pipeline from your team's registry runs on this computer." },
  { title: 'Agents', text: "each step runs your team's agent, in the right repo when it needs one." },
  { title: 'Review', text: 'the run pauses only at gates the pipeline defines.' },
  { title: 'Results', text: 'PRs and ticket updates (status, labels, comments) from the pipeline\'s action steps, plus a record of the run. If a run fails, the pipeline\'s failure actions run once.' },
]

const PLAIN_CODE_STEPS = [
  'Repeating a step for each item in a list (ForEach)',
  'Checking every handoff between agents',
  'Restoring the workspace before a retry',
  'Preparing workspaces and repos',
  'Opening pull requests',
  'Finding the open pull requests for a ticket (Find PRs)',
  'Labelling, requesting reviewers and commenting on pull requests (PR Update)',
  'Reading a ticket and its comments (Ticket Fetcher)',
  'Moving a ticket, adding labels, assigning and commenting in Jira (Jira Update)',
  'Pausing for human review',
  'Checking a pipeline before it starts',
  'Watching Jira for ready tickets and starting deliveries (Automation)',
]

const BUILDING = [
  'A block is one step: an agent (a skill file you write) or a built-in action. An agent declares what it needs and returns once, in the front of its own file, so the contract travels with the block.',
  'A pipeline connects blocks. ForEach repeats blocks for every item of a list, and a Human Gate pauses for review.',
  'Built-in action blocks read tickets, move them, label them, comment, find and update pull requests. They are plain code, with no AI.',
  'A pipeline can also say what to do if it fails, for example label the ticket and explain why.',
  'Published versions never change. A rule or a delivery keeps the version it started with, and you can open it read-only later.',
]

const AUTOMATION = [
  'A rule only decides when a pipeline starts: the Jira project, a ready label or status, and which published version to run.',
  'The pipeline decides what happens, including every change to Jira and GitHub, so a ticket can move through stages: spec, then code, then review.',
  'Stages can run on different engineers\' machines. They hand over through the ticket and the pull request, never through AXON itself.',
  'Rules run on one machine at a time. Pause all stops every rule on every machine.',
  'When a newer pipeline version exists, the rule shows what changed before you move it over.',
]

const SAFETY = [
  'Each agent works only inside its own folder — no pushing, no network, no access elsewhere.',
  'Everything an agent receives is treated as data, never as instructions.',
  'Every handoff between agents is checked against its declared contract.',
  'A retried step starts from a clean snapshot of the workspace.',
  'Agents get only the repo descriptions they ask for — never URLs or credentials.',
  'Jira and GitHub actions are AXON code run with your own credentials. Agents can never call them.',
  'Actions are safe to repeat: a resume or a rerun never posts the same comment or label twice.',
  'Before a delivery starts, AXON checks the pipeline, your Jira and GitHub access and that the ticket can reach the status the pipeline sets. A problem stops it before any agent runs or any tokens are spent.',
]

const DATA_LIVES = [
  'Runs execute on this computer. AXON has no server of its own.',
  'Secrets (Jira, GitHub) are encrypted on this machine and never synced.',
  'Your Claude key is either linked to your Claude Code config (AXON keeps only a fingerprint) or entered in AXON (encrypted by your operating system). It is never synced.',
  'Workspace snapshots stay on this computer and are deleted when a delivery finishes.',
  'The team registry receives pipelines, blocks, your automation rules and run summaries only, never code, prompts or agent output.',
  "The context an agent works on is sent to Anthropic's API only while that agent runs, using your organisation's key.",
  'Jira and GitHub are called with your own credentials.',
  'To let another machine carry on where this one stopped, automation leaves small markers on the Jira ticket itself (which rule ran, which comments AXON posted). They hold no code and no agent output.',
]

export default function About() {
  const { data } = useQuery({ queryKey: ['system-info'], queryFn: () => window.axon.system.getInfo(), staleTime: Infinity })

  useEffect(() => {
    window.axon?.window?.setTitle?.('AXON — About')
  }, [])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-8 py-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <img src={axonIcon} alt="" className="h-16" />
        <img src={axonTitle} alt="AXON" className="h-5" />
        <p className="text-base font-medium text-foreground">Engineering Intelligence. Automated Delivery.</p>
        <p className="text-sm text-muted-foreground">
          Version {data?.appVersion ?? '…'} · Proof of concept for internal evaluation
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>What AXON does</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">
            AXON runs pipelines of AI agents on your machine. Your team builds the agents and designs the pipeline; AXON runs it: in order,
            in the right place, with the right context, and with a human review wherever the pipeline asks for one.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What teams build with it</CardTitle>
          <CardDescription>Examples only.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {WHAT_TEAMS_BUILD.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-3">
            {HOW_IT_WORKS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-3 text-sm leading-relaxed">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{i + 1}</span>
                <span className="text-muted-foreground"><strong className="font-medium text-foreground">{s.title}:</strong> {s.text}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Building blocks and pipelines</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {BUILDING.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automation and staged workflows</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {AUTOMATION.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Built-in safety</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {SAFETY.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI only where it&apos;s needed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            AXON&apos;s built-in steps run as plain code — no AI, no tokens, the same result every time:
          </p>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {PLAIN_CODE_STEPS.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">Your agents handle the parts that need judgement. AXON handles the rest.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where your data lives</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-foreground/60">
            {DATA_LIVES.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
