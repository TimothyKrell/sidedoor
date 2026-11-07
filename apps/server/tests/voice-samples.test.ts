import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { voiceSamples } from '../src/writing/tells'

const doc = (section: string) => `# How I write\n\n## Voice\n- Warm and plain.\n\n${section}\n## Editing\n- Change little.\n`

test("only the user's own lines come through, without the section's explanation or what follows it", () => {
  const out = voiceSamples(doc('## How I actually sound\nPaste a few things.\n\n- "Sorry, no idea what to put here."\n- "It just works."\n'))
  expect(out).toBe('- "Sorry, no idea what to put here."\n- "It just works."')
})

test('the untouched template and a document without the section both say there are none yet', () => {
  const template = readFileSync(resolve(__dirname, '../defaults/writing.md'), 'utf8')
  expect(voiceSamples(template)).toContain('none saved yet')
  expect(voiceSamples(doc(''))).toContain('none saved yet')
})
