import { expect, test } from 'vitest'
import { toolsFor } from '../src/mcp/tools'
import { createResume, requireResume, setTheme } from '../src/services/resumes'

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await toolsFor('connected').find((t) => t.name === name)!.handler(args)
  return { error: r.isError ? r.content[0]!.text : null }
}

test('an agent changes a resume theme and type size the way the editor does, keeping options it leaves out', async () => {
  const r = createResume({ title: 'Tailored', theme: 'deco' })
  setTheme(r.id, 'deco', { accent: '#a8862a', showHighlights: false })

  expect(await call('set_resume_theme', { resumeId: r.id, theme: 'modern', scale: 1.1 })).toEqual({ error: null })
  expect(requireResume(r.id)).toMatchObject({ theme: 'modern', themeOptions: { accent: '#a8862a', showHighlights: false, scale: 1.1 } })

  expect(await call('set_resume_theme', { resumeId: r.id, scale: 1 })).toEqual({ error: null })
  expect(requireResume(r.id)).toMatchObject({ theme: 'modern', themeOptions: { scale: 1, accent: '#a8862a' } })
})
