# Проверка backend онбординга

Дата: 16 октября 2026. Ветка: `codex/onboarding-interests`. База: `bdb7d22f50e627248a79617fd105ffdcda0b0ffe` (`origin/develop` на момент старта).

Worktree: `/Users/sxibaev/Documents/GitHub/hunch/.worktrees/onboarding-interests`.

## Соответствие задаче

| Требование                                                                           | Реализация и проверка                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Девять устойчивых ID, пустой старт, минимум три разных ID, явный Skip, полная замена | Seed-каталог и две аккаунтные таблицы миграции 0281; service/PG tests проверяют дедупликацию, три политических ID, replace, отключённые/неизвестные ID и пустой Skip.                                                                                                                                                                  |
| Прогресс шести шагов и восстановление аккаунта                                       | GET даёт один согласованный снимок, nextStep и сохранённый выбор; состояние читается новым экземпляром клиента из БД. Auth DTO и isNewUser не меняются; iOS должен отдельно подключить GET после login/auth-me.                                                                                                                        |
| Идемпотентность и конкуренция                                                        | Транзакция и users FOR UPDATE; точная CAS revision, safe no-op, неизменный completedAt. Координатор удерживает users lock до подтверждения двух ожидающих writers через pg_stat_activity. Реальные параллельные соединения проверяют duplicate/разные PUT, complete-vs-progress, profile-vs-choice и запоздалую запись после удаления. |
| Необязательные шаги                                                                  | Все шаги можно явно пропустить. Traders не требует подписок; completion не создаёт follow. Passkey/push credential или permission не выводятся из отметки шага.                                                                                                                                                                        |
| Успешное сохранение handle/avatar                                                    | Hook в существующей profile-транзакции. Проверены ready asset без привязки, чужой/pending asset, атомарное продвижение и rollback обоих изменений при ошибке commit.                                                                                                                                                                   |
| Legacy и новые аккаунты                                                              | Миграция существующего cohort 0 и будущего default 1 в одной транзакции; отдельный schema-upgrade тест и проверка без heap rewrite на миллионе строк. GET не создаёт progress. Legacy не получает вымышленные интересы/дату.                                                                                                           |
| Merge и deletion                                                                     | Реальные admin merge full/keepSource, explicit target Skip, наследование completion, legacy target, inactive source и повтор merge. Реальный AuthService.deleteUser проверен для hard/retained удаления, включая запрет восстановления данных поздней записью.                                                                         |
| Приватность и совместимость                                                          | Существующий Bearer/session/CSRF middleware, strict request schemas, private/no-store. HTTP fixture проверяет изоляцию user ID, ошибки и сериализацию. Пройдены существующие Social/native-auth и PG lifecycle suites.                                                                                                                 |
| API и документация                                                                   | Пять операций зарегистрированы в общем OpenAPI; полный dump успешно построен и проверен. Контракт, JSON/curl, восстановление, ошибки, миграция/rollback и последующее подключение iOS описаны в backend-onboarding.md.                                                                                                                 |
| Scope                                                                                | iOS/веб, ленты, индексаторы, торговля, аналитика и Privy/push инфраструктура не изменялись. Merge/deploy не выполнялись.                                                                                                                                                                                                               |

## Команды и результаты

- Полный workspace build через Turbo с существующими зависимостями: успешно, 16/16 packages, exit 0.
- `pnpm check`: workspace typecheck и lint успешны; test:fast останавливается на существующем `account-value-tests.ts` из-за отсутствующего named export `BN` у `@coral-xyz/anchor` под Node 24.13.0. Та же ошибка воспроизведена в исходном checkout develop, без feature-изменений. Полный check не считается прошедшим; последующие fast suites этой командой не исполнялись.
- Отдельный regression runner: 15/15 suites, включая onboarding, Social API, native auth, admin merge, verified buy/copy/repair.
- Штатные `pnpm -F api run test:social` и `pnpm -F api run test:privy-native-auth`: успешно.
- PostgreSQL regression runner: 4/4 suites — admin-social, social, social-lifecycle и social-maintenance.
- Новые `onboarding-integration-tests` и `onboarding-sql-scale-integration-tests`: успешно.
- Полная цепочка миграций до 0281 и повторный запуск мигратора: успешно; checksums сохранены, повтор не переопределяет когорты.
- Полный OpenAPI dump с ENABLE_SWAGGER=true: успешно; проверены все пять операций и обязательные requestBody мутаций.
- Форматирование новых файлов, JSON-примеры документации и `git diff --check`: успешно.

Новые unit/route suites включены в `test:fast`; для целевого запуска добавлены `test:onboarding` и `test:onboarding:integration`.

## SQL и миграция

Все записи и EXPLAIN ANALYZE выполнялись только в одноразовом локальном TimescaleDB 2.14.2 / PostgreSQL 16, с точной проверкой имени `hunch_onboarding_test`. Production не использовался.

Scale suite использует 1 000 000 users, 100 000 onboarding states, 300 000 user interests и 100 000 assets. Один владелец имеет 10 001 asset; проверяется, что чтение фото обращается максимум к одной строке по asset ID, а не сканирует все его загрузки.

Проверены восемь точных форм SQL сервиса и 24 custom/generic плана, включая заполненный аккаунт, новый аккаунт без progress и отсутствующего пользователя. Для users/state/interests/assets запрещён Seq Scan на этой выборке; каталог содержит девять строк. В отчёте фиксируются время, buffers, фактические строки, удалённые фильтром строки, loops и индексы.

Финальный локальный прогон: cohort-DDL 121.0 мс; heap users до/после — 109232128 байт. Максимальное время из 24 EXPLAIN — 0.317 мс, максимальные root shared buffers (hit + read) — 24. Фото проверяется по `content_assets_pkey`; фактически просмотрено не больше 1 asset-строки. Эти цифры относятся только к данному синтетическому прогону.

Результаты финального прогона и точные планы сохранены в [verification/onboarding-sql-scale.json](verification/onboarding-sql-scale.json). Проверка cohort-DDL отдельно подтверждает одинаковый размер heap до/после добавления constant-default маркера и корректные значения 0/1 для существующего/нового аккаунта.

Это проверка на синтетическом объёме в disposable PG16, а не production EXPLAIN/нагрузочная проверка production. Она не подтверждает поведение под конкретной production-конкуренцией и распределением данных. Перед production rollout применимы обычные repository/deployment проверки; отдельного разрешения на production probes эта работа не даёт.

## Уточнения реализации

- Merge без изменения onboarding-состояния не увеличивает revision. Если merge изменил состояние, revision увеличивается, повтор остаётся no-op.
- Для завершённого source, чей handle/photo не перенёсся в target, используется server-only `not_applicable/profile_not_transferred`; пользовательский Skip не выдумывается. В незавершённом флоу такой pending шаг остаётся pending.
- Привилегированный admin merge читает существующий inactive source, как и прежде; пользовательские GET и мутации inactive-аккаунта отклоняются.
- Переиспользованы установленные зависимости, без install/purge. Предупреждение pnpm связано с путями нового worktree; manifest dependency ranges/lockfile не менялись. В pnpm 11.8 для запрета автоматического install понадобился lowercase `pnpm_config_verify_deps_before_run=warn`.

## Оставшиеся действия вне этой поставки

Исправление baseline Anchor/BN fast-test, production выкладка и подключение iOS остаются отдельной работой. Персонализация Home — отдельный согласованный этап. Эта ветка не меняет выдачу лент и не включает клиентское сохранение интересов автоматически.
