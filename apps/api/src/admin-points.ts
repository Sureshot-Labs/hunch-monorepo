#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

type ScriptOptions = {
  wallet?: string;
  userId?: string;
  walletAddress?: string;
  amount?: number;
  sourceId?: string;
  sourceType?: "order" | "execution";
  venue?: string;
  dryRun: boolean;
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

  const sourceType = getValue("--source-type");
  return {
    wallet: getValue("--wallet"),
    userId: getValue("--user-id"),
    walletAddress: getValue("--wallet-address"),
    amount: getValue("--amount") ? Number(getValue("--amount")) : undefined,
    sourceId: getValue("--source-id"),
    sourceType:
      sourceType === "order" || sourceType === "execution"
        ? sourceType
        : undefined,
    venue: getValue("--venue"),
    dryRun: hasFlag("--dry-run"),
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
    wallet_address: string;
    is_primary: boolean;
    last_login_at: Date | null;
  }>(
    `
      select u.id,
             u.email,
             u.username,
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
  }>(
    `
      select id, email, username
      from users
      where id = $1
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0] ?? null;
}

async function fetchPrimaryWallet(userId: string) {
  const { rows } = await pool.query<{ wallet_address: string | null }>(
    `
      select wallet_address
      from user_wallets
      where user_id = $1
      order by is_primary desc, created_at asc
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0]?.wallet_address ?? null;
}

async function main() {
  try {
    const options = parseArgs();
    const targetWallet = options.wallet?.trim();
    const targetUserId = options.userId?.trim();
    const amount = options.amount;

    if (!targetWallet && !targetUserId) {
      throw new Error("Provide --wallet or --user-id");
    }
    if (!Number.isFinite(amount) || !amount || amount <= 0) {
      throw new Error("Provide --amount (positive number)");
    }

    const users = targetWallet ? await fetchUsersByWallet(targetWallet) : [];
    const user = targetUserId
      ? await fetchUserById(targetUserId)
      : users[0] ?? null;

    if (targetWallet && users.length > 1 && !targetUserId) {
      console.error("Multiple users found for wallet. Use --user-id:");
      users.forEach((row) => {
        console.error(
          `${row.id} primary=${row.is_primary} lastLogin=${row.last_login_at?.toISOString() ?? "n/a"} ${row.email ?? ""} ${row.username ?? ""}`.trim(),
        );
      });
      process.exitCode = 1;
      return;
    }

    if (!user) {
      throw new Error("User not found");
    }

    const walletAddress =
      options.walletAddress?.trim() ??
      targetWallet ??
      (await fetchPrimaryWallet(user.id));
    const sourceType = options.sourceType ?? "execution";
    const sourceId = options.sourceId?.trim() ?? `manual:${randomUUID()}`;
    const venue = options.venue?.trim() ?? "admin";

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            userId: user.id,
            walletAddress: walletAddress ?? null,
            venue,
            sourceType,
            sourceId,
            amount,
          },
          null,
          2,
        ),
      );
      return;
    }

    const { rows } = await pool.query<{ id: string }>(
      `
        insert into volume_events (
          id,
          user_id,
          wallet_address,
          venue,
          source_type,
          source_id,
          notional_usd,
          created_at
        )
        values (
          gen_random_uuid(),
          $1, $2, $3, $4, $5, $6, now()
        )
        on conflict (user_id, source_type, source_id) do nothing
        returning id
      `,
      [user.id, walletAddress ?? null, venue, sourceType, sourceId, amount],
    );

    if (!rows.length) {
      throw new Error("Volume event already exists for that source_id");
    }

    console.log(`Added ${amount} points for ${user.id} (${sourceId})`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
