import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { test } from 'node:test'

// Instrument only an emitted sibling of the real coordinator. No production hook/export.
const plannerFile = new URL('../../src/planner.js', import.meta.url)
const instrumentedFile = new URL('../../src/planner-t48-test.js', import.meta.url)
const source = readFileSync(plannerFile, 'utf8')
const instrumented = source
  .replace('    commands = [];', '    t48Specs = new Map();\n    commands = [];')
  .replace(
    '        Object.assign(entry, materialized);',
    '        Object.assign(entry, materialized);\n        this.t48Specs.set(entry, spec);'
  )
  .replace(
    '                started = true;',
    '                this.t48Specs.delete(entry);\n                started = true;'
  )
  .replaceAll(
    'this.#active.delete(entry);',
    'this.t48Specs.delete(entry); this.#active.delete(entry);'
  )
  .replace(
    '    snapshot() {',
    `    t48() { return { specs: this.t48Specs.size, active: this.#active.size, commands: this.commands.length, reservations: this.#capacity.snapshot().queued, diagnostics: this.observation.diagnostics.snapshot() }; }\n    snapshot() {`
  )
assert.notEqual(instrumented, source)
writeFileSync(instrumentedFile, instrumented)

const common = `
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {FetchPlanner} from ${JSON.stringify(instrumentedFile.href)};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const spec=()=>({method:'GET',replay:{serverSafe:false,consumeSafe:false},prepare:()=>({url:'',init:{}}),consume:r=>r.text()});
const finish=async handles=>{await Promise.allSettled(handles.flatMap(h=>[h.result,h.resourcesDone]));await setImmediate()};
const diagnostic0=p=>assert.equal(p.t48().diagnostics.OBSERVER_FAILED,0);
`
function child(body: string) {
  const result = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '-e', common + body],
    {
      encoding: 'utf8',
      timeout: 10000
    }
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}

test('Bounded reservations retain only two specs before observer command drain', () => {
  child(`
let prepares=0,sends=0;const handles=[],a=[],b=[];let measured;
const p=new FetchPlanner(()=>{sends++;return Promise.resolve(new Response('ok'))},{maxQueuedOperations:2,maxParallelLimit:1});
p.observe(e=>{a.push(e);if(e.type==='headers-received'&&!measured){
 for(let i=0;i<100;i++){const s=spec();s.prepare=()=>{prepares++;return {url:'',init:{}}};handles.push(p.submit(s))}
 measured={...p.t48(), snapshots:handles.map(h=>h.snapshot())};
}});p.observe(e=>b.push(e));
const root=p.submit(spec());try{await finish([root,...handles]);
assert.equal(measured.specs,2,'PRE_DRAIN_RETAINED_SPECS');
assert.equal(measured.reservations,2);assert.equal(measured.commands,2);assert.equal(measured.active,3);
assert.equal(measured.snapshots.filter(s=>s.id!==0&&s.phase==='queued'&&s.sequence===0).length,2);
assert.equal(measured.snapshots.filter(s=>s.id===0&&s.failureCode==='QUEUE_FULL').length,98);
await finish(handles);assert.equal(prepares,2);assert.equal(sends,3);
assert.equal(a.filter(e=>e.type==='created').length,3);assert.deepEqual(a,b);diagnostic0(p);
assert.deepEqual([p.t48().active,p.t48().specs,p.t48().commands,p.t48().reservations],[0,0,0,0]);
}finally{p.stop();await finish([root,...handles])}
`)
})

test('Stop and abort coalesce with first reasons after full current fanout', () => {
  child(`
const owner=deferred(), entered=deferred(),handles=[];let measured,abortResult;
const p=new FetchPlanner(()=>Promise.resolve(new Response('ok')),{maxQueuedOperations:1,maxParallelLimit:1});
const root=p.submit({...spec(),prepare:async()=>{entered.resolve();await owner.promise;return {url:'',init:{}}}});
await entered.promise;
p.observe(e=>{if(e.type==='created'&&e.id!==root.id&&!measured){
 for(let i=0;i<100;i++){root.abort('abort-'+i);p.stop('stop-'+i)}measured=p.t48();
}});
const wait=p.submit(spec());handles.push(wait);
try{
assert.equal(measured.commands,2,'COALESCED_COMMANDS');
assert.equal(measured.active,2);assert.equal(p.snapshot().leasedAttempts,1);
abortResult=await root.result.catch(e=>e);assert.equal(abortResult.cause,'abort-0');
const stopped=await wait.result.catch(e=>e);assert.equal(stopped.cause,'stop-0');
const late=p.submit(spec());assert.equal(late.id,0);assert.equal((await late.result.catch(e=>e)).cause,'stop-0');
for(let i=0;i<1000;i++){root.abort(i);wait.abort(i);late.abort(i);p.stop(i)}
assert.equal(p.t48().commands,0);assert.equal(p.t48().active,1);assert.equal(p.snapshot().leasedAttempts,1);diagnostic0(p);
}finally{owner.resolve();p.stop();await finish([root,...handles])}
assert.equal(p.t48().active,0);assert.equal(p.snapshot().leasedAttempts,0);
`)
})

for (const boundary of ['headers-received', 'commit', 'operation-settled', 'resources-settled']) {
  test(`Nested submit and stop preserve FIFO at ${boundary}`, () => {
    child(`
const a=[],b=[],trace=[],handles=[],bounds=[];let once=false;
const p=new FetchPlanner(()=>Promise.resolve(new Response('ok')),{maxQueuedOperations:2,maxParallelLimit:1});
p.observe(e=>{a.push(e);trace.push('A:'+e.type+':'+e.id);
if(!once&&${boundary === 'commit' ? 'e.resultCommitted' : `e.type===${JSON.stringify(boundary)}`}){once=true;handles.push(p.submit(spec()));p.stop('first')}
bounds.push({...p.t48(),leased:p.snapshot().leasedAttempts})});
p.observe(e=>{b.push(e);trace.push('B:'+e.type+':'+e.id)});
const root=p.submit(spec());try{await finish([root,...handles]);await finish(handles);
assert.deepEqual(a,b,'FULL_FANOUT_FIFO');
for(const x of bounds){assert.ok(x.active<=x.reservations+x.leased,'ACTIVE_BOUND');assert.ok(x.commands<=2+x.active+1,'COMMAND_BOUND')} 
assert.ok(a.every((e,i)=>!i||e.sequence>a[i-1].sequence));
for(let i=0;i<trace.length;i+=2)assert.equal(trace[i].slice(2),trace[i+1].slice(2));
assert.equal(handles.length,1);assert.notEqual(handles[0].id,0);
assert.equal(handles[0].snapshot().failureCode,'STOPPED');diagnostic0(p);
assert.equal(p.t48().active,0);
}finally{p.stop();await finish([root,...handles])}
`)
  })
}

test('Header fanout completes before stop commits and cancels the queued operation', () => {
  child(`
const trace=[],snapshots=[];let sends=0;
const receipt=deferred();const q=new FetchPlanner(()=>{sends++;return receipt.promise},{maxParallelLimit:1,maxQueuedOperations:1});
const sent=q.submit(spec());await setImmediate();const queued=q.submit(spec());
q.observe(e=>{if(e.type==='headers-received'){trace.push('A(headers)');q.stop('first')}if(e.id===queued.id&&e.type==='operation-settled')trace.push('A(stop)')});
q.observe(e=>{if(e.type==='headers-received'){trace.push('B(headers)');snapshots.push(q.snapshot().stopped)}if(e.id===queued.id&&e.type==='operation-settled')trace.push('B(stop)')});
try{receipt.resolve(new Response('ok'));await finish([sent,queued]);
assert.deepEqual(trace,['A(headers)','B(headers)','A(stop)','B(stop)'],'HEADER_STOP_ORDER');
assert.deepEqual(snapshots,[false],'STOP_COMMITS_AFTER_FANOUT');assert.equal(sends,1);diagnostic0(q);
}finally{receipt.resolve(new Response('ok'));q.stop();await finish([sent,queued])}
`)
})

test('Failed operation fanout supports nested submits without reordering', () => {
  child(`
const a=[],b=[],handles=[];let once=false;
const p=new FetchPlanner(()=>Promise.resolve(new Response('failure',{status:429})),{maxQueuedOperations:2,maxParallelLimit:1});
p.observe(e=>{a.push(e);if(e.type==='operation-settled'&&!once){once=true;handles.push(p.submit(spec()))}});p.observe(e=>b.push(e));
const root=p.submit(spec());try{await finish([root,...handles]);await finish(handles);assert.deepEqual(a,b);assert.equal(handles.length,1);assert.equal(handles[0].snapshot().failureCode,'HTTP_FAILED');diagnostic0(p)}finally{p.stop();await finish([root,...handles])}
`)
})

test('Created observer loops drain iteratively without recursive pumping', () => {
  child(`
const a=[],b=[],handles=[];const p=new FetchPlanner(()=>Promise.resolve(new Response('ok')),{maxQueuedOperations:32});
p.observe(e=>{a.push(e);if(e.type==='created'&&handles.length<20)handles.push(p.submit(spec()))});p.observe(e=>b.push(e));
const root=p.submit(spec());try{await finish([root,...handles]);assert.equal(handles.length,20);assert.deepEqual(a,b);diagnostic0(p)}finally{p.stop();await finish([root,...handles])}
`)
})

// Child processes complete synchronously, so no test can still import this sibling.
process.on('exit', () => {
  unlinkSync(instrumentedFile)
})
