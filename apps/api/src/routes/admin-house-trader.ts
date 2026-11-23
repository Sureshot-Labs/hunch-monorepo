import type { FastifyInstance } from "fastify";
import { tx, type Pool } from "@hunch/infra";
import { z } from "zod";
import { createAdminMiddleware } from "../auth.js";
import { houseWithdrawalRecipient } from "../services/house-trader-withdrawal.js";
import {
  account,
  confirmHousePreview,
  enqueue,
  houseAdminActivitySql,
  type Action,
} from "../services/house-trader-store.js";
import {
  houseTraderAmount,
  houseTraderDefault,
  houseTraderPolicy,
  usdRaw,
} from "../services/house-trader-policy.js";

const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z
    .object({
      kind: z.literal("save"),
      revision: z.number().int().nonnegative(),
      policy: houseTraderPolicy,
    })
    .strict(),
  z
    .object({
      kind: z.literal("start"),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("pause") }).strict(),
  z.object({ kind: z.literal("retry_wallet_setup") }).strict(),
  z
    .object({
      kind: z.literal("sell"),
      positionId: z.string().uuid(),
      shares: houseTraderAmount,
      requestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("withdraw"),
      amount: houseTraderAmount,
      recipient: z.string().trim().length(42),
      requestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({ kind: z.literal("confirm"), actionId: z.string().uuid() })
    .strict(),
]);

export function registerAdminHouseTrader(app: FastifyInstance, pool: Pool) {
  const adminOnly = createAdminMiddleware({
    allowLegacyFallback: false,
    requiredAdminPermission: "admin:manage",
  });
  const path = "/admin/house-trader";
  app.get(path, { preHandler: adminOnly }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const data = await account(pool);
    const actions = data
      ? (await pool.query(houseAdminActivitySql, [data.user_id])).rows
      : [];
    return { account: data, defaults: houseTraderDefault, actions };
  });
  app.post(path, { preHandler: adminOnly }, async (request, reply) => {
    const parsed = operation.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_house_trader_request" });
    if (request.adminActor?.kind !== "admin_account")
      return reply.code(403).send({ error: "interactive_admin_required" });
    const adminId = request.adminActor.id;
    const input = parsed.data;
    const result = await tx(pool, async (db) => {
      if (input.kind === "create") {
        await db.query("select pg_advisory_xact_lock(1363429701)");
        if (await account(db)) return { ok: true };
        const user = (
          await db.query<{ id: string }>(
            "insert into users(display_name,is_active) values('Hunch House Trader',false) returning id",
          )
        ).rows[0];
        const created = (
          await db.query(
            "insert into house_trader_account(user_id) values($1) returning *,cursor_at::text",
            [user.id],
          )
        ).rows[0];
        await enqueue(db, created, {
          key: "setup",
          kind: "setup",
          request: { adminId },
        });
        return { ok: true };
      }
      const current = await account(db, true);
      if (!current) return { error: "create_trader_first" };
      switch (input.kind) {
        case "save":
          if (current.revision !== input.revision)
            return { error: "refresh_strategy" };
          await db.query(
            "update house_trader_account set settings=$1,revision=revision+1 where singleton",
            [input.policy],
          );
          return { ok: true };
        case "start":
          if (
            !current.deposit_wallet ||
            !current.settings ||
            input.revision !== current.revision
          )
            return { error: "trader_not_ready" };
          if (!current.active)
            await db.query(
              `update house_trader_account set active=true,revision=revision+1,
               cursor_at=clock_timestamp(),cursor_id='ffffffff-ffff-ffff-ffff-ffffffffffff' where singleton`,
            );
          return { ok: true };
        case "pause":
          if (current.active)
            await db.query(
              "update house_trader_account set active=false,revision=revision+1 where singleton",
            );
          return { ok: true };
        case "retry_wallet_setup": {
          if (current.deposit_wallet) return { error: "wallet_already_ready" };
          const retried = await db.query(
            `update house_trader_actions set state='queued',claim_token=null,reference=null,result='{}',
              reason='wallet_setup_retry',updated_at=now()
              where account_user_id=$1 and action_key='setup' and state='review'
                and reason in ('wallet_creation_retry_required','wallet_approvals_retry_required')`,
            [current.user_id],
          );
          return retried.rowCount === 1
            ? { ok: true }
            : { error: "wallet_setup_retry_not_available" };
        }
        case "confirm":
          return confirmHousePreview(
            db,
            current.user_id,
            input.actionId,
            adminId,
          );
        case "sell":
        case "withdraw": {
          if (!current.deposit_wallet) return { error: "trader_not_ready" };
          const recipient =
            input.kind === "withdraw"
              ? houseWithdrawalRecipient(input.recipient, [
                  current.controller,
                  current.deposit_wallet,
                ])
              : null;
          if (input.kind === "withdraw" && !recipient)
            return { error: "invalid_polygon_withdrawal_recipient" };
          const key = `admin:${input.requestId}`;
          const prior = (
            await db.query<Action>(
              "select * from house_trader_actions where account_user_id=$1 and action_key=$2",
              [current.user_id, key],
            )
          ).rows[0];
          if (prior) {
            if (
              prior.kind !== input.kind ||
              (input.kind === "withdraw" &&
                (prior.request.recipient !== recipient ||
                  usdRaw(String(prior.request.amount)) !==
                    usdRaw(input.amount))) ||
              (input.kind === "sell" &&
                (prior.request.positionId !== input.positionId ||
                  usdRaw(String(prior.request.shares)) !==
                    usdRaw(input.shares)))
            )
              return { error: "request_id_already_used" };
            return { id: prior.id };
          }
          const position =
            input.kind === "sell"
              ? (
                  await db.query<Action>(
                    `select * from house_trader_actions where account_user_id=$1 and id=$2 and kind='buy'
               and state='filled'`,
                    [current.user_id, input.positionId],
                  )
                ).rows[0]
              : null;
          if (
            input.kind === "sell" &&
            (!position?.market_id ||
              !position.token_id ||
              !position.outcome ||
              !position.event_id)
          )
            return { error: "position_not_found" };
          const job = await enqueue(db, current, {
            key,
            kind: input.kind,
            ...(position?.market_id &&
            position.token_id &&
            position.outcome &&
            position.event_id
              ? {
                  market: position.market_id,
                  event: position.event_id,
                  token: position.token_id,
                  outcome: position.outcome,
                }
              : {}),
            request:
              input.kind === "sell"
                ? {
                    adminId,
                    shares: input.shares,
                    positionId: input.positionId,
                  }
                : { adminId, amount: input.amount, recipient },
          });
          return { id: job?.id };
        }
      }
    });
    return "error" in result && result.error
      ? reply.code(409).send(result)
      : result;
  });
}
