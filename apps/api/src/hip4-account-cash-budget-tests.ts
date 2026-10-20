import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hip4ReadPolicySchema,
  hip4BackgroundRepairWeightLimit,
  hip4BackgroundRequestWeightLimit,
} from "@hunch/shared";
import {
  createHip4AccountClient,
  createHip4ReadClient,
} from "./services/hip4-client.js";
import { reserveHip4AccountCashBudget } from "./services/hip4-account-cash-budget.js";

const address = `0x${"ab".repeat(20)}`;
const standardRequests = [
  "userRole",
  "userAbstraction",
  "spotMeta",
  "spotClearinghouseState",
  "clearinghouseState",
  "userAbstraction",
] as const;
const defaultRequests = [
  "userRole",
  "userAbstraction",
  "userDexAbstraction",
  "borrowLendUserState",
  "spotMeta",
  "spotClearinghouseState",
  "userAbstraction",
  "userDexAbstraction",
] as const;

function fixture() {
  let clock = Date.now();
  let policy = hip4ReadPolicySchema.parse({ enabled: true });
  let revoked = false;
  let reservations = 0;
  let settlementFails = false;
  let renewalFails = false;
  let duringRenewal: (() => void) | null = null;
  let duringRecheck: (() => void | Promise<void>) | null = null;
  const calls: string[] = [];
  const settlements: number[] = [];
  const admissions: { at: number; weight: number; background: boolean }[] = [];
  const active = () => admissions.filter((row) => row.at > clock - 60_000);
  const usage = () => active().reduce((sum, row) => sum + row.weight, 0);
  const reserve = async (background = true) =>
    reserveHip4AccountCashBudget({
      background,
      now: () => clock,
      recheck: async () => {
        await duringRecheck?.();
        if (revoked) throw new Error("account_owner_unavailable");
        if (!policy.enabled) throw new Error("account_read_disabled");
        return policy;
      },
      reserve: async (weight, currentPolicy) => {
        reservations++;
        if (
          usage() + weight > currentPolicy.requestWeightPerMinute ||
          (background &&
            (active()
              .filter((row) => row.background)
              .reduce((sum, row) => sum + row.weight, 0) +
              weight >
              hip4BackgroundRepairWeightLimit(currentPolicy) ||
              usage() + weight >
                hip4BackgroundRequestWeightLimit(currentPolicy)))
        )
          return false;
        const row = { at: clock, weight, background };
        admissions.push(row);
        return {
          reservedWeight: weight,
          renew: async () => {
            duringRenewal?.();
            if (renewalFails || row.at <= clock - 60_000) return false;
            row.at = clock;
            return true;
          },
          settle: async (actual) => {
            settlements.push(actual);
            if (settlementFails)
              throw new Error("synthetic settlement failure");
            if (actual >= 20 && actual < weight) row.weight = actual;
          },
        };
      },
    });
  const clients = (
    budget: Awaited<ReturnType<typeof reserve>>,
    fetcher?: typeof fetch,
  ) => {
    const transport: typeof fetch = async (...args) => {
      const request = JSON.parse(String(args[1]?.body));
      calls.push(request.type);
      return fetcher ? fetcher(...args) : Response.json({});
    };
    const options = { deadlineMs: budget.deadlineMs };
    const account = createHip4AccountClient(
      policy,
      budget.admit,
      transport,
      options,
    );
    const publicRead = createHip4ReadClient(
      policy,
      budget.admit,
      transport,
      options,
    );
    return {
      read: async (
        request: (typeof defaultRequests)[number] | "clearinghouseState",
      ) =>
        request === "spotMeta"
          ? publicRead({ type: request })
          : request === "clearinghouseState"
            ? account({ type: request, user: address, dex: "" })
            : account({ type: request, user: address }),
    };
  };
  return {
    admissions,
    calls,
    settlements,
    usage,
    reserve,
    clients,
    reservationCount: () => reservations,
    advance: (milliseconds: number) => (clock += milliseconds),
    setPolicy: (value: Partial<typeof policy>) => {
      policy = { ...policy, ...value };
    },
    revokeOwner: () => (revoked = true),
    failSettlement: () => (settlementFails = true),
    failRenewal: () => (renewalFails = true),
    onRenewal: (callback: () => void) => (duringRenewal = callback),
    onRecheck: (callback: () => void | Promise<void>) =>
      (duringRecheck = callback),
    addExisting: (weight: number, background = true) =>
      admissions.push({ at: clock, weight, background }),
  };
}

test("fragmented quota denies the whole cash batch without burning a prefix; expiry recovers", async () => {
  const state = fixture();
  state.addExisting(202);
  state.addExisting(80, false);
  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(state.reserve(), /budget_exhausted/u);
  assert.equal(state.usage(), 282);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.settlements, []);
  state.advance(60_001);
  const budget = await state.reserve();
  const clients = state.clients(budget);
  try {
    for (const request of defaultRequests) await clients.read(request);
  } finally {
    await budget.settle();
  }
  assert.deepEqual(state.calls, defaultRequests);
  assert.deepEqual(state.settlements, [182]);
  assert.equal(state.usage(), 182);
});

test("raced cash reservations cannot both fit the same220 repair quota", async () => {
  const state = fixture();
  const results = await Promise.allSettled([state.reserve(), state.reserve()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(state.usage(), 182);
  assert.equal(state.reservationCount(), 2);
  assert.deepEqual(state.calls, []);
});

test("foreground prepaid cash uses global headroom without spending blocked background quota", async () => {
  const state = fixture();
  state.addExisting(137);
  state.addExisting(80, false);
  await assert.rejects(state.reserve(true), /budget_exhausted/u);
  assert.equal(state.usage(), 217);
  const budget = await state.reserve(false);
  const clients = state.clients(budget);
  for (const request of defaultRequests) await clients.read(request);
  await budget.settle();
  assert.deepEqual(state.calls, defaultRequests);
  assert.deepEqual(state.settlements, [182]);
  assert.equal(state.usage(), 399);
});

test("foreground fragmented global headroom also denies without burning prefixes", async () => {
  const state = fixture();
  state.addExisting(1110, false);
  await assert.rejects(state.reserve(false), /budget_exhausted/u);
  assert.equal(state.usage(), 1110);
  assert.deepEqual(state.calls, []);
  state.advance(60_001);
  const budget = await state.reserve(false);
  const clients = state.clients(budget);
  for (const request of standardRequests) await clients.read(request);
  await budget.settle();
  assert.deepEqual(state.calls, standardRequests);
  assert.equal(state.usage(), 124);
});

test("Standard cash uses124 prepaid weight and settles only after all cash IO", async () => {
  const state = fixture();
  const budget = await state.reserve();
  const clients = state.clients(budget);
  for (const request of standardRequests) {
    await clients.read(request);
    assert.deepEqual(state.settlements, []);
    assert.equal(state.usage(), 182);
  }
  await budget.settle();
  await budget.settle();
  assert.deepEqual(state.settlements, [124]);
  assert.equal(state.usage(), 124);
  assert.equal(state.reservationCount(), 1);
  await assert.rejects(clients.read("userRole"), /budget_exhausted/u);
  assert.deepEqual(state.calls, standardRequests);
});

test("ownership, lifecycle, environment and shrinking quotas stop the next IO", async () => {
  const mutations: ((state: ReturnType<typeof fixture>) => void)[] = [
    (state) => state.revokeOwner(),
    (state) => state.setPolicy({ enabled: false }),
    (state) => state.setPolicy({ environment: "testnet" }),
    (state) => state.setPolicy({ requestWeightPerMinute: 1199 }),
    (state) => state.setPolicy({ backgroundRequestWeightPerMinute: 299 }),
    (state) => state.setPolicy({ bookMaxAgeMs: 30_000 }),
  ];
  for (const mutate of mutations) {
    const state = fixture();
    const budget = await state.reserve();
    const clients = state.clients(budget);
    await clients.read("userRole");
    mutate(state);
    await assert.rejects(clients.read("userAbstraction"));
    await budget.settle();
    assert.deepEqual(state.calls, ["userRole"]);
    assert.deepEqual(state.settlements, [60]);
  }
});

test("transport failure retains attempted weight; settlement failure retains full bound", async () => {
  for (const failsSettlement of [false, true]) {
    const state = fixture();
    const budget = await state.reserve();
    const clients = state.clients(budget, async () => {
      assert.deepEqual(state.settlements, []);
      return state.calls.length === 2
        ? new Response("synthetic failure", { status: 503 })
        : Response.json({});
    });
    await clients.read("userRole");
    await assert.rejects(clients.read("userAbstraction"), /http_error/u);
    if (failsSettlement) state.failSettlement();
    await budget.settle();
    assert.deepEqual(state.settlements, [80]);
    assert.equal(state.usage(), failsSettlement ? 182 : 80);
  }
});

test("unknown mode requires182 upfront; request bounds and phase deadline cannot overrun it", async () => {
  const tooSmall = fixture();
  tooSmall.setPolicy({ backgroundRequestWeightPerMinute: 200 });
  await assert.rejects(tooSmall.reserve(), /budget_exhausted/u);
  assert.equal(tooSmall.usage(), 0);
  assert.deepEqual(tooSmall.calls, []);

  const state = fixture();
  const budget = await state.reserve();
  const clients = state.clients(budget);
  await clients.read("userRole");
  state.advance(60_000);
  await assert.rejects(clients.read("userAbstraction"), /budget_exhausted/u);
  await budget.settle();
  assert.deepEqual(state.calls, ["userRole"]);
  assert.deepEqual(state.settlements, [60]);

  const bounded = fixture();
  const full = await bounded.reserve();
  for (const weight of [60, 20, 20, 20, 20, 2, 20, 20])
    assert.equal(await full.admit(weight), true);
  await assert.rejects(full.admit(2), /budget_exhausted/u);
  await full.settle();
  assert.deepEqual(bounded.settlements, [182]);
});

test("pre-transport revocation retains existing receipt's conservative20 floor", async () => {
  const state = fixture();
  const budget = await state.reserve();
  state.revokeOwner();
  await assert.rejects(
    state.clients(budget).read("userRole"),
    /account_owner_unavailable/u,
  );
  await budget.settle();
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.settlements, [20]);
});

test("renewal failure and post-wait expiry cannot dispatch IO", async () => {
  for (const kind of ["failure", "expiry"] as const) {
    const state = fixture();
    const budget = await state.reserve();
    const clients = state.clients(budget);
    await clients.read("userRole");
    if (kind === "failure") state.failRenewal();
    else state.onRenewal(() => state.advance(60_000));
    await assert.rejects(clients.read("userAbstraction"));
    await budget.settle();
    assert.deepEqual(state.calls, ["userRole"]);
    assert.deepEqual(state.settlements, [60]);
  }
});

test("an awaited policy read cannot separate the final rolling touch from dispatch", async () => {
  const state = fixture();
  const budget = await state.reserve();
  const clients = state.clients(budget);
  await clients.read("userRole");
  state.onRecheck(async () => {
    await Promise.resolve();
    state.advance(59_000);
  });
  await clients.read("userAbstraction");
  await budget.settle();
  state.advance(2_000);
  assert.equal(state.usage(), 80);
  assert.deepEqual(state.calls, ["userRole", "userAbstraction"]);
});

test("renewing a late prepaid dispatch retains the aggregate past its original expiry", async () => {
  const state = fixture();
  const budget = await state.reserve();
  const clients = state.clients(budget);
  await clients.read("userRole");
  state.advance(59_000);
  await clients.read("userAbstraction");
  await budget.settle();
  state.advance(2_000);
  assert.equal(state.usage(), 80);
  state.advance(58_001);
  assert.equal(state.usage(), 0);
});
