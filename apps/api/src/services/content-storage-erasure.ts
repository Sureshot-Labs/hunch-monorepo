import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { getContentServiceRuntime } from "../content-service-runtime.js";
import { contentAssetPublicUrl } from "./content-asset-url.js";

/** Progress is durable in S3; another bounded worker turn continues it. */
export class StorageErasureInProgress extends Error {}

export async function eraseObjectVersions(
  client: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<void> {
  // Covers unversioned buckets too. On versioned S3 this creates a marker,
  // which is removed together with *all* historical versions below.
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  for (let page = 0; page < 8; page += 1) {
    const listed = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        MaxKeys: 1000,
      }),
    );
    const objects = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ]
      .filter((entry) => entry.Key === key && entry.VersionId != null)
      .map((entry) => ({ Key: key, VersionId: entry.VersionId }));
    if (objects.length === 0) return;
    const deleted = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      }),
    );
    if (deleted.Errors?.length)
      throw new Error("S3 version erasure was incomplete");
    // Re-read the first page: pagination markers can refer to deleted versions.
  }
  throw new StorageErasureInProgress("More object versions remain");
}

const cloudFront = new CloudFrontClient({
  region: "us-east-1",
  maxAttempts: 3,
});

export async function invalidateStoredContent(
  key: string,
  reference: string,
  invalidationId: string | null,
  client: Pick<CloudFrontClient, "send"> = cloudFront,
): Promise<{ id: string | null; completed: boolean }> {
  if (!key.startsWith("content/")) return { id: null, completed: true };
  const config = getContentServiceRuntime();
  const distribution = config.assetCloudFrontDistributionId;
  if (!distribution) {
    // Hunch serves public assets through CloudFront, including custom domains.
    // A CNAME must not silently bypass invalidation when configuration is missing.
    throw new Error("CloudFront erasure distribution is not configured");
  }
  if (invalidationId) {
    const result = await client.send(
      new GetInvalidationCommand({
        DistributionId: distribution,
        Id: invalidationId,
      }),
    );
    return {
      id: invalidationId,
      completed: result.Invalidation?.Status === "Completed",
    };
  }
  const result = await client.send(
    new CreateInvalidationCommand({
      DistributionId: distribution,
      InvalidationBatch: {
        CallerReference: reference,
        Paths: {
          Quantity: 1,
          Items: [new URL(contentAssetPublicUrl(key)).pathname],
        },
      },
    }),
  );
  const id = result.Invalidation?.Id;
  if (!id) throw new Error("CloudFront did not acknowledge erasure");
  return { id, completed: result.Invalidation?.Status === "Completed" };
}
