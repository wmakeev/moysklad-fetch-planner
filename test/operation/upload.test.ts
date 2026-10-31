import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

for (const family of ['native', 'undici']) {
  for (const mode of ['released', 'rejected', 'failure', 'watchdog']) {
    test(`${family} cooperative upload ${mode} exits naturally after physical cleanup`, () => {
      const child = spawnSync(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          new URL('./upload-source.js', import.meta.url).pathname,
          family,
          mode
        ],
        { encoding: 'utf8', timeout: 15000 }
      )
      assert.ifError(child.error)
      const raw = child.stdout + child.stderr
      assert.equal(child.signal, null, raw)
      assert.match(child.stdout, /"event":"baseline-ready"/, raw)
      assert.match(
        child.stdout,
        /"event":"finally-clean".*"producerPending":0,"sockets":0,"serverListening":false/,
        raw
      )
      assert.equal(child.status, mode === 'failure' || mode === 'watchdog' ? 1 : 0, raw)
      if (mode === 'failure') assert.match(child.stderr, /INJECTED_AFTER_HEADERS/)
      else if (mode === 'watchdog') assert.match(child.stderr, /WATCHDOG_UPLOAD/)
      else {
        assert.doesNotMatch(raw, /WATCHDOG|ERR_ASSERTION/)
        assert.match(child.stdout, /"event":"barrier-check","producerPending":1,"nextPrepare":0/)
        assert.match(child.stdout, /"event":"barrier-check","producerPending":0,"nextPrepare":0/)
        assert.match(child.stdout, /"event":"next-prepare","producerPending":0,"nextPrepare":1/)
      }
    })
  }
}
