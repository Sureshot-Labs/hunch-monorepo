import type { RedisClientType as RedisClient } from "redis";

import { getRedis } from "../redis.js";

type StreamListener = (payload: unknown) => void;

type ChannelState = {
  listeners: Set<StreamListener>;
  subscribed: boolean;
  inFlight: Promise<void> | null;
  handler: (message: string) => void;
};

let sharedSubscriber: RedisClient | null = null;
let sharedSubscriberPromise: Promise<RedisClient | null> | null = null;

const channels = new Map<string, ChannelState>();

function channelName(prefix: string, tokenId: string): string {
  return `${prefix}:${tokenId}`;
}

function parseJson(data: string): unknown | null {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function getOrCreateChannelState(channel: string): ChannelState {
  const existing = channels.get(channel);
  if (existing) return existing;

  const state: ChannelState = {
    listeners: new Set(),
    subscribed: false,
    inFlight: null,
    handler: (message: string) => {
      const nextState = channels.get(channel);
      if (!nextState || nextState.listeners.size === 0) return;
      const payload = parseJson(message);
      if (payload == null) return;
      for (const listener of nextState.listeners) {
        try {
          listener(payload);
        } catch {
          // ignore per-listener failures
        }
      }
    },
  };

  channels.set(channel, state);
  return state;
}

async function getSharedSubscriber(): Promise<RedisClient | null> {
  if (sharedSubscriber) return sharedSubscriber;
  if (sharedSubscriberPromise) return sharedSubscriberPromise;

  sharedSubscriberPromise = (async () => {
    const base = await getRedis();
    if (!base) return null;

    const sub = base.duplicate();
    sub.on("error", (err: unknown) =>
      console.warn("[prices-sse] redis subscriber error", String(err)),
    );
    await sub.connect();
    sharedSubscriber = sub;
    return sub;
  })()
    .catch((err: unknown) => {
      console.warn(
        "[prices-sse] failed to create redis subscriber",
        String(err),
      );
      return null;
    })
    .finally(() => {
      sharedSubscriberPromise = null;
    });

  return sharedSubscriberPromise;
}

async function ensureChannelSubscribed(
  sub: RedisClient,
  channel: string,
): Promise<void> {
  const state = getOrCreateChannelState(channel);

  if (state.inFlight) await state.inFlight;
  if (state.subscribed) return;

  state.inFlight = sub
    .subscribe(channel, state.handler)
    .then(() => {
      state.subscribed = true;
    })
    .catch(() => undefined)
    .finally(() => {
      state.inFlight = null;
    });

  await state.inFlight;
}

async function maybeUnsubscribe(
  sub: RedisClient,
  channel: string,
): Promise<void> {
  const state = getOrCreateChannelState(channel);

  if (state.inFlight) await state.inFlight;
  if (state.listeners.size > 0) return;
  if (!state.subscribed) return;

  try {
    await sub.unsubscribe(channel);
    state.subscribed = false;
  } catch {
    // best-effort
  }
}

async function subscribeToChannels(
  prefix: string,
  tokenIds: string[],
  listener: StreamListener,
): Promise<() => void> {
  const uniqueTokenIds = Array.from(new Set(tokenIds));
  if (uniqueTokenIds.length === 0) return () => undefined;

  const sub = await getSharedSubscriber();
  if (!sub) {
    throw new Error("Redis subscriber unavailable");
  }

  for (const tokenId of uniqueTokenIds) {
    const channel = channelName(prefix, tokenId);
    const state = getOrCreateChannelState(channel);
    state.listeners.add(listener);
  }

  await Promise.all(
    uniqueTokenIds.map((id) =>
      ensureChannelSubscribed(sub, channelName(prefix, id)),
    ),
  );

  return () => {
    for (const tokenId of uniqueTokenIds) {
      const channel = channelName(prefix, tokenId);
      const state = channels.get(channel);
      if (!state) continue;
      state.listeners.delete(listener);
    }

    void Promise.all(
      uniqueTokenIds.map((id) =>
        maybeUnsubscribe(sub, channelName(prefix, id)),
      ),
    );
  };
}

export async function subscribeToPriceTicks(
  tokenIds: string[],
  listener: StreamListener,
): Promise<() => void> {
  return subscribeToChannels("prices", tokenIds, listener);
}

export async function subscribeToMarketStates(
  tokenIds: string[],
  listener: StreamListener,
): Promise<() => void> {
  return subscribeToChannels("market_state", tokenIds, listener);
}
