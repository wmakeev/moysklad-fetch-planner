# T80 — Fetch type contract

Дата: 2026-10-31. Статус: доработка T80/2 по V8/B1; выбранный контракт исправлен, требуется новая независимая приёмка перед T90. Production/API не изменены. Прежний результат T80/1 не принят: перегруженный emit пропускал чужой Node EventEmitter. Основание: T80/A5 и границы адаптации из `../01-plan.md`, F07/F13 из `../02-research.md`. Проверки и полные compiler outputs находятся в `../run/journal/T80.md`. Это declaration-only прототип в изолированных потребителях, не приёмка будущего production tarball и не runtime-проверка T100.

## Решение [ALT, ROOT, VERIFY]

Выбрать generic сохранение параметров вызова и результата транспорта с ограничением `NativeFetch | UndiciFetch`. Не возвращать сам `F`: planner создаёт новую функцию и не копирует произвольные свойства, generic-отношения и overload set исходного callable. Возвращать нормализованную сигнатуру вызова. Native и undici не объявляются взаимозаменяемыми: входы и Response остаются из семейства переданного транспорта.

```ts
import type { fetch as undiciFetch } from 'undici-types'

type NativeFetch = typeof globalThis.fetch
type UndiciFetch = typeof undiciFetch
type Transport = NativeFetch | UndiciFetch

type Scheduled<F extends Transport> = F extends Transport
  ? (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>
  : never

declare class FetchPlanner<F extends Transport = UndiciFetch> {
  constructor(fetchApi: F, options?: Options<F>)
  getFetch(): Scheduled<F>
  protected checkFreeRequestSlotTrigger(): void
}

declare function wrapFetch<F extends Transport>(fetchApi: F, options?: Options<F>): Scheduled<F>
```

Полный замкнутый прототип, включая события и нужную часть options, — `__temp/plan-core-refactor/types/generic.d.ts`. Имена вспомогательных типов здесь не предписывают новые публичные экспорты. В T90 существующие поля options/getters и protected hook сохраняются; прототип намеренно моделирует только затронутые Fetch/event сигнатуры. Runtime adapter, новая transport policy и новый entrypoint не нужны.

Условный тип `Scheduled` распределяется по union. Для динамического `NativeFetch | UndiciFetch` возвращается union callable, вызов которого требует вход, допустимый обоим транспортам. Нераспределённый `(...args: Parameters<F>)` разрешал бы чужой Request случайно выбранному транспорту; `negative-union-input.ts` отвергает такой вызов на обеих версиях типов Node и обоих компиляторах. Ограничение `Transport` проверяет функцию до сохранения её параметров: числовой input и Promise<number> не становятся допустимыми через generic inference.

## Сравнение альтернатив

1. `generic.d.ts`: constructor выводит F; getFetch/wrapFetch возвращают `Scheduled<F>`; RequestEvent/F-options выводятся из того же F. Native и legacy positives проходят; уточнённые CustomInit/CustomResponse сохраняются; subclass hook сохраняется. Этот вариант выбран.
2. `overloads.d.ts`: отдельные constructor и wrapFetch overloads для NativeFetch/UndiciFetch, getFetch возвращает соответствующую семейную сигнатуру. Все обязательные native/legacy positives также проходят и неверные transport/body/method отклоняются. CustomResponse расширяется до базового Response: `custom.ts` даёт ровно три TS2322 в обоих компиляторах. Проверяемая constructor-factory форма также не сохраняет class/protected hook (`subclass.ts`: TS2508/TS4112/TS2339). Overloads можно усложнить дополнительным generic class/mode, но это увеличивает поверхность ради уже решённой generic-вариантом задачи [SURFACE]; отдельного generic-рефайнмента overloads здесь не доказываем.
3. Возврат точного `F` без нормализации отклонён по смыслу: `Object.assign(fetch, {marker:true})` не даёт marker новой функции planner. `negative-callable-property.ts` ожидает TS2339. Не использовать `as F` для сокрытия этого расхождения.
4. Обновление только `@types/node` не решение: `old.d.ts` воспроизводит прежние Fetch сигнатуры и F07 source; native проба остаётся красной с @types/node24.19.2. Нельзя заменить типы native на undici-types7.3.0 либо добавить DOM ради скрытия конфликта.

## Контракт входов, выхода и событий

| Поверхность | Native | Legacy undici7.3.0 / undici-types7.3.0 |
| --- | --- | --- |
| constructor | выводит typeof globalThis.fetch | выводит исходный callable транспорта |
| getFetch / wrapFetch | assignable к typeof globalThis.fetch | assignable к прежнему typeof undici.fetch |
| input | string, global URL, global Request | исходный RequestInfo: string, URL, undici Request |
| init | global RequestInit | исходный undici RequestInit, включая dispatcher/duplex |
| FormData / File | global FormData; global File как поле формы и непосредственный body | undici FormData; node:buffer File как поле формы и body |
| result | Promise<global Response> | Promise<undici Response> |
| bytes | Response.bytes() и Request.bytes(): Promise<Uint8Array> с @types/node24.19.2 | метод отсутствует в декларациях7.3.0; вызов обязан дать TS2339 |
| custom transport | сохраняет CustomInit и CustomResponse | сохранение через тот же generic механизм, без расширения семейства |
| RequestEvent.url | Parameters<F>[0] | Parameters<F>[0] |
| RequestEvent.method | NonNullable<Parameters<F>[1]>['method'] | то же; string или undefined |

`RequestEvent<F extends Transport = Transport>` сохраняет прежние actionId/requestId/startTime. `ResponseEvent<F>` и `FetchErrorEvent<F>` расширяют его с прежними responseType/endTime/error/errorTime; `FetchPlannerEvents<F>`, `FetchPlannerEventHandler<F>`, `FetchPlannerEventMap<F>` и `FetchPlannerOptions<F>` должны проводить один и тот же F до eventHandler и instance: FetchPlanner<F>. Прототип `Options<F>.eventHandler` использует `FetchPlannerEventHandler<F>` с одной function-property сигнатурой emit. Аргументы — mapped union кортежей из единственного `FetchPlannerEventMap<F>`, включая instance: FetchPlanner<F>. Перегруженный emit из T80/1 отвергнут по V8/B1: generic emit<K> настоящего EventEmitter проходил чужой overloaded target даже при явном F. NoInfer не устраняет эту причину [ROOT]. Default событий — оба семейства, поскольку непараметризованное событие может прийти от любого транспорта. Default класса оставлен UndiciFetch для прежних непараметризованных аннотаций.

Выбранная форма (полный исходник — `generic.d.ts`):

```ts
interface FetchPlannerEventHandler<F extends Transport = Transport> {
  emit: (...args: { [K in keyof FetchPlannerEventMap<F>]: [name: K, ...args: FetchPlannerEventMap<F>[K]] }[keyof FetchPlannerEventMap<F>]) => void
}
interface Options<F extends Transport = Transport> {
  eventHandler?: FetchPlannerEventHandler<F>
}
```

Контрольная альтернатива `event-explicit.d.ts` задаёт одну function-property сигнатуру с явным union трёх кортежей; она даёт те же результаты, но дублирует EventMap [ALT, CONSIST, SURFACE]. `event-overloads.d.ts` сохраняет дефектный T80/1 как red-контроль. Возврат void совместим с boolean Node EventEmitter. Matching native/legacy/custom emitters, все три события, их typed instance, обычный contextual `emit(name, event, instance)`, объект с аннотацией `FetchPlannerEventHandler<NativeFetch>` и отдельная аннотация `FetchPlannerEventHandler<NativeFetch>['emit']` проверены в `events.ts`. Для коррелированного сужения event по name проверена rest-destructuring форма `(...args) => { const [name, event, instance] = args }`; обычные раздельные параметры не обещают такого сужения. Native listener bytes отдельно проверен `events-bytes.ts`.

Не обещать, что undici Request можно передать native fetch, или что native RequestInit.dispatcher подходит undici7.3.0. Совпадение рантайм-объектов не доказывает структурной совместимости разных деклараций. Metadata извлекается из исходного input/init в T100; тип события не разрешает здесь читать body или превращать Request в строку.

## Уточнение @types/node и первоисточник

Исследованы установленные первичные declarations, а не пересказ сторонней статьи. Точные package версии проверены по package.json и настоящим compiler diagnostics:

- Исходные `@types/node22.20.5/web-globals/fetch.d.ts` определяют global Fetch через собственный undici-types6.21.0. Прямой undici-types7.3.0 использует node:buffer File, а6.21.0 — другой File; F07 показывает formData/File и dispatcher несовместимость.
- В `undici-types7.3.0/fetch.d.ts` и `undici7.3.0/types/fetch.d.ts` BodyMixin не содержит bytes. Импортирование этих Response под видом native Response было бы ложным обещанием.
- Проверенный `@types/node24.19.2` использует nested undici-types7.24.6 (диапазон манифеста >=7.24.0 <7.24.7). Его `fetch.d.ts:36` содержит bytes() для BodyMixin, следовательно Request и Response. Direct undici-types7.3.0 остаётся отдельно.
- `undici-types7.3.0/formdata.d.ts` импортирует File из buffer; RequestInit/body/Headers/dispatcher проверялись по fetch.d.ts и dispatcher.d.ts исходного пакета. Формы global RequestInit и Fetch читались из `@types/node/web-globals/fetch.d.ts` обеих версий.

Рекомендовать T90 закрепить dev @types/node24.19.2 и те же @types/node в strict package consumers, не трогая direct undici-types7.3.0 и dev undici7.3.0. Это доказанный вариант, не утверждение о минимально возможной версии @types/node. На исходных22.20.5 generic и overloads уже исправляют native-basic и legacy, но ровно две TS2339 на native Request/Response.bytes остаются. На24.19.2 те же positive fixtures проходят TS5.7.3 и TS7.0.2. Поэтому обновление нужно для корректного отражения принятого Node>=24 bytes API, а не вместо исправления Fetch сигнатуры.

Standalone environments находятся вне checkout, не имеют project node_modules в цепочке родителей, NODE_PATH пуст; bare22/bare24 не разрешают `undici` через require.resolve. Compilers лежат отдельно в tooling, потребителю доступны лишь @types/node и прямая undici-types зависимость. Native/legacy declaration closure проходит без runtime undici; его намеренная подстановка вместо undici-types даёт ровно TS2307. Никаких casts/any/ts-ignore/skipLibCheck в consumer-пробах не используется; any внутри неизменённых vendor declarations не удаляется.

## Breaking уточнения в пределах major

Непараметризованный RequestEvent.url становится честным union native/undici, поэтому listener, считающий любой Request только undici Request, должен сузить/параметризовать тип. Для native аннотации класса использовать `FetchPlanner<typeof globalThis.fetch>`; старый `FetchPlanner` по умолчанию означает undici, а не оба транспорта одновременно. Generic options/event maps проводят выбранный транспорт; не расширять входы одного транспорта до union ради удобства реализации. Аннотация нового wrapper сохраняет параметры и Response обычной Fetch сигнатуры, но не собственные свойства callable и не произвольные generic/overloaded зависимости: Parameters/ReturnType используют последнюю overload-сигнатуру. Для A5 обе исходные Fetch функции имеют одну нужную сигнатуру; произвольный overload-preserving API не обещается. Типы TypeScript Node24 становятся проверенным consumer baseline; старые типы22 допустимы только без обещания bytes.

Прежняя перегруженная аннотация `OldHandler` даже того же native семейства не присваивается новому handler: `events-overload-annotation.ts:8` даёт ровно TS2322 в TS5/TS7; старый прототип принимает её. Это явное breaking-уточнение major: заменить такую аннотацию на `FetchPlannerEventHandler<F>` или одну функцию с union кортежей, либо оставить inference подходящего Node EventEmitter. Совместимость произвольных старых overload handlers не обещается. Runtime adapter ради сохранения старой аннотации не добавляется. Ошибка чужого emitter является защитой от ложного listener Response, а не поводом расширять F или использовать cast.

## Точные fixtures и gates для T90

- Перенести `native.ts` в `test/package/fixtures/native.ts`, заменив только импорт contract на package/root. Не терять обе bytes проверки, assignability typeof globalThis.fetch, Promise<Response>, Request/URL, FormData/File-body и EventEmitter<EventMap<typeof fetch>>.
- Сохранить `legacy.ts` как bare legacy positive вместе с native fixture, а `undici.ts` как установленный undici7.3.0 positive; проверить string/URL/Request и оба пути constructor/getFetch/wrapFetch. `custom.ts` и `subclass.ts` закрепляют выбор generic и сохранение protected hook.
- В обеих consumer средах и обоих компиляторах прогонять отрицательные `negative-{transport,constructor,input-transport,body,method,planner-body,planner-method,event,event-method,union-input,callable-property}.ts`. У generic transport/constructor/input-transport/union-input — TS2345; body/method/event — TS2322; callable-property — TS2339. При установленном undici добавить `negative-undici-{body,method,bytes}.ts`: TS2322/TS2322/TS2339. Runner собирает их в один consumer, проверяет точное число, исходную строку и код каждой ошибки, не просто ненулевой exit.
- Перенести `events.ts`, `events-bytes.ts`, `events-negative.ts` и `events-overload-annotation.ts` в package consumer gate, заменив только contract import и при необходимости имя Options на существующий FetchPlannerOptions. `events-negative.ts` для выбранной формы требует ровно 12 diagnostics: строки8/9/10/11/12 — TS2322 (native EventEmitter к undici constructor/wrapFetch/явному F/options),14/15 — TS2345 (явно типизированный чужой handler к constructor/wrapFetch),16 — TS2322 (его options assignment),20 — TS2345 в TS5, TS2739 в TS7 (неверный event),21 — TS2345 (неверный instance),23 — TS2322 (method),24 — TS2322 (обратная граница legacy emitter к native). Дополнительных diagnostics быть не должно. Строки относятся к сохранённому прототипу; после переноса вычислять строки fixture, сохраняя точный count/code/location.
- `events.ts` — exit0 на обоих Node types и TS5/TS7; `events-bytes.ts` — exit0 с Node types24, ровно TS2339 на строке7 с Node types22. `events-overload-annotation.ts` — ровно TS2322 на строке8 у выбранного и явного union; у старого overload-контроля exit0. В отдельном исследовательском red/green gate `run-events.mjs` старый прототип даёт только шесть ошибок (строки14/15 — TS2322 в TS5, TS2345 в TS7;16 — TS2322;20 — TS2345 в TS5, TS2739 в TS7;21 — TS2345;23 — TS2322), ошибочно пропуская пять native→undici входов и обратный emitter. Выбранная форма и явный union закрывают все эти входы. Не выдавать red-контроль за допустимый production контракт.
- В bare consumer намеренно испортить реальный declaration import undici-types→undici и требовать единственный TS2307 из файла декларации. После выделения внутренних helpers искать import в реальном файле графа деклараций, а не требовать первую строку index.d.ts. Сохранить тест отсутствия runtime undici и замкнутости опубликованных declarations.
- Адаптировать старые gates F13 только к новым фактическим declaration paths/diagnostics. Сохранить current-build/npm+pnpm tarball/root+deep imports/GET+POST smoke. Проверить уже настоящий tarball, а не выдать этот declaration-only прототип за пакетную приёмку.
- Не добавлять bytes к старому undici Response, не добавлять runtime undici, не снижать strict и не использовать skipLibCheck. Runtime POST/init override/body identity/replay остаются T100. D09/D10/D12 и errorLimits остаются открытыми в установленном объёме.

## Повторение

Все исходники и runner находятся в `__temp/plan-core-refactor/types/`. Tooling устанавливается в отдельный scratch; команды ниже не меняют production dependencies/lock. Каждый npm install выполнять отдельной командой с timeout300, consumer matrix — отдельным запуском на каждую среду (при необходимости дополнительно аргумент ts5/ts7). Не запускать потребители одной среды одновременно: они используют один consumer.ts/contract.d.ts.

```sh
export PATH="$PWD/__temp/environment-compat/node_modules/node/bin:$PWD/__temp/environment-compat/node_modules/.bin:$PATH"
node --version
pnpm --version
node node_modules/typescript/bin/tsc --version
scratch=/tmp/orchestrate-fetch-planner-003/T80-1
```

```sh
timeout 300 npm install --prefix "$scratch/tooling" --ignore-scripts --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 ts5@npm:typescript@5.7.3 ts7@npm:typescript@7.0.2
timeout 300 npm install --prefix "$scratch/bare22" --ignore-scripts --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 @types/node@22.20.5 undici-types@7.3.0
timeout 300 npm install --prefix "$scratch/bare24" --ignore-scripts --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 @types/node@24.19.2 undici-types@7.3.0
timeout 300 npm install --prefix "$scratch/undici22" --ignore-scripts --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 @types/node@22.20.5 undici-types@7.3.0 undici@7.3.0
timeout 300 npm install --prefix "$scratch/undici24" --ignore-scripts --no-audit --no-fund --package-lock=false --fetch-retries=0 --fetch-timeout=20000 @types/node@24.19.2 undici-types@7.3.0 undici@7.3.0
```

```sh
timeout 300 node __temp/plan-core-refactor/types/run.mjs "$scratch" bare22
timeout 300 node __temp/plan-core-refactor/types/run.mjs "$scratch" bare24
timeout 300 node __temp/plan-core-refactor/types/run.mjs "$scratch" undici22
timeout 300 node __temp/plan-core-refactor/types/run.mjs "$scratch" undici24
```

Ожидается exit0 у каждого runner: отрицательные компиляции проверены внутри. Сам tsc возвращает0 при успехе,2 при ожидаемой ошибке TS5 и1 при ожидаемой ошибке TS7. В baseline22 native-basic проходит новым контрактом, native bytes даёт ровно две TS2339; baseline24 новый контракт проходит полностью; прежний old контракт остаётся красным на native в обеих версиях Node types. Конкретные compiler logs и counts закреплены в журнале T80.

## Повторение event-boundary доработки

После подготовки isolated tooling теми же pinned install-командами и успешной основной матрицы для каждой среды выполнить event runner. `$scratch` — свежая папка с теми же четырьмя consumer directories и tooling; одновременно не писать в одну среду двумя runners. Для раздельного параллельного запуска основной и event матрицы нужны разные consumer directories, допускаются ссылки только на установленные node_modules. T80/2 использовал `/tmp/orchestrate-fetch-planner-003/T80-2/work` и `event-work`, не меняя исходные consumer-файлы T80/1.

```sh
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" bare22 ts5
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" bare22 ts7
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" bare24 ts5
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" bare24 ts7
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" undici22 ts5
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" undici22 ts7
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" undici24 ts5
timeout 300 node __temp/plan-core-refactor/types/run-events.mjs "$scratch" undici24 ts7
```

Ожидается 11 проверенных компиляций в каждом event-запуске: три старого контроля и по четыре выбранного mapped union и явного union. Нулевой exit runner означает совпадение всех diagnostics с ожиданиями, включая намеренно красные fixtures. Полная исходная матрица остаётся 134 компиляции; дополнительная event-матрица — 88. До новой независимой приёмки T80 не считать принятым, T90 не запускать.
