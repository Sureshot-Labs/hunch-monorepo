# Backend/Infra task: production media storage for Content CMS

## Кратко

Нужно подготовить production-хранилище загружаемых изображений, видео, аудио и
файлов для Content CMS. API уже реализован и задеплоен, но media storage и
публикация намеренно выключены до инфраструктурного ревью.

Эта задача **не требует выдавать AWS-доступ фронтендеру или Codex**. Все
изменения в AWS выполняет backend/infra-инженер через принятый в проекте способ
(IaC предпочтительнее ручных изменений).

## Что уже есть

- Backend использует AWS SDK S3 и поддерживает EC2/ECS default credential chain.
- Долгоживущие `CONTENT_ASSET_S3_ACCESS_KEY_ID` и
  `CONTENT_ASSET_S3_SECRET_ACCESS_KEY` для AWS не нужны и должны оставаться
  пустыми.
- Upload идёт напрямую из admin browser по presigned `PUT` в
  `content-staging/*`.
- Backend проверяет размер, MIME, SHA-256 checksum, magic bytes и размеры
  изображения, затем выполняет server-side copy в immutable `content/*`.
- Публичный объект получает `Cache-Control: public, max-age=31536000, immutable`.
- Удаление объектов выполняется durable worker job, не внутри HTTP-транзакции.
- Production сейчас сообщает `storageConfigured: false` и
  `publishingEnabled: false`.
- До этой задачи S3 bucket, CloudFront distribution и IAM policy для CMS никем
  не создавались и не изменялись.

## Требуемая реализация

### 1. Private S3 bucket

Создать отдельный bucket в том же AWS region, где работает production backend.
Название выбрать по действующему naming convention, например
`hunch-content-production-<account>-<region>`.

Обязательные настройки:

- S3 Block Public Access: все четыре флага включены;
- Object Ownership: Bucket owner enforced, ACL отключены;
- default encryption: SSE-S3 (`AES256`) либо существующий approved KMS key;
- bucket versioning включён, если это соответствует принятой backup policy;
- запретить public bucket policy и public object ACL;
- `content-staging/*` не должен быть доступен через CDN или напрямую публично;
- `content/*` читается только CloudFront Origin Access Control;
- lifecycle для `content-staging/*`: удалять незавершённые/забытые объекты через
  1 день и abort incomplete multipart uploads через 1 день;
- при включённом versioning удалить noncurrent staging versions по принятому
  короткому retention;
- не добавлять lifecycle, удаляющий production `content/*` автоматически.

### 2. CloudFront

Создать CloudFront distribution с S3 Origin Access Control (OAC), без публичного
S3 website endpoint.

Требования:

- viewer protocol policy: redirect HTTP to HTTPS;
- разрешить публичный `GET`/`HEAD` только для immutable `content/*`;
- bucket policy для OAC ограничить ARN конкретной distribution и prefix
  `content/*`;
- `content-staging/*` через distribution должен возвращать `403`/`404`;
- передавать корректные `Content-Type`, `ETag` и `Cache-Control` S3 object;
- response headers policy должна добавлять
  `X-Content-Type-Options: nosniff`;
- application cookies и Authorization не должны входить в cache key;
- invalidation на публикацию не требуется: public object keys immutable и
  содержат checksum;
- custom domain вроде `media.hunch.trade` желателен, но для первого запуска
  допустим стандартный `https://<distribution>.cloudfront.net`.

### 3. S3 CORS для прямого admin upload

Разрешить только точные admin origins:

- `https://admin.hunch.trade`;
- `http://127.0.0.1:5173` на период локальной проверки;
- `http://localhost:5173` на период локальной проверки.

Минимально необходимая политика:

- methods: `PUT`, а для диагностики допустимы `GET` и `HEAD`;
- allowed headers: `content-type`, `x-amz-checksum-sha256`, `x-amz-*`;
- expose headers: `etag`, `x-amz-checksum-sha256`;
- max age: 3600 секунд;
- wildcard origin `*` не использовать.

После выпуска production admin локальные origins можно убрать отдельным
изменением после подтверждения команды.

### 4. IAM для production backend

Добавить least-privilege policy к **существующей EC2 instance role**, которую
использует production API. Не создавать IAM user и не выпускать access keys.

Минимальные разрешения:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageContentObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::<BUCKET>/content-staging/*",
        "arn:aws:s3:::<BUCKET>/content/*"
      ]
    }
  ]
}
```

`HeadObject` использует `s3:GetObject`; server-side `CopyObject` требует
`s3:GetObject` для source и `s3:PutObject` для destination. Если выбран KMS,
добавить только необходимые permissions к конкретному key и проверить checksum
flow с `ChecksumMode: ENABLED`.

### 5. Production runtime configuration

Через существующий approved механизм конфигурации задать:

```dotenv
CONTENT_ASSET_S3_ENDPOINT=
CONTENT_ASSET_S3_REGION=<AWS_REGION>
CONTENT_ASSET_S3_BUCKET=<BUCKET>
CONTENT_ASSET_S3_ACCESS_KEY_ID=
CONTENT_ASSET_S3_SECRET_ACCESS_KEY=
CONTENT_ASSET_S3_FORCE_PATH_STYLE=false
CONTENT_ASSET_PUBLIC_BASE_URL=https://<CLOUDFRONT_DOMAIN_OR_MEDIA_DOMAIN>
CONTENT_ASSET_UPLOAD_TTL_SEC=900
```

Важно:

- endpoint для обычного AWS S3 должен быть пустым;
- static credentials должны быть пустыми: SDK возьмёт credentials из instance
  role;
- не включать `CONTENT_PUBLISHING_ENABLED`;
- не задавать renderer/revalidation variables в рамках этой задачи;
- не менять `DATABASE_URL`, trading/market services, PostgreSQL или Redis.

После настройки выполнить штатный backend deploy. Startup env preflight должен
пройти до остановки текущего API.

## Проверка

Выполнить вместе с локальной admin-панелью:

1. `GET https://api.hunch.trade/health` возвращает `200` и `db: ready`.
2. `GET https://api.hunch.trade/health/content` возвращает:
   - migration `0007_content_foreign_key_indexes.sql` или новее;
   - `storageConfigured: true`;
   - `publishingEnabled: false`.
3. Создать upload intent для небольшого PNG/JPEG.
4. Выполнить presigned `PUT` из браузера со всеми headers, возвращёнными API.
5. Вызвать complete и получить asset со статусом `ready`.
6. Убедиться, что backend успешно выполнил checksum-enabled `HEAD`, bounded
   `GET`, `CopyObject` и повторный `HEAD`.
7. Public CDN URL возвращает `200`, правильный `Content-Type`, immutable
   `Cache-Control` и `X-Content-Type-Options: nosniff`.
8. `content-staging/*` недоступен публично.
9. Проверить, что после TTL staging object удаляется worker/lifecycle и нет
   failed storage deletion jobs.
10. Повторить smoke для app markets/feed, чтобы подтвердить отсутствие
    побочного влияния.

## Acceptance criteria

- Нет IAM user и долгоживущих S3 keys.
- Bucket полностью private; public read идёт только через CloudFront OAC.
- IAM role ограничена object actions в двух prefixes одного bucket; bucket-wide
  `ListBucket` текущему API не требуется.
- Реальный upload/verify/copy/CDN/delete flow проходит end-to-end.
- `/health/content` показывает `storageConfigured: true`.
- `CONTENT_PUBLISHING_ENABLED` остаётся `false` до отдельного rollout landing.
- Существующие markets/feed/app endpoints проходят smoke без регрессий.
- Названия созданных AWS resources, region и CDN base URL переданы команде; AWS
  credentials никому не передаются.

## Rollback

Если preflight или media smoke не проходит:

1. оставить `CONTENT_PUBLISHING_ENABLED=false`;
2. очистить **все** `CONTENT_ASSET_*` runtime variables одновременно и вернуть
   предыдущий backend image штатным rollback-механизмом;
3. не удалять bucket/IAM/CDN до разбора уже загруженных объектов;
4. проверить `/health`, feed, контрольное событие и app route;
5. зафиксировать AWS/API error без публикации credentials или signed URLs.

## Не входит в эту задачу

- Деплой admin или landing;
- включение публикации статей;
- `/journal`, sitemap, RSS и Next.js revalidation;
- изменение основной БД, рынков, trading workers или Redis;
- выдача AWS-доступа кому-либо вне backend/infra команды.
