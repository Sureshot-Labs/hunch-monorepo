#!/usr/bin/env tsx

import { pool } from "./db.js";
import type { PoolClient } from "pg";

type ScriptOptions = {
  wallet?: string;
  userId?: string;
  grant: boolean;
  revoke: boolean;
  revokeAllAdmins: boolean;
  allowZeroAdmins: boolean;
  proofBypassOn: boolean;
  proofBypassOff: boolean;
  show: boolean;
  listAdmins: boolean;
};

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  return {
    wallet: getValue("--wallet"),
    userId: getValue("--user-id"),
    grant: hasFlag("--grant"),
    revoke: hasFlag("--revoke"),
    revokeAllAdmins: hasFlag("--revoke-all-admins"),
    allowZeroAdmins: hasFlag("--allow-zero-admins"),
    proofBypassOn: hasFlag("--proof-bypass-on"),
    proofBypassOff: hasFlag("--proof-bypass-off"),
    show: hasFlag("--show"),
    listAdmins: hasFlag("--list-admins"),
  };
}

function normalizeWallet(value: string): string {
  return value.trim().toLowerCase();
}

type Queryable = Pick<typeof pool, "query"> | Pick<PoolClient, "query">;

async function fetchUsersByWallet(wallet: string, db: Queryable = pool) {
  const { rows } = await db.query<{
    id: string;
    email: string | null;
    username: string | null;
    is_admin: boolean;
    kalshi_proof_bypass: boolean;
    wallet_address: string;
    is_primary: boolean;
    last_login_at: Date | null;
  }>(
    `
      select u.id,
             u.email,
             u.username,
             u.is_admin,
             u.kalshi_proof_bypass,
             u.last_login_at,
             w.wallet_address,
             w.is_primary
      from users u
      join user_wallets w on w.user_id = u.id
      where lower(w.wallet_address) = $1
      order by w.is_primary desc, u.last_login_at desc nulls last
    `,
    [normalizeWallet(wallet)],
  );
  return rows;
}

async function fetchUserById(userId: string, db: Queryable = pool) {
  const { rows } = await db.query<{
    id: string;
    email: string | null;
    username: string | null;
    is_admin: boolean;
    kalshi_proof_bypass: boolean;
  }>(
    `
      select id, email, username, is_admin, kalshi_proof_bypass
      from users
      where id = $1
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0] ?? null;
}

async function setAdmin(
  userId: string,
  isAdmin: boolean,
  db: Queryable = pool,
) {
  await db.query(`update users set is_admin = $2 where id = $1`, [
    userId,
    isAdmin,
  ]);
}

async function setKalshiProofBypass(
  userId: string,
  enabled: boolean,
  db: Queryable = pool,
) {
  await db.query(`update users set kalshi_proof_bypass = $2 where id = $1`, [
    userId,
    enabled,
  ]);
}

async function listAdmins(db: Queryable = pool) {
  const { rows } = await db.query<{
    id: string;
    email: string | null;
    username: string | null;
  }>(`select id, email, username from users where is_admin = true`);
  rows.forEach((row) => {
    console.log(`${row.id} ${row.email ?? ""} ${row.username ?? ""}`.trim());
  });
}

async function countAdmins(db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(*)::text as count from users where is_admin = true`,
  );
  return Number(rows[0]?.count ?? "0");
}

async function resolveTargetUser(
  targetWallet: string | undefined,
  targetUserId: string | undefined,
  db: Queryable = pool,
) {
  const users = targetWallet ? await fetchUsersByWallet(targetWallet, db) : [];
  const user = targetUserId
    ? await fetchUserById(targetUserId, db)
    : (users[0] ?? null);

  if (targetWallet && users.length > 1 && !targetUserId) {
    console.error("Multiple users found for wallet. Use --user-id:");
    users.forEach((row) => {
      console.error(
        `${row.id} primary=${row.is_primary} admin=${row.is_admin} lastLogin=${row.last_login_at?.toISOString() ?? "n/a"} ${row.email ?? ""} ${row.username ?? ""}`.trim(),
      );
    });
    process.exitCode = 1;
    return null;
  }

  return user;
}

async function main() {
  try {
    const options = parseArgs();

    if (options.listAdmins) {
      await listAdmins();
      return;
    }

    const targetWallet = options.wallet?.trim();
    const targetUserId = options.userId?.trim();

    if (options.revokeAllAdmins) {
      const adminToggleCount = Number(options.grant) + Number(options.revoke);
      const proofToggleCount =
        Number(options.proofBypassOn) + Number(options.proofBypassOff);
      if (options.show) {
        throw new Error("--revoke-all-admins cannot be combined with --show");
      }
      if (adminToggleCount > 0 || proofToggleCount > 0) {
        throw new Error(
          "--revoke-all-admins cannot be combined with --grant/--revoke or proof-bypass flags",
        );
      }

      const client = await pool.connect();
      try {
        await client.query("begin");

        const beforeCount = await countAdmins(client);
        await client.query(
          `update users set is_admin = false where is_admin = true`,
        );

        let keeperId: string | null = null;
        if (targetWallet || targetUserId) {
          const keeper = await resolveTargetUser(
            targetWallet,
            targetUserId,
            client,
          );
          if (!keeper) {
            throw new Error("Keeper user not found");
          }
          await setAdmin(keeper.id, true, client);
          keeperId = keeper.id;
        }

        const afterCount = await countAdmins(client);
        if (afterCount === 0 && !options.allowZeroAdmins) {
          throw new Error(
            "Refusing to leave zero admins. Provide --user-id/--wallet keeper or pass --allow-zero-admins",
          );
        }

        await client.query("commit");
        console.log(
          `Revoked admin for all users (before=${beforeCount}, after=${afterCount}${keeperId ? `, keeper=${keeperId}` : ""})`,
        );
        return;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    if (!targetWallet && !targetUserId) {
      throw new Error("Provide --wallet or --user-id");
    }

    const user = await resolveTargetUser(targetWallet, targetUserId);
    if (!user) throw new Error("User not found");

    if (options.show) {
      console.log(
        JSON.stringify(
          {
            id: user.id,
            email: user.email,
            username: user.username,
            isAdmin: user.is_admin,
            kalshiProofBypass: user.kalshi_proof_bypass,
            wallet: "wallet_address" in user ? user.wallet_address : undefined,
          },
          null,
          2,
        ),
      );
      return;
    }

    const adminToggleCount = Number(options.grant) + Number(options.revoke);
    const proofToggleCount =
      Number(options.proofBypassOn) + Number(options.proofBypassOff);

    if (adminToggleCount > 1 || proofToggleCount > 1) {
      throw new Error(
        "Use only one toggle per group: --grant/--revoke and --proof-bypass-on/--proof-bypass-off",
      );
    }
    if (adminToggleCount + proofToggleCount !== 1) {
      throw new Error(
        "Use exactly one action: --grant | --revoke | --proof-bypass-on | --proof-bypass-off",
      );
    }

    if (adminToggleCount === 1) {
      await setAdmin(user.id, options.grant);
      console.log(
        `${options.grant ? "Granted" : "Revoked"} admin for ${user.id}`,
      );
      return;
    }

    await setKalshiProofBypass(user.id, options.proofBypassOn);
    console.log(
      `${options.proofBypassOn ? "Enabled" : "Disabled"} kalshi proof bypass for ${user.id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
