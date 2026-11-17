import type { FormTab } from '../browser'
import type { AuditEntry } from '../form-answers'
import type { FillReport } from './fill-form'

/**
 * A submit's window left open when it stopped for questions, by application: the next fill picks
 * up there. `filled` is what was in it then, so fields on steps behind it still get checked;
 * `held` are the ones Sidedoor held back, which the next fill must look at again. `codeAskedAt`:
 * submit was clicked and the form asked for a code it emailed then, so the next run only enters
 * the code. Kept in memory: a restart loses the windows, and the next fill starts over.
 */
export interface StoppedForm {
  tab: FormTab
  url: string
  filled: FillReport['filled']
  held: string[]
  audit: AuditEntry[]
  codeAskedAt: string | null
}

export const stoppedForms = new Map<string, StoppedForm>()

/** Sidedoor still holds the window a submit stopped in for a security code (the user may have closed it since). */
export const codeWindowOpen = (applicationId: string) => !!stoppedForms.get(applicationId)?.codeAskedAt
