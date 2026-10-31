import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { test } from 'node:test'

// Stage II has no HTTP receipt integration. Instrument only a sibling compiled copy:
// seed/update the actual coordinator's private policy, never a public tuning hook.
// This proves admission/math/history, not header parsing or correction receipt updates.
const plannerUrl = new URL('../../src/planner.js', import.meta.url)
const helpersUrl = new URL('./helpers.js', import.meta.url)
const source = readFileSync(plannerUrl, 'utf8')
const instrumented = new URL('../../src/planner.t46-probe.js', import.meta.url)
assert.ok(source.includes('    constructor('))
writeFileSync(
  instrumented,
  source.replace(
    '    constructor(',
    `    static t46Update(planner, patch, effective) {
      Object.assign(planner.#pacing, patch);
      if (effective !== undefined) planner.#capacity.setEffectiveParallelism(effective);
      planner.#wake();
    }
    constructor(`
  )
)

for (const scenario of [
  'history',
  'prepare-pause',
  'prepare-pacing',
  'prepare-effective',
  'effective-below-active',
  'delayed',
  'effective',
  'pause',
  'pacing',
  'guard',
  'stop',
  'abort',
  'deadline',
  'attempt',
  'stamp-stop',
  'stamp-abort',
  'stamp-deadline',
  'descriptor-stop'
]) {
  test(`Pacing actual coordinator ${scenario} rechecks admission without stale permits`, () => {
    const script = `
      import assert from 'node:assert/strict'
      import { test } from 'node:test'
      import { FetchPlanner } from ${JSON.stringify(instrumented.href)}
      import { createRuntime, deferred, trackTimeouts } from ${JSON.stringify(helpersUrl.href)}
      test('controlled actual admission', async t => {
        const clock = createRuntime(t)
        const timers = trackTimeouts(t)
        const scenario = ${JSON.stringify(scenario)}
        const prepare = deferred()
        const owner = deferred()
        const calls = []
        const handles = []
        const planner = new FetchPlanner(() => {
          const snapshot = planner.snapshot()
          assert.ok(snapshot.sentActive <= snapshot.effectiveParallelism, 'SENT_WITHIN_EFFECTIVE')
          calls.push(performance.now())
          return Promise.resolve(new Response())
        }, {maxParallelLimit:3, jitter:0, throttlingCoefficient:1,
            maxRequestDelayTimeMs:1000, deadlineMs:10000, attemptTimeoutMs:9000})
        const update = (patch, effective) => FetchPlanner.t46Update(planner, patch, effective)
        const start = performance.now()
        update({limit:10,remaining:5,retryTimeInterval:1000,lastDispatchAt:start})
        let disposed = 0
        const spec = {
          method:'GET', replay:{serverSafe:false,consumeSafe:false},
          prepare: async ctx => {
            ctx.onDispose(() => { disposed++ })
            await prepare.promise
            return {url:'', init: scenario === 'descriptor-stop' ? {
              get headers() { planner.stop(); return {} }
            } : {}}
          },
          consume: async () => { await owner.promise; return 42 }
        }
        try {
          for (let i=0;i<3;i++) handles.push(planner.submit(spec))
          await clock.flush()
          assert.equal(planner.snapshot().leasedAttempts,3)
          assert.equal(calls.length,0)
          if (scenario === 'effective-below-active') {
            update({remaining:10})
            prepare.resolve()
            await clock.flush()
            assert.equal(calls.length,3)
            update({},1)
            await clock.flush()
            assert.equal(planner.snapshot().sentActive,3,'REDUCTION_DOES_NOT_RELEASE_ACTIVE')
            assert.ok(handles.every(h => h.snapshot().outcome === 'pending'))
            const next = planner.submit({...spec,consume:() => 42})
            handles.push(next)
            await clock.flush()
            assert.equal(next.snapshot().phase,'queued')
            owner.resolve()
            await clock.flush()
            for (const h of handles) assert.equal((await h.result).value,42)
            assert.equal(calls.length,4)
          } else if (scenario.startsWith('prepare-')) {
            if (scenario === 'prepare-pause') update({serverNotBefore:start+800})
            if (scenario === 'prepare-pacing') update({remaining:0})
            if (scenario === 'prepare-effective') update({},1)
            prepare.resolve()
            await clock.flush()
            assert.equal(calls.length,0,'PREPARE_RETURN_RECHECKS_POLICY')
            const delay = scenario === 'prepare-pause' ? 800 : scenario === 'prepare-pacing' ? 1000 : 500
            await clock.advance(delay-1)
            assert.equal(calls.length,0)
            await clock.advance(1)
            assert.equal(calls.length,1,'PREPARE_POLICY_RESUMES_ACTUAL_TRANSPORT')
            owner.resolve()
            await clock.advance(1000)
            await clock.advance(1000)
            for (const h of handles) assert.equal((await h.result).value,42)
          } else if (scenario === 'descriptor-stop') {
            prepare.resolve()
            await clock.flush()
            assert.equal(calls.length,0, 'DESCRIPTOR_GETTER_CANNOT_BYPASS_STOP')
          } else {
            prepare.resolve()
            await clock.flush()
            assert.ok(handles.every(h => h.snapshot().phase === 'ready'))
            assert.equal(calls.length,0, 'READY_MUST_WAIT_FOR_PACING')
            assert.equal(planner.snapshot().sentActive,0)
            clock.jumpWall(-9000000000)
            await clock.advance(499)
            assert.equal(calls.length,0, 'NO_EARLY_TRANSPORT')
            if (scenario.startsWith('stamp-')) {
              let armed = true
              const now = Date.now.bind(Date)
              t.mock.method(Date,'now', () => {
                if (armed) {
                  armed=false
                  if (scenario === 'stamp-stop') planner.stop()
                  if (scenario === 'stamp-abort') handles.forEach(h => h.abort())
                  if (scenario === 'stamp-deadline') t.mock.method(performance,'now', () => start+10000)
                }
                return now()
              })
            }
            // Timer only wakes the pump. A managed microtask changes safety before
            // that pump runs, and after the previous eligibility wait was scheduled.
            clock.tick(scenario === 'delayed' ? 401 : 1)
            if (scenario === 'effective') update({},1)
            if (scenario === 'pause') update({serverNotBefore:start+800})
            if (scenario === 'pacing') update({remaining:0})
            if (scenario === 'guard') update({guardOpen:true})
            if (scenario === 'stop') planner.stop()
            if (scenario === 'abort') handles.forEach(h => h.abort())
            if (scenario === 'deadline') t.mock.method(performance,'now', () => start+10000)
            if (scenario === 'attempt') t.mock.method(performance,'now', () => start+9000)
            await clock.flush()
            const terminal = ['guard','stop','abort','deadline','attempt'].includes(scenario) || scenario.startsWith('stamp-')
            if (terminal) {
              assert.equal(calls.length,0,'FINAL_GATE_PREVENTS_TRANSPORT')
              const code = scenario === 'guard' ? 'GUARD_OPEN' : scenario.endsWith('stop') ? 'STOPPED' : scenario.endsWith('abort') ? 'ABORTED' : scenario === 'attempt' ? 'ATTEMPT_TIMEOUT' : 'DEADLINE'
              for (const h of handles) await assert.rejects(h.result,{code})
            } else {
              if (scenario === 'pause' || scenario === 'pacing') {
                assert.equal(calls.length,0,'CHANGED_POLICY_INVALIDATES_WAKE')
                await clock.advance(scenario === 'pause' ? 299 : 499)
                assert.equal(calls.length,0,'CHANGED_POLICY_STILL_WAITS')
                await clock.advance(1)
              }
              assert.equal(calls.length,1,'ONE_ADMISSION_PER_PACING_ELIGIBILITY')
              const first = performance.now()
              assert.equal(calls[0], first)
              if (scenario === 'effective') {
                await clock.advance(1000)
                assert.equal(calls.length,1,'REDUCED_EFFECTIVE_HOLDS_NEW_READY')
                assert.equal(planner.snapshot().sentActive,1)
                owner.resolve()
                await clock.flush()
                // Recovery has elapsed during the known-work wait, so zero pacing is valid.
                await clock.advance(1000)
              } else {
                const delay = scenario === 'pacing' ? 1000 : 500
                await clock.advance(delay-1)
                assert.equal(calls.length,1,'HISTORY_PREVENTS_READY_BURST')
                await clock.advance(1)
                assert.equal(calls.length,2)
                assert.equal(calls[1]-calls[0],delay)
                await clock.advance(delay)
                assert.equal(calls.length,3)
              }
              owner.resolve()
              await clock.advance(1000)
              for (const h of handles) assert.equal((await h.result).value,42)
            }
          }
        } finally {
          prepare.resolve(); owner.resolve()
          handles.forEach(h => h.abort())
          await Promise.allSettled(handles.flatMap(h => [h.result,h.resourcesDone]))
          await clock.flush()
          assert.equal(disposed,scenario === 'effective-below-active' ? 4 : 3)
          assert.equal(planner.snapshot().leasedAttempts,0)
          assert.equal(planner.snapshot().sentActive,0)
          assert.equal(timers.active.size,0,'NO_TIMER_AFTER_CLEANUP')
          assert.ok(timers.maximum()<=1,'ONE_COORDINATOR_TIMER')
        }
      })
    `
    const child = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', '--input-type=module', '--eval', script],
      { encoding: 'utf8', timeout: 5000 }
    )
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout, /pass 1/)
  })
}

test.after(() => {
  unlinkSync(instrumented)
})
