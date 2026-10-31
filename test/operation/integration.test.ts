import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FetchPlanner as Root } from '../../src/index.js'
import { FetchPlanner as Deep } from '../../src/planner.js'
import { OperationError } from '../../src/operation-types.js'
import type { Event, Handle, Init, PlannerSnapshot, Spec } from '../../src/operation-types.js'
import { createRuntime, deferred, trackTimeouts } from './helpers.js'

// Only emitted siblings are instrumented. All scheduling/ownership code is actual source.
const folder = mkdtempSync(fileURLToPath(new URL('../../src/t52-', import.meta.url)))
const planner = readFileSync(new URL('../../src/planner.js', import.meta.url), 'utf8')
function replaceOnce(source: string, before: string, after: string): string {
  assert.equal(source.split(before).length, 2, `Unique instrumentation anchor: ${before}`)
  return source.replace(before, after)
}
let instrumented = replaceOnce(
  planner,
  '    commands = [];',
  '    t52States = [];\n    t52Specs = new Map();\n    commands = [];'
)
instrumented = replaceOnce(
  instrumented,
  '        Object.assign(entry, materialized);',
  '        Object.assign(entry, materialized);\n        this.t52States.push(state); this.t52Specs.set(entry, spec);'
)
instrumented = replaceOnce(
  instrumented,
  '                started = true;',
  '                this.t52Specs.delete(entry);\n                started = true;'
)
instrumented = instrumented.replaceAll(
  'this.#active.delete(entry);',
  'this.t52Specs.delete(entry); this.#active.delete(entry);'
)
instrumented = replaceOnce(
  instrumented,
  '    snapshot() {',
  `    t52() { return { active: this.#active.size, specs: this.t52Specs.size, commands: this.commands.length, ready: this.#ready.size, timer: this.#timer !== undefined, pump: this.#pumpScheduled, subscribers: this.observation.listeners.size, operationSubscribers: this.t52States.reduce((n,s)=>n+s.observation.listeners.size,0), deliveries: this.observation.pendingDeliveries?.length ?? 0, diagnostics: this.observation.diagnostics.snapshot() }; }
    snapshot() {`
)
// Dependencies resolve to the unchanged emitted modules one directory above.
instrumented = instrumented.replaceAll("from './", "from '../")
writeFileSync(`${folder}/planner.js`, instrumented)
const index = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8')
writeFileSync(
  `${folder}/index.js`,
  index.replaceAll("from './", "from '../").replace("from '../planner.js'", "from './planner.js'")
)
process.on('exit', () => {
  rmSync(folder, { recursive: true, force: true })
})

test('Integration root and deep exports use the sole coordinator', () => {
  assert.equal(Root, Deep)
})

for (const { entry, Planner } of [
  { entry: 'root', Planner: Root },
  { entry: 'deep', Planner: Deep }
]) {
  for (const committed of [false, true]) {
    test(`Integration actual ${entry} combined ${committed ? 'commit delivery' : 'late discard'}`, async t => {
      const clock = createRuntime(t)
      const timers = trackTimeouts(t)
      const consume = deferred<undefined>()
      const entered = deferred<undefined>()
      const cleanup = deferred<undefined>()
      const disposing = deferred<undefined>()
      const handles: Handle<string>[] = []
      const a: Event[] = []
      const b: Event[] = []
      const snapshots: PlannerSnapshot[] = []
      const value = { temporary: true }
      const reason = { aborted: true }
      let sends = 0
      let prepares = 0
      let discards = 0
      let disposals = 0
      let deliveries = 0
      let burst = false
      const planner = new Planner<typeof fetch>(
        () => {
          sends++
          return Promise.resolve(new Response())
        },
        { maxParallelLimit: 1, maxQueuedOperations: 2 }
      )
      const spec = (): Spec<Init<typeof fetch>, Response, string> & { method: 'GET' } => ({
        method: 'GET',
        replay: { serverSafe: false, consumeSafe: false },
        prepare: () => {
          prepares++
          return { url: '', init: {} }
        },
        consume: () => 'nested'
      })
      const first = planner.observe(event => {
        a.push(event)
        if (event.phase === 'consuming' && !burst) {
          burst = true
          for (let i = 0; i < 100; i++) handles.push(planner.submit(spec()))
          snapshots.push(planner.snapshot())
          planner.stop('first-stop')
        }
      })
      const second = planner.observe(event => {
        b.push(event)
      })
      const handle = planner.submit({
        ...spec(),
        method: 'POST',
        consume: async (_response, ctx) => {
          ctx.onDiscard(() => {
            discards++
          })
          ctx.onDispose(async () => {
            disposals++
            disposing.resolve(undefined)
            await cleanup.promise
          })
          entered.resolve(undefined)
          await consume.promise
          return value
        }
      })
      const result = handle.result.then(
        completed => {
          deliveries++
          return completed
        },
        (error: unknown) => error
      )
      try {
        await entered.promise
        assert.equal(handles.filter(h => h.id !== 0).length, 2)
        assert.equal(handles.filter(h => h.snapshot().failureCode === 'QUEUE_FULL').length, 98)
        assert.equal(snapshots[0]?.queued, 2)
        if (committed) {
          consume.resolve(undefined)
          await disposing.promise
          assert.equal(handle.snapshot().resultCommitted, true)
        }
        handle.abort(reason)
        if (committed) assert.equal((await handle.result).value, value)
        else {
          await assert.rejects(
            handle.result,
            error =>
              error instanceof OperationError && error.code === 'ABORTED' && error.cause === reason
          )
          assert.equal(disposals, 0)
          consume.resolve(undefined)
          await disposing.promise
        }
        assert.equal(planner.snapshot().leasedAttempts, 1)
        assert.equal(planner.snapshot().sentActive, 1)
        assert.equal(handle.snapshot().resources, 'pending')
        assert.equal(prepares, 1)
        assert.equal(sends, 1)
        cleanup.resolve(undefined)
        await handle.resourcesDone
        await result
        await Promise.allSettled(handles.flatMap(h => [h.result, h.resourcesDone]))
        await clock.flush()
        assert.equal(disposals, 1)
        assert.equal(deliveries, committed ? 1 : 0)
        assert.equal(discards, committed ? 0 : 1)
        assert.equal(deliveries + discards, 1)
        assert.deepEqual(a, b)
        assert.equal(a.filter(e => e.id === handle.id && e.type === 'operation-settled').length, 1)
        assert.deepEqual(
          [
            planner.snapshot().queued,
            planner.snapshot().leasedAttempts,
            planner.snapshot().sentActive,
            timers.active.size
          ],
          [0, 0, 0, 0]
        )
      } finally {
        consume.resolve(undefined)
        cleanup.resolve(undefined)
        planner.stop()
        handle.abort()
        first.unsubscribe()
        second.unsubscribe()
        await Promise.allSettled([
          handle.result,
          handle.resourcesDone,
          ...handles.flatMap(h => [h.result, h.resourcesDone])
        ])
      }
    })
  }
}

for (const entry of ['index', 'planner']) {
  for (const interrupt of ['abort', 'attempt', 'deadline']) {
    const phases =
      interrupt === 'abort' ? ['before', 'committed'] : ['before', 'committed', 'final-clock']
    for (const phase of phases) {
      const committed = phase === 'committed'
      const finalClock = phase === 'final-clock'
      test(`Integration ${entry} ${interrupt} ${phase} consume burst stop and pending disposer`, () => {
        const source = `
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {FetchPlanner} from ${JSON.stringify(`file://${folder}/${entry}.js`)};
import {FetchPlanner as Deep} from ${JSON.stringify(`file://${folder}/planner.js`)};
assert.equal(FetchPlanner,Deep);
const interrupt=${JSON.stringify(interrupt)}, committed=${committed},finalClock=${finalClock};
// Only semantic phase time is controlled. Coordinator timer handles remain real.
const actualNow=performance.now.bind(performance),nowDescriptor=Object.getOwnPropertyDescriptor(performance,'now');
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
let controlledNow=1000000,resumedAt;
const clockTrace=[];
const mark=phase=>clockTrace.push({phase,controlledMono:Math.floor(performance.now()),realMono:actualNow(),epoch:Date.now()});
const resume=()=>{assert.equal(resumedAt,undefined);resumedAt=actualNow();mark('real-time-resumed')};
try {
Object.defineProperty(performance,'now',{configurable:true,value:()=>controlledNow+(resumedAt===undefined?0:actualNow()-resumedAt)});
mark('frozen-before-submit');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const entered=deferred(),consume=deferred(),disposing=deferred(),cleanup=deferred(),budget=deferred();
const timers=new Set(); let maximumTimers=0,timerFires=0;
globalThis.setTimeout=(fn,ms,...args)=>{const timer=originalSet(()=>{timers.delete(timer);timerFires++;fn(...args)},ms);timers.add(timer);maximumTimers=Math.max(maximumTimers,timers.size);return timer};
globalThis.clearTimeout=timer=>{timers.delete(timer);originalClear(timer)};
let sends=0,prepares=0,discards=0,disposed=0,deliveries=0,rejections=0,resourcesSettled=false,burst=false;
const value={canary:'PRIVATE_VALUE'},reason={canary:'PRIVATE_ABORT'},stopReason={canary:'PRIVATE_STOP'};
const a=[],b=[],trace=[],measurements=[],handles=[],guarded=[];let burstMeasurement,bStopped;
const p=new FetchPlanner(()=>{sends++;return Promise.resolve(new Response('ok'))},{maxParallelLimit:1,maxQueuedOperations:2,attemptTimeoutMs:interrupt==='attempt'?80:2000,deadlineMs:interrupt==='deadline'?80:3000,cleanupGraceMs:200});
const spec=()=>({method:'GET',replay:{serverSafe:false,consumeSafe:false},prepare:()=>{prepares++;return {url:'',init:{}}},consume:r=>r.text()});
const measure=label=>{mark(label);measurements.push({label,...p.t52(),...p.snapshot()})};
const attachA=p.observe(e=>{a.push(e);trace.push('A:'+e.sequence);measure('A');
 if(e.type==='phase-changed'&&e.phase==='consuming'&&!burst){burst=true;for(let i=0;i<100;i++)handles.push(p.submit(spec()));burstMeasurement={...p.t52(),...p.snapshot(),snapshots:handles.map(h=>h.snapshot())};for(let i=0;i<100;i++)p.stop(stopReason);measure('burst-stop')}
 if(e.type==='operation-settled'&&e.failureCode===(interrupt==='attempt'?'ATTEMPT_TIMEOUT':'DEADLINE'))budget.resolve();
});
const attachB=p.observe(e=>{b.push(e);trace.push('B:'+e.sequence);if(e.phase==='consuming')bStopped=p.snapshot().stopped;measure('B')});
const root=p.submit({...spec(),method:'POST',consume:async(_r,ctx)=>{
 ctx.onDiscard(()=>{discards++});ctx.onDispose(async()=>{disposed++;mark('disposer-enter');disposing.resolve();await cleanup.promise;guarded.push(p.submit(spec()))});
 mark('consume-enter');entered.resolve();await consume.promise;mark('consume-return');guarded.push(p.submit(spec()));return value;
}});
root.observe(()=>undefined);
const delivered=root.result.then(r=>{deliveries++;return r},e=>{rejections++;return e});
void root.resourcesDone.then(()=>{resourcesSettled=true});
try {
 await entered.promise;measure('entered');
 assert.equal(burst,true);assert.equal(bStopped,false,'STOP_AFTER_CURRENT_FANOUT');assert.equal(burstMeasurement.specs,2,'PRE_DRAIN_RETAINED_SPECS');
 assert.equal(burstMeasurement.queued,2);assert.equal(burstMeasurement.commands,2);assert.equal(burstMeasurement.active,3);
 assert.equal(burstMeasurement.snapshots.filter(s=>s.id===0&&s.failureCode==='QUEUE_FULL').length,98);
 assert.equal(burstMeasurement.snapshots.filter(s=>s.id!==0&&s.sequence===0).length,2);
 assert.equal(sends,1);assert.equal(prepares,1);assert.equal(p.snapshot().stopped,true);
 assert.equal(root.snapshot().phase,'consuming');assert.equal(root.snapshot().resultCommitted,false);
 assert.equal(performance.now(),1000000,'FROZEN_BEFORE_CUTOFF');
 if(committed){
  mark('consume-release-before-cutoff');consume.resolve();await disposing.promise;
  assert.equal(root.snapshot().resultCommitted,true,'ACTUAL_COMMIT_BEFORE_CUTOFF');
  assert.equal(root.snapshot().phase,'cleanup');assert.equal(performance.now(),1000000);
  measure('committed');resume();
 } else if(finalClock){
  // No await/macrotask between exact cutoff and owner return: expire(now) must win.
  const fires=timerFires;controlledNow+=80;mark('exact-cutoff-before-release');consume.resolve();await disposing.promise;
  assert.equal(timerFires,fires,'FINAL_CLOCK_WITHOUT_TIMER_DELIVERY');
  assert.equal(root.snapshot().resultCommitted,false,'FINAL_CLOCK_REFUSES_COMMIT');
  resume();
 } else {resume()}
 if(interrupt==='abort'){for(let i=0;i<100;i++)root.abort(reason)}
 else if(committed){await delivered} else await budget.promise;
 const result=await delivered;measure('logical-terminal');
 if(interrupt!=='abort'&&!finalClock){assert.ok(timerFires>0,'REAL_COORDINATOR_TIMER_FIRED');assert.ok(performance.now()>=1000000+(committed&&interrupt==='attempt'?200:80),'REAL_TIME_REACHED_CUTOFF')}
 if(committed){assert.equal(result.value,value,'VALUE_IDENTITY');assert.equal(result.cleanup,'pending');assert.equal(deliveries,1)}
 else {assert.equal(result.code,interrupt==='abort'?'ABORTED':interrupt==='attempt'?'ATTEMPT_TIMEOUT':'DEADLINE');assert.equal(result.phase,'consuming');assert.equal(result.status,200);assert.equal(root.snapshot().resultCommitted,false);if(interrupt==='abort')assert.equal(result.cause,reason);assert.equal(rejections,1);
  if(!finalClock){assert.equal(disposed,0,'NO_CLEANUP_WHILE_CONSUME_ACTIVE');assert.equal(guarded.length,0);assert.equal(resourcesSettled,false);assert.equal(p.snapshot().leasedAttempts,1);assert.equal(p.snapshot().sentActive,1);mark('consume-release-after-settlement');consume.resolve();await disposing.promise}
 }
 await setImmediate();measure('pending-disposer');
 assert.equal(resourcesSettled,false);assert.equal(p.snapshot().leasedAttempts,1);assert.equal(p.snapshot().sentActive,1);assert.equal(disposed,1);assert.equal(prepares,1);assert.equal(sends,1);assert.equal(root.snapshot().resources,'pending');
 assert.equal(guarded.length,1);assert.equal(guarded[0].snapshot().failureCode,'REENTRANT_OPERATION','LATE_CONSUME_GUARD');
 for(const h of handles.filter(h=>h.id!==0)){const error=await h.result.catch(e=>e);assert.equal(error.code,'STOPPED');assert.equal(error.cause,stopReason)}
 cleanup.resolve();assert.deepEqual(await root.resourcesDone,{resources:'released'});await setImmediate();measure('released');
 assert.equal(guarded.length,2);assert.equal(guarded[1].snapshot().failureCode,'REENTRANT_OPERATION','PENDING_DISPOSER_GUARD');
 await Promise.allSettled(handles.concat(guarded).flatMap(h=>[h.result,h.resourcesDone]));
 assert.equal(deliveries,committed?1:0);assert.equal(rejections,committed?0:1);assert.equal(discards,committed?0:1);assert.equal(deliveries+discards,1,'VALUE_MUST_NOT_BE_LOST_0_0');
 assert.equal(a.filter(e=>e.id===root.id&&e.type==='operation-settled').length,1);assert.equal(a.filter(e=>e.id===root.id&&e.type==='resources-settled').length,1);
 assert.deepEqual(a,b,'FULL_FANOUT_FIFO');for(let i=0;i<trace.length;i+=2)assert.equal(trace[i].slice(2),trace[i+1].slice(2));
 assert.ok(a.every((e,i)=>e.id!==0&&(!i||e.sequence>a[i-1].sequence)));assert.equal(a.filter(e=>e.type==='created').length,3);
 for(const m of measurements){assert.ok(m.active<=m.queued+m.leasedAttempts,'ACTIVE_BOUND');assert.ok(m.queued<=2);assert.ok(m.sentActive<=m.leasedAttempts&&m.leasedAttempts<=1,'SENT_LEASE_BOUND')}
 assert.ok(!JSON.stringify(a).includes('PRIVATE_'),'OBSERVATION_PRIVACY');
 attachA.unsubscribe();attachB.unsubscribe();await setImmediate();
 const final=p.t52();assert.deepEqual([final.active,final.specs,final.commands,final.ready,final.subscribers,final.operationSubscribers,final.deliveries],[0,0,0,0,0,0,0],'FINAL_REGISTRIES_ZERO');
 assert.equal(final.timer,false);assert.equal(final.pump,false);assert.equal(timers.size,0);assert.equal(maximumTimers,1);
 assert.deepEqual([p.snapshot().queued,p.snapshot().leasedAttempts,p.snapshot().sentActive],[0,0,0]);
 assert.deepEqual([final.diagnostics.OBSERVER_FAILED,final.diagnostics.INVALID_HINT,final.diagnostics.LATE_COMPLETION],[0,0,0]);
 console.log(JSON.stringify({entry:${JSON.stringify(entry)},interrupt,committed,finalClock,clockTrace,timerFires,maximumTimers,sends,deliveries,discards,disposed,events:a.length,measurements,final,timers:timers.size}));
} finally {
 consume.resolve();cleanup.resolve();p.stop();root.abort();attachA.unsubscribe();attachB.unsubscribe();
 await Promise.allSettled([root.result,root.resourcesDone,...handles.concat(guarded).flatMap(h=>[h.result,h.resourcesDone])]);
}
} finally {
 globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
 if(nowDescriptor)Object.defineProperty(performance,'now',nowDescriptor);else delete performance.now;
 assert.deepEqual(Object.getOwnPropertyDescriptor(performance,'now'),nowDescriptor,'CLOCK_DESCRIPTOR_RESTORED');
}
`
        const child = spawnSync(
          process.execPath,
          ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
          { encoding: 'utf8', timeout: 10000 }
        )
        assert.ifError(child.error)
        assert.equal(child.signal, null)
        assert.equal(child.status, 0, child.stdout + child.stderr)
        console.log(child.stdout.trim())
      })
    }
  }
}
