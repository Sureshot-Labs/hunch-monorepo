import { createHmac, timingSafeEqual } from "node:crypto";

import { getContentServiceRuntime } from "../content-service-runtime.js";
import { ContentError } from "./content-errors.js";

type ContentPreviewClaims = {
  version: 1;
  articleId: string;
  revision: number;
  expiresAt: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function previewSecret(): string {
  const secret = getContentServiceRuntime().previewSecret;
  if (!secret) {
    throw new ContentError(
      "content_preview_unavailable",
      "Content preview is not configured",
      503,
    );
  }
  return secret;
}

function signature(encodedClaims: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedClaims).digest();
}

function createToken(
  inputs: { articleId: string; revision: number; ttlSeconds: number },
  secret: string,
): { token: string; expiresAt: string } {
  const expiresAt = Math.floor(Date.now() / 1_000) + inputs.ttlSeconds;
  const claims: ContentPreviewClaims = {
    version: 1,
    articleId: inputs.articleId,
    revision: inputs.revision,
    expiresAt,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const encodedSignature = signature(encodedClaims, secret).toString(
    "base64url",
  );
  return {
    token: `${encodedClaims}.${encodedSignature}`,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}

export function createContentPreviewToken(inputs: {
  articleId: string;
  revision: number;
  ttlSeconds: number;
}): { token: string; expiresAt: string } {
  return createToken(inputs, previewSecret());
}

function verifyToken(token: string, secret: string): ContentPreviewClaims {
  const [encodedClaims, encodedSignature, extra] = token.split(".");
  if (!encodedClaims || !encodedSignature || extra) {
    throw new ContentError(
      "content_preview_invalid",
      "Invalid content preview token",
      401,
    );
  }
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    providedSignature = Buffer.alloc(0);
  }
  const expectedSignature = signature(encodedClaims, secret);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new ContentError(
      "content_preview_invalid",
      "Invalid content preview token",
      401,
    );
  }
  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(encodedClaims, "base64url").toString("utf8"),
    );
  } catch {
    claims = null;
  }
  if (
    !claims ||
    typeof claims !== "object" ||
    (claims as Partial<ContentPreviewClaims>).version !== 1 ||
    typeof (claims as Partial<ContentPreviewClaims>).articleId !== "string" ||
    !UUID_PATTERN.test(
      (claims as Partial<ContentPreviewClaims>).articleId ?? "",
    ) ||
    !Number.isInteger((claims as Partial<ContentPreviewClaims>).revision) ||
    ((claims as Partial<ContentPreviewClaims>).revision ?? 0) < 1 ||
    !Number.isInteger((claims as Partial<ContentPreviewClaims>).expiresAt)
  ) {
    throw new ContentError(
      "content_preview_invalid",
      "Invalid content preview token",
      401,
    );
  }
  const parsed = claims as ContentPreviewClaims;
  if (parsed.expiresAt <= Math.floor(Date.now() / 1_000)) {
    throw new ContentError(
      "content_preview_expired",
      "Content preview token has expired",
      410,
    );
  }
  return parsed;
}

export function verifyContentPreviewToken(token: string): ContentPreviewClaims {
  return verifyToken(token, previewSecret());
}

export function createContentPreviewTokenForTests(
  secret: string,
  inputs: { articleId: string; revision: number; ttlSeconds: number },
) {
  return createToken(inputs, secret);
}

export function verifyContentPreviewTokenForTests(
  token: string,
  secret: string,
) {
  return verifyToken(token, secret);
}
