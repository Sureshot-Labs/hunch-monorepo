#!/usr/bin/env tsx

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hasCliFlag, readCliValues } from "./lib/cli-args.js";
import type { XEditorialMediaProfile } from "./services/signal-bot-editorial-media-jobs.js";
import { renderXEditorialMedia } from "./services/x-editorial-media-renderer.js";

const DEFAULT_PROFILES: XEditorialMediaProfile[] = ["mobile", "desktop"];

export type XEditorialMediaPreviewOptions = {
  fps: number;
  outputRoot: string | null;
  profiles: XEditorialMediaProfile[];
  url: string;
};

const USAGE = `Usage:
  pnpm --filter api social:media:preview -- --url <tracking-wallet-url> [options]

Options:
  --profiles mobile,desktop  Profiles to render (default: mobile,desktop)
  --output <directory>       Root for a unique preview directory (default: OS temp)
  --fps <12-30>              Frames per second (default: 30)
  --help                     Show this help

Optional environment:
  HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH
  HUNCH_SOCIAL_MEDIA_FFMPEG_PATH
  HUNCH_SOCIAL_MEDIA_FFPROBE_PATH`;

function readSingleValue(
  argv: string[],
  name: string,
  options: { required: true },
): string;
function readSingleValue(
  argv: string[],
  name: string,
  options?: { required?: false },
): string | null;
function readSingleValue(
  argv: string[],
  name: string,
  options: { required?: boolean } = {},
): string | null {
  const key = `--${name}`;
  const provided = argv.some(
    (argument) => argument === key || argument.startsWith(`${key}=`),
  );
  const values = readCliValues(argv, name, { splitCommas: false });
  if (values.length > 1) throw new Error(`--${name} may only be provided once`);
  if (!values[0]) {
    if (provided) throw new Error(`--${name} requires a value`);
    if (options.required) throw new Error(`--${name} is required`);
    return null;
  }
  return values[0];
}

function parseProfiles(argv: string[]): XEditorialMediaProfile[] {
  const values = readCliValues(argv, "profiles");
  const provided = argv.some(
    (argument) =>
      argument === "--profiles" || argument.startsWith("--profiles="),
  );
  if (provided && !values.length) {
    throw new Error("--profiles requires at least one profile");
  }
  if (!values.length) return [...DEFAULT_PROFILES];
  const invalid = values.filter(
    (value) => value !== "mobile" && value !== "desktop",
  );
  if (invalid.length) {
    throw new Error(
      `--profiles only accepts mobile and desktop; received ${invalid.join(", ")}`,
    );
  }
  return [...new Set(values)] as XEditorialMediaProfile[];
}

function parseFps(argv: string[]): number {
  const raw = readSingleValue(argv, "fps");
  if (!raw) return 30;
  const fps = Number(raw);
  if (!Number.isSafeInteger(fps) || fps < 12 || fps > 30) {
    throw new Error("--fps must be an integer from 12 through 30");
  }
  return fps;
}

function parseCaptureUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--url must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("--url must not contain credentials");
  }
  if (!/^\/tracking\/wallet\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error("--url must point to /tracking/wallet/<address>");
  }
  return url.toString();
}

export function parseXEditorialMediaPreviewOptions(
  argv: string[],
): XEditorialMediaPreviewOptions {
  const rawUrl = readSingleValue(argv, "url", { required: true });
  return {
    fps: parseFps(argv),
    outputRoot: readSingleValue(argv, "output"),
    profiles: parseProfiles(argv),
    url: parseCaptureUrl(rawUrl),
  };
}

async function createRunDirectory(outputRoot: string | null): Promise<string> {
  if (!outputRoot) {
    return mkdtemp(path.join(tmpdir(), "hunch-social-media-preview-"));
  }
  const root = path.resolve(outputRoot);
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, "hunch-social-media-preview-"));
}

function formatMegabytes(byteSize: number): string {
  return `${(byteSize / (1024 * 1024)).toFixed(2)} MB`;
}

export async function runXEditorialMediaPreview(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (hasCliFlag(argv, "help")) {
    console.log(USAGE);
    return 0;
  }

  const options = parseXEditorialMediaPreviewOptions(argv);
  const outputDirectory = await createRunDirectory(options.outputRoot);
  console.log(`Rendering ${options.profiles.join(" + ")} preview...`);
  console.log(`Source: ${options.url}`);
  console.log(`Output: ${outputDirectory}`);

  const result = await renderXEditorialMedia({
    browserExecutablePath: env.HUNCH_SOCIAL_MEDIA_CHROMIUM_PATH?.trim() || null,
    ffmpegPath: env.HUNCH_SOCIAL_MEDIA_FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.HUNCH_SOCIAL_MEDIA_FFPROBE_PATH?.trim() || "ffprobe",
    fps: options.fps,
    outputDirectory,
    profiles: options.profiles,
    url: options.url,
  });

  for (const video of result.rendered) {
    console.log(
      `Rendered ${video.profile}: ${video.width}x${video.height}, ` +
        `${video.durationSec.toFixed(2)}s, ${formatMegabytes(video.byteSize)}`,
    );
    console.log(video.path);
  }
  for (const profile of options.profiles) {
    const error = result.errors[profile];
    if (error) console.error(`Failed ${profile}: ${error}`);
  }

  return Object.keys(result.errors).length === 0 && result.rendered.length > 0
    ? 0
    : 1;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runXEditorialMediaPreview(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\nRun with --help for usage.");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
