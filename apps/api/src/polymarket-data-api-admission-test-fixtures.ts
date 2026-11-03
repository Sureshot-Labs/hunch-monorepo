import type { DataApiAdmission } from "./services/polymarket-data-api-admission.js";
import type {
  DataApiAdmissionBackend,
  DataApiPermit,
} from "./services/polymarket-data-api-admission.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Offline HTTP-contract fixtures explicitly bypass scheduling, not parsing. */
export const offlineDataApiAdmission: DataApiAdmission = {
  acquire: async (url, signal) => {
    signal.throwIfAborted();
    return {
      id: "offline-fixture",
      origin: url.origin,
      family: url.pathname,
      epoch: 0,
      expiresAt: Date.now() + 10000,
    };
  },
  finish: async () => 0,
};

/** Same state-machine regressions run against JS and the actual Redis Lua. */
export async function exerciseAdmissionRaces(
  factory: (clock: () => number) => DataApiAdmissionBackend,
): Promise<void> {
  for (const ordering of ["before_probe_success", "after_probe_success"]) {
    let clock = 10000;
    const backend = factory(() => clock);
    const origin = `https://${randomUUID()}.example.invalid`;
    const p = (id: string, epoch = 0): DataApiPermit => ({
      id,
      epoch,
      origin,
      family: "positions",
      expiresAt: 100000,
    });
    const admit = async (id: string, at: number) => {
      clock = at;
      const reply = await backend.acquire({
        ...p(id),
        now: clock,
        lane: "interactive",
      });
      assert.equal(reply.kind, "admitted");
      return p(id, reply.kind === "admitted" ? reply.epoch : 0);
    };
    const a = await admit("a", 10000),
      b = await admit("b", 10100);
    clock = 10200;
    await backend.finish(
      a,
      { kind: "limited", retryAfterMs: 0, jitter: 0 },
      clock,
    );
    const probe = await admit("probe", 11201);
    if (ordering === "before_probe_success") {
      clock = 11300;
      assert.ok(
        (await backend.finish(
          b,
          { kind: "limited", retryAfterMs: 60000, jitter: 0 },
          clock,
        )) >= 60000,
      );
      clock = 11400;
      await backend.finish(
        probe,
        { kind: "success", retryAfterMs: 0, jitter: 0 },
        clock,
      );
    } else {
      clock = 11300;
      await backend.finish(
        probe,
        { kind: "success", retryAfterMs: 0, jitter: 0 },
        clock,
      );
      clock = 11400;
      assert.ok(
        (await backend.finish(
          b,
          { kind: "limited", retryAfterMs: 60000, jitter: 0 },
          clock,
        )) >= 60000,
      );
    }
    clock = 11500;
    assert.equal(
      (
        await backend.acquire({
          ...p("must_wait"),
          now: clock,
          lane: "interactive",
        })
      ).kind,
      "cooldown",
      ordering,
    );
    const newProbe = await admit("recovery", 72000);
    clock = 72001;
    assert.equal(
      (
        await backend.acquire({
          ...p("parallel_probe"),
          now: clock,
          lane: "interactive",
        })
      ).kind,
      "cooldown",
    );
    clock = 72002;
    await backend.finish(
      newProbe,
      { kind: "success", retryAfterMs: 0, jitter: 0 },
      clock,
    );
    await admit("recovered", 72200);
  }
}
