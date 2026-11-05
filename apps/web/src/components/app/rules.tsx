import { CircleAlert, CircleCheck, CircleX, RefreshCw } from 'lucide-react'
import { blockingFindings, type RuleCheck, type RuleOutcome } from '@sidedoor/shared/rules'
import { Button } from '~/components/ui/button'
import { rpc } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

const TONE: Record<RuleOutcome, string> = { fail: 'text-destructive', flag: 'text-hot', pass: 'text-muted-foreground', unknown: 'text-muted-foreground' }
const ICON = { fail: CircleX, flag: CircleAlert, pass: CircleCheck, unknown: CircleAlert } as const
const LABEL: Record<string, string> = { remote: 'Remote', pay: 'Pay', citizenship: 'Citizenship', clearance: 'Clearance' }

/** How the posting stands on your rules: fails stop prep and submit until you go ahead anyway. */
export function RulesCard({ id, check }: { id: string; check: RuleCheck | null }) {
  const recheck = useAction(() => rpc.checkRules({ id }))
  const override = useAction((clear: boolean) => rpc.overrideRules({ id, clear }), { success: (r) => (r?.override ? 'Prep and submit will go ahead' : 'Your rules block it again') })
  if (!check)
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        Not checked against your rules yet.
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={recheck.pending} onClick={() => void recheck.run(undefined)}>
          Check now
        </Button>
      </div>
    )
  const shown = check.findings.filter((f) => f.outcome !== 'pass' || f.rule === 'pay')
  const blocking = blockingFindings(check).length > 0
  const Icon = ICON[check.result]
  return (
    <div className={cn('rounded-xl border px-3 py-2.5 text-sm', check.result === 'fail' ? 'border-destructive/40 bg-destructive/5' : check.result === 'flag' ? 'border-hot/40 bg-hot/5' : 'bg-card')}>
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4 shrink-0', TONE[check.result])} />
        <span className="font-medium">
          {check.result === 'fail' ? (blocking ? 'Breaks your rules: prep and submit are stopped' : 'Breaks your rules: you chose to go ahead') : check.result === 'flag' ? 'Check this against your rules' : 'Meets your rules'}
        </span>
        <div className="ml-auto flex shrink-0 gap-1">
          {check.result === 'fail' && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={override.pending} onClick={() => void override.run(!blocking)}>
              {blocking ? 'Go ahead anyway' : 'Undo'}
            </Button>
          )}
          <Button size="icon" variant="ghost" className="size-7" title="Check again" disabled={recheck.pending} onClick={() => void recheck.run(undefined)}>
            <RefreshCw className={cn('size-3.5', recheck.pending && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {shown.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-xs">
          {shown.map((f) => (
            <li key={f.rule}>
              <span className={cn('font-medium', TONE[f.outcome])}>{LABEL[f.rule] ?? f.rule}:</span> {f.reason}
              {f.quote && f.outcome !== 'pass' && <span className="text-muted-foreground"> — “{f.quote}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
