import type { Pool } from "@hunch/infra";
import { deliverNativePushBatch } from "./services/native-push-queue.js";
import assert from "node:assert/strict";
import {
  safeNativePushPayload,
  safeNativePushText,
} from "./services/native-push-text.js";

assert.deepEqual(safeNativePushText("A trader", "A public update"), {
  title: "A trader",
  body: "A public update",
});
assert.deepEqual(
  safeNativePushText(
    "New Hunch from fucker",
    "a".repeat(240) + " kill yourself",
  ),
  {
    title: "New Hunch",
    body: "Open Hunch to view this update.",
  },
);
const target = { thesisId: "fixture", userId: "fixture" };
const delivered = safeNativePushPayload({
  aps: { alert: { title: "fucker", body: "kill yourself" }, sound: "default" },
  hunch: target,
});
assert.deepEqual(delivered.aps.alert, {
  title: "New Hunch",
  body: "Open Hunch to view this update.",
});
assert.deepEqual(delivered.hunch, target);
console.log(
  "[native-notification-text] full-text policy, queued legacy payload and safe routing passed",
);

// Exercise delivery of an already stored legacy payload through the actual sender boundary.
let sent = 0;
const deliveryDb = {
  query: async (sql: string) => {
    if (sql.includes("with selected as"))
      return {
        rows: [
          {
            id: "delivery",
            device_id: "device",
            user_id: "user",
            device_generation: "1",
            event_key: "event",
            topic: "new_markets",
            occurred_at: new Date(),
            attempts: 1,
            lease_id: "lease",
            payload: {
              aps: { alert: { title: "fucker", body: "kill yourself" } },
              hunch: target,
            },
          },
        ],
      };
    if (sql.includes("select d.token"))
      return {
        rows: [
          {
            token: "token",
            environment: "sandbox",
            updated_at: new Date(),
            registration_id: "registration",
          },
        ],
      };
    assert.ok(sql.includes("update native_push_deliveries"));
    return { rows: [], rowCount: 1 };
  },
} as unknown as Pool;
const counts = await deliverNativePushBatch({
  db: deliveryDb,
  send: async (input) => {
    sent++;
    const aps = input.payload.aps as { alert: { title: string; body: string } };
    assert.deepEqual(aps.alert, {
      title: "New Hunch",
      body: "Open Hunch to view this update.",
    });
    assert.deepEqual(input.payload.hunch, target);
    return { status: 200, reason: null, invalidatedAt: null };
  },
});
assert.equal(sent, 1);
assert.equal(counts.sent, 1);
