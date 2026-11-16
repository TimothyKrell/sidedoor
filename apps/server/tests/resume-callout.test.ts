import { expect, test } from 'vitest'
import { resumeAsText } from '@sidedoor/shared/resume'
import { renderResume } from '@sidedoor/shared/resume-themes'
import { toolsFor } from '../src/mcp/tools'
import { createResume, requireResume } from '../src/services/resumes'

const call = async (args: Record<string, unknown>) => {
  const r = await toolsFor('connected').find((t) => t.name === 'set_resume_callout')!.handler(args)
  expect(r.isError).toBeFalsy()
}

test('a corner note goes on the page with a ticked box per item, and stays out of the resume text', async () => {
  const r = createResume({ title: 'Tailored', theme: 'deco' })
  await call({ resumeId: r.id, title: 'Hi, Sam', items: ['One page', '  ', '<strong>No skills section!</strong>', '<img src=x onerror=alert(1)>'] })

  const c = requireResume(r.id).content
  expect(c.callout).toEqual({ title: 'Hi, Sam', items: ['One page', '<strong>No skills section!</strong>', '<img src=x onerror=alert(1)>'] })
  const html = renderResume(c, 'deco')
  expect(html).toContain('class="has-callout"')
  expect(html).toContain('<div class="callout-title">Hi, Sam</div>')
  expect(html).toContain('<li><strong>No skills section!</strong></li>')
  expect(html).not.toContain('<img')
  // The match check reads this text; a note to the reader isn't evidence.
  expect(resumeAsText(c)).not.toContain('No skills section')
})

test('clear takes the note off, and a resume without one renders as before', async () => {
  const r = createResume({ title: 'Tailored', theme: 'modern' })
  await call({ resumeId: r.id, title: 'Hi', items: ['One page'] })
  await call({ resumeId: r.id, clear: true })
  const c = requireResume(r.id).content
  expect(c.callout).toBeUndefined()
  expect(renderResume(c, 'modern')).not.toContain('class="has-callout"')
})
