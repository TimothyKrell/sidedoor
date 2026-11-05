import { useQuery } from '@tanstack/react-query'
import { History, Pencil, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { clearStaleFlagFn, qo } from '~/lib/api'
import type { RpcOutput } from '~/lib/rpc'
import { useAction } from '~/lib/use-action'

export type StaleFlag = RpcOutput<'staleFlags'>[number]

const DOC_TITLES: Record<string, string> = { experience: 'Experience', answers: 'Standard answers', stories: 'Story bank' }

/**
 * Sentences a change to a profile document made out of date, in a draft or an application's package.
 * One query for every open flag, shared by all the cards on a page. Nothing here changes the text:
 * "Use suggestion" opens the editor with it, for the user to save or not.
 */
export function StaleFlags({ draftId, applicationId, onUse }: { draftId?: string; applicationId?: string; onUse?: (f: StaleFlag) => void }) {
  const { data } = useQuery(qo.staleFlags())
  const clear = useAction((v: { id: string }) => clearStaleFlagFn({ data: v }))
  const flags = (data ?? []).filter((f) => (draftId ? f.draftId === draftId : !f.draftId && f.applicationId === applicationId))
  if (!flags.length) return null
  return (
    <div className="mt-3 space-y-2">
      {flags.map((f) => (
        <div key={f.id} className="flex gap-2 rounded-lg border border-hot/30 bg-hot/10 px-2.5 py-2 text-xs">
          <History className="mt-px size-3.5 shrink-0 text-hot" />
          <div className="min-w-0 flex-1 space-y-1">
            <div>
              <span className="font-medium text-foreground">May be out of date{f.section === 'cover-letter' ? ' (cover letter)' : f.section?.startsWith('q:') ? ` (answer ${f.section.slice(2)})` : ''}:</span>{' '}
              <span className="text-muted-foreground">“{f.sentence}”</span>
            </div>
            <div className="text-muted-foreground">
              {DOC_TITLES[f.docKey] ?? f.docKey} now says: <span className="text-foreground">{f.fact}</span>
            </div>
            {f.suggestion && <div className="text-muted-foreground">Suggested: <span className="text-foreground">{f.suggestion}</span></div>}
            <div className="flex gap-1.5 pt-0.5">
              {onUse && f.suggestion && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onUse(f)}>
                  <Pencil /> Use suggestion
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={clear.pending} onClick={() => void clear.run({ id: f.id })} title="It's fine as written">
                <X /> Dismiss
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
