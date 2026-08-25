# Telegram one-click Redemption: полный план реализации

- Статус: согласованный план, реализация не начата.
- Область: backend `hunch-monorepo` + web frontend `Hunch_App`.
- Предлагаемая миграция: `0235_telegram_redemption_handoffs.sql`.

## Итоговое архитектурное решение

Telegram Mini App — это web-приложение. Handoff не получает custody над
кошельком, не создаёт «внутренний backend wallet» и не готовит wallet actions.
Он только доказывает, что конкретный Telegram-пользователь нажал кнопку для
конкретной redeemable-позиции.

После `claim` существующий frontend redemption flow сам:

1. Загружает актуальную позицию и redemption plan.
2. Проверяет существующие approvals теми же запросами, что обычный web UI.
3. Если approval нужен, выполняет его существующим wallet-specific путём.
4. Повторно загружает plan и выполняет redeem.
5. Сохраняет существующий redemption marker и запускает position sync.
6. Показывает результат и закрывает Mini App после подтверждения успеха.

```text
Telegram: Redeem in Hunch
  -> web Mini App открывается
  -> Hunch auth + Telegram initData проверены
  -> claim фиксирует клик как consent для sealed scope
  -> только победитель claim получает autoExecute=true
  -> существующий frontend redemption flow проверяет approval
  -> при необходимости выполняет существующий approval flow
  -> frontend повторно получает свежий redemption plan
  -> frontend выполняет существующий redeem flow
  -> receipt/marker + position sync подтверждают результат
  -> Redemption completed
  -> Mini App закрывается
```

В Mini App нет дополнительной кнопки `Confirm Redeem`. Системные wallet prompts,
подписи и подтверждения внешнего кошелька не скрываются и не обходятся.

## 1. Что означает one-click

One-click означает один продуктовый клик в Telegram, после которого Hunch
автоматически начинает существующий web redemption flow. Это не обещание одной
on-chain транзакции и не обещание отсутствия wallet prompts.

- Если approval уже есть, frontend сразу переходит к redeem.
- Если approval отсутствует, frontend выполняет обычный canonical approval, а
  затем redeem.
- Embedded и external EVM wallets используют уже поддерживаемые frontend пути.
- Polymarket Safe, Magic proxy и Deposit Wallet используют только уже
  поддерживаемую topology-specific логику.
- Deposit Wallet нельзя превращать в general-purpose controller: его generic
  batch не вызывается напрямую и relayer allowlist не обходится.

Eligibility кнопки не должна называться или вычисляться как
`managedInternalEvmWallet`. Правильный критерий: позиция redeemable, её owner
доступен текущему пользователю, а существующий web redemption flow поддерживает
данный venue/topology. Если web flow потребует две wallet-подписи, это всё ещё
тот же автоматический flow, но пользователь увидит обе wallet prompts.

## 2. Границы изменений

Добавляем только:

- отдельный sealed redemption handoff;
- один публичный `claim` endpoint;
- Telegram start parameter и Mini App route;
- auto-mode над существующим frontend redemption flow;
- кнопку в карточке позиции и выигрышном `position_resolved` notification;
- необходимые OpenAPI types, lifecycle/retention hooks и тесты.

Не меняем:

- `telegram_app_handoffs` и `telegram_trade_intents`;
- Buy/Sell, FAK/FOK и funding planner;
- venue redemption transaction builders;
- approval targets, calldata и operator selection;
- server-side Polymarket redemption и его приоритет;
- Privy policies, wallet custody или env contract;
- существующие redemption marker, position sync и notification lifecycle;
- правила Polymarket relayer/Deposit Wallet.

В частности, в этой задаче не создаётся `position_action_operation`, не
добавляется `groupWalletExecutableActions` и не вводится новый EVM batch.

## 3. Что уже существует и должно быть переиспользовано

Frontend уже умеет независимо получить approval state и выполнить approval:

- `Hunch_App/src/hooks/trade/usePolymarketRedemption.ts`;
- `Hunch_App/src/hooks/trade/useLimitlessRedemption.ts`;
- `Hunch_App/src/features/Redemption/desktop/RedemptionDialog.tsx`;
- `Hunch_App/src/features/Redemption/mobile/RedemptionDrawer.tsx`.

Эти hooks уже:

- получают venue redemption plan;
- загружают account/approval state;
- строят только canonical approval tasks;
- исполняют embedded, external, Safe, proxy и relayer paths;
- повторно получают plan после approval;
- ждут transaction receipt там, где он доступен;
- вызывают `notifyRedemptionWithRetry`;
- запускают принудительный positions sync.

Новый auto-mode обязан вызывать эту логику, а не копировать её и не принимать
approval instructions от handoff backend.

Backend уже имеет Telegram identity validation в `routes/telegram.ts`:

- Hunch session обязательна;
- Telegram `initData` signature и `auth_date` проверяются;
- активная связка Hunch user + Telegram user обязательна;
- подписанный `start_param` должен содержать именно предъявленный token.

Эта проверка выносится в узкий общий helper без переноса trade-specific commit
правил в redemption handoff.

## 4. Sealed consent scope

Handoff фиксирует экономический смысл клика, но не execution instructions.
Предлагаемый `scope_snapshot.version = 1`:

```ts
type TelegramRedemptionScopeV1 = Readonly<{
  version: 1;
  action: "redeem";
  consentCopyRevision: "telegram-redemption-v1";
  inspectionContractRevision: 1;
  primaryPositionRef: string;
  venueId: "polymarket" | "limitless";
  marketId: string;
  outcome: "YES" | "NO";
  ownerAddress: string;
  ownerBindingId: string;
  components: ReadonlyArray<{
    tokenId: string;
    outcome: "YES" | "NO";
    redeemableBalanceRaw: string;
  }>;
  expectedPayoutRaw: string;
  payoutAsset: string;
  redemptionPlanDigest: string;
}>;
```

`components` нужен потому, что canonical Polymarket redemption plan может
погашать весь condition/market unit, включая обе outcome components. Нельзя
обещать «только один token», если существующий venue plan фактически redeem-ит
condition целиком. Для Limitless массив обычно содержит одну component.

`redemptionPlanDigest` считается по canonical economic plan без calldata,
approval state и transient inspection revision. `scope_fingerprint` в таблице
считается по canonical JSON всего snapshot. Approval state в оба hash не
входит: approval может законно измениться между issue и claim.

Не сохраняются и не возвращаются:

- calldata;
- подписи;
- approval actions;
- redeem actions;
- execution wallet reference;
- relayer payload;
- `position_action_operation_id`.

### Fresh validation при claim

До перехода `issued -> claimed` backend повторно получает fresh evidence и
требует:

- тот же Hunch user и связанный Telegram user;
- тот же primary position, venue, market, outcome и owner binding;
- позиция всё ещё принадлежит пользователю и не скрыта/не передана;
- canonical redemption unit всё ещё redeemable;
- component token IDs и balances точно совпадают с sealed scope;
- expected payout и payout asset точно совпадают;
- topology всё ещё поддержана существующим web redemption flow.

Для v1 используется точное равенство, а не несимметричные диапазоны. Если
balance, payout, owner или canonical plan изменился, старый клик не запускает
другую операцию: endpoint возвращает `scope_changed`, а UI предлагает открыть
обычную позицию.

Claim validation не заменяет frontend revalidation. Перед approval и перед
redeem frontend снова получает account state и venue plan через существующие
API.

## 5. Persistence

Добавить пустую таблицу миграцией
`packages/db/migrations/0235_telegram_redemption_handoffs.sql`:

```text
telegram_redemption_handoffs
├── id uuid primary key
├── user_id uuid
├── telegram_user_id text
├── primary_position_id uuid
├── market_id text
├── venue_id text
├── token_hash text unique
├── source_key text
├── scope_fingerprint text
├── scope_snapshot jsonb
├── state: issued | claimed | cancelled | expired
├── claimed_by_user_id uuid nullable
├── issued_at timestamptz
├── expires_at timestamptz
├── claimed_at timestamptz nullable
├── cancelled_at timestamptz nullable
└── expired_at timestamptz nullable
```

Constraints:

- composite FK `(user_id, telegram_user_id)` связывает правильную account-link
  identity pair по тому же образцу, что `telegram_app_handoffs`; активность
  связки отдельно проверяется при issue и claim;
- `primary_position_id` ссылается на `positions(id)` с `on delete restrict`;
- `token_hash` и `scope_fingerprint` — lowercase SHA-256;
- `scope_snapshot` — JSON object;
- `expires_at > issued_at`;
- timestamps согласованы со state;
- immutable trigger запрещает менять identity, source и scope после issue;
- разрешены только `issued -> claimed | cancelled | expired` и no-op updates;
- `claimed_by_user_id`, если задан, равен `user_id`.

Индексы/uniqueness:

- unique `token_hash`;
- unique `(user_id, telegram_user_id, source_key, scope_fingerprint)` для
  безопасного retry одного Telegram delivery/card render;
- index `(user_id, state, expires_at)`;
- index `(market_id)` для retention selector;
- index `(primary_position_id)` для lifecycle/audit.

В таблице намеренно нет execution status. `claimed` означает только «клик
аутентифицирован и consent принят», а не «транзакция отправлена».

Миграция создаёт пустую структуру и не содержит data-dependent assertions или
`RAISE EXCEPTION` по историческим данным. Runtime immutable trigger допустим,
но deploy не должен зависеть от состояния старых rows.

### Token и TTL

- opaque token: `tr1_<32-byte-base64url>`;
- start parameter: `redeem_<opaque-token>`;
- в БД хранится только SHA-256 token hash;
- raw token не пишется в logs, notification JSON или analytics;
- token детерминированно восстанавливается HMAC-ом из `handoffId`, `userId` и
  `telegramUserId` с уже доступным Telegram bot secret;
- TTL по умолчанию — 10 минут;
- повторный issue с теми же `source_key + scope_fingerprint` возвращает тот же
  row/start parameter;
- новый scope создаёт новый row, старый row не мутируется.

## 6. Backend modules

Добавить узкие modules:

```text
apps/api/src/services/telegram-redemption-handoff-contract.ts
apps/api/src/services/telegram-redemption-handoff-repository.ts
apps/api/src/services/telegram-redemption-handoff.ts
apps/api/src/schemas/telegram-redemption-handoff.ts
```

Разделение ответственности:

- `contract`: prefixes, token parsing, scope types и canonical fingerprint;
- `repository`: issue/resolve/claim с короткими DB transactions и row lock;
- `service`: fresh scope inspection и orchestration;
- `schema`: публичный request/response/error contract.

Repository/token code не импортирует `apps/api/src/env.ts`. Это позволяет
использовать безопасную чистую часть из `signal-bot` sidecar без появления
новых обязательных API secrets в его import graph.

Fresh venue/network calls не выполняются внутри открытой DB transaction:

1. Resolve token + bound identity read-only.
2. Получить fresh redemption evidence.
3. Сравнить его с immutable scope.
4. Короткой transaction перечитать row и атомарно claim-нуть только `issued`
   row, который ещё не истёк.

## 7. Issue handoff

`issueTelegramRedemptionHandoff` принимает:

```ts
{
  userId: string;
  telegramUserId: string;
  sourceKey: string;
  scope: TelegramRedemptionScopeV1;
}
```

Он не подготавливает execution и не проверяет approval. Его результат:

```ts
{
  handoffId: string;
  startParam: string;
  expiresAt: string;
}
```

### Карточка позиции

Порядок выбора действия:

1. Если доступен существующий direct server redemption, сохранить его текущее
   поведение и не выпускать Mini App handoff.
2. Иначе, если scope можно точно построить и web redemption поддерживает
   topology, выпустить handoff.
3. Иначе оставить `View position`.

Кнопка:

```text
Redeem in Hunch · ≈ $X
```

### Уведомление о resolution

В `position_resolved.data` добавить `positionId`; миграция для JSON не нужна.

Только для `result = won` delivery пытается выпустить тот же exact-position
handoff. Для `lost`, неизвестного result, unsupported venue или transient scope
failure остаётся `View position`.

`deliverTelegramNotificationOutbox` получает узкий injected callback
`issueRedemptionHandoff`. `signal-bot-runner` передаёт реализацию, использующую
DB и уже загруженный Telegram bot token. Нельзя импортировать API-wide env или
runtime venue services в sidecar. Если fresh scope нельзя безопасно получить в
sidecar, producer сохраняет достаточный immutable position snapshot, а claim в
API всё равно выполняет обязательную fresh validation.

Raw token не помещается в notification payload. Callback возвращает готовый
start parameter непосредственно перед отправкой Telegram message.

## 8. Публичный API

Единственный новый публичный endpoint:

```http
POST /telegram/redemption-handoffs/claim
Content-Type: application/json
Cache-Control: no-store
```

Request:

```json
{
  "token": "tr1_...",
  "initDataRaw": "..."
}
```

Fresh claim response:

```json
{
  "ok": true,
  "handoffId": "uuid",
  "state": "claimed",
  "replayed": false,
  "autoExecute": true,
  "position": {
    "positionRef": "uuid",
    "venueId": "limitless",
    "marketId": "limitless:...",
    "outcome": "YES",
    "expectedPayoutRaw": "1000000",
    "payoutAsset": "USDC"
  }
}
```

Replay response:

```json
{
  "ok": true,
  "handoffId": "uuid",
  "state": "claimed",
  "replayed": true,
  "autoExecute": false,
  "position": {
    "positionRef": "uuid",
    "venueId": "limitless",
    "marketId": "limitless:...",
    "outcome": "YES",
    "expectedPayoutRaw": "1000000",
    "payoutAsset": "USDC"
  }
}
```

Response не содержит `actions`, `operation`, `controllerWalletRef`, calldata
или approval instructions. Frontend получает все execution facts через уже
существующие position/account/redemption-plan APIs.

### Identity и error contract

Endpoint:

- требует Hunch session;
- валидирует свежий Telegram `initData` для первого claim;
- проверяет активную composite account link;
- требует точное равенство signed `start_param` и `redeem_<token>`;
- ищет row по token hash + user + Telegram user;
- применяет rate limit по user/token и не логирует raw inputs;
- лениво переводит просроченный `issued` row в `expired`;
- возвращает стабильные codes: `invalid_token`, `identity_mismatch`,
  `start_param_mismatch`, `expired`, `scope_changed`, `not_redeemable`,
  `unsupported_topology`.

Для уже claimed row допустима та же ограниченная stale-initData логика, что у
существующего handoff, но только после повторной проверки signature, immutable
Telegram identity и принадлежности row. Такой replay всегда возвращает
`autoExecute: false`.

## 9. Защита от двойной отправки

Так как handoff не создаёт durable execution operation, он не может безопасно
обещать автоматический crash recovery после неизвестного момента broadcast.
Поэтому v1 использует строгую one-shot dispatch authority:

- atomic `issued -> claimed` выигрывает ровно один request;
- только победитель получает `autoExecute: true`;
- все параллельные tabs и повторные открытия получают `autoExecute: false`;
- replay никогда автоматически не вызывает approval или redeem;
- frontend дополнительно держит in-memory guard по `handoffId`;
- существующие wallet single-flight keys и venue protections сохраняются.

Если победивший tab закрылся после claim, но до broadcast, повторное открытие
показывает `Already opened` и кнопку перехода к обычной позиции. Пользователь
может выполнить обычный Redeem flow или получить новый handoff; автоматический
replay запрещён.

Это намеренный safety trade-off. Полный automatic crash recovery потребовал бы
durable submission/reconciliation state machine. Его нельзя незаметно
реализовать consent-таблицей; это отдельная v2 задача.

После wallet rejection в том же живом Mini App можно показать `Retry`: отказ
доказывает отсутствие broadcast, а повтор вызывает тот же существующий
frontend method. После неизвестной ошибки submission автоматический retry
запрещён; UI сначала проверяет receipt/position state.

## 10. Frontend implementation

### Routing

Расширить `Hunch_App/src/lib/telegram/startapp.ts` новым target:

```ts
{
  kind: "redemptionHandoff";
  token: string;
  path: `/redeem-handoff?token=${string}`;
}
```

Parser принимает только точный `redeem_tr1_<base64url>` формат. Существующие
`handoff_`, `b_`, `m_`, referral и wallet formats не меняются.

`TelegramMiniAppRuntime` использует существующий auth/link transition, затем
открывает `/redeem-handoff?token=...`. Token удаляется из browser URL после
успешного claim через history replacement и не попадает в analytics.

### Redemption handoff surface

Новая route/surface имеет состояния:

```text
authenticating
claiming
checking_position
checking_approval
approving
redeeming
confirming
completed
already_opened
failed
```

Для `autoExecute=true`:

1. По `positionRef` загрузить существующие Position и Market models.
2. Создать те же `usePolymarketRedemption` или `useLimitlessRedemption` inputs,
   что desktop/mobile redemption UI.
3. Дождаться завершения account и redemption-plan queries.
4. Если `approvalsRequired`, вызвать существующий `approveAll()`.
5. Дождаться refetch, подтверждающего approval.
6. Вызвать существующий `redeem()`; этот method ещё раз refetch-ит plan.
7. Дождаться существующего success callback, marker persistence и position
   sync/postcondition.
8. Показать `Redemption completed` и вызвать Telegram WebApp close.

Для `autoExecute=false` frontend ничего не подписывает и не отправляет. Он
показывает `This redemption link was already opened` и безопасные действия
`View position`/`Close`.

### Переиспользование без duplication

Не нужно импортировать presentation целого desktop dialog в Telegram route.
Нужно вынести минимальную общую orchestration-модель из существующих dialog и
drawer либо добавить к ней `auto` adapter. Canonical logic остаётся внутри
`usePolymarketRedemption` и `useLimitlessRedemption`.

Нельзя:

- заново строить approval calldata;
- доверять approval target из query string/claim response;
- отправлять backend-provided actions;
- писать новый generic EVM executor;
- обходить Deposit Wallet relayer path;
- считать embedded wallet обязательным.

### Completion semantics

Нельзя показывать `completed` только потому, что wallet prompt закрылся.

- Для direct transaction нужен успешный receipt.
- Для relayer path нужен accepted transaction hash и существующий backend
  marker/sync.
- Marker failure показывает `submitted, tracking delayed`, а не ложный failure
  и не повторяет transaction.
- Если position sync не успел подтвердить postcondition в ограниченное время,
  Mini App показывает `Redemption submitted` с `View position`, не отправляет
  повторно и не закрывается как completed.
- `redemption_completed` notification остаётся источником асинхронного
  подтверждения после закрытия/таймаута.

## 11. Consent copy

Кнопка и соседний текст должны честно раскрывать автоматическое продолжение.

Короткая кнопка:

```text
Redeem in Hunch · ≈ $X
```

Обязательная copy в карточке или сообщении:

```text
Tapping Redeem opens Hunch and starts redemption of this market position
automatically. If the canonical redemption adapter is not approved yet,
Hunch requests that approval first. Your wallet may ask you to authorize
transactions.
```

Claim фиксирует согласие именно с этой версией copy и scope fingerprint.
Изменение смысла copy требует новой contract/copy revision в scope.

## 12. Retention и user lifecycle

Новая таблица содержит position/market/user references, поэтому одновременно с
миграцией нужно обновить:

- market retention protected references;
- retention selection report и delete report;
- cleanup/delete path;
- user financial lifecycle preview/delete;
- admin user merge preview/execute либо явный merge blocker;
- privacy/account deletion audit.

Предлагаемые сроки:

- unclaimed token TTL: 10 минут;
- `expired`/`cancelled` cleanup: после 30 дней;
- `claimed` consent audit cleanup: после 90 дней, если нет активной financial
  reference и политика аудита не требует большего срока.

До cleanup любой row с `market_id` защищает market от hard delete. Cleanup
должен быть bounded, иметь dry-run/report и не удалять активные `issued` rows.

## 13. OpenAPI и observability

Добавить request/response/error schemas в backend OpenAPI и регенерировать
frontend API types через `bun run api:types`.

Структурированные counters/logs без raw token/initData:

- `telegram_redemption_handoff_issued`;
- `telegram_redemption_handoff_claimed`;
- `telegram_redemption_handoff_replayed`;
- `telegram_redemption_handoff_expired`;
- `telegram_redemption_handoff_scope_changed`;
- `telegram_redemption_handoff_button_fallback`;
- frontend stages `approval_started`, `redeem_started`, `submitted`,
  `completed`, `tracking_delayed`, `wallet_rejected` keyed by handoff ID.

Нельзя писать в logs owner secrets, raw token, `initDataRaw`, signatures или
calldata.

## 14. Обязательные тесты

### Backend

- миграция проходит на disposable PostgreSQL той же major version;
- SQL identifiers проверены на PostgreSQL keyword collisions;
- issue retry возвращает тот же handoff/start parameter;
- новый fingerprint создаёт новый immutable row;
- wrong Hunch user, Telegram user, token и signed start parameter отклоняются;
- fresh `initData` требуется для первого claim;
- expired handoff атомарно становится `expired`;
- transferred/hidden/redeemed position отклоняется;
- изменённый owner binding, component balance, payout или plan fingerprint
  возвращает `scope_changed`;
- два параллельных claim: ровно один `autoExecute=true`;
- claimed replay всегда `autoExecute=false`;
- response никогда не содержит actions, calldata или wallet refs;
- won notification получает Redeem, lost notification — только View position;
- issue failure не ломает delivery и оставляет View position;
- direct server Polymarket redemption сохраняет приоритет;
- raw token и initData отсутствуют в structured logs;
- market retention, user delete и admin merge учитывают новую таблицу;
- signal-bot import graph не достигает API-wide required env.

### Frontend

- `redeem_` parser принимает только точный token format;
- Telegram auth заканчивается до claim;
- token удаляется из URL после claim;
- fresh claim автоматически запускает flow без Hunch Confirm;
- replay/second tab не запускает wallet actions;
- approval present: `approveAll` пропускается, `redeem` вызывается один раз;
- approval missing: существующий `approveAll` завершается до `redeem`;
- после approval plan обязательно refetch-ится;
- embedded и external wallet paths не фильтруются по custody label;
- Polymarket Safe/proxy/Deposit Wallet продолжают использовать существующие
  adapters;
- wallet rejection разрешает controlled retry только в живой сессии;
- unknown submission error не вызывает автоматический retry;
- marker/sync timeout показывает submitted, а не completed;
- completed закрывает Telegram WebApp;
- regressions для существующих trade handoff/start params отсутствуют.

### Проверочные команды

Backend:

```text
pnpm typecheck
pnpm lint
pnpm check
```

Frontend:

```text
bun run api:types
bun run type-check
bun run lint
bun run check
```

Также обязательны narrow integration suites, `git diff --check` и реальный
PostgreSQL parse/execute новой migration. TypeScript и lint не доказывают
валидность SQL.

## 15. Порядок реализации и rollout

### Шаг 1. Persistence и contract

- migration + repository + immutable scope;
- retention/user lifecycle updates;
- unit/integration tests;
- feature остаётся недоступной пользователю.

### Шаг 2. Backend API

- общий Telegram identity helper;
- fresh redemption scope inspector;
- `POST /telegram/redemption-handoffs/claim`;
- OpenAPI и generated client types;
- кнопки пока не выпускаются.

### Шаг 3. Web Mini App

- start parameter routing;
- handoff route/surface;
- auto orchestration поверх существующих redemption hooks;
- replay/double-tab safety;
- completion/tracking states.

Frontend support должен быть deployed до появления Telegram-кнопок.

### Шаг 4. Position card

- включить handoff button только при подтверждённой frontend contract version;
- сохранить direct server redemption priority и View position fallback;
- начать с внутренней canary-аудитории.

### Шаг 5. Won notification

- добавить `positionId`;
- injected issue callback в notification delivery;
- включить Redeem только для `result=won`;
- проверить реальный Telegram mobile flow для embedded и external wallets.

### Rollback

Rollback — перестать выпускать новые Redeem buttons/start parameters. Уже
выпущенные handoffs остаются ограничены TTL и sealed scope. Таблица и claim
endpoint могут безопасно остаться до обычного cleanup; откатывать migration и
удалять audit rows не нужно.

## 16. Acceptance criteria

Готово, когда одновременно выполнено следующее:

- Telegram click является единственным Hunch product confirmation;
- Mini App остаётся web frontend и не вводит backend-controlled wallet;
- claim возвращает только consent/position metadata, а не wallet actions;
- approval обнаруживается и исполняется существующим frontend flow;
- redeem исполняется тем же venue-specific frontend flow, что обычный UI;
- ни один wallet topology не разрешается через новый обходной batch;
- два tabs не могут автоматически отправить две операции;
- replay не выполняет финансовое действие;
- scope/owner/balance/payout change fail closed;
- won notification имеет Redeem CTA, а безопасный fallback всегда доступен;
- `completed` означает подтверждённый успех, а uncertain submission не
  повторяется;
- retention, user lifecycle, OpenAPI, PostgreSQL tests и frontend/backend checks
  пройдены;
- Buy/Sell, funding, direct server redemption и существующий обычный Redeem UI
  не изменили поведение.

## 17. Явно отклонённые элементы первоначального варианта

Следующее не входит в реализацию:

- eligibility по `managed internal EVM wallet`;
- возврат approval/redeem actions из `claim`;
- `controllerWalletRef` в handoff response;
- создание `position_action_operation` при claim;
- backend grouping `approval + redeem`;
- новый `evm_transaction_batch` ради Telegram;
- требование `privy_wallet_send_calls`;
- новый normalized action executor во frontend;
- автоматический broadcast при повторном открытии claimed link.

Причина одна: web frontend уже умеет проверить approval и выполнить approval +
redeem для поддерживаемой wallet topology. Redemption handoff должен добавить
только authenticated consent и безопасный запуск этого существующего flow, а
не становиться второй финансовой state machine.
