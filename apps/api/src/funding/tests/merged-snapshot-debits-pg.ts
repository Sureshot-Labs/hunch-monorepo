import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL,
  FUNDING_EVM_SNAPSHOT_DEBIT_CANDIDATES_SQL,
  admitFundingSnapshotDebits,
  loadFundingPhysicalNativeSnapshotDebits,
  FundingSnapshotDebitEvidenceError,
  type FundingSnapshotDebitRow,
} from "../../account-value/funding-snapshot-debits.js";
import {
  hypercoreSpotAccountLocation,
  hypercorePerpsRefundLocation,
  stableOpaqueId,
  canonicalLocationKey,
  stableWalletAssetLocationIdentity,
} from "../../account-value/canonical.js";
import {
  loadFundingSnapshotDebits,
  fundingInvalidSourceComponentIds,
} from "../../account-value/funding-movement-feed.js";
import { loadHypercorePreparationAvailability } from "../preparation/hypercore-availability.js";
import type { AssetLocation, ValuedAssetComponent } from "../domain/types.js";

/** Rolled-back indexed-tail fixtures. Real central terminal merge is separately
 * exercised by merged-refund-identity-pg; this matrix isolates every read path,
 * including native physical admission and single-statement preparation. */
export async function verifyMergedSnapshotDebitsPg(client: PoolClient) {
  const original = randomUUID(),
    current = randomUUID(),
    next = randomUUID();
  const address = `0x${"ab".repeat(20)}`;
  const base = {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  };
  const sourceTime = "2026-10-14T16:00:10.000Z",
    freshTime = "2026-10-14T16:00:25.000Z";
  const evmLocation = (accountId: string): AssetLocation => ({
    kind: "wallet",
    accountId,
    asset: base,
    locationId: stableWalletAssetLocationIdentity({
      accountId,
      address,
      asset: base,
      balanceClass: "",
    }).locationId,
    details: { address },
  });
  const locations = [
    (accountId: string) =>
      hypercoreSpotAccountLocation({
        accountId,
        address,
        controllerWalletId: "controller",
      }).location,
    evmLocation,
    (accountId: string) =>
      hypercorePerpsRefundLocation({
        accountId,
        address,
        controllerWalletId: "controller",
      }),
  ];
  for (const [index, makeLocation] of locations.entries()) {
    const oldLocation = makeLocation(original),
      operationId = randomUUID(),
      segmentId = randomUUID();
    const native = oldLocation.asset.networkId === "hyperliquid:mainnet";
    const originalComponent = native
      ? stableOpaqueId("asset", canonicalLocationKey(oldLocation))
      : stableWalletAssetLocationIdentity({
          accountId: original,
          address,
          asset: base,
          balanceClass: "",
        }).componentId;
    const source = { kind: "owned_location", location: oldLocation };
    await client.query(
      "insert into funding_operations(id,user_id,status,source_snapshot) values($1,$2,'refunded',$3)",
      [operationId, current, { source }],
    );
    await client.query(
      "insert into funding_operation_segments(id,operation_id,source_snapshot) values($1,$2,$3)",
      [segmentId, operationId, source],
    );
    await client.query(
      `insert into balance_reservations(operation_id,user_id,segment_id,component_id,location_id,network_id,asset_id,mode,asset_decimals,state,raw_amount)
      values($1,$2,$3,$4,$5,$6,$7,'subtract_available',$8,'released','10000000')`,
      [
        operationId,
        current,
        segmentId,
        originalComponent,
        oldLocation.locationId,
        oldLocation.asset.networkId,
        oldLocation.asset.assetId,
        oldLocation.asset.decimals,
      ],
    );
    await client.query(
      "insert into balance_reservations select * from balance_reservations where operation_id=$1",
      [operationId],
    );
    const debitId = 950000 + index;
    await client.query(
      `insert into funding_observations values($1,$2,$3,$4,$5,$6,'10000000','2026-10-14T16:00:20Z','2026-10-14T16:00:20Z','source_debit',true,'finalized',$7)`,
      [
        debitId,
        operationId,
        segmentId,
        oldLocation.asset.networkId,
        oldLocation.asset.assetId,
        address,
        oldLocation.asset.decimals,
      ],
    );
    const component = (
      accountId: string,
      observedAt = sourceTime,
    ): ValuedAssetComponent =>
      ({
        componentId: native
          ? stableOpaqueId(
              "asset",
              canonicalLocationKey(makeLocation(accountId)),
            )
          : stableWalletAssetLocationIdentity({
              accountId,
              address,
              asset: base,
              balanceClass: "",
            }).componentId,
        location: makeLocation(accountId),
        amount: { asset: oldLocation.asset, raw: "100000000" },
        observationFreshness: "fresh",
        observationError: null,
        observedAt,
      }) as ValuedAssetComponent;
    const read = (accountId = current, time = sourceTime) =>
      loadFundingSnapshotDebits(client, accountId, [
        component(accountId, time),
      ]);
    assert.equal(
      (await read()).length,
      1,
      "released duplicates do not multiply a merged debit",
    );
    assert.equal((await read())[0].amount.raw, "10000000");
    assert.equal(
      (await read(current, freshTime)).length,
      0,
      "fresh physical snapshot absorbs historical debit",
    );
    if (native) {
      assert.equal(
        (
          await loadFundingPhysicalNativeSnapshotDebits(
            client,
            current,
            makeLocation(current),
            sourceTime,
          )
        ).length,
        1,
      );
      assert.deepEqual(
        await loadHypercorePreparationAvailability(client, {
          accountId: current,
          location: makeLocation(current),
          observedAt: sourceTime,
        }),
        { reservedRaw: "0", submittedDebitRaw: "10000000" },
      );
    }
    await client.query("update funding_operations set user_id=$2 where id=$1", [
      operationId,
      next,
    ]);
    await client.query(
      "update balance_reservations set user_id=$2 where operation_id=$1",
      [operationId, next],
    );
    assert.equal(
      (await read()).length,
      0,
      "old relational owner cannot read moved money",
    );
    assert.equal(
      (await read(next)).length,
      1,
      "second merge still anchors original frozen source",
    );
    await client.query(
      "update funding_observations set canonical=false,finality_status='reorged' where id=$1",
      [debitId],
    );
    assert.equal((await read(next)).length, 0);
    if (native)
      assert.deepEqual(
        await loadHypercorePreparationAvailability(client, {
          accountId: next,
          location: makeLocation(next),
          observedAt: sourceTime,
        }),
        { reservedRaw: "0", submittedDebitRaw: "0" },
        "reorg does not resurrect released old-owner holds",
      );
    await client.query(
      "update funding_observations set canonical=true,finality_status='finalized' where id=$1",
      [debitId],
    );
    const sql = native
      ? FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL
      : FUNDING_EVM_SNAPSHOT_DEBIT_CANDIDATES_SQL;
    const target = component(next);
    const snapshot = {
      component_id: target.componentId,
      location_id: target.location.locationId,
      address,
      asset_decimals: oldLocation.asset.decimals,
      snapshot_at: sourceTime,
      network_id: oldLocation.asset.networkId,
      asset_id: oldLocation.asset.assetId,
      native_source_dex: native
        ? (oldLocation.details.nativeSourceDex ?? "spot")
        : null,
    };
    const { rows } = await client.query<FundingSnapshotDebitRow>(sql, [
      next,
      JSON.stringify([snapshot]),
    ]);
    assert.equal(admitFundingSnapshotDebits(next, rows).length, 1);
    if (index === 2) {
      const spotLocation = locations[0](next);
      const spotComponent = {
        ...target,
        location: spotLocation,
        componentId: stableOpaqueId(
          "asset",
          canonicalLocationKey(spotLocation),
        ),
      };
      const spotFacts = await loadFundingSnapshotDebits(client, next, [
        spotComponent,
      ]);
      assert.equal(
        spotFacts.length,
        1,
        "the perps debit cannot reduce/fence the simultaneous spot snapshot",
      );
      assert.equal(spotFacts[0].amount.raw, "10000000");
      assert.equal(spotFacts[0].observationError, undefined);
    }
    for (const patch of [
      { component_id: "wrong" },
      { location_id: "wrong" },
      { asset_decimals: 18 },
      { address: `0x${"cc".repeat(20)}` },
    ]) {
      const invalid = await client.query<FundingSnapshotDebitRow>(sql, [
        next,
        JSON.stringify([{ ...snapshot, ...patch }]),
      ]);
      assert.equal(
        admitFundingSnapshotDebits(next, invalid.rows).length,
        0,
        JSON.stringify(patch),
      );
    }
    const unknownSource = {
      ...source,
      location: { ...oldLocation, locationId: "legacy-arbitrary" },
    };
    await client.query(
      "update funding_operations set source_snapshot=$2 where id=$1",
      [operationId, { source: unknownSource }],
    );
    await client.query(
      "update funding_operation_segments set source_snapshot=$2 where id=$1",
      [segmentId, unknownSource],
    );
    await client.query(
      "update balance_reservations set location_id='legacy-arbitrary' where operation_id=$1",
      [operationId],
    );
    const unknown = await read(next);
    assert.equal(unknown.length, 1);
    assert.equal(
      unknown[0].amount.raw,
      "0",
      "unverified proof must not become money",
    );
    assert.equal(
      unknown[0].observationError,
      "funding_source_evidence_invalid",
    );
    assert.deepEqual(
      [
        ...fundingInvalidSourceComponentIds(next, unknown, [
          target,
          component(current),
        ]),
      ],
      [target.componentId],
      "mask just the requested owned stale component",
    );
    assert.equal(
      (await read(next, freshTime)).length,
      0,
      "normal fresh snapshot removes unknown debit tail",
    );
    if (native) {
      await assert.rejects(
        loadFundingPhysicalNativeSnapshotDebits(
          client,
          next,
          makeLocation(next),
          sourceTime,
        ),
        FundingSnapshotDebitEvidenceError,
      );
      await assert.rejects(
        loadHypercorePreparationAvailability(client, {
          accountId: next,
          location: makeLocation(next),
          observedAt: sourceTime,
        }),
        { code: "evidence_invalid" },
      );
      assert.deepEqual(
        await loadHypercorePreparationAvailability(client, {
          accountId: next,
          location: makeLocation(next),
          observedAt: freshTime,
        }),
        { reservedRaw: "0", submittedDebitRaw: "0" },
      );
    }
    await client.query(
      "update funding_operations set source_snapshot=$2 where id=$1",
      [operationId, { source }],
    );
    await client.query(
      "update funding_operation_segments set source_snapshot=$2 where id=$1",
      [segmentId, source],
    );
    await client.query(
      "update balance_reservations set location_id=$2 where operation_id=$1",
      [operationId, oldLocation.locationId],
    );
    const statement = native
      ? `native_candidate_tail_${index}`
      : "evm_candidate_tail";
    await client.query(`prepare ${statement}(uuid,jsonb) as ${sql}`);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      for (const [name, payload] of [
        ["merged-hit", [snapshot]],
        ["resumed-empty", [{ ...snapshot, snapshot_at: freshTime }]],
        ["sparse-owner", [{ ...snapshot, address: `0x${"cc".repeat(20)}` }]],
        ["empty-input", []],
      ] as const) {
        // Fixture UUID/JSON constants only, never user/provider SQL interpolation.
        const plan = (
          await client.query(
            `explain(analyze,buffers,format json) execute ${statement}('${next}','${JSON.stringify(payload)}')`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const serialized = JSON.stringify(plan.Plan);
        assert.ok(
          serialized.includes(
            native
              ? "funding_observations_native_source_tail_idx"
              : "funding_observations_evm_source_tail_idx",
          ),
        );
        const blocks =
          Number(plan.Plan["Local Hit Blocks"]) +
          Number(plan.Plan["Local Read Blocks"]);
        assert.ok(blocks < 200, `${statement}/${mode}/${name}: ${blocks}`);
        console.log(`${statement}/${mode}/${name}`, {
          ms: plan["Execution Time"],
          localBlocks: blocks,
        });
      }
    }
  }
  console.log(
    "merged snapshot debit native/EVM, preparation/admission and reorg recovery cases passed",
  );
}
