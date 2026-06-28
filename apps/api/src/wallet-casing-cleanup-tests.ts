#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  assertExecutionFlags,
  buildWalletCasingCleanupReport,
  parseArgs,
  runWalletCasingCleanupMutationsInTx,
} from "./wallet-casing-cleanup.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function randomEmail(): string {
  return `wallet-casing-cleanup-${crypto.randomUUID()}@example.com`;
}

await test("wallet casing cleanup refuses partial execution flags", async () => {
  assert.throws(
    () => assertExecutionFlags(parseArgs(["--execute"])),
    /requires both --execute and --confirm-fix/,
  );
  assert.throws(
    () => assertExecutionFlags(parseArgs(["--confirm-fix"])),
    /requires both --execute and --confirm-fix/,
  );
  assert.doesNotThrow(() =>
    assertExecutionFlags(parseArgs(["--execute", "--confirm-fix"])),
  );
});

await test("wallet casing cleanup reports and merges duplicate EVM storage rows", async () => {
  const client = await pool.connect();
  const checksumWallet = "0xAAbBcCdDEeFf0011223344556677889900aABbCc";
  const lowerWallet = checksumWallet.toLowerCase();
  const signerAddress = "0xBbCcDdEeFf0011223344556677889900AaBbCcDd";
  const funderAddress = "0xCcDdEeFf0011223344556677889900AaBbCcDdEe";
  const tokenId = `wallet-casing-token-${crypto.randomUUID()}`;
  const marketId = `wallet-casing-market-${crypto.randomUUID()}`;

  try {
    await client.query("begin");

    const userInsert = await client.query<{ id: string }>(
      `
        insert into users (email, is_active, is_verified)
        values ($1, true, true)
        returning id
      `,
      [randomEmail()],
    );
    const userId = userInsert.rows[0]?.id;
    assert.ok(userId);

    await client.query(
      `
        insert into user_wallets (
          user_id,
          wallet_address,
          wallet_type,
          is_primary,
          is_verified
        )
        values ($1, $2, 'evm', true, true)
      `,
      [userId, lowerWallet],
    );

    await client.query(
      `
        insert into unified_tokens(token_id, venue, market_id, side)
        values ($1, 'polymarket', $2, 'YES')
      `,
      [tokenId, marketId],
    );

    await client.query(
      `
        insert into positions (
          user_id,
          wallet_address,
          venue,
          position_scope,
          token_id,
          side,
          size,
          average_price,
          unrealized_pnl,
          realized_pnl,
          last_updated_at,
          created_at,
          updated_at
        )
        values
          ($1, $2, 'polymarket', 'own', $4, 'FLAT', 0, 0.40, 0, -1, now() - interval '2 days', now() - interval '2 days', now() - interval '2 days'),
          ($1, $3, 'polymarket', 'own', $4, 'LONG', 7, 0.45, 1.2, 0.5, now(), now(), now())
      `,
      [userId, lowerWallet, checksumWallet, tokenId],
    );

    await client.query(
      `
        insert into orders (
          user_id,
          wallet_address,
          signer_address,
          venue,
          venue_order_id,
          token_id,
          side,
          order_type,
          price,
          size,
          status
        )
        values ($1, $2, $3, 'polymarket', $4, $5, 'BUY', 'GTC', 0.45, 7, 'filled')
      `,
      [userId, checksumWallet, signerAddress, crypto.randomUUID(), tokenId],
    );

    await client.query(
      `
        insert into user_venue_credentials (
          user_id,
          wallet_address,
          venue,
          api_key,
          api_secret,
          funder_address
        )
        values ($1, $2, 'polymarket', 'key', 'secret', $3)
      `,
      [userId, lowerWallet, funderAddress],
    );

    const dryRunReport = await buildWalletCasingCleanupReport(client, {
      sampleLimit: 100,
    });
    assert.ok(
      dryRunReport.duplicateSamples.some(
        (sample) =>
          sample.table_name === "positions" &&
          sample.wallet_key === lowerWallet &&
          sample.token_id === tokenId,
      ),
    );

    const beforeMutations = await client.query<{ rows: string }>(
      "select count(*)::text as rows from positions where user_id = $1",
      [userId],
    );
    assert.equal(beforeMutations.rows[0]?.rows, "2");

    const mutationCounts = await runWalletCasingCleanupMutationsInTx(client);
    assert.ok(
      mutationCounts.some(
        (row) =>
          row.label === "positions_duplicate_rows_deleted" &&
          Number(row.rows) >= 1,
      ),
    );

    const positionRows = await client.query<{
      wallet_address: string;
      size: string;
    }>(
      `
        select wallet_address, size::text
        from positions
        where user_id = $1 and token_id = $2
      `,
      [userId, tokenId],
    );
    assert.equal(positionRows.rows.length, 1);
    assert.equal(positionRows.rows[0]?.wallet_address, lowerWallet);
    assert.equal(positionRows.rows[0]?.size, "7");

    const orderRows = await client.query<{
      wallet_address: string;
      signer_address: string;
    }>(
      `
        select wallet_address, signer_address
        from orders
        where user_id = $1 and token_id = $2
      `,
      [userId, tokenId],
    );
    assert.equal(orderRows.rows[0]?.wallet_address, lowerWallet);
    assert.equal(
      orderRows.rows[0]?.signer_address,
      signerAddress.toLowerCase(),
    );

    const credentialRows = await client.query<{ funder_address: string }>(
      `
        select funder_address
        from user_venue_credentials
        where user_id = $1 and venue = 'polymarket'
      `,
      [userId],
    );
    assert.equal(
      credentialRows.rows[0]?.funder_address,
      funderAddress.toLowerCase(),
    );

    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

await test("wallet casing cleanup aborts cross-scope position conflicts", async () => {
  const client = await pool.connect();
  const checksumWallet = "0xDdEeFf0011223344556677889900AaBbCcDdEeFf";
  const lowerWallet = checksumWallet.toLowerCase();
  const tokenId = `wallet-casing-cross-scope-${crypto.randomUUID()}`;

  try {
    await client.query("begin");

    const userInsert = await client.query<{ id: string }>(
      `
        insert into users (email, is_active, is_verified)
        values ($1, true, true)
        returning id
      `,
      [randomEmail()],
    );
    const userId = userInsert.rows[0]?.id;
    assert.ok(userId);

    await client.query(
      `
        insert into positions (
          user_id,
          wallet_address,
          venue,
          position_scope,
          token_id,
          side,
          size,
          average_price,
          unrealized_pnl,
          realized_pnl,
          last_updated_at,
          created_at,
          updated_at
        )
        values
          ($1, $2, 'polymarket', 'own', $4, 'LONG', 1, 0.40, 0, 0, now(), now(), now()),
          ($1, $3, 'polymarket', 'followed', $4, 'LONG', 2, 0.45, 0, 0, now(), now(), now())
      `,
      [userId, lowerWallet, checksumWallet, tokenId],
    );

    await assert.rejects(
      () => runWalletCasingCleanupMutationsInTx(client),
      /cross-scope position wallet\/token conflicts/,
    );

    const positionRows = await client.query<{ rows: string }>(
      "select count(*)::text as rows from positions where user_id = $1",
      [userId],
    );
    assert.equal(positionRows.rows[0]?.rows, "2");

    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
