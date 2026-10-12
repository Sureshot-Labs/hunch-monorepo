import WebSocket from "ws";
import { hip4Identity, type Hip4ReadPolicy } from "@hunch/shared";

// This stream is a repair hint, never authoritative metadata or a trade ledger.
// Reconnect/duplicates/gaps all converge through the same bounded REST cycle.
export function watchHip4Metadata(
  policy: Hip4ReadPolicy,
  wake: () => void,
  socketFactory = (url: string) =>
    new WebSocket(url, {
      handshakeTimeout: policy.requestTimeoutMs,
      maxPayload: policy.responseMaxBytes,
      perMessageDeflate: false,
    }),
  events: {
    data?: (channel: "l2Book" | "trades", payload: unknown) => void;
    gap?: (reason: string) => void;
  } = {},
) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retryMs = policy.streamRetryMs;
  let subscriptions = new Map<
    string,
    { type: "l2Book" | "trades"; coin: string }
  >();
  const diagnostics = {
    connected: false,
    reconnects: 0,
    hints: 0,
    lastMessageAt: null as string | null,
    subscriptionErrors: 0,
    subscriptions: 0,
  };
  const connect = () => {
    if (stopped) return;
    const current = socketFactory(
      policy.environment === "mainnet"
        ? "wss://api.hyperliquid.xyz/ws"
        : "wss://api.hyperliquid-testnet.xyz/ws",
    );
    socket = current;
    let lastMessage = Date.now();
    current.on("open", () => {
      diagnostics.connected = true;
      if (policy.metadataStreamEnabled)
        current.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "outcomeMetaUpdates" },
          }),
        );
      for (const subscription of subscriptions.values())
        current.send(JSON.stringify({ method: "subscribe", subscription }));
      wake(); // An authoritative generation repair follows every connection.
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage >= policy.streamIdleMs)
          current.terminate();
        else if (current.readyState === WebSocket.OPEN)
          current.send(JSON.stringify({ method: "ping" }));
      }, policy.streamHeartbeatMs);
    });
    current.on("message", (payload) => {
      lastMessage = Date.now();
      diagnostics.lastMessageAt = new Date(lastMessage).toISOString();
      try {
        const message = JSON.parse(payload.toString());
        if (message.channel === "error") {
          diagnostics.subscriptionErrors++;
          events.gap?.("subscription_error");
          current.terminate();
          return;
        }
        if (message.channel === "l2Book" || message.channel === "trades") {
          retryMs = policy.streamRetryMs;
          events.data?.(message.channel, message.data);
          return;
        }
        if (
          message.channel === "pong" ||
          message.channel === "outcomeMetaUpdates"
        )
          retryMs = policy.streamRetryMs;
        if (message.channel !== "outcomeMetaUpdates") return;
        diagnostics.hints++;
        wake();
      } catch {
        /* A malformed hint cannot mutate the published generation. */
      }
    });
    current.on("error", () => current.terminate());
    current.on("close", () => {
      diagnostics.connected = false;
      events.gap?.("disconnect");
      clearInterval(heartbeat);
      if (stopped) return;
      diagnostics.reconnects++;
      retry = setTimeout(connect, retryMs);
      retryMs = Math.min(policy.streamRetryMaxMs, retryMs * 2);
    });
  };
  if (
    policy.enabled &&
    (policy.metadataStreamEnabled || policy.liveEnabled) &&
    policy.outcomeAllowlist.length
  )
    connect();
  return {
    diagnostics,
    setOutcomes: (outcomes: number[]) => {
      const next = new Map<
        string,
        { type: "l2Book" | "trades"; coin: string }
      >();
      if (policy.liveEnabled)
        for (const outcome of [...new Set(outcomes)]
          .filter((id) => policy.outcomeAllowlist.includes(id))
          .slice(0, policy.maxLiveOutcomes)) {
          const identity = hip4Identity(policy.environment, outcome);
          for (const side of identity.sides)
            next.set(`l2Book:${side.coin}`, {
              type: "l2Book",
              coin: side.coin,
            });
          next.set(`trades:${identity.sides[0].coin}`, {
            type: "trades",
            coin: identity.sides[0].coin,
          });
        }
      if (socket?.readyState === WebSocket.OPEN) {
        for (const [key, subscription] of subscriptions)
          if (!next.has(key))
            socket.send(
              JSON.stringify({ method: "unsubscribe", subscription }),
            );
        for (const [key, subscription] of next)
          if (!subscriptions.has(key))
            socket.send(JSON.stringify({ method: "subscribe", subscription }));
      }
      if ([...subscriptions.keys()].join() !== [...next.keys()].join())
        events.gap?.("subscription_change");
      subscriptions = next;
      diagnostics.subscriptions =
        next.size + Number(policy.metadataStreamEnabled);
    },
    close: () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.terminate();
    },
  };
}

// Coalesces any number of stream hints during work/wait into one repair. The
// minimum interval and request budget prevent a busy stream from a hot loop.
export function createHip4Wakeup() {
  let pending = false;
  let notify: (() => void) | undefined;
  return {
    request: () => {
      pending = true;
      notify?.();
    },
    wait: (minMs: number, maxMs: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        let ready = minMs <= 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          pending = false;
          clearTimeout(minimum);
          clearTimeout(maximum);
          signal.removeEventListener("abort", finish);
          notify = undefined;
          resolve();
        };
        const minimum = setTimeout(() => {
          ready = true;
          if (pending) finish();
        }, minMs);
        const maximum = setTimeout(finish, maxMs);
        notify = () => {
          if (ready) finish();
        };
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted || (ready && pending)) finish();
      }),
  };
}
