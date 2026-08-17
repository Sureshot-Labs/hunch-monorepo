import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { imageSize } from "image-size";

import type { AllowedRoot } from "./config.js";

const MAX_IMAGE_BYTES = 20_000_000;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 100_000_000;
const BLOCKED_COMPONENTS = new Set([
  ".aws",
  ".codex",
  ".config",
  ".gnupg",
  ".kube",
  ".ssh",
  ".secrets",
  "credentials",
  "secrets",
]);
const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
};

export type LocalImage = {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width: number;
  height: number;
};

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function detectMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
    bytes.subarray(0, 6).toString("ascii") === "GIF89a"
  )
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    /avi[fs]/.test(bytes.subarray(8, 40).toString("ascii"))
  )
    return "image/avif";
  return null;
}

async function rejectSymlinkComponents(
  root: string,
  file: string,
): Promise<void> {
  const relative = path.relative(root, file);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Image path must not contain symbolic links");
    }
  }
}

export async function inspectLocalImage(
  inputPath: string,
  roots: AllowedRoot[],
): Promise<LocalImage> {
  if (!inputPath.trim()) throw new Error("A local image path is required");
  const absolute = path.resolve(inputPath);
  const root = roots.find((candidate) =>
    inside(candidate.configuredPath, absolute),
  );
  if (!root) throw new Error("Image path is outside JOURNAL_MCP_ALLOWED_ROOTS");
  const relativeComponents = path
    .relative(root.configuredPath, absolute)
    .split(path.sep)
    .filter(Boolean);
  if (
    relativeComponents.some((component) =>
      BLOCKED_COMPONENTS.has(component.toLowerCase()),
    )
  ) {
    throw new Error("Image path enters a blocked credential directory");
  }
  const extension = path.extname(absolute).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION[extension];
  if (!expectedMime)
    throw new Error("Only JPEG, PNG, WebP, AVIF, and GIF files are allowed");

  await rejectSymlinkComponents(root.configuredPath, absolute);
  const resolved = await realpath(absolute);
  if (!inside(root.realPath, resolved)) {
    throw new Error("Resolved image path is outside JOURNAL_MCP_ALLOWED_ROOTS");
  }
  // Open the already-resolved path so a parent symlink cannot be swapped
  // between the containment check and the file read.
  const before = await lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Image path must be a regular non-symlink file");
  }
  if (before.size <= 0 || before.size > MAX_IMAGE_BYTES) {
    throw new Error("Image must be between 1 byte and 20 MB");
  }

  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("Image changed while it was being opened");
    }
    if (opened.nlink > 1) {
      throw new Error("Image path must not be a hard-linked file");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Image changed while it was being read");
    }
    const detectedMime = detectMime(bytes);
    if (!detectedMime || detectedMime !== expectedMime) {
      throw new Error("Image extension and magic-byte MIME do not match");
    }
    let dimensions: ReturnType<typeof imageSize>;
    try {
      dimensions = imageSize(bytes);
    } catch {
      throw new Error("Image dimensions could not be decoded");
    }
    const width = dimensions.width;
    const height = dimensions.height;
    if (
      !width ||
      !height ||
      width > MAX_IMAGE_DIMENSION ||
      height > MAX_IMAGE_DIMENSION ||
      width * height > MAX_IMAGE_PIXELS
    ) {
      throw new Error("Image dimensions exceed the 20,000 px / 100 MP limits");
    }
    return {
      bytes,
      filename: path.basename(resolved),
      mimeType: detectedMime,
      byteSize: bytes.length,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      width,
      height,
    };
  } finally {
    await handle.close();
  }
}
