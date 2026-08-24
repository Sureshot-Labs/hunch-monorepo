import assert from "node:assert/strict";

import {
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
  quarantineStaleSignalBotMessageDeliveries,
  recordSignalBotMessageNonDeliveryState,
  reserveSignalBotMessageDelivery,
} from "./services/signal-bot-message-delivery-ledger.js";

type StoredDelivery = {
  id: string;
  metrics: Record<string, unknown>;
  messageId: number | null;
};

function memoryLedgerDb(initial?: StoredDelivery) {
  let stored = initial;
  const queries: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes("insert into signal_bot_messages")) {
        if (stored) return { rowCount: 0, rows: [] };
        stored = {
          id: String(params[0]),
          messageId: null,
          metrics: JSON.parse(String(params[9])) as Record<string, unknown>,
        };
        return { rowCount: 1, rows: [{ id: stored.id }] };
      }
      if (
        sql.includes("where chat_id = $1") &&
        sql.includes("metrics #>> '{deliveryStateV2,status}' = 'sending'")
      ) {
        if (!stored) return { rowCount: 0, rows: [] };
        const status = String(stored.metrics.status ?? "");
        if (["pending", "prepared", "send_failed"].includes(status)) {
          stored.metrics = JSON.parse(String(params[3])) as Record<
            string,
            unknown
          >;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("select id::text, telegram_message_id, metrics")) {
        return {
          rowCount: stored ? 1 : 0,
          rows: stored
            ? [
                {
                  id: stored.id,
                  metrics: stored.metrics,
                  telegram_message_id: stored.messageId,
                },
              ]
            : [],
        };
      }
      if (
        sql.includes("update signal_bot_messages") &&
        sql.includes("metrics #>> '{deliveryStateV2,attemptId}'")
      ) {
        if (!stored || stored.id !== String(params[0])) {
          return { rowCount: 0, rows: [] };
        }
        const state = stored.metrics.deliveryStateV2 as
          | { attemptId?: unknown; status?: unknown }
          | undefined;
        const expectedStatus = sql.includes("set telegram_message_id = $4")
          ? params[1]
          : (params[4] ?? "reserved");
        const attemptId = sql.includes("set telegram_message_id = $4")
          ? params[2]
          : params[1];
        if (
          state?.status !== expectedStatus ||
          state?.attemptId !== attemptId
        ) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("set telegram_message_id = $4")) {
          stored.messageId = typeof params[3] === "number" ? params[3] : null;
          stored.metrics = JSON.parse(String(params[4])) as Record<
            string,
            unknown
          >;
        } else {
          stored.metrics = JSON.parse(String(params[2])) as Record<
            string,
            unknown
          >;
        }
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes("where telegram_message_id is null") &&
        sql.includes("'pending', 'prepared', 'send_failed'")
      ) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return { db: db as never, getStored: () => stored, queries };
}

const reservationInput = {
  baselineAt: "2026-01-01T00:00:00.000Z",
  chatId: "99",
  messageKind: "initial" as const,
  noteId: "00000000-0000-4000-8000-000000000001",
  replyToMessageId: null,
  threadRootNoteId: "00000000-0000-4000-8000-000000000001",
};

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "legacy non-delivery upsert fences active V2 attempts",
    run: async () => {
      const queries: string[] = [];
      const result = await recordSignalBotMessageNonDeliveryState({
        baselineAt: reservationInput.baselineAt,
        chatId: reservationInput.chatId,
        db: {
          query: async (sql: string) => {
            queries.push(sql);
            return { rowCount: 0, rows: [] };
          },
        } as never,
        messageKind: reservationInput.messageKind,
        metrics: { status: "compose_failed" },
        noteId: reservationInput.noteId,
        replyToMessageId: null,
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
        threadRootNoteId: reservationInput.threadRootNoteId,
      });
      assert.equal(result, false);
      assert.equal(queries.length, 1);
      assert.match(queries[0] ?? "", /deliveryStateV2,version}' is null/);
      assert.match(queries[0] ?? "", /telegram_message_id is null/);
    },
  },
  {
    name: "ambiguous delivery becomes terminal and cannot be reserved again",
    run: async () => {
      const memory = memoryLedgerDb();
      const reservation = await reserveSignalBotMessageDelivery({
        ...reservationInput,
        db: memory.db,
      });
      assert.equal(reservation.status, "acquired");
      if (reservation.status !== "acquired") return;
      assert.equal(
        await beginSignalBotMessageDelivery({
          attemptId: reservation.attemptId,
          db: memory.db,
          deliveryRef: reservation.deliveryRef,
        }),
        true,
      );
      assert.equal(
        await finishSignalBotMessageDelivery({
          attemptId: reservation.attemptId,
          db: memory.db,
          deliveryRef: reservation.deliveryRef,
          errorCode: "ambiguous",
          expectedStatus: "sending",
          status: "delivery_unknown",
        }),
        true,
      );
      assert.deepEqual(
        await reserveSignalBotMessageDelivery({
          ...reservationInput,
          db: memory.db,
        }),
        { outcome: "delivery_unknown", status: "terminal" },
      );
    },
  },
  {
    name: "concurrent reservations permit one external delivery owner",
    run: async () => {
      const memory = memoryLedgerDb();
      const reservations = await Promise.all([
        reserveSignalBotMessageDelivery({
          ...reservationInput,
          db: memory.db,
        }),
        reserveSignalBotMessageDelivery({
          ...reservationInput,
          db: memory.db,
        }),
      ]);
      assert.equal(
        reservations.filter((value) => value.status === "acquired").length,
        1,
      );
      assert.equal(
        reservations.filter((value) => value.status === "active").length,
        1,
      );
    },
  },
  {
    name: "queued media delivery preserves the attempt fence until send begins",
    run: async () => {
      const attemptId = "00000000-0000-4000-8000-000000000088";
      const memory = memoryLedgerDb({
        id: "00000000-0000-4000-8000-000000000099",
        messageId: null,
        metrics: {
          deliveryStateV2: { attemptId, status: "queued", version: 2 },
          status: "queued",
        },
      });
      assert.equal(
        await beginSignalBotMessageDelivery({
          attemptId,
          db: memory.db,
          deliveryRef: "00000000-0000-4000-8000-000000000099",
          expectedStatus: "queued",
        }),
        true,
      );
      assert.equal(
        (
          memory.getStored()?.metrics.deliveryStateV2 as
            | { status?: unknown }
            | undefined
        )?.status,
        "sending",
      );
    },
  },
  {
    name: "legacy potentially-sent status normalizes fail-closed",
    run: async () => {
      const memory = memoryLedgerDb({
        id: "00000000-0000-4000-8000-000000000099",
        messageId: null,
        metrics: { status: "send_failed" },
      });
      assert.deepEqual(
        await reserveSignalBotMessageDelivery({
          ...reservationInput,
          db: memory.db,
        }),
        { outcome: "delivery_unknown", status: "terminal" },
      );
    },
  },
  {
    name: "stale sending quarantine is a terminal batch transition",
    run: async () => {
      const memory = memoryLedgerDb();
      assert.equal(
        await quarantineStaleSignalBotMessageDeliveries({ db: memory.db }),
        1,
      );
      assert.equal(
        memory.queries.some((sql) =>
          sql.includes("metrics #>> '{deliveryStateV2,status}' = 'sending'"),
        ),
        true,
      );
      assert.equal(
        memory.queries.some((sql) =>
          sql.includes("'pending', 'prepared', 'send_failed'"),
        ),
        true,
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(
      `[signal-bot-message-delivery-ledger-tests] failed: ${test.name}`,
    );
    throw error;
  }
}

console.log(
  `[signal-bot-message-delivery-ledger-tests] passed ${passed}/${tests.length}`,
);
