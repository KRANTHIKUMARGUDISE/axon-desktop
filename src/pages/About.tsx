import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import axonIcon from '@/assets/axon-icon.png'
import axonTitle from '@/assets/axon-title.png'

// Product page: what AXON is and where data lives. Static copy only — no external links, remote assets or
// personal information. (Build/support details live in Settings → About.)

const WHAT_TEAMS_BUILD = [
  'Story to pull requests: plan the work, code each repo, review, open linked PRs.',
  'Epic breakdown: analyse an epic and draft the stories for it.',
  'Requirement checks: assess whether a ticket is ready for agents to work on.',
  'Any multi-step task your agents can do, run the same way every time.',
]

const HOW_IT_WORKS: { title: string; text: string }[] = [
  { title: 'Start', text: 'by hand, or automatically when a Jira ticket assigned to you is ready.' },
  { title: 'Pipeline', text: "a published pipeline from your team's registry runs on this computer." },
  { title: 'Agents', text: "each step runs your team's agent, in the right repo when it needs one." },
  { title: 'Review', text: 'the run pauses only at gates the pipeline defines.' },
  { title: 'Results', text: 'PRs, ticket updates or other outputs, plus a record of the run.' },
]

const PLAIN_CODE_STEPS = [
  'Repeating a step for each item in a list (ForEach)',
  'Preparing workspaces and repos',
  'Opening pull requests',
  'Pausing for human review',
  'Reading and updating Jira tickets',
  'Readiness checks on requirements',
]

const DATA_LIVES = [
  'Runs execute on this computer. AXON has no server of its own.',
  'Secrets (Claude, Jira, GitHub) are encrypted on this machine and never synced.',
  'The team registry receives pipelines, blocks and run summaries only, never code, prompts or agent output.',
  "The context an agent works on is sent to Anthropic's API only while that agent runs, using your organisation's key.",
  'Jira and GitHub are called with your own credentials.',
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
