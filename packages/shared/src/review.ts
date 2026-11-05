// Where an application stands on the way out the door: the same steps for the Review page, Today,
// and agents. Nothing here blocks anything; it says what's left, so you can go down the list.

import { extractProseSections } from './package-sections'

/** The AI stops working a resume up once the match reaches this. */
export const TUNE_TARGET = 95

export const TUNE_STOPS = ['target', 'no_gain', 'no_more_facts', 'limit'] as const
export type TuneStop = (typeof TUNE_STOPS)[number]

/** One pass of the AI working the resume up against the posting. */
export interface ResumeTune {
  at: string
  /** The match when it started, and when it finished. */
  from: number
  to: number
  /** Edit-and-recheck rounds. 0: it was already at the target. */
  rounds: number
  stopped: TuneStop
  /** What it changed and why it stopped, to you, in a few lines. */
  summary: string
  /** It finished lower than it started, so the resume went back to how it was. */
  reverted?: boolean
}

export const TUNE_STOP_LABEL: Record<TuneStop, string> = {
  target: 'Reached the target',
  no_gain: 'More edits stopped helping',
  no_more_facts: 'Used every fact it has',
  limit: 'Hit the round limit',
}

/** Changes whenever the text does, so a check-off doesn't outlive what you checked. */
export const textMark = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0
  return `${t.length}:${h.toString(36)}`
}

export interface WritingItem {
  key: string
  title: string
  text: string
  /** Nothing written yet, or only a placeholder for you to replace. */
  blank: boolean
  done: boolean
}

const PLACEHOLDER = /^(_|\*)*(\[.*\]|\(.*\)|tbd|todo|your (answer|words)[^.]*|you write[^.]*|write (this|it)[^.]*)\.?(_|\*)*$/i

/** Everything in the package that's prose for you to read or write yourself, and what you've checked off. */
export const writingItems = (md: string | null | undefined, checks: Record<string, string> | null | undefined): WritingItem[] =>
  extractProseSections(md, { all: true }).map((s) => ({
    key: s.key,
    title: s.title,
    text: s.text,
    blank: !s.text || PLACEHOLDER.test(s.text),
    done: !!s.text && checks?.[s.key] === textMark(s.text),
  }))

export const REVIEW_BUCKETS = ['ai', 'tune', 'answers', 'writing', 'ready', 'sending', 'stuck'] as const
export type ReviewBucket = (typeof REVIEW_BUCKETS)[number]

export const BUCKET_META: Record<ReviewBucket, { label: string; hint: string }> = {
  ai: { label: 'AI working', hint: 'Your AI is on it. Nothing for you yet.' },
  tune: { label: 'Not tuned yet', hint: 'Your AI hasn’t pushed the resume as far as it can.' },
  answers: { label: 'Questions', hint: 'Answer these so the AI can go further.' },
  writing: { label: 'Writing', hint: 'Essays and letters to write or check off.' },
  ready: { label: 'Ready to send', hint: 'Everything’s done. Approve and submit.' },
  sending: { label: 'Sending', hint: 'Sidedoor is filling and submitting the form.' },
  stuck: { label: 'Stuck', hint: 'Submitting stopped and needs you.' },
}

export interface ReviewFacts {
  stage: string
  /** Prep, a match check or tuning is queued or running. */
  aiWorking: boolean
  tuned: boolean
  openQuestions: number
  openDecisions: number
  writingLeft: number
  /** Sidedoor is filling or submitting the real form. */
  sending: boolean
  /** A real submit stopped short (not a dry run): a captcha, a failure. */
  stuck: boolean
}

/** The one thing this application is waiting on, earliest step first. */
export const reviewBucket = (f: ReviewFacts): ReviewBucket => {
  if (f.sending) return 'sending'
  if (f.aiWorking) return 'ai'
  if (f.openQuestions || f.openDecisions) return f.tuned ? 'answers' : 'tune'
  if (!f.tuned) return 'tune'
  if (f.writingLeft) return 'writing'
  return f.stuck ? 'stuck' : 'ready'
}

/** What's still open, in words, for the confirmation before an application goes out. */
export const stillOpen = (f: Pick<ReviewFacts, 'tuned' | 'openQuestions' | 'openDecisions' | 'writingLeft'>) => {
  const n = (c: number, one: string) => `${c} ${one}${c === 1 ? '' : 's'}`
  return [!f.tuned && 'the resume isn’t tuned', f.openQuestions > 0 && n(f.openQuestions, 'open question'), f.openDecisions > 0 && n(f.openDecisions, 'open decision'), f.writingLeft > 0 && `${n(f.writingLeft, 'written answer')} not checked off`].filter((x): x is string => !!x)
}
