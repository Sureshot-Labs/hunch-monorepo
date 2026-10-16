# Интересы и серверный прогресс онбординга Hunch

Контракт v1. Реализация: `hunch-monorepo`, миграция `0281_user_onboarding.sql`.

Первая поставка сохраняет выбранные интересы в Hunch-аккаунте и позволяет восстановить серверный прогресс онбординга после повторного входа или смены устройства. Персонализация Home вынесена в отдельную задачу по решению пользователя. В этой поставке выдача лент не меняется.

Документ сохраняет согласованные продуктовые правила и описывает реализованный серверный контракт. Подключение iOS выполняется отдельной поставкой. Ни один из новых endpoints не является условием доступа к старым API.

## 1. Реализация

Маршруты: `apps/api/src/routes/onboarding.ts`; Zod/OpenAPI: `schemas/onboarding.ts`; транзакционный сервис: `services/onboarding-service.ts`; чистые переходы и merge: `services/onboarding-state.ts`.

Миграция добавляет cohort-маркер в users, каталог, `user_onboarding_state` и `user_interests`. Набор интересов и результат шага изменяются одной транзакцией. Auth response и существующие feed-контракты не меняются.

Профиль вызывает `recordOnboardingProfileWrite` внутри своей транзакции после UPDATE. Account deletion очищает данные в `clearUserSocialData`; полный и keepSource merge вызывают `mergeUserOnboardingData` после переноса профиля/asset ownership и до удаления source. Привилегированный merge сохраняет существующую поддержку inactive source; персональные GET/мутации для неактивного аккаунта запрещены.

## 2. Что подтверждено и что уточнено

Приложенный `BACKEND_ONBOARDING.md` от 14 октября в основном актуален и совпадает с копией в `hunch-ios/docs`. Серверные методы интересов и прогресса отсутствуют и в проверенном `origin/develop`. Наличие отдельных Telegram onboarding/interest механизмов не означает наличие этой функции: они обслуживают другие процессы.

| Область                | Фактическое состояние и следствие                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Интересы iOS           | Девять ID, пустой `Set`, минимум три для Continue. Callback не передаёт выбранный набор дальше. Backend-поставка сама по себе клиент не подключит.                           |
| Восстановление iOS     | Сохраняется локальный `onboardingPending`, но не текущий шаг. При повторном показе флоу снова начинается с interests.                                                        |
| Профиль и follow       | Методы уже есть. Handle сохраняется через profile PATCH. Аватар: signed PUT → upload complete → profile PATCH. Follow выполняется сразу при выборе.                          |
| Фото                   | Continue разрешён и без фото. Это пропуск, а не подтверждение сохранённого аватара.                                                                                          |
| Passkey и push         | Passkey link реально вызывается через Privy SDK. Экран notifications хранит локальные переключатели; полноценной push-интеграции здесь нет.                                  |
| Traders                | Экран показывается при ≥3 разных рекомендациях. При ошибке или 0–2 результатах пропускается. Число рекомендаций не является минимальным числом подписок.                     |
| Home                   | iOS вызывает `/social/feed?source=thesis&mode=all&limit=20`. `/feed/for-you` — другой API событий на основе истории действий; без истории/Redis он возвращает пустую выдачу. |
| Документация прототипа | В `docs/PROTOTYPE.md` iOS остались устаревшие утверждения о выбранном US elections и локальном passkey. Для этого ТЗ источником поведения служит текущий код.                |

`isNewUser` по-прежнему означает создание Hunch-аккаунта. Не переопределять его как незавершённый онбординг.

## 3. Границы первой поставки

Реализовать каталог интересов, чтение и полную замену выбора, явный Skip, серверный прогресс, идемпотентное завершение, миграцию legacy-аккаунтов, обработку account merge/deletion, тесты и документацию для последующего подключения iOS.

Не входят: изменения iOS/веба, ранжирование или фильтрация лент, изменения индексаторов, topic classification, backfill событий, торговля, баланс, аналитика, новая Privy/Passkey-аутентификация, push-инфраструктура, админский интерфейс каталога.

Новые функции не должны блокировать вход, торговлю, старые Social API или веб на основании статуса онбординга.

## 4. Интересы и каталог

Сохранить текущие iOS ID без переименования. Это самостоятельный продуктовый каталог, а не динамическая выдача `/meta/categories`.

| ID              | Label         | Связь с имеющейся таксономией для будущей персонализации                              |
| --------------- | ------------- | ------------------------------------------------------------------------------------- |
| `usElections`   | US elections  | Отдельная тема внутри politics; точное соответствие ещё нужно реализовать.            |
| `politics`      | Politics      | Широкая category `politics`.                                                          |
| `technology`    | Technology    | Category `technology`.                                                                |
| `sports`        | Sports        | Category `sports`.                                                                    |
| `culture`       | Culture       | Сейчас широкая нормализация в entertainment; для отличия от Entertainment нужна тема. |
| `economy`       | Economy       | Явное соответствие category `economics`.                                              |
| `geopolitics`   | Geopolitics   | Сейчас нормализация в politics; нужна отдельная тема.                                 |
| `trump`         | Trump         | Отдельная тема; одной category politics недостаточно.                                 |
| `entertainment` | Entertainment | Широкая category `entertainment`.                                                     |

Каталог v1 фиксирован миграцией/кодом: ID, label, `enabled`, `sortOrder`, `catalogVersion=1`, `minSelections=3`. Все девять пунктов первоначально доступны. Изображения, иконки и раскладка принадлежат iOS.

Правила записи:

1. Начальный выбор пустой. Никаких автоматически выбранных интересов.
2. `completed`: минимум три **разных** включённых ID. Повторы нормализуются до проверки минимума; три копии одного ID не проходят.
3. `skipped`: только пустой массив. Не принимать непустой Skip и не превращать пустой Continue в Skip автоматически.
4. Запись заменяет набор целиком в одной транзакции. Удалённые ID действительно удаляются.
5. Неизвестные или отключённые ID в новой записи отклоняются целиком. Существующие сохранённые отключённые пункты можно читать; отключение каталога не стирает выбор и не запускает онбординг заново.
6. Считать минимум по ID каталога, даже если три интереса относятся к одной широкой category politics. Не подменять исходные ID категориями.
7. Набор принадлежит `users.id`. Другой привязанный метод входа в тот же аккаунт читает те же данные. Guest не может сохранять персональные данные.
8. Порядок возвращаемых ID детерминирован по каталогу; порядок присланного массива не является предпочтением ранжирования.

## 5. Контракт API

Request/response схемы зарегистрированы в Fastify/OpenAPI. Формат ошибок — `{ "error": "code" }`; conflict/incomplete ответы также содержат каноническое поле `onboarding`.

| Метод                                | Назначение                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `GET /users/interests`               | Каталог, публичный, без данных аккаунта.                                              |
| `GET /users/me/onboarding`           | Каноническое состояние и сохранённые `interestIds`. Отдельный GET интересов не нужен. |
| `PUT /users/me/interests`            | Полная замена выбора или явный Skip; одновременно обновляет шаг interests.            |
| `PATCH /users/me/onboarding`         | Результат одного другого шага. Не принимает произвольный общий status или userId.     |
| `POST /users/me/onboarding/complete` | Явное идемпотентное завершение.                                                       |

Для всех `/me` использовать существующую обязательную Hunch Bearer-сессию; для мутаций — существующий CSRF-механизм с `x-csrf-token`. Владельца брать только из сессии. Применить действующие проверки состояния аккаунта и уместные существующие write rate limits. Новые персональные ответы — `Cache-Control: private, no-store`; не добавлять интересы в публичный профиль или общий Redis-кеш.

Каталог:

```json
{
  "catalogVersion": 1,
  "minSelections": 3,
  "items": [
    {
      "id": "usElections",
      "label": "US elections",
      "enabled": true,
      "sortOrder": 0
    },
    { "id": "politics", "label": "Politics", "enabled": true, "sortOrder": 1 },
    {
      "id": "technology",
      "label": "Technology",
      "enabled": true,
      "sortOrder": 2
    },
    { "id": "sports", "label": "Sports", "enabled": true, "sortOrder": 3 },
    { "id": "culture", "label": "Culture", "enabled": true, "sortOrder": 4 },
    { "id": "economy", "label": "Economy", "enabled": true, "sortOrder": 5 },
    {
      "id": "geopolitics",
      "label": "Geopolitics",
      "enabled": true,
      "sortOrder": 6
    },
    { "id": "trump", "label": "Trump", "enabled": true, "sortOrder": 7 },
    {
      "id": "entertainment",
      "label": "Entertainment",
      "enabled": true,
      "sortOrder": 8
    }
  ]
}
```

Первый GET нового аккаунта:

```json
{
  "flowVersion": 1,
  "revision": 0,
  "status": "not_started",
  "completionReason": null,
  "completedAt": null,
  "nextStep": "interests",
  "interestIds": [],
  "steps": {
    "interests": { "status": "pending", "reason": null },
    "handle": { "status": "pending", "reason": null },
    "photo": { "status": "pending", "reason": null },
    "passkey": { "status": "pending", "reason": null },
    "notifications": { "status": "pending", "reason": null },
    "traders": { "status": "pending", "reason": null }
  }
}
```

`PUT /users/me/interests` для Continue:

```json
{
  "expectedRevision": 0,
  "outcome": "completed",
  "interestIds": ["politics", "technology", "sports"]
}
```

Для Skip, как альтернативный первый запрос:

```json
{ "expectedRevision": 0, "outcome": "skipped", "interestIds": [] }
```

Оба запроса возвращают **полный канонический объект состояния** той же формы, что GET. После первого успешного запроса `revision=1`, `status=in_progress`, `nextStep=handle`, шаг interests получает соответствующий status. Выбранные ID возвращаются в ответе; при Skip массив пустой.

Пример явного пропуска handle:

```json
{
  "expectedRevision": 1,
  "step": "handle",
  "outcome": "skipped",
  "reason": "user_skipped"
}
```

Пример неприменимого необязательного шага:

```json
{
  "expectedRevision": 4,
  "step": "traders",
  "outcome": "not_applicable",
  "reason": "insufficient_suggestions"
}
```

Завершение после обработки всех шагов:

```json
{ "expectedRevision": 6 }
```

Числа revision в примерах иллюстративны: клиент всегда использует последнюю полученную revision. Profile PATCH также может её увеличить.

Ошибки:

- `400 invalid_request`: некорректная форма, неожиданные поля, неизвестный step/outcome, непустой Skip.
- `400 invalid_interest`: неизвестный/отключённый ID; `400 too_few_interests`: меньше трёх разных ID для completed.
- Существующие `401`/`403` для auth/CSRF/состояния аккаунта, `429` для rate limit.
- `409 onboarding_revision_conflict`: конфликт версии; вернуть актуальный объект в поле `onboarding`.
- `409 onboarding_revision_exhausted`: дальнейшее увеличение revision не помещается в безопасный JSON integer; состояние не изменяется.
- `409 onboarding_incomplete`: незавершённые обязательные для обработки шаги; вернуть актуальный объект.
- `409 onboarding_completed`: попытка изменить прогресс уже завершённого флоу, кроме безопасного повтора.
- `409 onboarding_step_evidence_missing`: completed для handle/photo без соответствующих сохранённых данных.

Проверять JSON строго: `userId`, `completedAt`, `status`, `revision` вместо `expectedRevision` и произвольный объект steps не должны давать клиенту возможность переписать серверное состояние.

## 6. Переходы и правила шагов

Общий статус: `not_started` → `in_progress` → `completed`. GET ничего не начинает. Первая успешная мутация enrolled-аккаунта переводит его в in_progress. Повторный вход не создаёт новый флоу.

Состояние шага: `pending`, `completed`, `skipped`, `not_applicable`. PATCH не принимает переход обратно в pending. Порядок `nextStep`: interests → handle → photo → passkey → notifications → traders; выбирается первый pending. Пока не обработан interests, записи остальных шагов отклоняются как `onboarding_incomplete`.

| Шаг           | Правило                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| interests     | Только PUT интересов. completed требует ≥3 допустимых ID; skipped требует пустой набор; клиент не может записать not_applicable. Серверное legacy-исключение описано в разделе 8.                                  |
| handle        | Можно пропустить. Completed подтверждает сохранённый валидный handle, но само наличие автоматически выданного handle не завершает шаг.                                                                             |
| photo         | Можно пропустить. Completed подтверждает уже привязанный к профилю готовый avatar asset. Upload complete без profile PATCH недостаточно. Continue без фото трактуется как skipped.                                 |
| passkey       | Необязательный. Completed означает обработку шага клиентом после успешного link; это не серверное доказательство наличия credential и не основание выдавать доступ. Skip/недоступная capability не блокируют флоу. |
| notifications | Необязательный. В текущей интеграции использовать not_applicable с `feature_unavailable`, пока нет полноценного подключения. Не интерпретировать шаг как OS permission или серверную подписку.                     |
| traders       | Completed означает обработанный экран, допустим с нулём новых подписок. <3 distinct suggestions — not_applicable; ошибка загрузки — skipped. Никаких автоматических follow.                                        |

Для skipped использовать ограниченные reason-коды `user_skipped`, `no_photo`, `suggestions_unavailable`; для not_applicable — `feature_unavailable`, `capability_unavailable`, `insufficient_suggestions`. Ограничить их допустимость соответствующими шагами в схемах/сервисе. Не принимать произвольные тексты ошибок устройства.

Если необязательный шаг выключен клиентом или не поддерживается, клиент явно сохраняет not_applicable и идёт дальше. Ни passkey, ни notifications, ни наличие подписок не являются условиями завершения.

POST complete требует terminal-результат всех шести шагов; пропуск — полноценный terminal-результат. Он не превращает необработанные шаги в «успешно выполненные». Когда все шаги terminal, но POST complete ещё не вызван, состояние остаётся in_progress, `nextStep=null`; клиент должен повторить completion. После завершения `nextStep=null`, `completionReason=flow`, `completedAt` устанавливается сервером единожды.

### Успешное сохранение профиля и прерывание

В существующий `SocialService.updateProfile` добавлен транзакционный hook для enrolled-флоу, который уже находится in_progress:

- Успешный PATCH с явно переданным handle, включая подтверждение прежнего значения, помечает handle completed в той же транзакции.
- Успешный PATCH с non-null готовым `avatarAssetId`, действительно привязанным к этому пользователю, помечает photo completed в той же транзакции.
- Ошибка/rollback не меняет шаг; удаление аватара и displayName/bio-only PATCH не отмечают photo/handle completed.
- Завершённые и legacy-аккаунты не запускают флоу заново. Обычная запись профиля до начала флоу тоже не запускает его.
- Старый response профиля сохраняется. Будущий клиент перечитывает onboarding после PATCH, чтобы получить новую revision.

Profile/follow/asset данные остаются в существующих таблицах. Не копировать handle, avatar и списки подписок в steps. Явный PATCH шага handle/photo допустим для восстановления, но только после проверки уже сохранённых данных.

## 7. Конкуренция и повторы

Общий `revision` относится к выбору и прогрессу одного аккаунта. `expectedRevision` — обязательное неотрицательное целое в безопасном диапазоне JSON integer. Все мутации выполняются в транзакции и используют единый порядок блокировок: `users` → onboarding state → дочерние интересы. Это согласуется с существующими profile/deletion/merge critical sections.

1. Нормализовать запрос, проверить авторизацию и допустимость операции, заблокировать пользователя, получить состояние.
2. Если запрошенный результат уже совпадает с текущим, вернуть 200 с текущим состоянием без изменения revision/timestamp. Это безопасный повтор, включая изменённый порядок ID.
3. Если результат отличается, требуется точное равенство `expectedRevision` текущей revision. При любом несовпадении, включая присланную «будущую» версию, вернуть 409 и актуальное состояние, не применять ничего.
4. При успешном реальном изменении увеличить revision один раз. Нельзя отдельно коммитить удаление старых интересов, вставку новых и изменение шага.
5. POST complete для уже completed возвращает исходное состояние и время даже со старой revision.
6. Запоздалый progress PATCH никогда не возвращает completed в in_progress и не меняет completedAt.

Пример: устройство A сохранило набор A при revision 0; B прочитало revision 1 и сохранило B; повтор первого запроса A с revision 0 должен получить conflict, а не восстановить набор A.

PUT интересов можно использовать после завершения/для legacy, если клиент прочитал актуальную revision. Он меняет текущий выбор и результат шага interests, но не общий completed и не исходный completedAt/completionReason. Это явная последующая правка предпочтений. Устаревшая запись до завершения должна конфликтовать, если она меняет данные.

## 8. Хранение и legacy миграция

Используемая модель:

- `users.onboarding_version smallint`: 0 — существующий аккаунт освобождён от флоу, 1 — аккаунт должен пройти flow v1 в клиенте, который его использует.
- Небольшой серверный каталог `onboarding_interests` с девятью seed-строками, устойчивым ID, label, enabled, sort_order. Никакой зависимости от наличия событий в категории.
- `user_onboarding_state`: PK/FK user_id, flow_version, revision, status, completion_reason, completed_at, steps, timestamps. Steps — ограниченный JSONB с фиксированными ключами и проверкой схемы; без копий профиля.
- `user_interests`: PK `(user_id, interest_id)`, FK на пользователя и каталог. FK на пользователя с ON DELETE CASCADE. Не удалять catalog ID при отключении.

Каталог имеет единственный источник значений — seed-строки БД. `catalogVersion=1`, `minSelections=3` задаются контрактом v1. GET читает state и interestIds одним SQL statement; он не видит частично сохранённый выбор. Шаги ограничены Zod-схемой на границе записи/чтения, а SQL CHECK фиксирует ключи и инвариант общего завершения.

Миграция в одной транзакции добавляет `users.onboarding_version NOT NULL DEFAULT 0`, затем меняет DEFAULT на 1 для будущих INSERT. Таким образом, существующие строки остаются cohort 0 без массовой записи interests/state, а новые аккаунты автоматически получают 1 во всех существующих путях создания. Не определять legacy по отсутствию state-строки: её нет и у нового аккаунта до первой мутации.

GET без state-строки синтезирует:

- cohort 0: completed, `completionReason=legacy`, `completedAt=null`, `nextStep=null`, `interestIds=[]`, все шаги not_applicable с `reason=legacy_exempt`;
- cohort 1: not_started, revision 0, все шаги pending, пустые интересы.

`legacy_exempt` — только серверный reason, клиент его записывать не может. `completedAt=null` при legacy — намеренное исключение: историческое время прохождения неизвестно, его нельзя выдумывать. При пользовательском завершении flow время обязательно.

Создавать state лениво при первой мутации. Наличие state у legacy после изменения интересов не отменяет освобождение от флоу. GET не записывает данные.

Аккаунты, созданные на вебе **после миграции**, тоже cohort 1. Веб продолжает работать без новых запросов; при первом использовании будущего iOS-клиента такой аккаунт получит онбординг. Старые аккаунты, включая незавершённый локальный iOS-флоу до миграции, освобождаются от повторного запуска. Это осознанное правило перехода первой версии.

Проверить все актуальные INSERT/merge/import пути на момент реализации. Миграция этой поставки — `0281_user_onboarding.sql`. Не редактировать применённые миграции. Проверить upgrade и повторный запуск мигратора, ограничения/индексы и короткий DDL lock на PostgreSQL 16.

## 9. Удаление и объединение аккаунтов

При hard delete дочерние записи удаляются каскадно. При soft/retained delete явно удалить интересы и прогресс через существующий lifecycle до сохранения финансового tombstone. Одного FK CASCADE недостаточно. Запоздалый запрос старой сессии не должен восстановить данные удалённого аккаунта.

При полном merge:

- Явный выбор target, включая явный Skip, сохраняется. Source переносится только если у target нет явного решения: interests pending **или** server-only not_applicable/legacy_exempt. Освобождение legacy от флоу не означает отказ от интересов. Не объединять два набора через union.
- Если target уже completed, сохранить его статус и время. Если completed только source, перенести общий completed и исходное время/completionReason; legacy-освобождение также не должно приводить к новому флоу или выдуманной дате. Это не разрешает копировать весь state поверх явного target-выбора: интересы и steps объединяются по указанным приоритетам. Для terminal-результата незаполненные шаги получают подходящие terminal-результаты source; при legacy exemption допустим серверный legacy_exempt. `nextStep` остаётся null.
- Если оба флоу незавершены, сохранить уже обработанные шаги target; переносить подходящие source-результаты только в pending. Для handle/photo проверять фактически оставшиеся данные профиля после merge. Если completed source завершает флоу target, но его поле профиля не перенеслось, соответствующий pending шаг target получает server-only `not_applicable/profile_not_transferred`; это не означает пользовательский Skip. Если оба флоу ещё незавершены, такой шаг остаётся pending.
- Если merge меняет предпочтения, шаги или общий статус, увеличить revision target. Merge без изменения onboarding-состояния сохраняет revision: такой no-op не делает ранее прочитанное состояние устаревшим. Повтор merge безопасен.
- Обработать существующий режим `keepSource`: поскольку source остаётся отдельным аккаунтом, не стирать его предпочтения/прогресс; target применяет те же правила приоритета и получает собственные записи. Проверить оба режима тестами.

Использовать существующий порядок блокировки обоих users и ту же транзакцию merge. Не менять финансовую семантику объединения. Если current merge перемещает профиль после social hook, учитывать это при расположении onboarding hook.

## 10. Передача контракта iOS

В этой задаче iOS не редактировать. В backend-документации дать следующую последовательность будущего подключения:

1. После успешного login/exchange или `/auth/me` вызвать `GET /users/me/onboarding`. Старые auth response и `isNewUser` оставить без изменения.
2. completed → приложение; иначе открыть `nextStep`, загрузив сохранённые interestIds. Для `in_progress` с `nextStep=null` повторить POST complete.
3. Каталог получать с сервера, оформление сопоставлять по девяти ID. Не создавать выбор из локальных дефолтов.
4. Continue/Skip интересов ждут успешного PUT и используют возвращённое состояние.
5. Handle/avatar сохраняются прежними API; затем GET состояния. Для Skip и неприменимых шагов — progress PATCH.
6. При 409 использовать актуальное состояние и согласовать экран с ним; не повторять старый выбор автоматически с подставленной новой revision.
7. Traders: <3 distinct recommendations → not_applicable; ошибка → skipped. `HUNCH_ONBOARDING_ALWAYS_SHOW_TRADERS` остаётся UI-флагом. Ничего автоматически не подписывать и не переотправлять готовые follow при completion.
8. Завершать локальную сессию онбординга после успешного POST complete или получения completed. Сетевая ошибка не равна Skip и не доказывает завершение.

Без этого последующего изменения клиента текущий iOS продолжит хранить интересы локально. Backend readiness и интеграция экрана — разные критерии готовности.

## Примеры подключения

Переменные ниже задаются клиентом/тестовым окружением; не сохранять реальные bearer/CSRF в документации или логах.

```sh
curl --fail-with-body "$HUNCH_API_URL/users/interests"
curl --fail-with-body "$HUNCH_API_URL/users/me/onboarding" \
  -H "Authorization: Bearer $HUNCH_TOKEN"
curl --fail-with-body -X PUT "$HUNCH_API_URL/users/me/interests" \
  -H "Authorization: Bearer $HUNCH_TOKEN" -H "x-csrf-token: $HUNCH_CSRF" \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":0,"outcome":"completed","interestIds":["politics","technology","sports"]}'
curl --fail-with-body -X PATCH "$HUNCH_API_URL/users/me/onboarding" \
  -H "Authorization: Bearer $HUNCH_TOKEN" -H "x-csrf-token: $HUNCH_CSRF" \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":1,"step":"handle","outcome":"skipped","reason":"user_skipped"}'
```

Для Skip интересов отправить PUT с `outcome=skipped`, `interestIds=[]` и актуальной revision. Все мутации возвращают полный state, который становится базой следующего запроса. После обработки остальных шагов:

```sh
curl --fail-with-body -X POST "$HUNCH_API_URL/users/me/onboarding/complete" \
  -H "Authorization: Bearer $HUNCH_TOKEN" -H "x-csrf-token: $HUNCH_CSRF" \
  -H 'Content-Type: application/json' --data '{"expectedRevision":6}'
```

Число 6 подходит только для примера, где каждый шаг был обработан ровно одной мутацией. При profile hook или повторной правке брать revision из последнего ответа/GET.

## 11. Проверки и критерии приёмки

| Сценарий                                   | Ожидаемый результат                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Новый аккаунт / первый GET                 | Пустые интересы, not_started; GET не создаёт state.                                                                                                                                          |
| 0–2 ID, повторы, три политических ID       | Первые варианты отклоняются по distinct-count; `usElections,politics,trump` принимаются как три разных интереса.                                                                             |
| Полная замена                              | Старые удалённые ID исчезают; массив нормализован; одна атомарная запись.                                                                                                                    |
| Skip                                       | Пустой набор + skipped; он отличается от pending. Непустой Skip отклонён.                                                                                                                    |
| Неизвестный/отключённый ID                 | Вся запись отклонена; прежнее состояние сохранено.                                                                                                                                           |
| Auth/CSRF/изоляция                         | Guest, неверный токен/CSRF и запись чужого userId отклонены; публичный профиль не раскрывает интересы.                                                                                       |
| Повторный вход / другой метод / устройство | Тот же user_id читает тот же выбор и прогресс.                                                                                                                                               |
| Handle/avatar                              | Успех профильной записи атомарно продвигает начатый флоу; отказ/rollback не продвигает; один upload complete не завершает photo.                                                             |
| Прерывание                                 | После сохранения профиля и потери клиента профиль и шаг восстановлены; готовые follow не повторяются.                                                                                        |
| Все шаги пропущены явно                    | Completion успешен; passkey/push/фото/подписки не требуются. Необработанный interests завершение блокирует.                                                                                  |
| Traders                                    | 0, 1, 2 distinct suggestions и ошибка допускают указанный пропуск; ≥3 не требуют follow.                                                                                                     |
| Повторы и гонки                            | Реальные параллельные транзакции: duplicate PUT, два разных набора, complete против stale PATCH, profile hook против PUT; нет потерянных обновлений и отмены completed.                      |
| Повтор complete                            | Тот же completedAt, без новой revision и дополнительных записей.                                                                                                                             |
| Редактирование после completed             | Актуальный PUT меняет интересы, не запускает флоу заново. Stale PUT не перетирает выбор.                                                                                                     |
| Миграция                                   | Legacy completed без вымышленных даты/интересов; новые INSERT cohort 1; повтор мигратора не меняет когорты.                                                                                  |
| Merge/delete                               | Explicit target Skip сохраняется; source переносится в pending или legacy без явного решения, но не затирает явный выбор; full/keepSource merge; hard/soft delete; гонка записи с удалением. |
| Совместимость                              | Старые auth/profile/follow/feed requests и response-схемы сохраняются; веб не получает новый gate.                                                                                           |
| OpenAPI                                    | Все новые endpoints, terminal/legacy состояния, error codes и JSON-примеры соответствуют реальной сериализации.                                                                              |

Использовать существующий test runner и добавить onboarding suites в подходящий запускаемый набор; не оставлять их вне CI/команд проверки. Нужны unit/route tests с `app.inject` и интеграционные тесты настоящего PostgreSQL, особенно для миграции, CAS, merge и удаления. Моки не доказывают транзакционную корректность.

Базовые команды репозитория: `pnpm -F api run test:social`, `pnpm -F api run test:privy-native-auth`, целевые onboarding/lifecycle integration suites, `pnpm check`, `pnpm build`. Полный workspace build обязателен перед объявлением готовности коммита по `AGENTS.md`; targeted API typecheck его не заменяет. Допустимый неустанавливающий fallback указан в `AGENTS.md`:

```sh
PNPM_CONFIG_PM_ON_FAIL=ignore PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn ./node_modules/.bin/turbo run build --env-mode=loose
```

Integration runner требует явно заданных `--database-url` и `--expect-database` для одноразовой тестовой базы. Не использовать production `.env` для тестовых записей. Проверять успешный exit code; пропущенные/не запущенные тесты не считать прошедшими.

Все новые/изменённые SQL проверить на PostgreSQL соответствующей production major version — по текущей конфигурации PG16 — и representative scale в disposable DB/restore. Для account-scoped запросов показать индексный доступ по user_id, bounded работу и планы чтения/записи. Учесть конкурентные блокировки, новые FK и DDL, не выполнять backfill миллионов событий. По `AGENTS.md` production EXPLAIN ANALYZE допускается только с отдельным явным разрешением; оно этим ТЗ не выдаётся. Отсутствие production performance verification отражать в отчёте.

## 12. Проверка и порядок поставки

```sh
pnpm -F api run test:onboarding
pnpm -F api run test:onboarding:integration -- \
  --database-url "$HUNCH_ONBOARDING_TEST_DATABASE_URL" \
  --expect-database "$HUNCH_ONBOARDING_TEST_DATABASE_NAME"
pnpm -F api run test:privy-native-auth
pnpm -F api run test:social
pnpm check
pnpm build
```

`test:onboarding` включён в `test:fast`. PG suite проверяет реальную миграцию/cohort, replace/skip, revision-гонки, profile rollback, merge и удаление. SQL scale suite в rollback-only транзакции создаёт 1 000 000 users, 100 000 progress rows, 300 000 interests и 100 000 assets и снимает EXPLAIN ANALYZE BUFFERS для точных SQL сервиса с custom/generic plans, включая пустые и заполненные аккаунты. Запускать только на одноразовой базе: suite требует место и время для индексов/fixtures.

При повторном использовании установленных зависимостей в worktree pnpm 11 может сообщить, что workspace paths изменились. Не выполнять автоматическую переустановку/очистку. В данной версии pnpm явная настройка без install передаётся в lowercase: `pnpm_config_verify_deps_before_run=warn`. Сверить установленные версии с lockfile и использовать её вместе с full build, если uppercase fallback не распознаётся.

Будущая выкладка: additive migration → backend → smoke новых API тестовым аккаунтом → отдельное подключение iOS. При откате backend оставить совместимую additive схему и данные; старый код их игнорирует. Migration cutoff определяет cohort: аккаунты, созданные после неё даже во время отката, остаются новыми для будущего флоу. Не очищать интересы при rollback.

## 13. Отдельный этап персонализации

Это не часть текущей цели. Для будущего задания нужен opt-in Home-контракт у `/social/feed`, явное соответствие девяти интересов темам, fallback на общую ленту, корректные курсоры и account-scoped кеширование. `/feed/for-you` нельзя объявить готовым решением для нового пользователя.

Точная поддержка US elections, Trump, Geopolitics и Culture требует отдельного решения таксономии: текущие широкие категории схлопывают эти различия, а теги разных провайдеров хранятся неодинаково. Выбор ID сейчас сохраняется без потерь, чтобы эта работа могла использовать его позже. Не добавлять в первую поставку фиктивную «персонализацию» через сравнение подписей или общий фильтр politics.

## 14. Карта исходников

Пути backend ниже относятся к `hunch-monorepo` на проверенном `origin/develop`; номера строк ориентировочные и меняются при дальнейшей работе.

| Файл                                           | Что проверить/использовать                                        |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `apps/api/src/routes/social.ts:120–245`        | Handle, suggestions, profile, follow и существующие схемы ошибок. |
| `apps/api/src/routes/social-assets.ts:129`     | Upload complete; не равно привязке аватара.                       |
| `apps/api/src/services/social-service.ts:284`  | Транзакционный updateProfile и hook прогресса.                    |
| `apps/api/src/services/social-service.ts:846`  | Social feed; в первой поставке не изменять.                       |
| `apps/api/src/services/social-primitives.ts`   | Общие SocialError, cursor/validation conventions.                 |
| `apps/api/src/auth.ts:1386`                    | Создание users; повторно проверить все пути INSERT.               |
| `apps/api/src/auth.ts:1620`                    | Account deletion, включая сохранение финансового tombstone.       |
| `apps/api/src/services/social-lifecycle.ts:11` | clearUserSocialData и mergeUserSocialData.                        |
| `apps/api/src/admin-merge-user-core.ts:1265`   | Порядок merge профиля и удаления source.                          |
| `apps/api/src/routes/auth.ts`                  | Сохранить существующие auth response/isNewUser.                   |
| `apps/api/src/routes/feed.ts:1172`             | Существующий history-based for-you; отдельный от Social Home.     |
| `apps/api/src/routes/meta.ts:37`               | Category fallback; не использовать как onboarding-каталог.        |
| `packages/db/src/migrate.ts:75`                | Транзакции, checksum, повторный запуск миграций.                  |
| `apps/api/src/test-runner.ts`                  | Discovery тестов и guarded integration target.                    |
| `AGENTS.md`                                    | Полный build и требования SQL-проверки.                           |

Read-only ориентиры iOS: `Hunch/Features/Onboarding/OnboardingInterestsScreen.swift`, `OnboardingFlowScreen.swift`, `OnboardingFlowModel.swift`, `OnboardingSocialModel.swift`, `OnboardingPhotoScreen.swift`; `Hunch/Core/API/HunchSocialDataClient.swift`, `SocialDataClient.swift`, `HunchAuthenticationAPIClient.swift`; `Hunch/Features/Authentication/AuthenticationModel.swift`; `Hunch/Core/Authentication/HunchSession.swift`; `HunchTests/OnboardingFlowTests.swift`.
