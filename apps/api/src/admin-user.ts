#!/usr/bin/env tsx

import { pool } from "./db.js";

type ScriptOptions = {
  wallet?: string;
  userId?: string;
  grant: boolean;
  revoke: boolean;
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
    show: hasFlag("--show"),
    listAdmins: hasFlag("--list-admins"),
  };
}

function normalizeWallet(value: string): string {
  return value.trim().toLowerCase();
}

async function fetchUsersByWallet(wallet: string) {
  const { rows } = await pool.query<{
    id: string;
    email: string | null;
    username: string | null;
    is_admin: boolean;
    wallet_address: string;
    is_primary: boolean;
    last_login_at: Date | null;
  }>(
    `
      select u.id,
             u.email,
             u.username,
             u.is_admin,
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

async function fetchUserById(userId: string) {
  const { rows } = await pool.query<{
    id: string;
    email: string | null;
    username: string | null;
    is_admin: boolean;
  }>(
    `
      select id, email, username, is_admin
      from users
      where id = $1
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0] ?? null;
}

async function setAdmin(userId: string, isAdmin: boolean) {
  await pool.query(`update users set is_admin = $2 where id = $1`, [
    userId,
    isAdmin,
  ]);
}

async function listAdmins() {
  const { rows } = await pool.query<{
    id: string;
    email: string | null;
    username: string | null;
  }>(`select id, email, username from users where is_admin = true`);
  rows.forEach((row) => {
    console.log(`${row.id} ${row.email ?? ""} ${row.username ?? ""}`.trim());
  });
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

    if (!targetWallet && !targetUserId) {
      throw new Error("Provide --wallet or --user-id");
    }

    const users = targetWallet ? await fetchUsersByWallet(targetWallet) : [];
    const user = targetUserId
      ? await fetchUserById(targetUserId)
      : users[0] ?? null;

    if (targetWallet && users.length > 1 && !targetUserId) {
      console.error("Multiple users found for wallet. Use --user-id:");
      users.forEach((row) => {
        console.error(
          `${row.id} primary=${row.is_primary} admin=${row.is_admin} lastLogin=${row.last_login_at?.toISOString() ?? "n/a"} ${row.email ?? ""} ${row.username ?? ""}`.trim(),
        );
      });
      process.exitCode = 1;
      return;
    }

    if (!user) {
      throw new Error("User not found");
    }

    if (options.show) {
      console.log(
        JSON.stringify(
          {
            id: user.id,
            email: user.email,
            username: user.username,
            isAdmin: user.is_admin,
            wallet: "wallet_address" in user ? user.wallet_address : undefined,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (options.grant === options.revoke) {
      throw new Error("Use --grant or --revoke");
    }

    await setAdmin(user.id, options.grant);
    console.log(
      `${options.grant ? "Granted" : "Revoked"} admin for ${user.id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
