#!/usr/bin/env tsx

import { pool } from "./db.js";
import {
  AdminAuthError,
  AdminAuthService,
  type AdminRole,
} from "./services/admin-auth.js";

type Command =
  | "invite"
  | "activate"
  | "disable"
  | "rotate-link"
  | "revoke-sessions"
  | "list"
  | "help";

type Options = {
  command: Command;
  email?: string;
  role?: AdminRole;
  json: boolean;
};

function usage(): string {
  return `
Usage:
  pnpm -F api run admin:auth -- invite --email <email>
  pnpm -F api run admin:auth -- activate --email <email> --role sadmin|admin|viewer|analyst
  pnpm -F api run admin:auth -- disable --email <email>
  pnpm -F api run admin:auth -- rotate-link --email <email>
  pnpm -F api run admin:auth -- revoke-sessions --email <email>
  pnpm -F api run admin:auth -- list

Options:
  --json  Print machine-readable JSON.
`.trim();
}

function parseArgs(argv: string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = (args[0] ?? "help") as Command;
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const roleRaw = getValue("--role");
  const role =
    roleRaw === "sadmin" ||
    roleRaw === "admin" ||
    roleRaw === "viewer" ||
    roleRaw === "analyst"
      ? roleRaw
      : undefined;
  return {
    command,
    email: getValue("--email"),
    role,
    json: args.includes("--json"),
  };
}

function requireEmail(options: Options): string {
  const email = options.email?.trim();
  if (!email) throw new Error("--email is required");
  return email;
}

function requireRole(options: Options): AdminRole {
  if (options.role) return options.role;
  throw new Error("--role sadmin|admin|viewer|analyst is required");
}

function print(options: Options, payload: unknown, text: string): void {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(text);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case "help":
      console.log(usage());
      return;
    case "invite": {
      const result = await AdminAuthService.inviteAdmin(requireEmail(options));
      print(
        options,
        {
          email: result.admin.email,
          status: result.admin.status,
          enrollmentUrl: result.enrollmentUrl,
          expiresAt: result.expiresAt.toISOString(),
        },
        [
          `Invited ${result.admin.email}`,
          `Status: ${result.admin.status}`,
          `Expires: ${result.expiresAt.toISOString()}`,
          `Enrollment URL: ${result.enrollmentUrl}`,
        ].join("\n"),
      );
      return;
    }
    case "rotate-link": {
      const result = await AdminAuthService.rotateEnrollmentLink(
        requireEmail(options),
      );
      print(
        options,
        {
          email: result.admin.email,
          status: result.admin.status,
          enrollmentUrl: result.enrollmentUrl,
          expiresAt: result.expiresAt.toISOString(),
        },
        [
          `Rotated enrollment link for ${result.admin.email}`,
          `Status: ${result.admin.status}`,
          `Expires: ${result.expiresAt.toISOString()}`,
          `Enrollment URL: ${result.enrollmentUrl}`,
        ].join("\n"),
      );
      return;
    }
    case "activate": {
      const result = await AdminAuthService.activateAdmin(
        requireEmail(options),
        requireRole(options),
      );
      print(
        options,
        {
          email: result.email,
          status: result.status,
          role: result.role,
          activatedAt: result.activatedAt?.toISOString() ?? null,
        },
        `Activated ${result.email} as ${result.role}`,
      );
      return;
    }
    case "disable": {
      const result = await AdminAuthService.disableAdmin(requireEmail(options));
      print(
        options,
        {
          email: result.email,
          status: result.status,
          role: result.role,
          disabledAt: result.disabledAt?.toISOString() ?? null,
        },
        `Disabled ${result.email}`,
      );
      return;
    }
    case "revoke-sessions": {
      const revoked = await AdminAuthService.revokeSessionsByEmail(
        requireEmail(options),
      );
      print(options, { revoked }, `Revoked ${revoked} session(s)`);
      return;
    }
    case "list": {
      const rows = await AdminAuthService.listAdmins();
      const payload = rows.map((row) => ({
        email: row.email,
        status: row.status,
        role: row.role,
        invitedAt: row.invitedAt.toISOString(),
        enrolledAt: row.enrolledAt?.toISOString() ?? null,
        activatedAt: row.activatedAt?.toISOString() ?? null,
        disabledAt: row.disabledAt?.toISOString() ?? null,
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      }));
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      for (const row of payload) {
        console.log(
          [
            row.email,
            `status=${row.status}`,
            `role=${row.role ?? "-"}`,
            `enrolled=${row.enrolledAt ?? "-"}`,
            `activated=${row.activatedAt ?? "-"}`,
            `lastLogin=${row.lastLoginAt ?? "-"}`,
          ].join(" "),
        );
      }
      return;
    }
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AdminAuthError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
