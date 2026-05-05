import type { RedisClientType as RedisClient } from "redis";

import { getRedis } from "../redis.js";

type NotificationListener = (payload: unknown) => void;

type ChannelState = {
  listeners: Set<NotificationListener>;
  subscribed: boolean;
  inFlight: Promise<void> | null;
  handler: (message: string) => void;
};

let sharedSubscriber: RedisClient | null = null;
let sharedSubscriberPromise: Promise<RedisClient | null> | null = null;

const channels = new Map<string, ChannelState>();

function channelName(userId: string): string {
  return `notify:${userId}`;
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
      console.warn("[notify-sse] redis subscriber error", String(err)),
    );
    await sub.connect();
    sharedSubscriber = sub;
    return sub;
  })()
    .catch((err: unknown) => {
      console.warn(
        "[notify-sse] failed to create redis subscriber",
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
  userId: string,
): Promise<void> {
  const channel = channelName(userId);
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
  userId: string,
): Promise<void> {
  const channel = channelName(userId);
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

export async function subscribeToNotifications(
  userId: string,
  listener: NotificationListener,
): Promise<() => void> {
  const trimmed = userId.trim();
  if (!trimmed) return () => undefined;

  const sub = await getSharedSubscriber();
  if (!sub) {
    throw new Error("Redis subscriber unavailable");
  }

  const channel = channelName(trimmed);
  const state = getOrCreateChannelState(channel);
  state.listeners.add(listener);

  await ensureChannelSubscribed(sub, trimmed);

  return () => {
    const nextState = channels.get(channel);
    if (nextState) nextState.listeners.delete(listener);
    void maybeUnsubscribe(sub, trimmed);
  };
}
