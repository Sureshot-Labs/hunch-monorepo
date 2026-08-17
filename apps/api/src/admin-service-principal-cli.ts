#!/usr/bin/env tsx

import { pool } from "./db.js";
import {
  createJournalServicePrincipal,
  disableJournalServicePrincipal,
  issueJournalServiceCredential,
  listJournalServicePrincipals,
  revokeJournalServiceCredential,
  rotateJournalServiceCredential,
} from "./services/journal-service-principals.js";

type Command =
  | "create"
  | "issue"
  | "rotate"
  | "revoke"
  | "disable"
  | "list"
  | "help";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const candidate = index >= 0 ? args[index + 1] : undefined;
  return candidate && !candidate.startsWith("--") ? candidate : undefined;
}

function required(args: string[], flag: string): string {
  const candidate = value(args, flag)?.trim();
  if (!candidate) throw new Error(`${flag} is required`);
  return candidate;
}

function productionConfirmed(args: string[]): void {
  if (
    process.env.NODE_ENV?.toLowerCase() === "production" &&
    !args.includes("--confirm-production")
  ) {
    throw new Error("--confirm-production is required in production");
  }
}

function usage() {
  return `
Usage:
  pnpm -F api admin:service-principal create --key <key> --display-name <name> --actor-admin-id <uuid> --note <text>
  pnpm -F api admin:service-principal issue --principal-id <uuid> --scopes <comma-list> [--ttl-days <days>] --actor-admin-id <uuid> --note <text>
  pnpm -F api admin:service-principal rotate --credential-id <uuid> --scopes <comma-list> [--ttl-days <days>] --actor-admin-id <uuid> --note <text>
  pnpm -F api admin:service-principal revoke --credential-id <uuid> --actor-admin-id <uuid> --reason <text>
  pnpm -F api admin:service-principal disable --principal-id <uuid> --actor-admin-id <uuid> --reason <text>
  pnpm -F api admin:service-principal list

Credential TTL defaults to 30 days. Rotation atomically revokes the selected credential and issues its replacement. Add --confirm-production to every mutating production command. Plaintext tokens are printed once and are never accepted as arguments.
`.trim();
}

async function main() {
  const raw = process.argv.slice(2);
  const args = raw[0] === "--" ? raw.slice(1) : raw;
  const command = (args[0] ?? "help") as Command;
  if (command === "help") {
    console.log(usage());
    return;
  }
  if (command === "list") {
    console.log(
      JSON.stringify(await listJournalServicePrincipals(pool), null, 2),
    );
    return;
  }
  productionConfirmed(args);
  const actorAdminId = required(args, "--actor-admin-id");

  if (command === "create") {
    const created = await createJournalServicePrincipal(pool, {
      key: required(args, "--key"),
      displayName: required(args, "--display-name"),
      actorAdminId,
      note: required(args, "--note"),
    });
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  if (command === "issue") {
    const ttlDays = Number(value(args, "--ttl-days") ?? "30");
    const issued = await issueJournalServiceCredential(pool, {
      principalId: required(args, "--principal-id"),
      scopes: required(args, "--scopes").split(","),
      ttlDays,
      actorAdminId,
      note: required(args, "--note"),
    });
    console.log(JSON.stringify(issued, null, 2));
    return;
  }
  if (command === "rotate") {
    const ttlDays = Number(value(args, "--ttl-days") ?? "30");
    const issued = await rotateJournalServiceCredential(pool, {
      credentialId: required(args, "--credential-id"),
      scopes: required(args, "--scopes").split(","),
      ttlDays,
      actorAdminId,
      note: required(args, "--note"),
    });
    console.log(JSON.stringify(issued, null, 2));
    return;
  }
  if (command === "revoke") {
    console.log(
      JSON.stringify(
        await revokeJournalServiceCredential(pool, {
          credentialId: required(args, "--credential-id"),
          actorAdminId,
          reason: required(args, "--reason"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "disable") {
    console.log(
      JSON.stringify(
        await disableJournalServicePrincipal(pool, {
          principalId: required(args, "--principal-id"),
          actorAdminId,
          reason: required(args, "--reason"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
