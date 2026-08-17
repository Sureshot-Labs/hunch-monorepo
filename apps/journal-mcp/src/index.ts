#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { JournalApiClient, JournalApiError } from "./api-client.js";
import { loadJournalMcpConfig, type JournalMcpConfig } from "./config.js";
import { inspectLocalImage } from "./image-file.js";

const uuid = z.string().uuid();
const cursor = z.string().trim().min(1).max(1_024).optional();
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const articleStatus = z.enum([
  "draft",
  "in_review",
  "approved",
  "published",
  "scheduled",
  "archived",
]);
const articleKind = z.enum(["guide", "news", "analysis", "research", "update"]);
const jsonObject = z.record(z.string(), z.json());
const nullableJsonObject = jsonObject.nullable();
const credentialFreeHttpUrl = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  }, "Only credential-free HTTP(S) URLs are allowed");
const editableArticleFields = {
  contentKind: articleKind.optional(),
  editorialGraph: jsonObject.optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  title: z.string().trim().min(1).max(160).optional(),
  excerpt: z.string().trim().max(500).optional(),
  document: jsonObject.optional(),
  listCover: nullableJsonObject.optional(),
  heroImage: nullableJsonObject.optional(),
  socialImage: nullableJsonObject.optional(),
  seo: jsonObject.optional(),
  author: jsonObject.optional(),
  category: nullableJsonObject.optional(),
  tags: z.array(jsonObject).max(20).optional(),
  locale: z.string().trim().min(2).max(35).optional(),
  featured: z.boolean().optional(),
} as const;

const createDraftSchema = z
  .object({
    idempotency_key: idempotencyKey,
    draft: z
      .object({
        ...editableArticleFields,
        slug: editableArticleFields.slug.unwrap(),
        title: editableArticleFields.title.unwrap(),
      })
      .strict(),
  })
  .strict();

const changesSchema = z
  .object(editableArticleFields)
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one top-level change is required",
  });

const imageMetadataChangesSchema = z
  .object({
    alt: z.string().trim().max(500).nullable().optional(),
    caption: z.string().trim().max(2_000).nullable().optional(),
    credit_name: z.string().trim().max(200).nullable().optional(),
    credit_url: credentialFreeHttpUrl.nullable().optional(),
    focal_x: z.number().min(0).max(1).nullable().optional(),
    focal_y: z.number().min(0).max(1).nullable().optional(),
    source_type: z
      .enum(["app-screenshot", "telegram-screenshot", "generated-editorial"])
      .optional(),
    license: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one image metadata change is required",
  });

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function runTool(operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return result(await operation());
  } catch (error) {
    if (error instanceof JournalApiError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error.body.error ?? "journal_api_error",
              message: error.message,
              status: error.status,
              ...(error.body.issues ? { issues: error.body.issues } : {}),
              ...(error.body.details ? { details: error.body.details } : {}),
            }),
          },
        ],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "journal_mcp_error",
            message:
              error instanceof Error
                ? error.message
                : "Journal MCP operation failed",
          }),
        },
      ],
    };
  }
}

function articlePath(articleId: string, suffix = ""): string {
  return `/service/journal/articles/${encodeURIComponent(articleId)}${suffix}`;
}

export function createJournalMcpServer(config: JournalMcpConfig): McpServer {
  const api = new JournalApiClient(config);
  const server = new McpServer(
    { name: "hunch-journal", version: "0.1.0" },
    {
      instructions:
        "Read the current revision before edits. Every update requires expected_revision; never retry a revision conflict as an overwrite. Create and upload operations require a caller-stable idempotency_key. Nested values in changes replace the complete top-level field.",
    },
  );

  server.registerTool(
    "journal_list_articles",
    {
      description: "List Journal articles visible to the service principal.",
      inputSchema: z
        .object({
          cursor,
          limit: z.number().int().min(1).max(100).default(25),
          query: z.string().trim().min(1).max(200).optional(),
          status: articleStatus.optional(),
        })
        .strict(),
    },
    ({ cursor: cursorValue, limit, query, status }) =>
      runTool(() =>
        api.request("GET", "/service/journal/articles", {
          query: { cursor: cursorValue, limit, q: query, status },
        }),
      ),
  );

  server.registerTool(
    "journal_get_article",
    {
      description:
        "Get a Journal article with its current draft revision and content hash.",
      inputSchema: z.object({ article_id: uuid }).strict(),
    },
    ({ article_id }) =>
      runTool(() => api.request("GET", articlePath(article_id))),
  );

  server.registerTool(
    "journal_list_versions",
    {
      description: "List immutable version summaries for a Journal article.",
      inputSchema: z
        .object({
          article_id: uuid,
          cursor,
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
    },
    ({ article_id, cursor: cursorValue, limit }) =>
      runTool(() =>
        api.request("GET", articlePath(article_id, "/versions"), {
          query: { cursor: cursorValue, limit },
        }),
      ),
  );

  server.registerTool(
    "journal_get_version",
    {
      description: "Get one immutable full Journal version snapshot.",
      inputSchema: z.object({ article_id: uuid, version_id: uuid }).strict(),
    },
    ({ article_id, version_id }) =>
      runTool(() =>
        api.request(
          "GET",
          articlePath(
            article_id,
            `/versions/${encodeURIComponent(version_id)}`,
          ),
        ),
      ),
  );

  server.registerTool(
    "journal_create_draft",
    {
      description:
        "Create an article in draft state. Reuse the same idempotency_key when retrying the same body.",
      inputSchema: createDraftSchema,
    },
    ({ idempotency_key, draft }) =>
      runTool(() =>
        api.request("POST", "/service/journal/articles", {
          body: draft,
          idempotencyKey: idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "journal_checkpoint_draft",
    {
      description:
        "Create an explicit immutable checkpoint for the current draft revision.",
      inputSchema: z
        .object({
          article_id: uuid,
          expected_revision: z.number().int().positive(),
        })
        .strict(),
    },
    ({ article_id, expected_revision }) =>
      runTool(() =>
        api.request("POST", articlePath(article_id, "/checkpoint"), {
          body: { expectedRevision: expected_revision },
        }),
      ),
  );

  server.registerTool(
    "journal_update_draft",
    {
      description:
        "Update typed top-level draft fields with optimistic concurrency. Nested objects and arrays replace the complete field. A backend checkpoint is created atomically before a meaningful service update.",
      inputSchema: z
        .object({
          article_id: uuid,
          expected_revision: z.number().int().positive(),
          changes: changesSchema,
        })
        .strict(),
    },
    ({ article_id, expected_revision, changes }) =>
      runTool(() =>
        api.request("PATCH", articlePath(article_id), {
          body: { expectedRevision: expected_revision, ...changes },
        }),
      ),
  );

  server.registerTool(
    "journal_validate_draft",
    {
      description:
        "Run the backend publication validation without changing article state.",
      inputSchema: z.object({ article_id: uuid }).strict(),
    },
    ({ article_id }) =>
      runTool(() => api.request("POST", articlePath(article_id, "/validate"))),
  );

  server.registerTool(
    "journal_create_preview",
    {
      description:
        "Create a short-lived preview token for an exact current draft revision.",
      inputSchema: z
        .object({
          article_id: uuid,
          expected_revision: z.number().int().positive(),
          ttl_seconds: z.number().int().min(60).max(3_600).default(600),
        })
        .strict(),
    },
    ({ article_id, expected_revision, ttl_seconds }) =>
      runTool(() =>
        api.request("POST", articlePath(article_id, "/preview-token"), {
          body: {
            expectedRevision: expected_revision,
            ttlSeconds: ttl_seconds,
          },
        }),
      ),
  );

  server.registerTool(
    "journal_list_assets",
    {
      description:
        "List sanitized image assets. Storage keys and raw metadata are never returned.",
      inputSchema: z
        .object({
          cursor,
          limit: z.number().int().min(1).max(100).default(30),
          status: z
            .enum(["pending", "verifying", "ready", "failed", "deleted"])
            .optional(),
        })
        .strict(),
    },
    ({ cursor: cursorValue, limit, status }) =>
      runTool(() =>
        api.request("GET", "/service/journal/assets", {
          query: { cursor: cursorValue, limit, status },
        }),
      ),
  );

  server.registerTool(
    "journal_upload_image",
    {
      description:
        "Validate and upload one local image from an allowlisted root, then return only the completed sanitized asset. The image alt text is required.",
      inputSchema: z
        .object({
          local_path: z.string().trim().min(1).max(4_096),
          idempotency_key: idempotencyKey,
          alt: z.string().trim().min(1).max(500),
          caption: z.string().trim().max(2_000).nullable().optional(),
          credit_name: z.string().trim().max(200).nullable().optional(),
          credit_url: credentialFreeHttpUrl.nullable().optional(),
          source_type: z.enum([
            "app-screenshot",
            "telegram-screenshot",
            "generated-editorial",
          ]),
          license: z.string().trim().min(1).max(200).nullable().optional(),
        })
        .strict(),
    },
    ({
      local_path,
      idempotency_key,
      alt,
      caption,
      credit_name,
      credit_url,
      source_type,
      license,
    }) =>
      runTool(async () => {
        const image = await inspectLocalImage(local_path, config.allowedRoots);
        const intent = await api.request<{
          asset: unknown;
          upload: null | {
            method: string;
            url: string;
            headers: Record<string, unknown>;
          };
        }>("POST", "/service/journal/assets", {
          idempotencyKey: idempotency_key,
          body: {
            originalFilename: image.filename,
            mimeType: image.mimeType,
            expectedByteSize: image.byteSize,
            checksumSha256: image.checksumSha256,
            defaultAlt: alt,
            defaultCaption: caption,
            creditName: credit_name,
            creditUrl: credit_url,
            sourceType: source_type,
            license,
          },
        });
        if (intent.upload === null)
          return { ok: true, asset: intent.asset, idempotentReplay: true };
        if (intent.upload.method !== "PUT")
          throw new Error("Upload intent uses an unsupported method");
        const assetId = z
          .object({ id: uuid })
          .passthrough()
          .parse(intent.asset).id;
        await api.uploadPresigned(
          intent.upload.url,
          intent.upload.headers,
          image.bytes,
        );
        return api.request(
          "POST",
          `/service/journal/assets/${encodeURIComponent(assetId)}/complete`,
          {
            body: {
              byteSize: image.byteSize,
              checksumSha256: image.checksumSha256,
              width: image.width,
              height: image.height,
            },
          },
        );
      }),
  );

  server.registerTool(
    "journal_update_image_metadata",
    {
      description:
        "Update metadata for an image created by this service principal. Omitted fields are unchanged; null clears a nullable field.",
      inputSchema: z
        .object({
          asset_id: uuid,
          changes: imageMetadataChangesSchema,
        })
        .strict(),
    },
    ({ asset_id, changes }) =>
      runTool(() =>
        api.request(
          "PATCH",
          `/service/journal/assets/${encodeURIComponent(asset_id)}/metadata`,
          {
            body: {
              defaultAlt: changes.alt,
              defaultCaption: changes.caption,
              creditName: changes.credit_name,
              creditUrl: changes.credit_url,
              focalX: changes.focal_x,
              focalY: changes.focal_y,
              sourceType: changes.source_type,
              license: changes.license,
            },
          },
        ),
      ),
  );

  server.registerTool(
    "journal_get_audit",
    {
      description: "Read generalized audit events for a Journal article.",
      inputSchema: z
        .object({
          article_id: uuid,
          cursor,
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
    },
    ({ article_id, cursor: cursorValue, limit }) =>
      runTool(() =>
        api.request("GET", articlePath(article_id, "/audit"), {
          query: { cursor: cursorValue, limit },
        }),
      ),
  );

  if (config.enableReviewSubmit) {
    server.registerTool(
      "journal_submit_review",
      {
        description:
          "Submit an exact current draft revision for human review; never approves or publishes.",
        inputSchema: z
          .object({
            article_id: uuid,
            expected_revision: z.number().int().positive(),
          })
          .strict(),
      },
      ({ article_id, expected_revision }) =>
        runTool(() =>
          api.request("POST", articlePath(article_id, "/submit-review"), {
            body: { expectedRevision: expected_revision },
          }),
        ),
    );
  }

  return server;
}

function main(): void {
  try {
    const config = loadJournalMcpConfig();
    void serveStdio(() => createJournalMcpServer(config));
    console.error("Hunch Journal MCP is listening on stdio");
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Hunch Journal MCP configuration error: ${error.message}`
        : "Hunch Journal MCP failed to start",
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) main();
