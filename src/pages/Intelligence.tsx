import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TransparencyBadge } from '@/components/intelligence/TransparencyBadge'
// AXON Reliability strip hidden for now — re-add `<ReliabilityPanel />` (and its
// pinned-footer wrapper below) to bring it back.
// import { ReliabilityPanel } from '@/components/intelligence/ReliabilityPanel'
import { FilterBar } from '@/components/intelligence/FilterBar'
import { RequirementsQualityPanel } from '@/components/intelligence/RequirementsQualityPanel'
import { ReworkRatePanel } from '@/components/intelligence/ReworkRatePanel'
import { ValueDeliveredPanel } from '@/components/intelligence/ValueDeliveredPanel'
import { BlockPipelineQualityPanel } from '@/components/intelligence/BlockPipelineQualityPanel'
import { CATEGORY_COLORS, ALL_PIPELINES_VALUE, ALL_BLOCKS_VALUE } from '@/components/intelligence/shared'

type Level = 'my' | 'team'
type Category = 'requirements-quality' | 'rework-rate' | 'deliveries' | 'block-pipeline-quality'

const CATEGORY_TABS: { value: Category; label: string; color: string }[] = [
  { value: 'requirements-quality', label: 'Requirements Quality', color: CATEGORY_COLORS.requirementsQuality },
  { value: 'rework-rate', label: 'Rework Rate', color: CATEGORY_COLORS.reworkRate },
  { value: 'deliveries', label: 'Deliveries', color: CATEGORY_COLORS.deliveries },
  { value: 'block-pipeline-quality', label: 'Block & Pipeline Quality', color: CATEGORY_COLORS.blockPipelineQuality },
]

interface IntelligenceProps {
  // Stubbed permission check — no real auth logic in this pass. Defaults to
  // true so Team View is reachable for review; wire to real lead/role lookup later.
  isLead?: boolean
}

export default function Intelligence({ isLead = true }: IntelligenceProps) {
  const [level, setLevel] = useState<Level>('my')
  const [category, setCategory] = useState<Category>('requirements-quality')
  // Shared across Deliveries and Block & Pipeline Quality tab content —
  // moved here from the (now time-period-only) global filter bar.
  const [pipeline, setPipeline] = useState(ALL_PIPELINES_VALUE)
  const [block, setBlock] = useState(ALL_BLOCKS_VALUE)

  function handleLevelChange(value: string) {
    const next = value as Level
    setLevel(next)
    // Block & Pipeline Quality doesn't exist in My View — fall back if it was active.
    if (next === 'my' && category === 'block-pipeline-quality') {
      setCategory('requirements-quality')
    }
  }

  const visibleCategoryTabs = level === 'my'
    ? CATEGORY_TABS.filter(t => t.value !== 'block-pipeline-quality')
    : CATEGORY_TABS

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6 pb-10">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Intelligence</h1>
            <p className="text-sm text-muted-foreground">Operational intelligence across your deliveries and blocks</p>
          </div>
          <TransparencyBadge />
        </div>

        <Tabs value={level} onValueChange={handleLevelChange}>
          <TabsList>
            <TabsTrigger value="my">My View</TabsTrigger>
            {isLead && <TabsTrigger value="team">Team View</TabsTrigger>}
          </TabsList>
        </Tabs>

        <FilterBar />

        <Tabs value={category} onValueChange={v => setCategory(v as Category)}>
          <TabsList className="h-auto flex-wrap justify-start">
            {visibleCategoryTabs.map(t => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="border-b-[3px]"
                style={{ borderBottomColor: category === t.value ? t.color : 'transparent' }}
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="requirements-quality">
            <RequirementsQualityPanel level={level} />
          </TabsContent>
          <TabsContent value="rework-rate">
            <ReworkRatePanel level={level} />
          </TabsContent>
          <TabsContent value="deliveries">
            <ValueDeliveredPanel level={level} pipeline={pipeline} onPipelineChange={setPipeline} />
          </TabsContent>
          {level === 'team' && (
            <TabsContent value="block-pipeline-quality">
              <BlockPipelineQualityPanel
                level={level}
                pipeline={pipeline}
                onPipelineChange={setPipeline}
                block={block}
                onBlockChange={setBlock}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  )
}
