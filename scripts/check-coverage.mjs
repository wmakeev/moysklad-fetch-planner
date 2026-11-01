/// <reference types="node" />

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const report = await readFile(process.argv[2] ?? 'coverage/lcov.info', 'utf8')
assert.ok(report.trim().endsWith('end_of_record'), 'LCOV must end with a complete record')
const records = report
  .split('end_of_record')
  .filter(record => record.trim())
  .map(record => {
    const lines = record.trim().split(/\r?\n/)
    const source = lines.find(line => line.startsWith('SF:'))?.slice(3)
    assert.ok(source, 'LCOV record is missing its source file')
    assert.equal(
      lines.filter(line => line.startsWith('SF:')).length,
      1,
      'LCOV record must have one source file'
    )
    const file = path.relative(process.cwd(), path.resolve(source))
    assert.ok(
      file.startsWith(`src${path.sep}`) && file.endsWith('.ts'),
      `LCOV must contain only original src files, found: ${source}`
    )
    for (const line of lines) {
      if (line.startsWith('DA:'))
        assert.match(line, /^DA:[1-9]\d*,\d+(?:,[^,]+)?$/, `Malformed LCOV line: ${line}`)
      if (line.startsWith('FNDA:'))
        assert.match(line, /^FNDA:\d+,.+$/, `Malformed LCOV function: ${line}`)
    }
    assert.ok(
      lines.some(line => line.startsWith('DA:')),
      `LCOV ${file} record must contain line coverage data`
    )
    return { file, lines }
  })

// Every executable source module is mandatory; fetch-types.ts contains only types.
const executableModules = [
  'callback-context',
  'guard',
  'index',
  'operation-capacity',
  'operation-hooks',
  'operation-observation',
  'operation-resources',
  'operation-state',
  'operation-types',
  'pacing',
  'planner',
  'response-classifier',
  'response-policy',
  'retry-policy',
  'runtime'
]
for (const record of records) {
  assert.ok(
    executableModules.some(name => record.file === path.join('src', `${name}.ts`)),
    `Unexpected LCOV source module: ${record.file}`
  )
}
for (const name of executableModules) {
  const file = path.join('src', `${name}.ts`)
  const moduleRecords = records.filter(item => item.file === file)
  assert.ok(
    moduleRecords.length > 0,
    `LCOV must contain ${file}; an incomplete or empty report is invalid`
  )
  const lines = moduleRecords.flatMap(record => record.lines)
  assert.ok(
    lines.some(line => /^DA:\d+,[1-9]\d*(?:,.*)?$/.test(line)),
    `LCOV ${file} must have executed lines`
  )
  // index is currently export-only. If it gains functions, execution is mandatory too.
  if (name !== 'index' || lines.some(line => line.startsWith('FN:') || line.startsWith('FNDA:')))
    assert.ok(
      lines.some(line => /^FNDA:[1-9]\d*,.+$/.test(line)),
      `LCOV ${file} must have executed functions`
    )
}
// Executed root re-export lines above prove a public import; submit lives in planner.
const planner = records.filter(record => record.file === path.join('src', 'planner.ts'))
assert.ok(
  planner.some(record => record.lines.some(line => /^FNDA:[1-9]\d*,submit$/.test(line))),
  'LCOV src/planner.ts must include executed public submit'
)

console.log(
  `LCOV verified: original src modules (${executableModules.join(', ')}), executed lines/functions/public submit, no test/samples`
)
