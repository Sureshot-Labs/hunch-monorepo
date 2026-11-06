import { canonicalJsonHash } from "../persistence/canonical.js";

export type PreparationAdmission = Readonly<{
  id: string;
  keyHash: string;
  delivery: "client" | "embedded";
  signer: string;
  phase: "reserved" | "started" | "reported" | "not_started";
  createdAt: string;
}>;

/** Server-owned journal; never accepted from a public preparation request. */
export type PreparationExecutionJournal = Readonly<{
  version: 1;
  admissions: Readonly<Record<string, PreparationAdmission>>;
}>;

export function preparationAdmissionKeyHash(key: string): string {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(key)) {
    throw new Error("preparation admission requires a random request key");
  }
  return canonicalJsonHash({ purpose: "preparation-admission-v1", key });
}

export function preparationExecutionKey(input: {
  runId: string;
  actionId: string;
  admissionId: string;
}): string {
  return `trade-preparation:v1:${input.runId}:${input.actionId}:${input.admissionId}`;
}

export function parsePreparationExecutionKey(key: string | undefined) {
  const uuid = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
  const match = key?.match(
    new RegExp(`^trade-preparation:v1:(${uuid}):(.{8,192}):(${uuid})$`, "i"),
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    runId: match[1],
    actionId: match[2],
    admissionId: match[3],
  };
}
