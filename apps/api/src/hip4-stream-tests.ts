import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type WebSocket from "ws";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import {
  createHip4Wakeup,
  watchHip4Metadata,
} from "./services/hip4-metadata-stream.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  send(value: string) {
    this.sent.push(value);
  }
  terminate() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
}
test("metadata stream uses only public hints, repairs on connect and survives malformed/duplicate notifications", async () => {
  const sockets: FakeSocket[] = [];
  let hints = 0;
  const stream = watchHip4Metadata(
    {
      ...DEFAULT_HIP4_READ_POLICY,
      enabled: true,
      outcomeAllowlist: [95],
      streamRetryMs: 1,
    },
    () => hints++,
    (url) => {
      assert.equal(url, "wss://api.hyperliquid.xyz/ws");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  sockets[0].emit("open");
  assert.deepEqual(
    sockets[0].sent.map((s) => JSON.parse(s)),
    [{ method: "subscribe", subscription: { type: "outcomeMetaUpdates" } }],
  );
  for (const payload of [
    "no json",
    '{"channel":"userFills"}',
    '{"channel":"outcomeMetaUpdates"}',
    '{"channel":"outcomeMetaUpdates"}',
  ])
    sockets[0].emit("message", Buffer.from(payload));
  assert.equal(hints, 3);
  sockets[0].terminate();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  sockets[1].emit("open");
  assert.equal(hints, 4);
  stream.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  watchHip4Metadata(
    DEFAULT_HIP4_READ_POLICY,
    () => {},
    () => {
      throw new Error("disabled must not connect");
    },
  ).close();
});
test("wake hints coalesce without bypassing minimum interval, and shutdown interrupts idle waits", async () => {
  const wake = createHip4Wakeup();
  const shutdown = new AbortController();
  wake.request();
  wake.request();
  const start = Date.now();
  await wake.wait(10, 1000, shutdown.signal);
  assert.ok(Date.now() - start >= 8);
  const idle = wake.wait(1000, 2000, shutdown.signal);
  shutdown.abort();
  await idle;
});
test("one connection carries both books and primary trades, repairs reconnect and unsubscribes hot changes", async () => {
  const sockets: FakeSocket[] = [];
  const gaps: string[] = [];
  const data: string[] = [];
  const stream = watchHip4Metadata(
    {
      ...DEFAULT_HIP4_READ_POLICY,
      enabled: true,
      outcomeAllowlist: [1, 2],
      maxLiveOutcomes: 1,
      streamRetryMs: 1,
    },
    () => {},
    () => {
      const socket = new FakeSocket();
      socket.readyState = 0;
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    {
      data: (channel) => data.push(channel),
      gap: (reason) => gaps.push(reason),
    },
  );
  stream.setOutcomes([1, 2, 999]);
  sockets[0].readyState = 1;
  sockets[0].emit("open");
  assert.deepEqual(
    sockets[0].sent.map((s) => JSON.parse(s).subscription),
    [
      { type: "outcomeMetaUpdates" },
      { type: "l2Book", coin: "#10" },
      { type: "l2Book", coin: "#11" },
      { type: "trades", coin: "#10" },
    ],
  );
  sockets[0].emit(
    "message",
    Buffer.from(JSON.stringify({ channel: "trades", data: [] })),
  );
  assert.deepEqual(data, ["trades"]);
  stream.setOutcomes([2]);
  assert.equal(
    sockets[0].sent
      .map((s) => JSON.parse(s))
      .filter((row) => row.method === "unsubscribe").length,
    3,
  );
  sockets[0].terminate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  sockets[1].emit("open");
  assert.equal(sockets[1].sent.length, 4);
  assert.equal(JSON.parse(sockets[1].sent[3]).subscription.coin, "#20");
  assert.ok(gaps.includes("disconnect"));
  stream.close();
});
