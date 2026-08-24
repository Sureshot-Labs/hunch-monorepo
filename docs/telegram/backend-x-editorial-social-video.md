# Backend Design: Automated Social Video for X Editorial Drafts

Status: implemented behind a disabled producer flag; production rollout pending
Owner: backend / growth infrastructure
Decision date: 2026-08-24
Depends on: `backend-x-editorial-draft-channel.md`

## Product Decision

Hunch will automatically render short screen-recording-style videos for
eligible X editorial drafts and deliver the ready media together with the draft
to the existing private Telegram editorial channel.

The manager remains the publication authority. Hunch does not publish to X,
schedule X posts, or remove the existing human review and editing step.

V1 produces up to two videos for one editorial draft:

- a mobile Hunch tracking-wallet walkthrough;
- a desktop Hunch tracking-wallet walkthrough at `1440x900`.

Telegram receives one media post:

- one ready video uses Bot API `sendVideo`;
- two ready videos use Bot API `sendMediaGroup`;
- the X editorial draft is the caption of the video or the first media-group
  item;
- the manager can copy the caption, download either video, edit the text, and
  publish manually to X.

The existing editorial limit of 1,000 visible characters intentionally remains
below Telegram's 1,024-character media-caption limit.

## Non-Goals

V1 does not:

- publish or schedule a post through the X API;
- retain rendered MP4 files in S3 or another long-lived Hunch media store;
- record an authenticated Hunch browser session;
- expose private notes, account state, cookies, or editor credentials;
- create synthetic replicas of Hunch pages;
- make `termotion` a production service or CLI dependency;
- generate a misleading single-wallet video for a multi-wallet cluster story;
- block ordinary Telegram V11 signal delivery.

## Current Editorial Lifecycle

The existing X editorial path already provides the required structured source:

```text
accepted holder-research note
  -> x_editorial_draft_v1 composer
  -> deterministic fact/style validation
  -> exact draft persisted in signal_bot_messages.metrics
  -> Telegram MarkdownV2 message
  -> manager review/edit/manual X publication
```

The renderer must consume the same structured note, selected side, holder
address, chain, event ID, market ID, and note ID that build the existing holder
tracking link. It must not parse the rendered Telegram card or infer a wallet
from model-authored prose.

## Target Architecture

```text
signal-bot
  -> compose and persist the exact X draft
  -> reserve signal_bot_messages delivery
  -> enqueue durable social-media render job

social-media-worker
  -> claim render job
  -> open public app.hunch.trade tracking-wallet URL in isolated Chromium
  -> render mobile and desktop scenarios through FFmpeg
  -> send video or media group to Telegram with the persisted draft as caption
  -> persist Telegram message IDs/file IDs and render audit
  -> delete all temporary render files
```

The social-media worker is a separate process and production container. Chrome
startup, page loading, frame capture, encoding, and Telegram file upload must
not block `publishSignalBotTick`, `publishSignalBotFollowthroughTick`, private
bot commands, or user-notification delivery.

## Why This Is Not a `termotion` Runtime

`termotion` is a deterministic renderer for local YAML/JSON timelines and
sanitized, scriptless local HTML/CSS states. Its current web surface does not
load a production React application, execute the application's scripts, or
fetch live tracking-wallet data.

Hunch therefore will not invoke the `termotion` CLI in production and will not
add a live-site mode to its existing `WebSurface`.

The new worker may reuse the proven generic patterns from `termotion`:

- system Chromium and FFmpeg discovery;
- container-safe Chrome launch arguments;
- frame-by-frame Playwright capture;
- backpressure-aware PNG-to-FFmpeg streaming;
- H.264 output verification through FFprobe;
- checksums, manifests, bounded process cleanup, and error classification.

If shared code becomes material, it should be extracted into a narrow generic
package with an explicit API. V1 may implement the small Hunch-owned capture
pipeline directly rather than couple production delivery to the application
renderer.

## Eligibility

Automatic video is eligible only when all of the following are true:

- destination content profile is `x_editorial_draft_v1`;
- the editorial draft is ready and persisted;
- the story has one unambiguous public tracking wallet;
- holder address and supported chain are valid;
- the public tracking-wallet route resolves successfully;
- at least the required profile and summary data render without a terminal
  loading or error state.

V1 should generate media for `single_holder` initial/update stories and their
holder-specific follow-throughs. A `sharp_cluster` story must remain text-only
unless a future cluster-specific visual surface is explicitly designed.

Eligibility failure is not an editorial-copy failure. The existing draft may
still be delivered text-only with an audited media skip reason.

## Capture URL and Browser Isolation

The worker builds the URL from structured fields already used by
`buildSignalBotHolderTrackingUrl`:

```text
/tracking/wallet/<address>
  ?chain=<chain>
  &signalEventId=<event-id>
  &signalMarketId=<market-id>
  &signalSide=<YES|NO>
  &signalSource=telegram_signal_bot
  &noteId=<note-id>
  &device=<mobile|desktop>
```

The browser context must be new and non-persistent for every job:

- no cookies or imported browser profile;
- no Telegram/editor authentication;
- fixed locale, timezone, color scheme, and reduced-motion policy;
- service workers disabled unless application loading proves to require them;
- bounded navigation, data-readiness, interaction, frame, and total-job
  timeouts;
- analytics and unrelated third-party requests may be blocked when doing so
  does not break the page.

The worker records only the public Hunch page. It must never click or open the
`Private notes` surface.

## Render Profiles

### Mobile

Authoring viewport:

- CSS viewport: `390x686`;
- device scale factor: `3`;
- mobile user agent and touch capability;
- Hunch route override: `device=mobile`.

Delivery output:

- `1080x1900`;
- 30 fps;
- H.264 MP4, `yuv420p`, fast-start;
- no audio;
- target duration: 20-24 seconds.

The authoring aspect ratio intentionally matches the delivery output so the
video is scaled without cropping or letterboxing.

### Desktop

Authoring and delivery output:

- viewport: `1440x900`;
- Hunch route override: `device=desktop`;
- 30 fps;
- H.264 MP4, `yuv420p`, fast-start;
- no audio;
- target duration: 14-18 seconds.

`1440x900` is the approved canonical MacBook-Air-like desktop workspace. V1
does not render a 2560x1440 master or retain a second high-resolution copy.

## V1 Visual Timeline

The exact timings are versioned content, not hard-coded incidental waits.

### Mobile timeline

1. Hold the trader profile hero long enough to identify the wallet.
2. Ease-scroll to Performance and hold it for about two seconds.
3. Ease-scroll to `Mix` and hold it for about two seconds.
4. Ease-scroll to `Entry Distribution` and hold it for about two seconds.
5. Ease-scroll to the wallet ledger and hold it for about two seconds.
6. Open the public `Wallet Stats` sheet with its normal entrance animation,
   hold the initial stats, then ease-scroll and hold the lower stats.

The scenario may shorten or skip an empty optional section. It must not scroll
through skeleton placeholders just to preserve a fixed duration.

### Desktop timeline

1. Hold the desktop wallet header/profile composition.
2. Ease-scroll to Performance and hold it for about two seconds.
3. Ease-scroll to `Mix` and hold it for about two seconds.
4. Ease-scroll to `Entry Distribution` and hold it for about two seconds.
5. Ease-scroll to the wallet ledger or signal-focused row and hold the final
   state rather than ending mid-scroll.

Desktop does not invent a mobile-style sheet when the desktop product surface
does not provide one.

## Hunch App Capture Contract

Production rendering uses a small explicit capture contract in `Hunch_App`:

- `capture=social-v1` query mode;
- `data-social-capture-ready=true` only after required public data settles;
- stable capture IDs for profile, chart, mix, entry distribution, ledger,
  mobile ledger toolbar, signal-focused row, stats button, and stats sheet;
- an explicit top-occluder marker on the sticky mobile shell header so section
  anchors preserve the actual header height and a readable gap;
- capture-mode suppression of transient toasts, onboarding overlays, analytics,
  and live refresh that can move content during a render;
- consistent mobile and desktop signal-focus behavior.

Capture mode may alter presentation timing only. It must not bypass
authorization, expose private data, or substitute synthetic business data.

The worker accepts only a root in terminal `ready` state and verifies the
profile-specific capture IDs before rendering. A missing, loading, or errored
contract is a render failure; the worker never clicks by screen coordinates.

## Render Method

V1 uses deterministic frame capture rather than real-time OS screen recording:

1. load the real public Hunch page and wait for explicit readiness;
2. derive scroll position and scene state from `frameIndex / fps`;
3. apply the state and wait one browser animation frame;
4. capture a bounded-quality JPEG buffer from the browser viewport;
5. stream the JPEG directly into FFmpeg with backpressure;
6. verify dimensions, codec, pixel format, duration, and frame count with
   FFprobe.

Frames are never materialized as a long-lived image sequence. Only the final MP4
files exist temporarily on disk.

This method costs more CPU than a real-time screencast but gives predictable
scroll speed, fixed duration, stable frame count, and an auditable failure when
the worker cannot keep up.

## Temporary Files and Retention

Hunch does not retain successful V1 videos after Telegram accepts them.

For each claimed job, the worker creates one narrowly scoped temporary
directory. It contains at most:

- the mobile MP4;
- the desktop MP4;
- small local manifests needed during the attempt.

After a known successful Telegram response, the worker stores the returned
Telegram identifiers and deletes the temporary directory. It also deletes the
directory after a terminal skip or `delivery_unknown` outcome.

For a known retryable Telegram failure, the same running worker may reuse the
temporary files for the bounded retry. A restart may discard them and regenerate
the deterministic scenario. No correctness guarantee depends on local files
surviving a process or container restart.

No S3 bucket, CDN URL, CMS `content_assets` row, or 30-day media retention is
required for V1. Telegram is the durable media host after delivery.

## Durable Job and Audit State

Rendered bytes are temporary, but the workflow state must be durable. Add a
small Postgres job table referencing the existing `signal_bot_messages` row.

The durable contract must include:

- one unique job per X editorial delivery;
- source note, chat, message kind, holder address, and chain;
- versioned scenario and render profiles;
- `queued`, `rendering`, `retry`, `sent`, `failed`, and
  `delivery_unknown` outcomes;
- attempt count, lease owner/expiry, and next-attempt time;
- per-profile outcome, dimensions, duration, byte size, and checksum;
- bounded error code/details without draft text or binary media in logs;
- Telegram message IDs and video `file_id`/`file_unique_id` values;
- timestamps for enqueue, render start/end, send, and cleanup.

The existing `signal_bot_messages` delivery ledger remains authoritative for
whether the editorial package was sent. The media job is the asynchronous work
ledger and must not create a second independent publication truth.

## Telegram Delivery Contract

Extend `SignalBotTelegramClient` with typed media methods and the same delivery
safety classification used by text sends.

### One ready profile

Use `sendVideo` with:

- the persisted X draft rendered as the caption;
- the existing validated MarkdownV2 emphasis and holder link;
- `supports_streaming=true`;
- the temporary MP4 uploaded with multipart form data.

### Two ready profiles

Use `sendMediaGroup` with two video items in this order:

1. mobile;
2. desktop.

Only the first item carries the complete X draft caption. The album must be
treated as one logical editorial delivery even though Telegram returns one
message object per media item.

### Delivery outcomes

- known success: store all returned identifiers, mark the existing delivery
  sent, and delete temporary files;
- known retryable failure: retain/regenerate media and retry under the durable
  job policy;
- blocked or missing destination: mark blocked and disable the channel through
  existing policy;
- ambiguous outcome: mark `delivery_unknown` and never automatically resend;
- one profile rendered and the other failed: send the successful profile after
  bounded attempts rather than lose the whole editorial package;
- no profile rendered after bounded attempts: send the persisted draft
  text-only and record an explicit media fallback reason.

Preview commands must remain side-effect safe. A media preview must not create
or advance a production delivery row.

## Idempotency and Concurrency

- enqueue uses the existing X delivery row as its idempotency key;
- only one worker may hold an unexpired lease for a job;
- every job transition is fenced by both `lease_owner` and `attempt_count`;
- a heartbeat renews the lease during rendering, and the worker renews it again
  immediately before acquiring the Telegram delivery ledger;
- profile output paths are derived from the job ID and profile name inside the
  job-specific temporary directory;
- Telegram send begins only after the existing delivery ledger transitions to
  `sending`;
- a sent or `delivery_unknown` delivery is terminal for automatic sends;
- worker restart reclaims only expired render leases;
- recovery reconciles a terminal delivery ledger before rendering or sending;
- a Telegram rate limit requeues both ledgers, preserves text-fallback mode,
  and never leaves a queued delivery attached to a terminal media job;
- cursor advancement occurs after durable enqueue, not after video rendering,
  so slow media work cannot stall future signal discovery.

## Configuration

Initial non-secret configuration:

```text
HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_ENABLED=false
HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_PROFILES=mobile,desktop
HUNCH_SECRET_BUNDLES_SOCIAL_MEDIA_WORKER=aws-sm:/hunch/prod/social-media-worker
HUNCH_SOCIAL_MEDIA_WORKER_ENABLED=true
HUNCH_SOCIAL_MEDIA_ALLOWED_ORIGINS=https://app.hunch.trade
HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH=
HUNCH_SOCIAL_MEDIA_FFMPEG_PATH=ffmpeg
HUNCH_SOCIAL_MEDIA_FFPROBE_PATH=ffprobe
HUNCH_SOCIAL_MEDIA_FPS=30
HUNCH_SOCIAL_MEDIA_NAVIGATION_TIMEOUT_SEC=45
HUNCH_SOCIAL_MEDIA_POLL_INTERVAL_SEC=5
HUNCH_SOCIAL_MEDIA_LEASE_SEC=600
HUNCH_SOCIAL_MEDIA_JOB_TIMEOUT_SEC=300
HUNCH_SOCIAL_MEDIA_MAX_VIDEO_MB=45
HUNCH_SOCIAL_MEDIA_RETRY_DELAY_SEC=60
HUNCH_SOCIAL_MEDIA_SHM_SIZE=1gb
HUNCH_SOCIAL_MEDIA_TMPFS_SIZE=512m
HUNCH_SOCIAL_MEDIA_MEMORY_LIMIT=2g
```

The producer and consumer flags are intentionally separate. Rollback disables
`HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_ENABLED` first; the worker remains enabled
until the durable queue is empty. Disabling the worker is an operational stop,
not the normal feature rollback.

V1 runs one render job at a time per worker process. Jobs default to three
render attempts, create a unique directory below the operating system temp
directory, and delete that directory in a `finally` block after every outcome.
Startup also removes stale directories with the exact
`hunch-social-media-` prefix. The container temp filesystem and memory are
bounded independently of durable Postgres state.

The worker receives the existing signal-bot Telegram credential through
`HUNCH_SECRET_BUNDLES_SOCIAL_MEDIA_WORKER`. Its default bundle set contains
only `DATABASE_URL` and `HUNCH_SIGNAL_BOT_TOKEN`; it deliberately excludes the
rest of the shared, signal-bot, ops, and AI credentials and receives no
editor/browser credentials. Chromium, FFmpeg, and FFprobe receive a small
allowlisted process environment rather than the secret-loaded worker
environment.

Before the first production deployment, publish the generated
`/hunch/prod/social-media-worker` AWS Secrets Manager bundle. The existing
`packages/config/dist/build-secret-bundles.js` builder now emits that bundle
from the two allowlisted keys. Compose also declares both keys as required, so
the worker fails closed when either value is unavailable.

## Deployment

Add a dedicated worker image or target containing:

- the backend runtime;
- a pinned compatible Chromium build;
- FFmpeg and FFprobe;
- fonts required by the Hunch page and normal browser fallbacks;
- a non-root runtime user and working Chrome sandbox where supported.

Do not add Chromium and FFmpeg to the shared image used by every API, indexer,
finance worker, and signal-bot service merely to support this one process.

Production starts at render concurrency `1`. Concurrency can increase only
after memory, CPU, page-load latency, Telegram upload size, and signal volume
are measured.

The server-build deployment starts `social-media-worker` from the dedicated
`social-media-runtime` target and verifies Chromium, FFmpeg, and FFprobe before
replacing live application containers. The no-build recreation path includes
the worker by default, reuses its existing specialized image (or an explicit
`HUNCH_SOCIAL_MEDIA_WORKER_IMAGE`), and never retags the generic backend image
as the media runtime.

## Observability

Record counters and bounded structured logs for:

- jobs queued, claimed, reclaimed, and completed;
- eligibility skips by reason;
- page readiness time and failure;
- mobile/desktop render duration and result;
- encoded duration, size, dimensions, and checksum;
- Telegram one-video versus album delivery;
- retry, blocked, and `delivery_unknown` outcomes;
- text-only fallback reason;
- temporary-directory cleanup failures.

Never log the Telegram token, draft body, browser cookies, video bytes, or a URL
containing sensitive query data. Wallet addresses and note IDs should follow
the existing signal-bot log policy.

## Test Strategy

### Local video preview

The renderer can be exercised without Postgres or Telegram. Start the matching
`Hunch_App` branch over HTTP, then invoke the API preview command with any
public tracking-wallet URL rewritten to the local origin. The host needs Google
Chrome or Chromium plus FFmpeg/FFprobe (`brew install ffmpeg` on macOS):

```bash
# Hunch_App terminal
bun run dev:http

# hunch-monorepo terminal
pnpm --filter api social:media:preview -- \
  --url 'http://localhost:3000/tracking/wallet/<address>?chain=polygon' \
  --profiles mobile,desktop \
  --output /tmp/hunch-social-previews
```

Every invocation creates a unique directory below `--output` and prints the
absolute MP4 paths, dimensions, duration, byte size, and any per-profile
failure. Omitting `--output` uses the operating-system temp directory. Use
`--fps 12` for a faster composition smoke test; use the default 30 fps for
editorial review. The preview path has no database or Telegram dependency and
does not delete its output files.

### Deterministic unit tests

- media eligibility and cluster exclusion;
- render-profile resolution;
- timeline interpolation and scroll bounds;
- job state transitions, leases, retries, and terminal outcomes;
- Telegram multipart payload construction for one and two videos;
- caption formatting and 1,024-character enforcement;
- response parsing for message IDs and Telegram video file IDs;
- ambiguous delivery does not resend;
- successful delivery triggers cleanup;
- failed profile degrades to the successful profile;
- exhausted render attempts degrade to text-only delivery.

### Browser integration tests

- mobile and desktop routes resolve with the expected device override;
- the worker waits through skeleton state;
- mobile stats sheet opens through a semantic selector;
- private notes never open;
- output dimensions, codec, pixel format, duration, and frame count match the
  requested profiles;
- failed readiness and missing selectors produce bounded typed errors.

### Manual editorial QA

Run representative single-holder examples across sports, politics, crypto, and
different wallet-data richness. The manager reviews:

- whether the first frame identifies the trader quickly;
- scroll speed and section dwell time;
- readability in Telegram and X;
- whether the mobile stats sheet adds useful proof;
- whether the desktop video is worth retaining as a default second asset;
- whether the caption copies cleanly into X;
- whether the displayed live page can contradict the persisted draft after a
  delayed render.

## Rollout

1. Land the design and deterministic unit contracts with the feature disabled.
2. Produce local mobile and desktop MP4 files for selected real public wallet
   URLs without Telegram delivery.
3. Add a preview-only Telegram command or bounded test harness.
4. Enable one private test editorial channel and render concurrency `1`.
5. Review a representative batch with the manager.
6. Enable production X-editorial media while preserving text-only fallback.
7. Re-evaluate whether desktop should remain default after actual editor usage.

## Acceptance Criteria

- one eligible X editorial signal produces a Telegram video post whose caption
  is the exact persisted X draft;
- two successful profiles arrive as one Telegram media group in mobile-first
  order;
- mobile output is `1080x1900`; desktop output is `1440x900`;
- the video shows the real public Hunch tracking-wallet page and never private
  editor state;
- the mobile scenario scrolls the page and opens the public Wallet Stats sheet;
- media rendering cannot block the main signal-bot loop;
- no successful MP4 remains in Hunch storage after Telegram accepts it;
- Telegram identifiers and render audit remain durable after cleanup;
- retry and ambiguous-delivery behavior cannot automatically duplicate an
  editorial package;
- normal Telegram signal channels and text-only X delivery remain compatible;
- automatic X publication remains out of scope.
