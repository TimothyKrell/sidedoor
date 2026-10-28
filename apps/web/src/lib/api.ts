import { queryOptions } from '@tanstack/react-query'
import { rpc } from './rpc'

export { rpc }

// Pages update from the live change stream (lib/live.ts); polling is only a slow safety net.
const live = { refetchInterval: 60_000, staleTime: 5_000 } as const

type PostingFilters = Parameters<typeof rpc.postings>[0]
type PeopleFilters = Parameters<typeof rpc.people>[0]

/** Query options shared by route loaders and components. Keys line up with lib/live.ts. */
export const qo = {
  today: () => queryOptions({ queryKey: ['today'], queryFn: () => rpc.today(), ...live }),
  postings: (f: PostingFilters) => queryOptions({ queryKey: ['postings', f], queryFn: () => rpc.postings(f), ...live }),
  posting: (id: string) => queryOptions({ queryKey: ['posting', id], queryFn: () => rpc.posting({ id }) }),
  applications: () => queryOptions({ queryKey: ['applications'], queryFn: () => rpc.applications(), ...live }),
  application: (id: string) => queryOptions({ queryKey: ['application', id], queryFn: () => rpc.application({ id }), ...live }),
  people: (f: PeopleFilters) => queryOptions({ queryKey: ['people', f], queryFn: () => rpc.people(f) }),
  person: (id: string) => queryOptions({ queryKey: ['person', id], queryFn: () => rpc.person({ id }), ...live }),
  radar: () => queryOptions({ queryKey: ['radar'], queryFn: () => rpc.radar() }),
  tasks: () => queryOptions({ queryKey: ['tasks'], queryFn: () => rpc.tasks(), refetchInterval: 5_000 }),
  task: (id: string) => queryOptions({ queryKey: ['tasks', id], queryFn: () => rpc.task({ id }), refetchInterval: 2_000 }),
  sources: () => queryOptions({ queryKey: ['sources'], queryFn: () => rpc.sources() }),
  threads: () => queryOptions({ queryKey: ['threads'], queryFn: () => rpc.threads() }),
  /** Under ['threads'] so chat writes invalidate it. */
  panelThreads: (page: string | null) => queryOptions({ queryKey: ['threads', 'panel', page], queryFn: () => rpc.panelThreads({ page }) }),
  thread: (id: string) => queryOptions({ queryKey: ['thread', id], queryFn: () => rpc.thread({ id }) }),
  status: () => queryOptions({ queryKey: ['status'], queryFn: () => rpc.status(), refetchInterval: 10_000 }),
  settings: () => queryOptions({ queryKey: ['settings'], queryFn: () => rpc.settings() }),
  tellRules: () => queryOptions({ queryKey: ['tellRules'], queryFn: () => rpc.tellRules(), staleTime: 60_000 }),
  stories: () => queryOptions({ queryKey: ['stories'], queryFn: () => rpc.stories() }),
  aiStatus: () => queryOptions({ queryKey: ['aiStatus'], queryFn: () => rpc.aiStatus(), staleTime: 30_000 }),
  docs: () => queryOptions({ queryKey: ['docs'], queryFn: () => rpc.docs() }),
  doc: (key: Parameters<typeof rpc.doc>[0]['key']) => queryOptions({ queryKey: ['doc', key], queryFn: () => rpc.doc({ key }) }),
  resumes: () => queryOptions({ queryKey: ['resumes'], queryFn: () => rpc.resumes() }),
  resume: (id: string) => queryOptions({ queryKey: ['resume', id], queryFn: () => rpc.resume({ id }) }),
  starterSources: () => queryOptions({ queryKey: ['sources', 'starter'], queryFn: () => rpc.starterSources() }),
  access: () => queryOptions({ queryKey: ['settings', 'access'], queryFn: () => rpc.access() }),
  connectInfo: () => queryOptions({ queryKey: ['aiStatus', 'connectInfo'], queryFn: () => rpc.connectInfo() }),
  grokBot: () => queryOptions({ queryKey: ['grokBot'], queryFn: () => rpc.grokBot() }),
}

// The page components were written against `fooFn({ data })` server functions; these keep that
// call shape over the RPC client.
const wrap =
  <I, O>(f: (i: I) => Promise<O>) =>
  (a: { data: I }) =>
    f(a.data)
const wrap0 =
  <O>(f: () => Promise<O>) =>
  () =>
    f()

export const searchFn = wrap(rpc.search)
export const trackPostingFn = wrap(rpc.trackPosting)
export const setPostingStatusFn = wrap(rpc.setPostingStatus)
export const setStageFn = wrap(rpc.setStage)
export const requestChangesFn = wrap(rpc.requestChanges)
export const updateApplicationFn = wrap(rpc.updateApplication)
export const createApplicationFn = wrap(rpc.createApplication)
export const startTaskFn = wrap(rpc.startTask)
export const retryTaskFn = wrap(rpc.retryTask)
export const cancelTaskFn = wrap(rpc.cancelTask)
export const savePersonFn = wrap(rpc.savePerson)
export const logInteractionFn = wrap(rpc.logInteraction)
export const scheduleFollowupFn = wrap(rpc.scheduleFollowup)
export const saveDraftFn = wrap(rpc.saveDraft)
export const draftSentFn = wrap(rpc.draftSent)
export const discardDraftFn = wrap(rpc.discardDraft)
export const editDraftFn = wrap(rpc.editDraft)
export const editPackageFn = wrap(rpc.editPackage)
export const startStoryInterviewFn = wrap(rpc.startStoryInterview)
export const findEmailFn = wrap(rpc.findEmail)
export const emailBouncedFn = wrap(rpc.emailBounced)
export const addSourceFn = wrap(rpc.addSource)
export const updateSourceFn = wrap(rpc.updateSource)
export const setCompanyInterestFn = wrap(rpc.setCompanyInterest)
export const watchCompanyFn = wrap(rpc.watchCompany)
export const runScoutNowFn = wrap0(rpc.runScoutNow)
export const saveSettingsFn = wrap(rpc.saveSettings)
export const testNotificationFn = wrap0(rpc.testNotification)
export const listTasksFn = wrap0(rpc.tasks)
export const listRadarFn = wrap0(rpc.radar)
export const getPersonFn = wrap(rpc.person)
export const getApplicationFn = wrap(rpc.application)

export type Today = Awaited<ReturnType<typeof rpc.today>>
export type ApplicationDetail = NonNullable<Awaited<ReturnType<typeof rpc.application>>>
