#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { prioritizeSignaledMapEvents } from "./services/market-map.js";

const byVolume = [
  { eventId: "large", volume: 100 },
  { eventId: "medium", volume: 50 },
  { eventId: "signaled", volume: 1 },
];

assert.deepEqual(
  prioritizeSignaledMapEvents([...byVolume], new Set(["signaled"]))
    .slice(0, 2)
    .map((event) => event.eventId),
  ["signaled", "large"],
);
assert.deepEqual(
  prioritizeSignaledMapEvents([...byVolume], new Set()).map(
    (event) => event.eventId,
  ),
  ["large", "medium", "signaled"],
);
assert.deepEqual(
  prioritizeSignaledMapEvents(
    [...byVolume],
    new Set(["medium", "signaled"]),
  ).map((event) => event.eventId),
  ["medium", "signaled", "large"],
);

console.log("[market-map-preview-priority-tests] ok");
