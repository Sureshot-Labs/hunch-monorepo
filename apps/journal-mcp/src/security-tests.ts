import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JournalApiClient } from "./api-client.js";
import { loadJournalMcpConfig, type JournalMcpConfig } from "./config.js";
import { inspectLocalImage } from "./image-file.js";

const token = `hjs_v1.00000000-0000-4000-8000-000000000001.${"A".repeat(43)}`;
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("config requires HTTPS outside localhost and explicit existing roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-mcp-config-"));
  try {
    assert.throws(() =>
      loadJournalMcpConfig({
        JOURNAL_SERVICE_API_ORIGIN: "http://journal.example.com",
        JOURNAL_SERVICE_TOKEN: token,
        JOURNAL_MCP_ALLOWED_ROOTS: root,
      }),
    );
    const config = loadJournalMcpConfig({
      JOURNAL_SERVICE_API_ORIGIN: "http://127.0.0.1:3001",
      JOURNAL_SERVICE_TOKEN: token,
      JOURNAL_MCP_ALLOWED_ROOTS: root,
    });
    assert.equal(config.apiOrigin.origin, "http://127.0.0.1:3001");
    assert.equal(config.allowedRoots.length, 1);
    assert.throws(() =>
      loadJournalMcpConfig({
        JOURNAL_SERVICE_API_ORIGIN: "http://127.0.0.1:3001",
        JOURNAL_SERVICE_TOKEN: token.replace("hjs_v1", "HJS_V1"),
        JOURNAL_MCP_ALLOWED_ROOTS: root,
      }),
    );
    assert.throws(() =>
      loadJournalMcpConfig({
        JOURNAL_SERVICE_API_ORIGIN: "http://127.0.0.1:3001",
        JOURNAL_SERVICE_TOKEN: `hjs_v1.${"a".repeat(36)}.${"A".repeat(43)}`,
        JOURNAL_MCP_ALLOWED_ROOTS: root,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image inspection rejects outside paths, symlinks, blocked dirs, and MIME mismatch", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "journal-mcp-image-"));
  const root = path.join(parent, "allowed");
  await mkdir(root);
  const valid = path.join(root, "valid.png");
  const mismatch = path.join(root, "mismatch.jpg");
  const link = path.join(root, "linked.png");
  const blockedDir = path.join(root, ".ssh");
  await writeFile(valid, onePixelPng);
  await writeFile(mismatch, onePixelPng);
  await symlink(valid, link);
  await mkdir(blockedDir);
  await writeFile(path.join(blockedDir, "capture.png"), onePixelPng);
  const roots = [{ configuredPath: root, realPath: await realpath(root) }];
  try {
    const image = await inspectLocalImage(valid, roots);
    assert.deepEqual(
      [image.mimeType, image.width, image.height],
      ["image/png", 1, 1],
    );
    await assert.rejects(() =>
      inspectLocalImage(path.join(parent, "outside.png"), roots),
    );
    await assert.rejects(
      () => inspectLocalImage(link, roots),
      /symbolic links/,
    );
    await assert.rejects(
      () => inspectLocalImage(mismatch, roots),
      /magic-byte MIME/,
    );
    await assert.rejects(
      () => inspectLocalImage(path.join(blockedDir, "capture.png"), roots),
      /blocked credential directory/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("API redirects are rejected before Authorization reaches a second origin", async () => {
  let secondOriginAuthorization: string | undefined;
  const second = createServer((request, response) => {
    secondOriginAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  const secondPort = (second.address() as { port: number }).port;
  const first = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${secondPort}/service/journal/articles`,
    });
    response.end();
  });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  const firstPort = (first.address() as { port: number }).port;
  const config: JournalMcpConfig = {
    apiOrigin: new URL(`http://127.0.0.1:${firstPort}`),
    serviceToken: token,
    allowedRoots: [],
    enableReviewSubmit: false,
  };
  try {
    await assert.rejects(
      () =>
        new JournalApiClient(config).request(
          "GET",
          "/service/journal/articles",
        ),
      /request failed/,
    );
    assert.equal(secondOriginAuthorization, undefined);
  } finally {
    first.close();
    second.close();
  }
});

test("API responses are bounded while streaming without Content-Length", async () => {
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(Buffer.alloc(4_000_001, 0x20));
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const port = (origin.address() as { port: number }).port;
  const config: JournalMcpConfig = {
    apiOrigin: new URL(`http://127.0.0.1:${port}`),
    serviceToken: token,
    allowedRoots: [],
    enableReviewSubmit: false,
  };
  try {
    await assert.rejects(
      () =>
        new JournalApiClient(config).request(
          "GET",
          "/service/journal/articles",
        ),
      /request failed/,
    );
  } finally {
    origin.close();
  }
});

test("presigned uploads reject embedded URL credentials", async () => {
  const config: JournalMcpConfig = {
    apiOrigin: new URL("http://127.0.0.1:3001"),
    serviceToken: token,
    allowedRoots: [],
    enableReviewSubmit: false,
  };
  await assert.rejects(
    () =>
      new JournalApiClient(config).uploadPresigned(
        "https://user:password@example.com/upload",
        {
          "content-type": "image/png",
          "x-amz-checksum-sha256": "checksum",
        },
        onePixelPng,
      ),
    /must not contain credentials/,
  );
});
