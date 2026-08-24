import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Browser, type Page } from "playwright-core";

import type { XEditorialMediaProfile } from "./signal-bot-editorial-media-jobs.js";

export type XEditorialMediaProfileSpec = {
  authoringHeight: number;
  authoringWidth: number;
  deviceScaleFactor: number;
  durationSec: number;
  outputHeight: number;
  outputWidth: number;
  profile: XEditorialMediaProfile;
};

export const X_EDITORIAL_MEDIA_PROFILE_SPECS: Record<
  XEditorialMediaProfile,
  XEditorialMediaProfileSpec
> = {
  mobile: {
    authoringHeight: 686,
    authoringWidth: 390,
    deviceScaleFactor: 3,
    durationSec: 22,
    outputHeight: 1_900,
    outputWidth: 1_080,
    profile: "mobile",
  },
  desktop: {
    authoringHeight: 900,
    authoringWidth: 1_440,
    deviceScaleFactor: 1,
    durationSec: 16,
    outputHeight: 900,
    outputWidth: 1_440,
    profile: "desktop",
  },
};

export type RenderedXEditorialMedia = {
  byteSize: number;
  durationSec: number;
  frameCount: number;
  height: number;
  path: string;
  profile: XEditorialMediaProfile;
  width: number;
};

const execFileAsync = promisify(execFile);

const DEFAULT_BROWSER_EXECUTABLES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit path.
    }
  }
  return null;
}

export async function resolveEditorialMediaBrowserExecutable(
  configured?: string | null,
): Promise<string> {
  const executable = await firstExecutable([
    configured?.trim() ?? "",
    ...DEFAULT_BROWSER_EXECUTABLES,
  ]);
  if (!executable) {
    throw new Error(
      "Chromium executable was not found; set HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH",
    );
  }
  return executable;
}

export function easeInOutCubic(progress: number): number {
  const value = Math.max(0, Math.min(1, progress));
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

type XEditorialMediaCaptureSection =
  | "entry-distribution"
  | "ledger"
  | "mix"
  | "performance"
  | "profile";

export type XEditorialMediaScrollPositions = Record<
  XEditorialMediaCaptureSection,
  number
>;

type XEditorialMediaScrollTransition = {
  endSec: number;
  from: XEditorialMediaCaptureSection;
  startSec: number;
  to: XEditorialMediaCaptureSection;
};

export const X_EDITORIAL_MEDIA_TIMELINE = {
  mobile: {
    sheetOpenSec: 15.4,
    sheetScrollEndSec: 19.4,
    sheetScrollStartSec: 18.2,
  },
  scrollTransitions: [
    { endSec: 3, from: "profile", startSec: 1.8, to: "performance" },
    { endSec: 6.4, from: "performance", startSec: 5.2, to: "mix" },
    {
      endSec: 9.8,
      from: "mix",
      startSec: 8.6,
      to: "entry-distribution",
    },
    {
      endSec: 13.2,
      from: "entry-distribution",
      startSec: 12,
      to: "ledger",
    },
  ] satisfies XEditorialMediaScrollTransition[],
} as const;

export function editorialMediaScrollPosition(input: {
  elapsedSec: number;
  positions: XEditorialMediaScrollPositions;
}): number {
  let position = input.positions.profile;
  for (const transition of X_EDITORIAL_MEDIA_TIMELINE.scrollTransitions) {
    if (input.elapsedSec < transition.startSec) return position;
    if (input.elapsedSec <= transition.endSec) {
      const progress = easeInOutCubic(
        (input.elapsedSec - transition.startSec) /
          (transition.endSec - transition.startSec),
      );
      const from = input.positions[transition.from];
      const to = input.positions[transition.to];
      return from + (to - from) * progress;
    }
    position = input.positions[transition.to];
  }
  return position;
}

export function editorialMediaSectionScrollTop(input: {
  documentTop: number;
  maxScroll: number;
  topOcclusion: number;
}): number {
  const captureGap = 12;
  return Math.max(
    0,
    Math.min(
      input.maxScroll,
      input.documentTop - Math.max(0, input.topOcclusion) - captureGap,
    ),
  );
}

function captureUrl(input: {
  profile: XEditorialMediaProfile;
  url: string;
}): string {
  const url = new URL(input.url);
  url.searchParams.set("capture", "social-v1");
  url.searchParams.set("device", input.profile);
  return url.toString();
}

async function preparePage(input: {
  browser: Browser;
  navigationTimeoutMs: number;
  profile: XEditorialMediaProfile;
  signal?: AbortSignal;
  url: string;
}): Promise<Page> {
  input.signal?.throwIfAborted();
  const spec = X_EDITORIAL_MEDIA_PROFILE_SPECS[input.profile];
  const context = await input.browser.newContext({
    colorScheme: "dark",
    deviceScaleFactor: spec.deviceScaleFactor,
    hasTouch: input.profile === "mobile",
    isMobile: input.profile === "mobile",
    locale: "en-US",
    reducedMotion: "no-preference",
    screen: {
      height: spec.authoringHeight,
      width: spec.authoringWidth,
    },
    serviceWorkers: "block",
    timezoneId: "UTC",
    userAgent:
      input.profile === "mobile"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: {
      height: spec.authoringHeight,
      width: spec.authoringWidth,
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(input.navigationTimeoutMs);
  page.setDefaultNavigationTimeout(input.navigationTimeoutMs);
  await page.route(
    /(?:google-analytics|googletagmanager|posthog|segment\.io)/i,
    (route) => route.abort(),
  );
  await page.goto(captureUrl({ profile: input.profile, url: input.url }), {
    waitUntil: "domcontentloaded",
  });
  const captureRoot = page.locator('[data-social-capture="social-v1"]').first();
  await captureRoot.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-social-capture="social-v1"]');
    const state = root?.getAttribute("data-social-capture-state");
    return state === "ready" || state === "error";
  });
  const captureState = await captureRoot.getAttribute(
    "data-social-capture-state",
  );
  if (captureState !== "ready") {
    throw new Error(
      `Tracking wallet capture contract reported ${captureState}`,
    );
  }
  const requiredCaptureIds = [
    "profile",
    "performance",
    "mix",
    "entry-distribution",
    "ledger",
    ...(input.profile === "mobile"
      ? ["ledger-toolbar", "wallet-stats-button"]
      : []),
  ];
  for (const captureId of requiredCaptureIds) {
    await page
      .locator(`[data-social-capture-id="${captureId}"]`)
      .first()
      .waitFor({ state: "visible" });
  }
  input.signal?.throwIfAborted();
  await page.evaluate(async () => {
    const assetsReady = (async () => {
      await document.fonts.ready;
      const images = [...document.images];
      await Promise.all(
        images.map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), {
                  once: true,
                });
              }),
        ),
      );
    })();
    await Promise.race([
      assetsReady,
      new Promise<void>((resolve) => window.setTimeout(resolve, 5_000)),
    ]);
  });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      [data-slot="sheet-overlay"] {
        animation-duration: 250ms !important;
        transition-duration: 250ms !important;
      }
      [data-slot="sheet-content"] {
        animation-duration: 350ms !important;
        transition-duration: 350ms !important;
      }
      html { scroll-behavior: auto !important; }
      body { cursor: none !important; }
      [data-capture-suppress],
      [data-testid="cookie-banner"],
      [data-testid="support-widget"] { display: none !important; }
    `,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  return page;
}

function startFfmpeg(input: {
  ffmpegPath: string;
  fps: number;
  outputPath: string;
  signal?: AbortSignal;
  spec: XEditorialMediaProfileSpec;
}): {
  completion: Promise<void>;
  process: ChildProcessWithoutNullStreams;
} {
  const child = spawn(
    input.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(input.fps),
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-vf",
      `scale=${input.spec.outputWidth}:${input.spec.outputHeight}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-movflags",
      "+faststart",
      input.outputPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
    });
  });
  const abort = () => {
    child.stdin.destroy();
    child.kill("SIGKILL");
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  child.once("close", () => input.signal?.removeEventListener("abort", abort));
  return { completion, process: child };
}

async function writeFrame(
  ffmpeg: ChildProcessWithoutNullStreams,
  frame: Buffer,
): Promise<void> {
  if (ffmpeg.stdin.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ffmpeg.stdin.off("drain", onDrain);
      ffmpeg.stdin.off("error", onError);
    };
    ffmpeg.stdin.once("drain", onDrain);
    ffmpeg.stdin.once("error", onError);
  });
}

async function captureSectionScrollPositions(
  page: Page,
): Promise<XEditorialMediaScrollPositions> {
  const geometry = await page.evaluate(() => {
    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
      document.body.scrollHeight - window.innerHeight,
    );
    const captureIds = [
      "entry-distribution",
      "ledger",
      "mix",
      "performance",
    ] as const;
    const documentTops: Partial<Record<XEditorialMediaCaptureSection, number>> =
      {};
    for (const captureId of captureIds) {
      const element = document.querySelector(
        `[data-social-capture-id="${captureId}"]`,
      );
      if (!element) throw new Error(`Missing capture section ${captureId}`);
      documentTops[captureId] =
        element.getBoundingClientRect().top + window.scrollY;
    }
    let topOcclusion = 0;
    const topOccluders = document.querySelectorAll(
      '[data-social-capture-occluder="top"], header',
    );
    for (const occluder of topOccluders) {
      const rect = occluder.getBoundingClientRect();
      const position = window.getComputedStyle(occluder).position;
      if (
        (position === "fixed" || position === "sticky") &&
        rect.top <= 0.5 &&
        rect.bottom > 0 &&
        rect.height < window.innerHeight * 0.35
      ) {
        topOcclusion = Math.max(topOcclusion, rect.bottom);
      }
    }
    return { documentTops, maxScroll, topOcclusion };
  });
  const positions: Partial<XEditorialMediaScrollPositions> = { profile: 0 };
  for (const [captureId, documentTop] of Object.entries(
    geometry.documentTops,
  )) {
    if (documentTop == null) continue;
    positions[captureId as XEditorialMediaCaptureSection] =
      editorialMediaSectionScrollTop({
        documentTop,
        maxScroll: geometry.maxScroll,
        topOcclusion: geometry.topOcclusion,
      });
  }
  return positions as XEditorialMediaScrollPositions;
}

async function openWalletStats(page: Page): Promise<void> {
  const button = page
    .locator('[data-social-capture-id="wallet-stats-button"]')
    .first();
  await button.evaluate(async (element) => {
    (element as HTMLElement).click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const animatedElements = document.querySelectorAll(
      '[data-slot="sheet-overlay"], [data-slot="sheet-content"]',
    );
    for (const animatedElement of animatedElements) {
      for (const animation of animatedElement.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
  await page
    .locator('[data-social-capture-id="wallet-stats-sheet"]')
    .first()
    .waitFor({ state: "visible" });
}

async function seekWalletStatsAnimation(
  page: Page,
  elapsedSec: number,
): Promise<void> {
  await page.evaluate(
    (elapsedMs) => {
      const animatedElements = document.querySelectorAll(
        '[data-slot="sheet-overlay"], [data-slot="sheet-content"]',
      );
      for (const animatedElement of animatedElements) {
        for (const animation of animatedElement.getAnimations()) {
          animation.pause();
          const endTime = Number(animation.effect?.getComputedTiming().endTime);
          animation.currentTime = Math.min(
            elapsedMs,
            Number.isFinite(endTime) ? endTime : elapsedMs,
          );
        }
      }
    },
    Math.max(0, elapsedSec) * 1_000,
  );
}

async function scrollWalletStats(page: Page, progress: number): Promise<void> {
  await page.evaluate((value) => {
    const dialog = document.querySelector(
      '[data-social-capture-id="wallet-stats-sheet"]',
    );
    if (!dialog) return;
    const candidates = [dialog, ...dialog.querySelectorAll("*")];
    const scroller = candidates.find((candidate) => {
      const element = candidate as HTMLElement;
      const style = window.getComputedStyle(element);
      return (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight
      );
    }) as HTMLElement | undefined;
    if (scroller) {
      scroller.scrollTop =
        Math.max(0, scroller.scrollHeight - scroller.clientHeight) * value;
    }
  }, progress);
}

async function renderProfile(input: {
  browser: Browser;
  ffmpegPath: string;
  ffprobePath: string;
  fps: number;
  navigationTimeoutMs: number;
  maxOutputBytes: number;
  outputDirectory: string;
  profile: XEditorialMediaProfile;
  signal?: AbortSignal;
  url: string;
}): Promise<RenderedXEditorialMedia> {
  const spec = X_EDITORIAL_MEDIA_PROFILE_SPECS[input.profile];
  const outputPath = path.join(
    input.outputDirectory,
    `hunch-${input.profile}.mp4`,
  );
  const page = await preparePage({
    browser: input.browser,
    navigationTimeoutMs: input.navigationTimeoutMs,
    profile: input.profile,
    signal: input.signal,
    url: input.url,
  });
  const { completion, process: ffmpeg } = startFfmpeg({
    ffmpegPath: input.ffmpegPath,
    fps: input.fps,
    outputPath,
    signal: input.signal,
    spec,
  });
  let sheetOpened = false;
  try {
    const scrollPositions = await captureSectionScrollPositions(page);
    const frameCount = Math.round(spec.durationSec * input.fps);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      input.signal?.throwIfAborted();
      const elapsedSec = frameIndex / input.fps;
      if (
        input.profile === "mobile" &&
        !sheetOpened &&
        elapsedSec >= X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetOpenSec
      ) {
        await openWalletStats(page);
        sheetOpened = true;
      }
      if (!sheetOpened) {
        const scrollPosition = editorialMediaScrollPosition({
          elapsedSec,
          positions: scrollPositions,
        });
        await page.evaluate(
          (position) => window.scrollTo(0, position),
          scrollPosition,
        );
      } else {
        await seekWalletStatsAnimation(
          page,
          elapsedSec - X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetOpenSec,
        );
      }
      if (
        sheetOpened &&
        elapsedSec >= X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetScrollStartSec
      ) {
        await scrollWalletStats(
          page,
          easeInOutCubic(
            (elapsedSec -
              X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetScrollStartSec) /
              (X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetScrollEndSec -
                X_EDITORIAL_MEDIA_TIMELINE.mobile.sheetScrollStartSec),
          ) * 0.45,
        );
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const screenshot = await page.screenshot({
        animations: "allow",
        fullPage: false,
        quality: 88,
        type: "jpeg",
      });
      await writeFrame(ffmpeg, screenshot);
    }
    ffmpeg.stdin.end();
    await completion;
  } catch (error) {
    ffmpeg.stdin.destroy();
    ffmpeg.kill("SIGKILL");
    await completion.catch(() => undefined);
    throw error;
  } finally {
    await page
      .context()
      .close()
      .catch(() => undefined);
  }
  const outputStat = await stat(outputPath);
  if (outputStat.size <= 0) throw new Error("FFmpeg produced an empty MP4");
  if (outputStat.size > input.maxOutputBytes) {
    throw new Error(
      `Rendered MP4 exceeds ${input.maxOutputBytes} bytes: ${outputStat.size}`,
    );
  }
  const verification = await verifyRenderedVideo({
    expectedDurationSec: spec.durationSec,
    expectedFrameCount: Math.round(spec.durationSec * input.fps),
    expectedHeight: spec.outputHeight,
    expectedWidth: spec.outputWidth,
    ffprobePath: input.ffprobePath,
    outputPath,
    signal: input.signal,
  });
  return {
    byteSize: outputStat.size,
    durationSec: verification.durationSec,
    frameCount: verification.frameCount,
    height: spec.outputHeight,
    path: outputPath,
    profile: input.profile,
    width: spec.outputWidth,
  };
}

async function verifyRenderedVideo(input: {
  expectedDurationSec: number;
  expectedFrameCount: number;
  expectedHeight: number;
  expectedWidth: number;
  ffprobePath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<{ durationSec: number; frameCount: number }> {
  const { stdout } = await execFileAsync(
    input.ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,color_range,nb_frames:format=duration",
      "-of",
      "json",
      input.outputPath,
    ],
    { maxBuffer: 1_000_000, signal: input.signal },
  );
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_name?: string;
      color_range?: string;
      height?: number;
      nb_frames?: string;
      pix_fmt?: string;
      width?: number;
    }>;
  };
  const stream = payload.streams?.[0];
  const durationSec = Number(payload.format?.duration);
  const frameCount = Number(stream?.nb_frames);
  if (
    stream?.codec_name !== "h264" ||
    stream.color_range !== "tv" ||
    stream.pix_fmt !== "yuv420p" ||
    stream.width !== input.expectedWidth ||
    stream.height !== input.expectedHeight ||
    !Number.isFinite(durationSec) ||
    Math.abs(durationSec - input.expectedDurationSec) > 0.25 ||
    !Number.isInteger(frameCount) ||
    Math.abs(frameCount - input.expectedFrameCount) > 1
  ) {
    throw new Error(
      `FFprobe rejected rendered MP4: ${JSON.stringify({
        durationSec,
        expectedDurationSec: input.expectedDurationSec,
        expectedFrameCount: input.expectedFrameCount,
        expectedHeight: input.expectedHeight,
        expectedWidth: input.expectedWidth,
        stream,
      })}`,
    );
  }
  return { durationSec, frameCount };
}

export async function renderXEditorialMedia(input: {
  browserExecutablePath?: string | null;
  ffmpegPath?: string;
  ffprobePath?: string;
  fps?: number;
  maxOutputBytes?: number;
  navigationTimeoutMs?: number;
  outputDirectory: string;
  profiles: XEditorialMediaProfile[];
  signal?: AbortSignal;
  url: string;
}): Promise<{
  errors: Partial<Record<XEditorialMediaProfile, string>>;
  rendered: RenderedXEditorialMedia[];
}> {
  input.signal?.throwIfAborted();
  const executablePath = await resolveEditorialMediaBrowserExecutable(
    input.browserExecutablePath,
  );
  const browser = await chromium.launch({
    args: [
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      "--hide-scrollbars",
      "--no-default-browser-check",
      "--no-first-run",
    ],
    executablePath,
    headless: true,
  });
  const rendered: RenderedXEditorialMedia[] = [];
  const errors: Partial<Record<XEditorialMediaProfile, string>> = {};
  const abort = () => void browser.close().catch(() => undefined);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (const profile of [...new Set(input.profiles)]) {
      try {
        rendered.push(
          await renderProfile({
            browser,
            ffmpegPath: input.ffmpegPath?.trim() || "ffmpeg",
            ffprobePath: input.ffprobePath?.trim() || "ffprobe",
            fps: Math.max(12, Math.min(30, input.fps ?? 30)),
            navigationTimeoutMs: Math.max(
              10_000,
              input.navigationTimeoutMs ?? 45_000,
            ),
            maxOutputBytes: Math.max(
              1_000_000,
              input.maxOutputBytes ?? 45 * 1024 * 1024,
            ),
            outputDirectory: input.outputDirectory,
            profile,
            signal: input.signal,
            url: input.url,
          }),
        );
      } catch (error) {
        input.signal?.throwIfAborted();
        errors[profile] =
          error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
  return { errors, rendered };
}
