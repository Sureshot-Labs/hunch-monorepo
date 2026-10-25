import assert from "node:assert/strict";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  eraseObjectVersions,
  StorageErasureInProgress,
} from "./services/content-storage-erasure.js";

for (const scenario of [
  { versions: 2, markers: 1, failures: 1 },
  { versions: 8001, markers: 2, failures: 0 },
  { versions: 1, markers: 2001, failures: 0 },
]) {
  type Entry = { Key: string; VersionId: string; marker: boolean };
  let sequence = 0;
  const key = "content/test.png";
  let entries: Entry[] = [];
  const add = (marker: boolean) =>
    entries.unshift({ Key: key, VersionId: String(++sequence), marker });
  for (let i = 0; i < scenario.versions; i++) add(false);
  for (let i = 0; i < scenario.markers; i++) add(true);
  entries.push({
    Key: key + ".neighbour",
    VersionId: "neighbour",
    marker: false,
  });
  let failures = scenario.failures;
  const hidden = () =>
    assert.ok(
      entries.find((entry) => entry.Key === key)?.marker,
      "surviving versions must always remain masked",
    );
  const send = async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) {
      add(true);
      hidden();
      return { VersionId: String(sequence), DeleteMarker: true };
    }
    if (command instanceof ListObjectVersionsCommand) {
      const page = entries.slice(0, 1000);
      const shape = (entry: Entry) => ({
        Key: entry.Key,
        VersionId: entry.VersionId,
        IsLatest: entry === entries[0],
      });
      return {
        Versions: page.filter((entry) => !entry.marker).map(shape),
        DeleteMarkers: page.filter((entry) => entry.marker).map(shape),
      };
    }
    assert.ok(command instanceof DeleteObjectsCommand);
    const errors = [];
    const deleted = command.input.Delete?.Objects;
    assert.ok(deleted);
    for (const object of deleted) {
      const entry = entries.find(
        (candidate) => candidate.VersionId === object.VersionId,
      );
      if (entry && !entry.marker && failures > 0) {
        failures--;
        errors.push({
          Key: key,
          VersionId: entry.VersionId,
          Code: "InternalError",
        });
        continue;
      }
      entries = entries.filter(
        (candidate) => candidate.VersionId !== object.VersionId,
      );
    }
    hidden();
    return { Errors: errors };
  };
  for (let turn = 0; ; turn++) {
    assert.ok(
      turn < 10,
      "bounded turns must make progress through both versions and old markers",
    );
    try {
      await eraseObjectVersions(
        { send } as unknown as Pick<S3Client, "send">,
        "fixture",
        key,
      );
      break;
    } catch (error) {
      assert.ok(
        error instanceof StorageErasureInProgress ||
          (error as Error).message === "S3 version erasure was incomplete",
      );
      hidden();
    }
  }
  assert.equal(
    entries.filter((entry) => entry.Key === key && !entry.marker).length,
    0,
  );
  assert.equal(entries.filter((entry) => entry.Key === key).length, 1);
  assert.ok(entries.some((entry) => entry.VersionId === "neighbour"));
}
console.log(
  "[account-erasure-version] partial failure, bounded 8001 versions, 2001 markers and neighbouring keys passed",
);
