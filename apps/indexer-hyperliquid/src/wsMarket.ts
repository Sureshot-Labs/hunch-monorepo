import WebSocket from "ws";
import PQueue from "p-queue";
import type { Pool } from "pg";
import {
  createTopTickGate,
  type RedisClientType,
  type TopTickGateOptions,
} from "@hunch/infra";
import {
  buildBookTopFromBbo,
  buildBookSnapshotFromTopTick,
  publishHyperliquidTopTick,
  type HyperliquidBookTop,
  type HyperliquidBookTarget,
} from "./market-data.js";
import { env } from "./env.js";
import { log } from "./log.js";
import type { HyperliquidBboPayload, HyperliquidWsMessage } from "./types.js";

type WsState = {
  wsUrl: string;
  pool: Pool;
  redis: RedisClientType;
  targets: HyperliquidBookTarget[];
  createWebSocket?: (wsUrl: string) => WebSocket;
};

let currentWs: WebSocket | null = null;
let currentState: WsState | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let activeCoins = new Set<string>();
let tokenByCoin = new Map<string, string>();
const intentionallyClosedSockets = new WeakSet<WebSocket>();

export type HyperliquidTopPublishPayload = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number;
  bookSnapshot?: HyperliquidBookTop["snapshot"];
};

export type HyperliquidTopPublisher = {
  publish: (payload: HyperliquidTopPublishPayload) => boolean;
  onIdle: () => Promise<void>;
  stats: () => {
    queued: number;
    running: number;
    coalesced: number;
  };
};

export function buildHyperliquidTokenByCoin(
  targets: HyperliquidBookTarget[],
): Map<string, string> {
  return new Map(targets.map((target) => [target.coin, target.tokenId]));
}

export function shouldReconnectClosedHyperliquidSocket(params: {
  isCurrentSocket: boolean;
  intentionallyClosed: boolean;
}): boolean {
  return params.isCurrentSocket && !params.intentionallyClosed;
}

export function shouldCloseHyperliquidHeartbeat(params: {
  nowMs: number;
  lastPongAtMs: number;
  pongTimeoutMs: number;
}): boolean {
  return params.nowMs - params.lastPongAtMs > params.pongTimeoutMs;
}

export function shouldResubscribeHyperliquidStream(params: {
  nowMs: number;
  lastMessageAtMs: number;
  lastResubscribeAtMs: number;
  staleMs: number;
}): boolean {
  return (
    params.nowMs - params.lastMessageAtMs > params.staleMs &&
    params.nowMs - params.lastResubscribeAtMs >= params.staleMs
  );
}

export function createHyperliquidTopPublisher(params: {
  concurrency: number;
  maxQueued: number;
  publishNow: (payload: HyperliquidTopPublishPayload) => Promise<void>;
  gateOptions?: TopTickGateOptions;
  warn?: (message: string, error: unknown) => void;
}): HyperliquidTopPublisher {
  const concurrency = Number.isFinite(params.concurrency)
    ? Math.max(1, Math.trunc(params.concurrency))
    : 1;
  const maxQueued = Number.isFinite(params.maxQueued)
    ? Math.max(1, Math.trunc(params.maxQueued))
    : 1;
  const queue = new PQueue({
    concurrency,
  });
  const coalescedByToken = new Map<string, HyperliquidTopPublishPayload>();
  let drainScheduled = false;

  const drainCoalesced = (): void => {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      while (coalescedByToken.size > 0 && queue.size < maxQueued) {
        const next = coalescedByToken.entries().next().value;
        if (!next) return;
        const [tokenId, payload] = next;
        coalescedByToken.delete(tokenId);
        addToQueue(payload);
      }
    });
  };

  const addToQueue = (payload: HyperliquidTopPublishPayload): void => {
    void queue
      .add(async () => {
        await params.publishNow(payload);
      })
      .catch((error) => {
        params.warn?.("Hyperliquid WS top publish failed", error);
      })
      .finally(() => {
        drainCoalesced();
      });
  };

  const enqueue = (payload: HyperliquidTopPublishPayload): void => {
    if (queue.size >= maxQueued) {
      coalescedByToken.set(payload.tokenId, payload);
      return;
    }
    addToQueue(payload);
  };
  const gate = createTopTickGate({
    ...params.gateOptions,
    onDeferredPublish: enqueue,
  });

  return {
    publish: (payload) => {
      if (!gate.shouldPublish(payload)) return false;
      enqueue(payload);
      return true;
    },
    onIdle: async () => {
      while (coalescedByToken.size > 0 || queue.size > 0 || queue.pending > 0) {
        drainCoalesced();
        await queue.onIdle();
        if (coalescedByToken.size === 0) break;
      }
    },
    stats: () => ({
      queued: queue.size,
      running: queue.pending,
      coalesced: coalescedByToken.size,
    }),
  };
}

const topPublisher = createHyperliquidTopPublisher({
  concurrency: env.wsConcurrency,
  maxQueued: env.wsQueueMax,
  publishNow: async ({ tokenId, bestBid, bestAsk, tsMs, bookSnapshot }) => {
    const state = currentState;
    if (!state) return;
    await publishHyperliquidTopTick({
      pool: state.pool,
      redis: state.redis,
      tokenId,
      bestBid,
      bestAsk,
      tsMs,
      bookSnapshot:
        bookSnapshot ??
        buildBookSnapshotFromTopTick({ tokenId, bestBid, bestAsk, tsMs }),
    });
  },
  warn: (message, error) => log.warn(message, error),
});

function sendSubscription(
  ws: WebSocket,
  method: "subscribe" | "unsubscribe",
  coin: string,
): void {
  ws.send(
    JSON.stringify({
      method,
      subscription: { type: "bbo", coin },
    }),
  );
}

function resubscribeAll(ws: WebSocket, targets: HyperliquidBookTarget[]): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  for (const target of targets) {
    sendSubscription(ws, "subscribe", target.coin);
  }
}

function syncSubscriptions(ws: WebSocket, targets: HyperliquidBookTarget[]) {
  if (ws.readyState !== WebSocket.OPEN) return;

  const desiredCoins = new Set(targets.map((target) => target.coin));
  for (const coin of activeCoins) {
    if (!desiredCoins.has(coin)) {
      sendSubscription(ws, "unsubscribe", coin);
      activeCoins.delete(coin);
    }
  }

  for (const coin of desiredCoins) {
    if (!activeCoins.has(coin)) {
      sendSubscription(ws, "subscribe", coin);
      activeCoins.add(coin);
    }
  }
}

function isBboPayload(value: unknown): value is HyperliquidBboPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HyperliquidBboPayload>;
  return (
    typeof candidate.coin === "string" &&
    typeof candidate.time === "number" &&
    Array.isArray(candidate.bbo)
  );
}

function parseWsMessage(raw: WebSocket.RawData): HyperliquidWsMessage | null {
  const text = Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw.toString();
  try {
    return JSON.parse(text) as HyperliquidWsMessage;
  } catch {
    return null;
  }
}

function scheduleReconnect() {
  if (!currentState || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentState) connect(currentState);
  }, env.wsReconnectSec * 1000);
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function setRuntimeTargets(targets: HyperliquidBookTarget[]): void {
  tokenByCoin = buildHyperliquidTokenByCoin(targets);
}

function connect(state: WsState): WebSocket | null {
  if (state.targets.length === 0) {
    log.warn("Hyperliquid WS not started: no bbo targets");
    return null;
  }

  setRuntimeTargets(state.targets);
  const ws =
    state.createWebSocket?.(state.wsUrl) ??
    new WebSocket(state.wsUrl, { perMessageDeflate: true });
  currentWs = ws;
  activeCoins = new Set<string>();
  let lastPongAtMs = Date.now();
  let lastMessageAtMs = lastPongAtMs;
  let lastResubscribeAtMs = lastPongAtMs;

  ws.on("open", () => {
    if (currentWs !== ws) return;
    const targets = currentState?.targets ?? state.targets;
    const nowMs = Date.now();
    lastPongAtMs = nowMs;
    lastMessageAtMs = nowMs;
    lastResubscribeAtMs = nowMs;
    log.info("Hyperliquid WS open", {
      url: state.wsUrl,
      targets: targets.length,
    });
    syncSubscriptions(ws, targets);
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (currentWs !== ws || ws.readyState !== WebSocket.OPEN) return;
      const nowMs = Date.now();
      try {
        ws.ping();
      } catch {
        // ignore; socket may already be closing
      }

      if (
        shouldCloseHyperliquidHeartbeat({
          nowMs,
          lastPongAtMs,
          pongTimeoutMs: env.wsPongTimeoutSec * 1000,
        })
      ) {
        log.warn("Hyperliquid WS pong timeout; reconnecting", {
          staleMs: nowMs - lastPongAtMs,
        });
        ws.close();
        return;
      }

      if (
        shouldResubscribeHyperliquidStream({
          nowMs,
          lastMessageAtMs,
          lastResubscribeAtMs,
          staleMs: env.wsResubscribeSec * 1000,
        })
      ) {
        const targets = currentState?.targets ?? state.targets;
        log.warn("Hyperliquid WS stream stale; resubscribing", {
          staleMs: nowMs - lastMessageAtMs,
          targets: targets.length,
        });
        resubscribeAll(ws, targets);
        lastResubscribeAtMs = nowMs;
      }
    }, env.wsHeartbeatSec * 1000);
  });

  ws.on("pong", () => {
    if (currentWs !== ws) return;
    lastPongAtMs = Date.now();
  });

  ws.on("message", (raw) => {
    if (currentWs !== ws) return;
    lastMessageAtMs = Date.now();
    const message = parseWsMessage(raw);
    if (message?.channel !== "bbo" || !isBboPayload(message.data)) return;

    const tokenId = tokenByCoin.get(message.data.coin);
    if (!tokenId) return;

    const top = buildBookTopFromBbo(tokenId, message.data);
    if (!top) return;

    topPublisher.publish({
      tokenId: top.tokenId,
      bestBid: top.bestBid,
      bestAsk: top.bestAsk,
      tsMs: top.tsMs,
      bookSnapshot: top.snapshot,
    });
  });

  ws.on("close", (code, reason) => {
    const intentionallyClosed = intentionallyClosedSockets.has(ws);
    const shouldReconnect = shouldReconnectClosedHyperliquidSocket({
      isCurrentSocket: currentWs === ws,
      intentionallyClosed,
    });
    if (currentWs !== ws) {
      return;
    }

    currentWs = null;
    activeCoins = new Set<string>();
    clearHeartbeat();
    log.warn("Hyperliquid WS closed", {
      code,
      reason: reason.toString(),
      intentionallyClosed,
    });
    if (shouldReconnect) {
      scheduleReconnect();
    }
  });

  ws.on("error", (error) => {
    log.warn("Hyperliquid WS error", error);
    if (currentWs !== ws || ws.readyState !== WebSocket.OPEN) return;
    ws.close();
  });

  return ws;
}

export function startHyperliquidMarketWS(state: WsState): WebSocket | null {
  currentState = state;
  setRuntimeTargets(state.targets);
  clearReconnectTimer();
  if (currentWs) {
    intentionallyClosedSockets.add(currentWs);
    clearHeartbeat();
    activeCoins = new Set<string>();
    currentWs.close();
    currentWs = null;
  }
  return connect(state);
}

export function updateHyperliquidMarketWSSubscriptions(
  targets: HyperliquidBookTarget[],
): void {
  if (!currentState) return;
  currentState = { ...currentState, targets };
  setRuntimeTargets(targets);
  if (!currentWs) {
    scheduleReconnect();
    return;
  }
  syncSubscriptions(currentWs, targets);
}

export async function waitForHyperliquidWsPublishesForTest(): Promise<void> {
  await topPublisher.onIdle();
}

export function resetHyperliquidMarketWSForTest(): void {
  clearReconnectTimer();
  clearHeartbeat();
  const ws = currentWs;
  currentWs = null;
  currentState = null;
  activeCoins = new Set<string>();
  tokenByCoin = new Map<string, string>();
  if (ws) {
    intentionallyClosedSockets.add(ws);
    try {
      ws.close();
    } catch {
      // ignore; test doubles may throw after teardown
    }
  }
}
