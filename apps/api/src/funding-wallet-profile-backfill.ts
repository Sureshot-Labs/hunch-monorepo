#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool } from "./db.js";
import { PrivyService, type PrivyWalletProfile } from "./privy-service.js";

type Args = Readonly<{
  execute: boolean;
  json: boolean;
  limit: number;
}>;

function parseArgs(argv: readonly string[]): Args {
  const limitArg = argv.find((value) => value.startsWith("--limit="));
  const parsedLimit = Number(limitArg?.slice("--limit=".length));
  return {
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
    limit:
      Number.isSafeInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1_000)
        : 100,
  };
}

function profileKey(input: {
  address: string;
  walletType: "ethereum" | "solana";
}): string {
  return `${input.walletType}:${
    input.walletType === "ethereum"
      ? input.address.toLowerCase()
      : input.address
  }`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { rows: users } = await pool.query<{
    id: string;
    privy_user_id: string;
  }>(
    `
      select users.id, users.privy_user_id
      from users
      where users.is_active = true
        and users.privy_user_id is not null
        and exists (
          select 1
          from user_wallets wallet
          where wallet.user_id = users.id
            and wallet.is_verified = true
            and wallet.wallet_source = 'unknown'
        )
      order by users.updated_at asc, users.id asc
      limit $1
    `,
    [args.limit],
  );
  const summary = {
    execute: args.execute,
    usersInspected: 0,
    usersFailed: 0,
    walletsClassified: 0,
    internalWalletsClassified: 0,
    unmatchedUnknownWallets: 0,
  };
  for (const user of users) {
    summary.usersInspected += 1;
    try {
      const privyUser = await PrivyService.getUserById(user.privy_user_id);
      const profiles = new Map<string, PrivyWalletProfile>(
        PrivyService.classifyWallets(privyUser).map((profile) => [
          profileKey({
            address: profile.address,
            walletType: profile.walletType,
          }),
          profile,
        ]),
      );
      const { rows: wallets } = await pool.query<{
        id: string;
        wallet_address: string;
        wallet_type: "ethereum" | "solana";
      }>(
        `
          select id, wallet_address, wallet_type
          from user_wallets
          where user_id = $1
            and is_verified = true
            and wallet_source = 'unknown'
          order by created_at asc, id asc
        `,
        [user.id],
      );
      for (const wallet of wallets) {
        const profile = profiles.get(
          profileKey({
            address: wallet.wallet_address,
            walletType: wallet.wallet_type,
          }),
        );
        if (!profile) {
          summary.unmatchedUnknownWallets += 1;
          continue;
        }
        summary.walletsClassified += 1;
        if (profile.isInternalWallet) summary.internalWalletsClassified += 1;
        if (!args.execute) continue;
        await pool.query(
          `
            update user_wallets
            set privy_wallet_id = $2,
                wallet_source = $3,
                is_internal_wallet = $4,
                privy_profile_updated_at = now(),
                updated_at = now()
            where id = $1
              and wallet_source = 'unknown'
          `,
          [
            wallet.id,
            profile.walletId?.trim() || null,
            profile.source,
            profile.isInternalWallet,
          ],
        );
      }
    } catch {
      summary.usersFailed += 1;
    }
  }
  const blockers =
    summary.usersFailed + summary.unmatchedUnknownWallets > 0
      ? [
          ...(summary.usersFailed > 0
            ? [`${summary.usersFailed} Privy profiles could not be loaded`]
            : []),
          ...(summary.unmatchedUnknownWallets > 0
            ? [
                `${summary.unmatchedUnknownWallets} verified wallets remain unclassified`,
              ]
            : []),
        ]
      : [];
  const report = { ...summary, blockers };
  console.log(
    args.json
      ? JSON.stringify(report, null, 2)
      : [
          `Wallet profile backfill: ${blockers.length === 0 ? "OK" : "BLOCKED"}`,
          `Mode: ${args.execute ? "execute" : "dry-run"}`,
          `Users inspected: ${summary.usersInspected}`,
          `Wallets classified: ${summary.walletsClassified}`,
          `Internal wallets classified: ${summary.internalWalletsClassified}`,
          `Unmatched unknown wallets: ${summary.unmatchedUnknownWallets}`,
          ...blockers.map((blocker) => `- ${blocker}`),
        ].join("\n"),
  );
  if (blockers.length > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main()
    .catch((error) => {
      console.error("[funding-wallet-profile-backfill]", error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
