// How long opening a form window may take, step by step. The desktop app enforces the steps
// (apps/desktop/src/form-open.ts); the server waits FORM_OPEN_SERVER_MS for its answer, which must
// leave clear room over all of them so the desktop always answers first, with the step that hung.

export const FORM_OPEN_STEPS = {
  /** The page's load event. A page that never finishes loading can still be filled; Page.enable decides. */
  loadMs: 35_000,
  /** CDP's Page domain answering: the window is usable. */
  pageEnableMs: 10_000,
  /** Registering the submit guard for every later document. */
  guardMs: 5_000,
  /** The guard in one frame of the page that's open now. */
  frameMs: 3_000,
  /** All of those frames together. */
  framesMs: 10_000,
} as const

/** The longest the desktop can take to answer an open, whatever hangs. */
export const FORM_OPEN_DESKTOP_MAX_MS = FORM_OPEN_STEPS.loadMs + FORM_OPEN_STEPS.pageEnableMs + FORM_OPEN_STEPS.guardMs + FORM_OPEN_STEPS.framesMs

/** How long the server waits for the desktop to open a form window. */
export const FORM_OPEN_SERVER_MS = 90_000
