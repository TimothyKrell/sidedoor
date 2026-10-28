import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point Sidedoor at a fresh, empty home before any app module loads.
process.env.SIDEDOOR_HOME = mkdtempSync(join(tmpdir(), 'sidedoor-test-'))
