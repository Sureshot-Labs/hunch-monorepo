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
    durationSec: 13,
    outputHeight: 1_900,
    outputWidth: 1_080,
    profile: "mobile",
  },
  desktop: {
    authoringHeight: 900,
    authoringWidth: 1_440,
    deviceScaleFactor: 1,
    durationSec: 11,
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

export function editorialMediaScrollProgress(input: {
  elapsedSec: number;
  profile: XEditorialMediaProfile;
}): number {
  const startSec = 1.2;
  const endSec = input.profile === "mobile" ? 7.4 : 8.5;
  return easeInOutCubic(
    (input.elapsedSec - startSec) / Math.max(0.1, endSec - startSec),
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
  url: string;
}): Promise<Page> {
  const spec = X_EDITORIAL_MEDIA_PROFILE_SPECS[input.profile];
  const context = await input.browser.newContext({
    deviceScaleFactor: spec.deviceScaleFactor,
    hasTouch: input.profile === "mobile",
    isMobile: input.profile === "mobile",
    locale: "en-US",
    reducedMotion: "reduce",
    screen: {
      height: spec.authoringHeight,
      width: spec.authoringWidth,
    },
    serviceWorkers: "block",
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
  await page.locator("main").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => document.body.innerText.trim().length > 80);
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
      html { scroll-behavior: auto !important; }
      body { cursor: none !important; }
      [data-capture-suppress],
      [data-testid="cookie-banner"],
      [data-testid="support-widget"] { display: none !important; }
    `,
  });
  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  if (
    /wallet (?:was )?not found|invalid wallet|failed to load wallet/.test(
      bodyText,
    )
  ) {
    throw new Error("Tracking wallet page did not resolve to a public wallet");
  }
  if (input.profile === "mobile") {
    await page
      .getByRole("button", { name: /wallet stats/i })
      .first()
      .waitFor({ state: "visible" });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return page;
}

function startFfmpeg(input: {
  ffmpegPath: string;
  fps: number;
  outputPath: string;
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
      `scale=${input.spec.outputWidth}:${input.spec.outputHeight}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
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

async function maxScrollFor(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
      document.body.scrollHeight - window.innerHeight,
    ),
  );
}

async function openWalletStats(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /wallet stats/i }).first();
  await button.evaluate((element) => (element as HTMLElement).click());
  await page
    .locator('[role="dialog"], [data-vaul-drawer]')
    .first()
    .waitFor({ state: "visible" });
}

async function scrollWalletStats(page: Page, progress: number): Promise<void> {
  await page.evaluate((value) => {
    const dialog = document.querySelector(
      '[role="dialog"], [data-vaul-drawer]',
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
  outputDirectory: string;
  profile: XEditorialMediaProfile;
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
    url: input.url,
  });
  const { completion, process: ffmpeg } = startFfmpeg({
    ffmpegPath: input.ffmpegPath,
    fps: input.fps,
    outputPath,
    spec,
  });
  let sheetOpened = false;
  try {
    const maxScroll = await maxScrollFor(page);
    const scrollTarget = maxScroll * (input.profile === "mobile" ? 0.72 : 0.82);
    const frameCount = Math.round(spec.durationSec * input.fps);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const elapsedSec = frameIndex / input.fps;
      if (input.profile === "mobile" && !sheetOpened && elapsedSec >= 8.2) {
        await openWalletStats(page);
        sheetOpened = true;
      }
      if (!sheetOpened) {
        const progress = editorialMediaScrollProgress({
          elapsedSec,
          profile: input.profile,
        });
        await page.evaluate(
          ({ target, value }) => window.scrollTo(0, target * value),
          { target: scrollTarget, value: progress },
        );
      } else if (elapsedSec >= 10.2) {
        await scrollWalletStats(
          page,
          easeInOutCubic((elapsedSec - 10.2) / 2.2) * 0.45,
        );
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const screenshot = await page.screenshot({
        animations: "disabled",
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
  const verification = await verifyRenderedVideo({
    expectedDurationSec: spec.durationSec,
    expectedFrameCount: Math.round(spec.durationSec * input.fps),
    expectedHeight: spec.outputHeight,
    expectedWidth: spec.outputWidth,
    ffprobePath: input.ffprobePath,
    outputPath,
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
}): Promise<{ durationSec: number; frameCount: number }> {
  const { stdout } = await execFileAsync(
    input.ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,nb_frames:format=duration",
      "-of",
      "json",
      input.outputPath,
    ],
    { maxBuffer: 1_000_000 },
  );
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_name?: string;
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
  navigationTimeoutMs?: number;
  outputDirectory: string;
  profiles: XEditorialMediaProfile[];
  url: string;
}): Promise<{
  errors: Partial<Record<XEditorialMediaProfile, string>>;
  rendered: RenderedXEditorialMedia[];
}> {
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
            outputDirectory: input.outputDirectory,
            profile,
            url: input.url,
          }),
        );
      } catch (error) {
        errors[profile] =
          error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { errors, rendered };
}
