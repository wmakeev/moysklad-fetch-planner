import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const report = await readFile(process.argv[2] ?? 'coverage/lcov.info', 'utf8')
const records = report
  .split('end_of_record')
  .filter(record => record.trim())
  .map(record => {
    const lines = record.trim().split(/\r?\n/)
    const source = lines.find(line => line.startsWith('SF:'))?.slice(3)
    assert.ok(source, 'LCOV record is missing its source file')
    const file = path.relative(process.cwd(), path.resolve(source))
    assert.ok(
      file.startsWith(`src${path.sep}`) && file.endsWith('.ts'),
      `LCOV must contain only original src files, found: ${source}`
    )
    return { file, lines }
  })

const index = records.find(
  record => record.file === path.join('src', 'index.ts')
)
assert.ok(index, 'LCOV must contain src/index.ts; an empty report is invalid')
assert.ok(
  index.lines.some(line => /^DA:\d+,[1-9]\d*(?:,.*)?$/.test(line)),
  'LCOV src/index.ts must have executed lines'
)
assert.ok(
  index.lines.some(line => /^FNDA:[1-9]\d*,.+$/.test(line)),
  'LCOV src/index.ts must have executed functions'
)
assert.ok(
  index.lines.some(line => /^FNDA:[1-9]\d*,wrapFetch$/.test(line)),
  'LCOV src/index.ts must include executed wrapFetch'
)

console.log(
  'LCOV verified: original src/index.ts, executed lines/functions/wrapFetch, no test/samples'
)
