#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { pool } from "./db.js";

type TestContext = {
  userId: string;
  authHeaders: Record<string, string>;
  createdWallets: Array<{ address: string; chain: "polygon" | "solana" }>;
};

function randomEmail(): string {
  return `wallet-private-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

async function createTestUser(): Promise<{
  userId: string;
  authHeaders: Record<string, string>;
}> {
  const insert = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [randomEmail()],
  );
  const userId = insert.rows[0]?.id;
  assert.ok(userId);

  const token = AuthService.generateToken(userId);
  const userAgent = "wallet-private-routes-tests";
  const session = await AuthService.createSession(
    userId,
    randomEvmAddress(),
    token,
    "127.0.0.1",
    userAgent,
  );

  return {
    userId,
    authHeaders: {
      authorization: `Bearer ${token}`,
      "x-csrf-token": session.csrfToken,
      "user-agent": userAgent,
    },
  };
}

async function assertPrivateWalletTablesExist(): Promise<void> {
  const result = await pool.query<{
    wallet_user_labels: string | null;
    wallet_user_notes: string | null;
  }>(`
    select
      to_regclass('public.wallet_user_labels')::text as wallet_user_labels,
      to_regclass('public.wallet_user_notes')::text as wallet_user_notes
  `);
  const row = result.rows[0];
  assert.equal(
    row?.wallet_user_labels,
    "wallet_user_labels",
    "wallet_user_labels migration must be applied before running route tests",
  );
  assert.equal(
    row?.wallet_user_notes,
    "wallet_user_notes",
    "wallet_user_notes migration must be applied before running route tests",
  );
}

async function cleanup(context: TestContext): Promise<void> {
  await pool.query("delete from user_sessions where user_id = $1", [context.userId]);
  await pool.query("delete from users where id = $1", [context.userId]);
  for (const wallet of context.createdWallets) {
    await pool.query("delete from wallets where address = $1 and chain = $2", [
      wallet.address,
      wallet.chain,
    ]);
  }
}

async function main() {
  await assertPrivateWalletTablesExist();
  const app = await buildApp();
  const { userId, authHeaders } = await createTestUser();
  const context: TestContext = { userId, authHeaders, createdWallets: [] };

  try {
    const unknownAddress = randomEvmAddress();

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${unknownAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.wallet.walletId, null);
      assert.equal(body.followed, false);
      assert.equal(body.userLabel, null);
      assert.deepEqual(body.notes, []);
    }

    {
      const before = await pool.query<{ count: string }>(
        "select count(*)::text as count from wallets where address = $1 and chain = $2",
        [unknownAddress, "polygon"],
      );
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${unknownAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: null },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.wallet.walletId, null);
      assert.equal(body.userLabel, null);
      const after = await pool.query<{ count: string }>(
        "select count(*)::text as count from wallets where address = $1 and chain = $2",
        [unknownAddress, "polygon"],
      );
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    }

    const labeledAddress = randomEvmAddress();
    let labeledWalletId: string;
    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "My test whale" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.followed, false);
      assert.equal(body.userLabel, "My test whale");
      labeledWalletId = body.wallet.walletId;
      assert.ok(labeledWalletId);
      context.createdWallets.push({ address: labeledAddress, chain: "polygon" });
    }

    {
      const forcedLastSeen = new Date("2024-01-02T03:04:05.000Z");
      await pool.query(
        "update wallets set last_seen_at = $2 where id = $1",
        [labeledWalletId, forcedLastSeen],
      );

      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "Renamed whale" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userLabel, "Renamed whale");

      const wallet = await pool.query<{ last_seen_at: Date }>(
        "select last_seen_at from wallets where id = $1",
        [labeledWalletId],
      );
      assert.equal(
        wallet.rows[0]?.last_seen_at.toISOString(),
        forcedLastSeen.toISOString(),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.userLabel, "Renamed whale");
      assert.deepEqual(body.notes, []);
    }

    {
      const followResponse = await app.inject({
        method: "POST",
        url: "/wallets/follow",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: {
          address: labeledAddress,
          chain: "polygon",
        },
      });
      assert.equal(followResponse.statusCode, 201);

      const profileResponse = await app.inject({
        method: "GET",
        url: `/wallets/${labeledWalletId}`,
        headers: authHeaders,
      });
      assert.equal(profileResponse.statusCode, 200);
      const profileBody = profileResponse.json();
      assert.equal(profileBody.wallet.userLabel, "Renamed whale");
      assert.equal(profileBody.wallet.followersCount, 1);

      const unfollowResponse = await app.inject({
        method: "DELETE",
        url: `/wallets/follow/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(unfollowResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${labeledAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.followed, false);
      assert.equal(body.userLabel, "Renamed whale");
    }

    {
      const invalidSolana = "not-a-solana-address";
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${invalidSolana}?chain=solana`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { label: "Nope" },
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Invalid Solana wallet address/);
    }

    const notesAddress = randomEvmAddress();
    let noteId: string;
    {
      const response = await app.inject({
        method: "POST",
        url: `/wallets/private/${notesAddress}/notes?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { note: "First note" },
      });
      assert.equal(response.statusCode, 201);
      const body = response.json();
      assert.equal(body.ok, true);
      noteId = body.note.id;
      assert.ok(noteId);
      context.createdWallets.push({ address: notesAddress, chain: "polygon" });
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.notes.length, 1);
      assert.equal(body.notes[0]?.note, "First note");
    }

    {
      const followResponse = await app.inject({
        method: "POST",
        url: "/wallets/follow",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: {
          address: notesAddress,
          chain: "polygon",
        },
      });
      assert.equal(followResponse.statusCode, 201);

      const unfollowResponse = await app.inject({
        method: "DELETE",
        url: `/wallets/follow/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(unfollowResponse.statusCode, 200);

      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.followed, false);
      assert.equal(body.notes.length, 1);
      assert.equal(body.notes[0]?.note, "First note");
    }

    {
      const response = await app.inject({
        method: "PATCH",
        url: `/wallets/private/${notesAddress}/notes/${noteId}?chain=polygon`,
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        payload: { note: "Updated note" },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.note.note, "Updated note");
    }

    {
      const response = await app.inject({
        method: "DELETE",
        url: `/wallets/private/${notesAddress}/notes/${noteId}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/wallets/private/${notesAddress}?chain=polygon`,
        headers: authHeaders,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.notes, []);
    }
  } finally {
    await cleanup(context);
    await app.close();
  }
}

await main();
