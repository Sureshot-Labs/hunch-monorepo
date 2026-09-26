import { z } from "zod";
import { aiCompletionMetadata } from "./ai-completion-diagnostics.js";
import { extractAiSourceUrls } from "./ai-response.js";

/** Shared Responses contract for both holder research and Maps search. */
export function buildXaiSearchResponseFormat(name: string, schema: z.ZodType) {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  return {
    text: {
      format: { type: "json_schema", name, strict: true, schema: jsonSchema },
    },
    // Inline citation tokens can corrupt JSON; provider source metadata remains.
    include: ["no_inline_citations"],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:/-]{1,160}$/.test(value)
    ? value
    : null;
}

export function searchSchemaIssues(schema: z.ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.slice(0, 24).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      }));
}

// Metadata only. No prompts, generated claims, reasoning or raw error bodies.
export function xaiSearchDiagnostics(payload: unknown, response: Response) {
  const root = record(payload);
  return {
    ...aiCompletionMetadata(payload),
    httpStatus: response.status,
    responseId: metadataString(root.id),
    requestId: metadataString(response.headers.get("x-request-id")),
    model: metadataString(root.model),
    incompleteReason: metadataString(record(root.incomplete_details).reason),
    providerErrorCode: metadataString(record(root.error).code),
    providerErrorType: metadataString(record(root.error).type),
    providerErrorParam: metadataString(record(root.error).param),
    foundSourceCount: extractAiSourceUrls(payload).length,
    rawCitationCount: null as number | null,
    parsedCitationCount: null as number | null,
    verifiedCitationCount: null as number | null,
    summaryChars: null as number | null,
    rejectedFields: [] as string[],
    schemaIssues: [] as Array<{ path: string; code: string }>,
  };
}

export type XaiSearchDiagnostics = ReturnType<typeof xaiSearchDiagnostics>;
