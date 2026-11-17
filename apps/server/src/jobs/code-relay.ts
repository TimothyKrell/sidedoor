import { logActivity } from '../activity'
import type { schema } from '../db/client'
import { nowIso } from '../ids'
import { detectAts } from '../scout/adapters'
import { getSecret } from '../secrets'
import { getMeta, getSettings, setMeta } from '../settings'

/**
 * Telling Grok Bot a form is waiting on a security code, so it fetches the code from the user's
 * email when there is one instead of checking on a schedule. Sidedoor POSTs once per code the form
 * asks for to a Grok Bot routine webhook (the same convention as the task routine in handoff.ts:
 * `Authorization: Bearer <key>`, a JSON body whose `sidedoor` says what it is). The Bot answers
 * the question with answer_user_questions, and the submit goes on from there. Without a webhook
 * the question just waits, as it did before.
 */

/** How long the window waits for the code before anything may close it: codes arrive within a minute or two. */
export const CODE_WAIT_MS = 15 * 60_000
/** New codes Sidedoor asks a form for after one is turned down, per application. */
export const MAX_CODE_RESENDS = 2

interface CodeHookState {
  /** The code prompts already announced, by when the code was asked for: one POST each. */
  announced: string[]
  /** New codes asked for after one was turned down. */
  resends: number
}

const stateKey = (applicationId: string) => `securityCode:${applicationId}`
const stateOf = (applicationId: string): CodeHookState => ({ announced: [], resends: 0, ...getMeta<CodeHookState>(stateKey(applicationId)) })

/**
 * Where to POST: the security code routine when one is set (Settings → Grok Bot), else the routine
 * that takes Sidedoor's tasks. A URL is used only with its own key. Null when there's none.
 */
export const codeWebhook = (): { url: string; key: string } | null => {
  const g = getSettings().grokBot
  const own = g.codeWebhookUrl.trim()
  if (own) {
    const key = getSecret('grokbot-code-webhook-key')
    return key ? { url: own, key } : null
  }
  const url = g.webhookUrl.trim()
  const key = getSecret('grokbot-webhook-key')
  return url && key ? { url, key } : null
}

const HOSTS: [RegExp, string][] = [
  [/greenhouse\.io|[?&]gh_jid=/i, 'greenhouse'],
  [/lever\.co/i, 'lever'],
  [/ashbyhq\.com/i, 'ashby'],
  [/myworkdayjobs\.com|workday/i, 'workday'],
  [/smartrecruiters\.com/i, 'smartrecruiters'],
  [/workable\.com/i, 'workable'],
  [/rippling\.com/i, 'rippling'],
  [/recruitee\.com/i, 'recruitee'],
  [/gem\.com/i, 'gem'],
]

/** The application system behind a form, from its links ("greenhouse"), so the Bot knows whose email to look for. */
export const atsOf = (...urls: (string | null | undefined)[]) => {
  for (const u of urls) {
    if (!u) continue
    const hit = HOSTS.find(([re]) => re.test(u))
    if (hit) return hit[1]
    const d = detectAts(u)
    if (d) return d.kind
  }
  return 'unknown'
}

/** Another new code may be asked for after one is turned down. */
export const resendsLeft = (applicationId: string) => Math.max(0, MAX_CODE_RESENDS - stateOf(applicationId).resends)

/** A new code was asked for. */
export const noteResend = (applicationId: string) => {
  const s = stateOf(applicationId)
  setMeta(stateKey(applicationId), { ...s, resends: s.resends + 1 } satisfies CodeHookState)
}

/** This code prompt was announced to Grok Bot already. */
export const codeAnnounced = (applicationId: string, requestedAt: string) => stateOf(applicationId).announced.includes(requestedAt)

export interface CodeHookResult {
  at: string
  ok: boolean
  error?: string
}

/** Code prompts being announced right now, so two runs can't both POST the same one. */
const sending = new Set<string>()

/**
 * Tell Grok Bot a form is waiting on the security code it emailed: once per code prompt (by when
 * it was asked for), never again for the same one, even if the POST failed. Nothing personal and
 * never a code goes in the body. 'not_configured' when there's no webhook: the question waits.
 */
export const announceCode = async (
  a: Pick<schema.Application, 'id' | 'companyName' | 'role' | 'applyUrl' | 'jobUrl'>,
  o: { questionId: string; requestedAt: string; pageUrl?: string | null },
): Promise<'sent' | 'duplicate' | 'not_configured' | 'failed'> => {
  const hook = codeWebhook()
  if (!hook) return 'not_configured'
  const id = `${a.id}\n${o.requestedAt}`
  if (sending.has(id) || codeAnnounced(a.id, o.requestedAt)) return 'duplicate'
  sending.add(id)
  try {
    const s = stateOf(a.id)
    // Recorded before the POST: one request per prompt, not a retry after a failure.
    setMeta(stateKey(a.id), { ...s, announced: [...s.announced, o.requestedAt].slice(-20) } satisfies CodeHookState)
    const body = {
      sidedoor: 'security-code',
      appId: a.id,
      company: a.companyName,
      role: a.role,
      questionId: o.questionId,
      requestedAt: o.requestedAt,
      ats: atsOf(o.pageUrl, a.applyUrl, a.jobUrl),
      // The window waits at least this long for the code.
      waitUntil: new Date(Date.parse(o.requestedAt) + CODE_WAIT_MS).toISOString(),
    }
    try {
      const r = await fetch(hook.url, { method: 'POST', headers: { authorization: `Bearer ${hook.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`Grok Bot answered ${r.status}${r.status === 401 ? ' (check the key)' : r.status === 400 ? ' (is the routine paused?)' : ''}`)
      setMeta('grokBotCodeHook', { at: nowIso(), ok: true } satisfies CodeHookResult)
      return 'sent'
    } catch (e) {
      // The URL and key stay out of the message: a network error names only that it failed.
      const error = e instanceof Error && e.message.startsWith('Grok Bot answered') ? e.message : "Couldn't reach the security code webhook"
      setMeta('grokBotCodeHook', { at: nowIso(), ok: false, error } satisfies CodeHookResult)
      logActivity('system', `Couldn't tell Grok Bot about the security code: ${a.companyName}`, { detail: `${error}. The question waits in Sidedoor.`, link: '/settings?section=ai' })
      return 'failed'
    }
  } finally {
    sending.delete(id)
  }
}

/** Check the code webhook from Settings: the routine is told it's a test. */
export const testCodeWebhook = async () => {
  const hook = codeWebhook()
  if (!hook) throw new Error('Add the security code routine’s webhook URL and key first.')
  const r = await fetch(hook.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${hook.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sidedoor: 'test', note: 'Sidedoor is checking this webhook. There is no code to relay: reply that you got it and stop.' }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error("Couldn't reach the security code webhook")
  })
  if (!r.ok) throw new Error(`Grok Bot answered ${r.status}${r.status === 401 ? ' (check the key)' : ''}`)
}
