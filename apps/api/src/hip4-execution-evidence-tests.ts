import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import {
  persistHip4AccountRefresh,
  readHip4ProviderEvidenceStatus,
  selectHip4ExactRecheckSources,
} from "./services/hip4-account-repository.js";
import { HIP4_FILL_PAGE_MAX } from "./services/hip4-account-history.js";

const address = `0x${"1".repeat(40)}`;
const fill = {
  coin: "#133430",
  px: "0.26",
  sz: "27",
  side: "B",
  time: 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"2".repeat(64)}`,
  oid: 1,
  crossed: false,
  fee: "0",
  tid: 1,
  feeToken: "USDC",
  cloid: null,
};
function repository() {
  type Retained = {
    fingerprint: string;
    provider_fill: unknown;
    provider_evidence_status: unknown;
  };
  const rows = new Map<string, Retained>();
  let history: Record<string, unknown> = {};
  let lease = randomUUID();
  const key = (args: unknown[]) => JSON.stringify(args.slice(0, 6));
  const db = {
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes("select lease_token, history"))
        return {
          rows:
            args[2] === lease ? [{ history: structuredClone(history) }] : [],
        };
      if (sql.startsWith("insert into hip4_account_executions")) {
        const id = key(args);
        let retained = rows.get(id);
        if (!retained) {
          retained = {
            fingerprint: args[8] as string,
            provider_fill:
              args[9] == null ? null : JSON.parse(args[9] as string),
            provider_evidence_status: null,
          };
          rows.set(id, retained);
        } else if (
          retained.fingerprint === args[8] &&
          retained.provider_fill == null &&
          args[9] != null
        )
          retained.provider_fill = JSON.parse(args[9] as string);
        return { rows: [structuredClone(retained)] };
      }
      if (sql.startsWith("update hip4_account_executions")) {
        const retained = rows.get(key(args));
        assert.ok(retained);
        assert.deepEqual(
          retained.provider_evidence_status,
          args[7] == null ? null : JSON.parse(args[7] as string),
        );
        retained.provider_evidence_status = JSON.parse(args[6] as string);
        return { rows: [{ tid: 1 }] };
      }
      if (sql.startsWith("update hip4_account_snapshots set"))
        history = JSON.parse(args[5] as string);
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => db } as unknown as Pool;
  async function save(
    sources: Array<typeof fill> = [fill],
    withSources = true,
  ) {
    lease = randomUUID();
    await persistHip4AccountRefresh(pool, {
      environment: "mainnet",
      address,
      lease,
      observation: null,
      executions: sources.map((source) =>
        projectHip4Execution("mainnet", address, source),
      ),
      ...(withSources ? { executionSources: sources } : {}),
      ledger: [],
      history: {},
      error: null,
    });
  }
  const row = (source = fill) => {
    const retained = rows.get(
      JSON.stringify([
        "mainnet",
        address,
        source.time,
        source.coin,
        String(source.tid),
        String(source.oid),
      ]),
    );
    assert.ok(retained);
    return retained;
  };
  return {
    save,
    row,
    setLegacyConflict: () => {
      history = { accountingConflicts: { [fill.coin]: fill.time } };
    },
  };
}

test("same exact execution's changed quantity is quarantined without replacing original provider facts", async () => {
  const h = repository();
  await h.save();
  await h.save([{ ...fill, sz: "28" }]);
  assert.equal(
    h.row().fingerprint,
    canonicalJsonHash(projectHip4Execution("mainnet", address, fill)),
  );
  assert.deepEqual(h.row().provider_fill, fill);
  const status = readHip4ProviderEvidenceStatus(
    h.row().provider_evidence_status,
  );
  assert.equal(status?.state, "conflicted");
  assert.equal(status?.reason, "execution_identity_conflict");
});

test("source-only startPosition contradiction is precise and later official matching evidence restores it", async () => {
  const h = repository();
  await h.save();
  await h.save([{ ...fill, startPosition: "1" }]);
  assert.equal(
    readHip4ProviderEvidenceStatus(h.row().provider_evidence_status)?.reason,
    "execution_accounting_conflict",
  );
  await h.save();
  const status = readHip4ProviderEvidenceStatus(
    h.row().provider_evidence_status,
  );
  assert.equal(status?.state, "matched");
  assert.equal(status?.revision, "2");
});

test("source-absent, empty reads and unrelated order matches cannot clear a known contradiction", async () => {
  const h = repository();
  await h.save();
  await h.save([{ ...fill, fee: "0.01" }]);
  const original = structuredClone(h.row().provider_evidence_status);
  await h.save([fill], false);
  await h.save([]);
  await h.save([{ ...fill, oid: 2, tid: 2 }]);
  assert.deepEqual(h.row().provider_evidence_status, original);
  assert.equal(
    readHip4ProviderEvidenceStatus(
      h.row({ ...fill, oid: 2, tid: 2 }).provider_evidence_status,
    )?.state,
    "matched",
  );
});

test("within-response conflicting duplicates stay conflicted in either order, then recover on a later matching recheck", async () => {
  for (const sources of [
    [{ ...fill, sz: "28" }, fill],
    [fill, { ...fill, sz: "28" }],
  ]) {
    const h = repository();
    await h.save();
    await h.save(sources);
    assert.equal(
      readHip4ProviderEvidenceStatus(h.row().provider_evidence_status)?.state,
      "conflicted",
    );
    await h.save();
    assert.equal(
      readHip4ProviderEvidenceStatus(h.row().provider_evidence_status)?.state,
      "matched",
    );
  }
});

test("equivalent decimal spellings are a matching official recheck, not a false financial contradiction", async () => {
  const h = repository();
  await h.save();
  await h.save([{ ...fill, startPosition: "1" }]);
  await h.save([
    {
      ...fill,
      px: "0.26000",
      sz: "27.00000",
      fee: "0.00000000",
      startPosition: "0.00000",
    },
  ]);
  assert.equal(
    readHip4ProviderEvidenceStatus(h.row().provider_evidence_status)?.state,
    "matched",
  );
});

test("unknown marker versions and malformed revisions are unavailable rather than silently clear", () => {
  assert.equal(readHip4ProviderEvidenceStatus(null), null);
  assert.equal(readHip4ProviderEvidenceStatus({ version: 2 }), undefined);
  assert.equal(
    readHip4ProviderEvidenceStatus({ version: 1, revision: 1 }),
    undefined,
  );
});

test("legacy coin ambiguity only acquits an exact row after a real matching source, even with retained provenance", async () => {
  const h = repository();
  await h.save();
  h.setLegacyConflict();
  await h.save([fill], false);
  assert.equal(h.row().provider_evidence_status, null);
  await h.save([fill]);
  const status = readHip4ProviderEvidenceStatus(
    h.row().provider_evidence_status,
  );
  assert.equal(status?.state, "matched");
  assert.equal(status?.revision, "1");
});

test("source slice bounds the whole response before filtering and makes no inference from missing/capped rows", () => {
  const scope = {
    coin: fill.coin,
    orderId: String(fill.oid),
    timeMs: fill.time,
  };
  const foreign = { ...fill, oid: 2 };
  assert.throws(() =>
    selectHip4ExactRecheckSources(
      Array.from({ length: HIP4_FILL_PAGE_MAX + 1 }, () => foreign),
      scope,
    ),
  );
  const capped = Array.from({ length: HIP4_FILL_PAGE_MAX }, () => foreign);
  assert.deepEqual(selectHip4ExactRecheckSources(capped, scope), []);
  capped[0] = fill;
  assert.deepEqual(selectHip4ExactRecheckSources(capped, scope), [fill]);
  assert.deepEqual(
    selectHip4ExactRecheckSources(
      [{ ...fill, coin: "#133431" }, { ...fill, time: fill.time + 1 }, foreign],
      scope,
    ),
    [],
  );
});
