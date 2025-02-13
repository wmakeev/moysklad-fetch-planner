/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable n/no-unsupported-features/node-builtins */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import asyncTimers from 'node:timers/promises'
import { fetch, MockAgent, setGlobalDispatcher } from 'undici'
import {
  FetchPlanner,
  FetchPlannerEventHandler,
  FetchPlannerEventMap,
  FetchPlannerEvents,
  wrapFetch
} from '../src/index.js'

//#region init
const mockAgent = new MockAgent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
})
mockAgent.disableNetConnect()

setGlobalDispatcher(mockAgent)

const mockPool = mockAgent.get('http://example.com')

const interceptSimpleHttpGet = () => {
  mockPool
    .intercept({
      path: '/foo',
      method: 'GET'
    })
    .reply(200, { ok: true })
}

const interceptHttpWithRateLimit = (
  reqPath: string,
  limit: number,
  remaining: number,
  data: string
) => {
  mockPool
    .intercept({
      path: `/${reqPath}`,
      method: 'GET'
    })
    .defaultReplyHeaders({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(remaining),
      'X-Lognex-Retry-TimeInterval': String(1000)
    })
    .reply(200, { ok: true, data })
}

const interceptHttpWith429TooManyRequestsError = (
  reqPath: string,
  limit: number,
  retryAfter: number
) => {
  mockPool
    .intercept({
      path: `/${reqPath}`,
      method: 'GET'
    })
    .defaultReplyHeaders({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(0),
      'X-Lognex-Retry-TimeInterval': String(1000),
      'X-Lognex-Retry-After': String(retryAfter)
    })
    .reply(429, {})
}

const interceptHttpWith429ParallelLimitError = (reqPath: string) => {
  mockPool
    .intercept({
      path: `/${reqPath}`,
      method: 'GET'
    })
    .defaultReplyHeaders({
      'X-Lognex-Auth': '429005'
    })
    .reply(429, {})
}
//#endregion

test.afterEach(() => {
  mockAgent.assertNoPendingInterceptors()
  mock.reset()
  mock.timers.reset()
})

test('wrapFetch (simple)', async () => {
  const wrappedFetch = wrapFetch(fetch)

  interceptSimpleHttpGet()

  const response = await wrappedFetch('http://example.com/foo')

  const result = (await response.json()) as { ok: boolean }

  assert.ok(result.ok)
})

test('FetchPlanner (simple GET)', async () => {
  const fetchPlanner = new FetchPlanner(fetch)

  const wrappedFetch = fetchPlanner.getFetch()

  interceptSimpleHttpGet()

  const response = await wrappedFetch('http://example.com/foo')

  const result = (await response.json()) as { ok: boolean }

  assert.ok(result.ok)
})

test('FetchPlanner (event handler)', async () => {
  const events: {
    event: keyof FetchPlannerEventMap
    data: FetchPlannerEvents
  }[] = []

  const eventHandler: FetchPlannerEventHandler = {
    emit(event, data, instance) {
      assert.ok(instance instanceof FetchPlanner)
      events.push({
        event,
        data
      })
    }
  }

  const fetchPlanner = new FetchPlanner(fetch, {
    eventHandler
  })

  const wrappedFetch = fetchPlanner.getFetch()

  interceptHttpWith429TooManyRequestsError('foo', 45, 10)
  interceptHttpWith429ParallelLimitError('foo')
  interceptSimpleHttpGet()

  const response = await wrappedFetch('http://example.com/foo')

  const result = (await response.json()) as { ok: boolean }

  assert.ok(result.ok)

  assert.strictEqual(events.length, 6)

  assert.deepEqual(
    events.map(ev => ev.event),
    ['request', 'response', 'request', 'response', 'request', 'response']
  )

  const { event: ev0_name, data: ev0_data } = events[0]!

  assert.strictEqual(ev0_name, 'request')
  assert.strictEqual(ev0_data.actionId, 1)
  assert.strictEqual(ev0_data.url, 'http://example.com/foo')
  assert.strictEqual(ev0_data.requestId, 1)
  assert.strictEqual(typeof ev0_data.startTime, 'number')
  assert.strictEqual('endTime' in ev0_data, false)
  assert.strictEqual('responseType' in ev0_data, false)

  const { event: ev1_name, data: ev1_data } = events[1]!

  assert.strictEqual(ev1_name, 'response')
  assert.strictEqual(ev1_data.actionId, 1)
  assert.strictEqual(ev1_data.url, 'http://example.com/foo')
  assert.strictEqual(ev1_data.requestId, 1)
  assert.strictEqual(typeof ev1_data.startTime, 'number')
  assert.ok('endTime' in ev1_data)
  assert.strictEqual(typeof ev1_data.endTime, 'number')
  assert.ok(ev1_data.startTime <= ev1_data.endTime)
  assert.strictEqual(ev1_data.responseType, 'RATE_LIMIT_OVERFLOW')

  const { event: ev3_name, data: ev3_data } = events[3]!

  assert.strictEqual(ev3_name, 'response')
  assert.strictEqual(ev3_data.actionId, 1)
  assert.strictEqual(ev3_data.url, 'http://example.com/foo')
  assert.strictEqual(ev3_data.requestId, 2)
  assert.strictEqual(typeof ev3_data.startTime, 'number')
  assert.ok('endTime' in ev3_data)
  assert.strictEqual(typeof ev3_data.endTime, 'number')
  assert.ok(ev3_data.startTime <= ev3_data.endTime)
  assert.strictEqual(ev3_data.responseType, 'PARALLEL_LIMIT_OVERFLOW')

  const { event: ev5_name, data: ev5_data } = events[5]!

  assert.strictEqual(ev5_name, 'response')
  assert.strictEqual(ev5_data.actionId, 1)
  assert.strictEqual(ev5_data.url, 'http://example.com/foo')
  assert.strictEqual(ev5_data.requestId, 3)
  assert.strictEqual(typeof ev5_data.startTime, 'number')
  assert.ok('endTime' in ev5_data)
  assert.strictEqual(typeof ev5_data.endTime, 'number')
  assert.ok(ev5_data.startTime <= ev5_data.endTime)
  assert.strictEqual(ev5_data.responseType, 'OK')
})

test('FetchPlanner (EventEmitter as event handler)', async t => {
  t.plan(5)

  const eventHandler = new EventEmitter<FetchPlannerEventMap>()

  const fetchPlanner = new FetchPlanner(fetch, {
    eventHandler
  })

  eventHandler.on('request', function (ev, planner) {
    t.assert.equal(ev.actionId, 1)
    t.assert.equal(planner.getRateLimit(), null)
  })

  eventHandler.on('response', (ev, planner) => {
    t.assert.equal(ev.actionId, 1)
    t.assert.equal(planner.getRateLimit(), 10)
  })

  const wrappedFetch = fetchPlanner.getFetch()

  interceptHttpWithRateLimit('foo', 10, 5, '')

  const response = await wrappedFetch('http://example.com/foo')

  const result = (await response.json()) as { ok: boolean }

  t.assert.equal(result.ok, true)
})

test('FetchPlanner (simple POST)', async () => {
  const fetchPlanner = new FetchPlanner(fetch)

  const wrappedFetch = fetchPlanner.getFetch()

  mockPool
    .intercept({
      path: '/foo',
      method: 'POST',
      headers: {
        'Foo-Header': '42'
      },
      body: '{"some":123}'
    })
    .reply(200, { ok: true })

  const response = await wrappedFetch('http://example.com/foo', {
    method: 'POST',
    headers: {
      'Foo-Header': '42'
    },
    body: JSON.stringify({
      some: 123
    })
  })

  const result = (await response.json()) as { ok: boolean }

  assert.ok(result.ok)
})

test('FetchPlanner (jitter)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  const fetchPlanner1 = new FetchPlanner(fetch, {
    maxParallelLimit: 1,
    throttlingCoefficient: 1,
    maxRequestDelayTimeMs: 1000,
    jitter: 0
  })
  const wrappedFetch1 = fetchPlanner1.getFetch()

  const delaysWithoutJitter = []

  let i = 10
  while (i-- > 0) {
    interceptHttpWithRateLimit('foo', 10, 5, '')
    const p = wrappedFetch1('http://example.com/foo')
    mock.timers.tick(510)
    await asyncTimers.setImmediate()
    await p
    delaysWithoutJitter.push(fetchPlanner1.getLastRequestDelay())
  }

  // Первое значение пустое, остальные несколько могут быть с задержкой
  delaysWithoutJitter.splice(0, 3)

  const delaysDiffAvg =
    delaysWithoutJitter
      .map(it => Math.abs(it - 500))
      .reduce((res, it) => res + it, 0) / delaysWithoutJitter.length

  assert.ok(delaysDiffAvg < 10)

  const fetchPlanner2 = new FetchPlanner(fetch, {
    maxParallelLimit: 1,
    throttlingCoefficient: 1,
    maxRequestDelayTimeMs: 1000,
    jitter: 0.3
  })
  const wrappedFetch2 = fetchPlanner2.getFetch()

  const delaysWithJitter = []

  i = 100
  while (i-- > 0) {
    interceptHttpWithRateLimit('foo', 10, 5, '')
    const p = wrappedFetch2('http://example.com/foo')
    mock.timers.tick(1000)
    await asyncTimers.setImmediate()
    await p
    delaysWithJitter.push(fetchPlanner2.getLastRequestDelay())
  }

  delaysWithJitter.splice(0, 3)

  const jitterDiff =
    delaysWithJitter
      .map(it => Math.abs(it - 500))
      .reduce((res, it) => res + it, 0) / delaysWithJitter.length

  assert.ok(jitterDiff > 30)
})

test('FetchPlanner (delay reduce)', async () => {
  const fetchPlanner1 = new FetchPlanner(fetch, {
    maxParallelLimit: 1,
    throttlingCoefficient: 1,
    maxRequestDelayTimeMs: 1000,
    jitter: 0
  })
  const wrappedFetch1 = fetchPlanner1.getFetch()

  const delays = []

  let i = 5
  while (i-- > 0) {
    interceptHttpWithRateLimit('foo', 10, 5, '')

    await wrappedFetch1('http://example.com/foo')

    // Через 500 мс задержка должна быть нулевой
    await asyncTimers.setTimeout(500)

    // При последовательном выполнении запросов, каждый новый запрос
    // будет отправляться без задержки, т.к. расчетная задержка по данным из
    // предыдущего запроса компенсируется временем ожидания
    delays.push(fetchPlanner1.getLastRequestDelay())
  }

  const delaysDiff = delays.reduce((res, it) => res + it, 0) / delays.length

  assert.ok(delaysDiff < 5)
})

test('FetchPlanner (POST with RateLimit)', async () => {
  const fetchPlanner = new FetchPlanner(fetch)

  const wrappedFetch = fetchPlanner.getFetch()

  interceptHttpWithRateLimit('foo', 10, 8, 'data')

  const response = await wrappedFetch('http://example.com/foo')

  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 1)

  const result = (await response.json()) as { ok: boolean }

  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)

  assert.ok(result.ok)

  assert.equal(fetchPlanner.getRateLimit(), 10)
  assert.equal(fetchPlanner.getRateLimitRemaining(), 8)
})

test('FetchPlanner (waitForRequestSlot)', async () => {
  const fetchPlanner = new FetchPlanner(fetch, {
    maxParallelLimit: 3,
    maxRequestDelayTimeMs: 100,
    throttlingCoefficient: 1
  })

  const wrappedFetch = fetchPlanner.getFetch()

  const resultsPromises = []

  let order = 0

  for (const priority of [10, 81, 70, 11, 60, 80, 52, 30, 51]) {
    const resultPromise = fetchPlanner
      .waitForFreeRequestSlot(priority)
      .then(async () => {
        order++

        interceptHttpWithRateLimit(
          `foo/${order}`,
          10,
          10 - order,
          `${order} / ${priority}`
        )

        const res = await wrappedFetch(`http://example.com/foo/${order}`)

        return await res.json()
      })

    resultsPromises.push(resultPromise)
  }

  assert.equal(fetchPlanner.getRequestSlotHandlersCount(), 9)

  const results = (await Promise.all(resultsPromises))
    .map(it => (it as { data: string }).data)
    .sort()

  assert.deepEqual(results, [
    '1 / 10',
    '2 / 11',
    '3 / 30',
    '4 / 51',
    '5 / 52',
    '6 / 60',
    '7 / 70',
    '8 / 80',
    '9 / 81'
  ])
})

test('FetchPlanner (parallel limit and throttling)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  const fetchPlanner = new FetchPlanner(fetch, {
    maxParallelLimit: 2,
    maxRequestDelayTimeMs: 1000,
    jitter: 0,
    throttlingCoefficient: 1
  })

  const wrappedFetch = fetchPlanner.getFetch()

  // Выполняем одновременно три запроса
  interceptHttpWithRateLimit('foo/1', 10, 4, 'r1')
  const resp1Promise = wrappedFetch('http://example.com/foo/1')

  interceptHttpWithRateLimit('foo/2', 10, 3, 'r2')
  const resp2Promise = wrappedFetch('http://example.com/foo/2')

  interceptHttpWithRateLimit('foo/3', 10, 2, 'r3')
  const resp3Promise = wrappedFetch('http://example.com/foo/3')

  // Запросы сразу попадают в очередь
  assert.equal(fetchPlanner.getActionsQueueLength(), 3)
  assert.equal(fetchPlanner.getRateLimit(), null)
  assert.equal(fetchPlanner.getRateLimitRemaining(), null)
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)
  assert.equal(Math.round(fetchPlanner.getLastRequestDelay()), 0)
  assert.ok(fetchPlanner.getNextRequestTime() - Date.now() <= 0)

  // Первые запросы начинают обрабатываться через 0 мс таймаута, т.к.
  // без получения актуального RateLimit задержки нет.
  mock.timers.tick(0)

  // Т.к. `maxParallelLimit=2`, то для обработки из очереди сразу достаются
  // два запроса. В очереди остается только 1.
  assert.equal(fetchPlanner.getActionsQueueLength(), 1)

  // RateLimit ещё не определен, т.к. мы не получили еще ни одного ответа от
  // сервера.
  assert.equal(fetchPlanner.getRateLimit(), null)
  assert.equal(fetchPlanner.getRateLimitRemaining(), null)

  // 2 запросы полученные из очереди в обработке
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 2)

  // Для не нулевой задержки нужен RateLimit, поэтому задержка еще равна 0.
  assert.ok(fetchPlanner.getNextRequestTime() - Date.now() <= 0)

  // Первые 2 запросы уже отправлены. Получим ответ на первый запрос.
  const [resp1, resp2] = await Promise.all([resp1Promise, resp2Promise])

  assert.equal(resp1.status, 200)
  assert.equal(resp2.status, 200)

  // В момент получения запроса должны должны быть получены заголовки RateLimit
  assert.equal(fetchPlanner.getRateLimit(), 10)
  // ..`X-RateLimit-Remaining` установлен уже из ответа на 2-ой запрос
  assert.equal(fetchPlanner.getRateLimitRemaining(), 3)

  const [result1, result2] = await Promise.all([resp1.json(), resp2.json()])

  assert.equal((result1 as { data: string }).data, 'r1')
  assert.equal((result2 as { data: string }).data, 'r2')

  // [ждем выполнения finally у второго запроса]
  // await asyncTimers.setImmediate()

  // В очереди всё еще находится третий запрос.
  assert.equal(fetchPlanner.getActionsQueueLength(), 1)
  // Запросов в состоянии выполнения нет.
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)

  // Для выполнения третьего запроса была рассчитана задержка
  const delay = fetchPlanner.getNextRequestTime() - Date.now()

  assert.ok(delay > 600)
  assert.ok(delay <= 700)

  // .. ожидаем 200мс
  mock.timers.tick(710)

  // Третий запрос пошёл в обработку
  assert.equal(fetchPlanner.getActionsQueueLength(), 0)
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 1)

  const resp3 = await resp3Promise
  assert.equal(resp3.status, 200)

  const result3 = await resp3.json()

  assert.equal((result3 as { data: string }).data, 'r3')

  // Все запросы выполнены
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)
  assert.ok(Math.round(fetchPlanner.getLastRequestDelay()) - 600 <= 100)
  assert.equal(fetchPlanner.getNextRequestTime(), 0)
})

test('FetchPlanner (retry 429 TooManyRequests error)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  const fetchPlanner = new FetchPlanner(fetch, {
    maxParallelLimit: 2,
    maxRequestDelayTimeMs: 1000,
    jitter: 0,
    throttlingCoefficient: 1
  })

  const wrappedFetch = fetchPlanner.getFetch()

  // Запрос с ошибкой 429
  interceptHttpWith429TooManyRequestsError('foo/1', 10, 100)
  const resp1Promise = wrappedFetch('http://example.com/foo/1')

  // Запрос попал в очередь
  assert.equal(fetchPlanner.getActionsQueueLength(), 1)

  // Нет задержки для первого запроса
  mock.timers.tick(0)

  // Запрос ушел из очереди в обработку
  assert.equal(fetchPlanner.getActionsQueueLength(), 0)
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 1)

  // [даем mock сработать]
  await asyncTimers.setImmediate()

  // Получена ошибка 429 и запрос вернулся обратно в очередь
  assert.equal(fetchPlanner.getRateLimit(), 10)
  assert.equal(fetchPlanner.getRateLimitRemaining(), 0)
  assert.equal(fetchPlanner.getActionsQueueLength(), 1)
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)
  assert.equal(fetchPlanner.getParallelLimitCorrection(), 0)

  const delay = fetchPlanner.getNextRequestTime() - Date.now()
  assert.ok(delay - 900 <= 100)

  // Ожидаем половину от времени задержки (запрос не должен быть отправлен)
  mock.timers.tick(500)

  interceptHttpWithRateLimit('foo/1', 10, 1, 'r1')

  // Ожидаем вторую половину времени задержки
  mock.timers.tick(510)

  // Запрос отправляется повторно
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 1)

  const result1 = await (await resp1Promise).json()

  assert.equal((result1 as { data: string }).data, 'r1')
})

test('FetchPlanner (retry 429 parallel limit overflow error)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  const fetchPlanner = new FetchPlanner(fetch, {
    maxParallelLimit: 3,
    maxRequestDelayTimeMs: 1000,
    jitter: 0, // будет мешать тестированию
    throttlingCoefficient: 1,
    parallelLimitCorrectionPeriodMs: 1000
  })

  const wrappedFetch = fetchPlanner.getFetch()

  interceptHttpWithRateLimit('foo/1', 10, 9, 'r1')
  interceptHttpWithRateLimit('foo/2', 10, 8, 'r2')
  // Запрос с ошибкой 429
  interceptHttpWith429ParallelLimitError('foo/3')

  const resp1Promise = wrappedFetch('http://example.com/foo/1')
  const resp2Promise = wrappedFetch('http://example.com/foo/2')
  const resp3Promise = wrappedFetch('http://example.com/foo/3')

  // Нет задержки для первых запросов
  mock.timers.tick(0)

  // Запросы ушли из очереди в обработку
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 3)

  const result1 = await (await resp1Promise).json()
  assert.equal((result1 as { data: string }).data, 'r1')

  const result2 = await (await resp2Promise).json()
  assert.equal((result2 as { data: string }).data, 'r2')

  // Получена ошибка 429 и запрос вернулся обратно в очередь
  assert.equal(fetchPlanner.getRateLimit(), 10)
  assert.equal(fetchPlanner.getRateLimitRemaining(), 8)
  assert.equal(fetchPlanner.getActionsQueueLength(), 1)
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 0)
  // Добавлена корректировка для лимита параллельных запросов
  assert.equal(fetchPlanner.getParallelLimitCorrection(), -1)

  interceptHttpWithRateLimit('foo/3', 10, 9, 'r3')

  // Задержка по RateLimit
  mock.timers.tick(210)

  // Запрос отправляется повторно
  assert.equal(fetchPlanner.getCurInflightRequestsCount(), 1)

  const result3 = await (await resp3Promise).json()
  assert.equal((result3 as { data: string }).data, 'r3')

  mock.timers.reset()

  // Ожидаем
  await asyncTimers.setTimeout(700)

  interceptHttpWithRateLimit('foo/4', 10, 9, 'r4')
  const resp4Promise = wrappedFetch('http://example.com/foo/4')
  const result4 = await (await resp4Promise).json()
  assert.equal((result4 as { data: string }).data, 'r4')

  // Пересмотр лимита параллельных запросов должен произойти еще позже
  assert.equal(fetchPlanner.getParallelLimitCorrection(), -1)

  // Ожидаем еще
  await asyncTimers.setTimeout(300)

  interceptHttpWithRateLimit('foo/5', 10, 9, 'r5')
  const resp5Promise = wrappedFetch('http://example.com/foo/5')
  const result5 = await (await resp5Promise).json()
  assert.equal((result5 as { data: string }).data, 'r5')

  // Лимит параллельных запросов восстановлен в исходное значение
  assert.equal(fetchPlanner.getParallelLimitCorrection(), 0)
})
