import { freemem } from "node:os";
import { readFile } from "node:fs/promises";
import {
  EmbeddingMemoryError,
  embeddingBytesPerItem,
  memoryAdmission,
  type MemoryAdmission,
} from "./memory.js";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  parseVenueLifecyclePolicy,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import {
  embeddingPolicySchema,
  generationForPolicy,
  readActiveGeneration,
  LEGACY_EMBEDDING_GENERATION,
  buildEmbeddingText,
  cleanEmbeddingText,
  embeddingTextHash,
  fetchEmbeddingBatch,
  EmbeddingProviderError,
  embeddingKey,
  embeddingIndex,
  readEmbeddingSourcePage,
  loadEmbeddingSources,
  type EmbeddingPolicy,
  type EmbeddingGeneration,
  type EmbeddingDb,
  type EmbeddingKind,
  type EmbeddingSource,
} from "@hunch/embeddings";
import {
  CONTROL,
  STREAM,
  GROUP,
  DLQ,
  EmbeddingStore,
  record,
  compareStreamId,
} from "./store.js";

type Coverage = { eligible: number; verified: number; missing: number };
type Pass = {
  scanVersion: 3;
  countsReady: boolean;
  probes: Partial<Record<EmbeddingKind, string>>;
  phase: "building" | "verifying" | "ready" | "active";
  kind: EmbeddingKind;
  after: string | null;
  coverage: { events: Coverage; markets: Coverage };
  watermark: string;
  overflow: string;
  startedAt: number;
  verifiedAt: string | null;
  pilotStartBytes: number;
  pilotItems: number;
  projectedBytes: number;
  gcCursor: string;
  gcKind: EmbeddingKind;
  gcDone: boolean;
  eligibilityRevision: string;
  notBefore?: number;
};
type SourceCensus = {
  revision: string;
  kind: EmbeddingKind;
  after: string | null;
  counts: Record<EmbeddingKind, number>;
  completedAt: number | null;
};
const CENSUS_KEY = `${CONTROL}source-census`;
const emptyCoverage = () => ({
  events: { eligible: 0, verified: 0, missing: 0 },
  markets: { eligible: 0, verified: 0, missing: 0 },
});
const stateKey = (g: EmbeddingGeneration) => `${CONTROL}state:${g.id}`;
const generationKey = (g: EmbeddingGeneration) =>
  `${CONTROL}generation:${g.id}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export type EngineOptions = {
  store: EmbeddingStore;
  db: EmbeddingDb;
  apiKey: string;
  provider?: typeof fetchEmbeddingBatch;
  availableMemory?: () => Promise<number>;
};

export async function workerAvailableMemory(): Promise<number> {
  let available = freemem();
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(text);
    if (match) available = Number(match[1]) * 1024;
  } catch {
    /* macOS/disposable tests use os.freemem. */
  }
  for (const [limitFile, usedFile] of [
    ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"],
    [
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ],
  ]) {
    try {
      const [limit, used] = await Promise.all([
        readFile(limitFile, "utf8"),
        readFile(usedFile, "utf8"),
      ]);
      if (Number.isFinite(Number(limit)))
        available = Math.min(available, Number(limit) - Number(used));
    } catch {
      /* cgroup version or no explicit limit */
    }
  }
  return Math.max(0, available);
}

export class EmbeddingEngine {
  private policy: EmbeddingPolicy | null = null;
  private venues: string[] = [];
  private policyAt = 0;
  private policyError: string | null = null;
  private retries = 0;
  private claimCursor = "0-0";
  private lastMaintenance = 0;
  private lastReport = 0;
  private memoryPauses = new Map<string, MemoryAdmission>();
  private memorySamples = new Map<string, { at: number; bytes: number }>();
  private backgroundFailures = new Map<
    string,
    { code: string; retryAt: number }
  >();
  constructor(readonly options: EngineOptions) {}
  private get store() {
    return this.options.store;
  }
  private async refreshPolicy(force = false) {
    if (!force && Date.now() - this.policyAt < 30000) return;
    this.policyAt = Date.now();
    try {
      const row = await fetchActiveRuntimePolicy(
        this.options.db,
        "ai_embeddings",
      );
      const lifecycleRow = await fetchActiveRuntimePolicy(
        this.options.db,
        "venue_lifecycle",
      );
      const lifecycle = lifecycleRow
        ? parseVenueLifecyclePolicy(lifecycleRow.payload)
        : DEFAULT_VENUE_LIFECYCLE_POLICY;
      if (!lifecycle) throw new Error("invalid_venue_lifecycle_policy");
      this.policy = embeddingPolicySchema.parse(row?.payload ?? {});
      this.venues = Object.keys(lifecycle.venues).filter((venue) =>
        venueHasLifecycleCapability(lifecycle, venue, "discovery"),
      );
      this.policyError = null;
    } catch {
      this.policyError = "embedding_policy_unavailable_or_invalid";
    }
  }
  private async usedMemory() {
    const info = String(await this.store.redis.sendCommand(["INFO", "memory"]));
    return Number(/^used_memory:(\d+)/m.exec(info)?.[1] ?? NaN);
  }
  private async memoryCheck(generation: EmbeddingGeneration, pass?: Pass) {
    const used = await this.usedMemory();
    const available = await (
      this.options.availableMemory ?? workerAvailableMemory
    )();
    let remaining = 0;
    let perItem = 0;
    if (pass && pass.pilotItems >= 1000 && pass.phase === "building") {
      remaining = Math.max(
        0,
        pass.coverage.events.eligible +
          pass.coverage.markets.eligible -
          pass.pilotItems,
      );
      let sample = this.memorySamples.get(generation.id);
      if (!sample || Date.now() - sample.at >= 60000) {
        sample = {
          at: Date.now(),
          bytes: await embeddingBytesPerItem(this.store, generation),
        };
        this.memorySamples.set(generation.id, sample);
      }
      perItem = sample.bytes;
    }
    const admission = memoryAdmission(
      generation.id,
      used,
      available,
      remaining,
      perItem,
    );
    if (pass) pass.projectedBytes = admission.projectedBytes;
    if (admission.blockedBy) {
      this.memoryPauses.set(generation.id, admission);
      throw new EmbeddingMemoryError(admission);
    }
    this.memoryPauses.delete(generation.id);
    return admission;
  }
  private async prepare(generation: EmbeddingGeneration) {
    for (const kind of ["event", "market"] as const)
      await this.store.ensureIndex(generation, kind);
    await this.store.put(generationKey(generation), generation);
    await this.store.fenced("return redis.call('UNLINK',unpack(KEYS,2))", [
      `${CONTROL}deleting:${generation.id}`,
      `${CONTROL}deleted:${generation.id}`,
      stateKey(generation),
      `${CONTROL}gc:${generation.id}`,
      `${CONTROL}retired:${generation.id}`,
    ]);
  }
  private async advanceCensus(): Promise<SourceCensus> {
    const revision = `time-v3:${[...this.venues].sort().join(",")}`;
    let census = await this.store.get<SourceCensus>(CENSUS_KEY);
    if (
      !census ||
      census.revision !== revision ||
      (census.completedAt != null &&
        Date.now() - census.completedAt >= 6 * 3600000)
    ) {
      census = {
        revision,
        kind: "event",
        after: null,
        counts: { event: 0, market: 0 },
        completedAt: null,
      };
    }
    if (census.completedAt != null) return census;
    const page = await readEmbeddingSourcePage(
      this.options.db,
      census.kind,
      census.after,
      this.venues,
    );
    census.counts[census.kind] += page.ids.length;
    census.after = page.after;
    if (page.done) {
      if (census.kind === "event") {
        census.kind = "market";
        census.after = null;
      } else census.completedAt = Date.now();
    }
    // Count and cursor commit together; a restart cannot double-count a page.
    await this.store.put(CENSUS_KEY, census);
    return census;
  }
  private async newPass(phase: Pass["phase"] = "building"): Promise<Pass> {
    const last = (await this.store.redis.sendCommand([
      "XREVRANGE",
      STREAM,
      "+",
      "-",
      "COUNT",
      "1",
    ])) as unknown[][];
    return {
      scanVersion: 3,
      countsReady: false,
      probes: {},
      phase,
      kind: "event",
      after: null,
      coverage: emptyCoverage(),
      watermark: last.length ? String(last[0][0]) : "0-0",
      overflow: String(
        (await this.store.redis.sendCommand(["GET", `${CONTROL}reconcile`])) ??
          "0",
      ),
      startedAt: Date.now(),
      verifiedAt: null,
      pilotStartBytes: await this.usedMemory(),
      pilotItems: 0,
      projectedBytes: 0,
      gcCursor: "0",
      gcKind: "event",
      gcDone: false,
      eligibilityRevision: [...this.venues].sort().join(","),
    };
  }
  private async generations(
    active: EmbeddingGeneration,
    desired: EmbeddingGeneration,
  ) {
    // Retaining or collecting an older generation blocks a third generation,
    // never reconciliation of the generation that is already serving reads.
    const alreadyServing = active.id === desired.id;
    let registered = await this.store.get<EmbeddingGeneration[]>(
      `${CONTROL}generations`,
    );
    if (!registered) {
      registered = [active];
      await this.store.put(generationKey(active), active);
      await this.store.put(`${CONTROL}generations`, registered);
    }
    if (
      registered.some((g) => g.id === desired.id) &&
      (await this.store.redis.get(`${CONTROL}deleting:${desired.id}`))
    ) {
      // A canceled GC may have removed either index and some hashes. Re-admit and
      // re-verify the generation rather than activating its old ready checkpoint.
      await this.prepare(desired);
    }
    // No third full generation. Only in-flight work delays retired generation GC.
    for (const generation of registered) {
      if (generation.id === active.id || generation.id === desired.id) continue;
      const retired = Number(
        (await this.store.redis.sendCommand([
          "GET",
          `${CONTROL}retired:${generation.id}`,
        ])) ?? 0,
      );
      if (!retired) {
        await this.store.put(`${CONTROL}retired:${generation.id}`, Date.now());
      }
      const pins = Number(
        await this.store.redis.sendCommand([
          "ZCOUNT",
          `${CONTROL}pins:${generation.id}`,
          String(Date.now()),
          "+inf",
        ]),
      );
      if (pins) return alreadyServing;
      const admitted = Number(
        await this.store.fenced(
          `
if redis.call('ZCOUNT',KEYS[2],ARGV[2],'+inf')>0 then return 0 end
redis.call('SET',KEYS[3],'1'); return 1`,
          [
            `${CONTROL}pins:${generation.id}`,
            `${CONTROL}deleting:${generation.id}`,
          ],
          [String(Date.now())],
        ),
      );
      if (!admitted) return alreadyServing;
      // Bounded cleanup uses only an exact registered generation prefix; never broad ai:*.
      const progress = (await this.store.get<{
        kind: EmbeddingKind;
        cursor: string;
      }>(`${CONTROL}gc:${generation.id}`)) ?? { kind: "event", cursor: "0" };
      const scan = (await this.store.redis.sendCommand([
        "SCAN",
        progress.cursor,
        "MATCH",
        `${embeddingKey(generation, progress.kind, "")}*`,
        "COUNT",
        "200",
      ])) as [string, string[]];
      if (scan[1].length)
        await this.store.fenced(
          "return redis.call('UNLINK',unpack(KEYS,2))",
          scan[1],
        );
      progress.cursor = scan[0];
      if (progress.cursor === "0") {
        try {
          await this.store.fenced("return redis.call('FT.DROPINDEX',KEYS[2])", [
            embeddingIndex(generation, progress.kind),
          ]);
        } catch (error) {
          if (!/Unknown index|no such index/i.test(String(error))) throw error;
        }
        if (progress.kind === "event") progress.kind = "market";
        else {
          registered = registered.filter((g) => g.id !== generation.id);
          await this.store.put(`${CONTROL}generations`, registered);
          await this.store.put(
            `${CONTROL}deleted:${generation.id}`,
            Date.now(),
          );
        }
      }
      await this.store.put(`${CONTROL}gc:${generation.id}`, progress);
      return alreadyServing;
    }
    if (!registered.some((g) => g.id === desired.id)) {
      await this.memoryCheck(desired);
      await this.prepare(desired);
      registered.push(desired);
      await this.store.put(`${CONTROL}generations`, registered);
    }
    return true;
  }
  private async process(
    generation: EmbeddingGeneration,
    kind: EmbeddingKind,
    ids: string[],
    building: boolean,
    verify = false,
  ) {
    const sources = await loadEmbeddingSources(
      this.options.db,
      kind,
      ids,
      this.venues,
    );
    const missing: {
      source: EmbeddingSource;
      text: string;
      hash: string;
      retryAt: number;
    }[] = [];
    let verified = 0;
    let verifiedId: string | undefined;
    let invalid = 0;
    for (const source of sources) {
      if (!source.eligible) {
        await this.store.commit(generation, source, "");
        await this.store.fenced("return redis.call('UNLINK',KEYS[2])", [
          `${CONTROL}failure:${generation.id}:${kind}:${source.id}`,
        ]);
        continue;
      }
      if (!cleanEmbeddingText(source.title)) {
        invalid++;
        await this.recordFailure(
          generation,
          kind,
          source.id,
          embeddingTextHash(JSON.stringify(source)),
          "invalid_source_title",
          0,
        );
        continue;
      }
      const text = buildEmbeddingText(source, generation),
        hash = embeddingTextHash(text);
      const [previous, version, , bytes] = await this.store.metadata(
        generation,
        source,
      );
      if (
        bytes === generation.dimensions * 4 &&
        previous === hash &&
        (version === generation.id ||
          (generation.legacy && version?.startsWith("intfloat/e5-large-v2@")))
      ) {
        await this.store.commit(generation, source, hash);
        verified++;
        verifiedId ??= source.id;
        continue;
      }
      const failure = await this.store.get<{ hash: string; retryAt?: number }>(
        `${CONTROL}failure:${generation.id}:${kind}:${source.id}`,
      );
      missing.push({
        source,
        text,
        hash,
        retryAt: failure?.hash === hash ? (failure.retryAt ?? 0) : 0,
      });
    }
    if (verify)
      return {
        eligible: sources.filter((s) => s.eligible).length,
        verified,
        verifiedId,
        missing: missing.length + invalid,
      };
    const policy = this.policy;
    if (!policy) throw new Error("embedding_policy_unavailable");
    if (
      missing.length &&
      (await this.store.redis.get(`${CONTROL}cost-drift:${generation.id}`))
    )
      throw new Error("embedding_provider_cost_drift");
    const payable = missing.filter((item) => item.retryAt <= Date.now());
    for (
      let offset = 0;
      offset < payable.length;
      offset += policy.batchSize * policy.concurrency
    ) {
      const slices = [];
      for (
        let j = offset;
        j <
        Math.min(
          payable.length,
          offset + policy.batchSize * policy.concurrency,
        );
        j += policy.batchSize
      )
        slices.push(payable.slice(j, j + policy.batchSize));
      // Every sibling settles before moving on, even if one fails or a policy changes.
      const results = await Promise.allSettled(
        slices.map(async (batch) => {
          let reserved = 0;
          let response;
          try {
            response = await (this.options.provider ?? fetchEmbeddingBatch)({
              generation,
              texts: batch.map((x) => x.text),
              apiKey: this.options.apiKey,
              timeoutMs: policy.requestTimeoutMs,
              beforeAttempt: async ({ attempt, estimatedCostUsd }) => {
                if (attempt > 1) {
                  this.retries++;
                  await this.store.put(
                    `${CONTROL}unknown-cost:${generation.id}`,
                    true,
                  );
                }
                await this.store.reserve(
                  generation,
                  estimatedCostUsd,
                  building ? policy.generationBudgetUsd : null,
                );
                reserved += estimatedCostUsd;
              },
            });
          } catch (error) {
            if (reserved > 0)
              await this.store.put(
                `${CONTROL}unknown-cost:${generation.id}`,
                true,
              );
            if (error instanceof EmbeddingProviderError && !error.breaker) {
              // Record once per content revision, not on every stream delivery/restart.
              for (const item of batch) {
                await this.recordFailure(
                  generation,
                  kind,
                  item.source.id,
                  item.hash,
                  error.code,
                  error.retryable ? 4 : 1,
                  error.retryAfterMs,
                );
              }
            }
            throw error;
          }
          if (response.usage.costUsd != null)
            await this.store.fenced(
              "return redis.call('INCRBYFLOAT',KEYS[2],ARGV[2])",
              [`${CONTROL}actual-cost:${generation.id}`],
              [String(response.usage.costUsd)],
            );
          else
            await this.store.put(
              `${CONTROL}unknown-cost:${generation.id}`,
              true,
            );
          if (
            response.usage.costUsd != null &&
            response.usage.costUsd > reserved + 1e-9
          ) {
            await this.store.reserve(
              generation,
              response.usage.costUsd - reserved,
              null,
            );
            await this.store.put(`${CONTROL}cost-drift:${generation.id}`, {
              at: Date.now(),
              charged: response.usage.costUsd,
              reserved,
            });
            throw new Error("embedding_provider_cost_drift");
          }
          const current = await loadEmbeddingSources(
            this.options.db,
            kind,
            batch.map((x) => x.source.id),
            this.venues,
          );
          for (let i = 0; i < batch.length; i++) {
            const source = current[i],
              item = batch[i];
            if (!source.eligible) {
              await this.store.commit(generation, source, "");
              continue;
            }
            if (
              !cleanEmbeddingText(source.title) ||
              embeddingTextHash(buildEmbeddingText(source, generation)) !==
                item.hash
            ) {
              await this.store.fenced("return redis.call('INCR',KEYS[2])", [
                `${CONTROL}reconcile`,
              ]);
              continue;
            }
            await this.store.commit(
              generation,
              source,
              item.hash,
              response.embeddings[i],
            );
            await this.store.fenced("return redis.call('UNLINK',KEYS[2])", [
              `${CONTROL}failure:${generation.id}:${kind}:${source.id}`,
            ]);
          }
        }),
      );
      const failed = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failed) throw failed.reason;
    }
    return {
      eligible: sources.filter((s) => s.eligible).length,
      verified,
      verifiedId,
      missing: missing.length + invalid,
    };
  }
  private async recordFailure(
    generation: EmbeddingGeneration,
    kind: EmbeddingKind,
    id: string,
    hash: string,
    code: string,
    attempts: number,
    retryAfterMs = 0,
  ) {
    const key = `${CONTROL}failure:${generation.id}:${kind}:${id}`;
    const previous = await this.store.get<{ hash: string }>(key);
    if (previous?.hash !== hash)
      await this.store.dead(kind, id, generation.id, code, attempts);
    await this.store.put(key, {
      hash,
      code,
      at: Date.now(),
      retryAt: Date.now() + Math.max(6 * 3600000, retryAfterMs),
    });
    await this.store.fenced("return redis.call('EXPIRE',KEYS[2],604800)", [
      key,
    ]);
  }
  private async processMessages(
    active: EmbeddingGeneration,
    desired: EmbeddingGeneration,
    canBuild: boolean,
  ) {
    const claimed = (await this.store.redis.sendCommand([
      "XAUTOCLAIM",
      STREAM,
      GROUP,
      this.store.token,
      "60000",
      this.claimCursor,
      "COUNT",
      "200",
    ])) as unknown[];
    this.claimCursor = String(claimed[0]);
    const deleted = (claimed[2] ?? []) as unknown[];
    if (deleted.length) {
      await this.store.fenced(
        "redis.call('INCR',KEYS[3]); return redis.call('INCRBY',KEYS[2],ARGV[2])",
        [`${CONTROL}lost-pending`, `${CONTROL}reconcile`],
        [String(deleted.length)],
      );
    }
    let entries = claimed[1] as unknown[][];
    if (!entries.length) {
      const response = (await this.store.redis.sendCommand([
        "XREADGROUP",
        "GROUP",
        GROUP,
        this.store.token,
        "COUNT",
        "200",
        "STREAMS",
        STREAM,
        ">",
      ])) as unknown[][] | null;
      entries = (response?.[0]?.[1] ?? []) as unknown[][];
    }
    if (!entries.length) return false;
    const ids = { event: new Set<string>(), market: new Set<string>() };
    const ack: string[] = [];
    for (const [messageId, fields] of entries) {
      const payload = record(fields);
      const kind = String(payload.entity_type);
      const id = String(
        payload.entity_id ?? payload.market_id ?? payload.event_id ?? "",
      );
      if ((kind !== "event" && kind !== "market") || !id) {
        await this.store.dead(kind, id, desired.id, "invalid_payload", 0);
        await this.store.ack([String(messageId)]);
        continue;
      }
      ids[kind].add(id);
      ack.push(String(messageId));
    }
    for (const kind of ["event", "market"] as const) {
      if (!ids[kind].size) continue;
      await this.process(active, kind, [...ids[kind]], false);
      if (canBuild && desired.id !== active.id)
        await this.process(desired, kind, [...ids[kind]], true);
    }
    if (!canBuild && desired.id !== active.id)
      await this.store.fenced("return redis.call('INCR',KEYS[2])", [
        `${CONTROL}reconcile`,
      ]);
    await this.store.ack(ack);
    return true;
  }
  private async cleanTerminal(generation: EmbeddingGeneration, pass: Pass) {
    const prefix = embeddingKey(generation, pass.gcKind, "");
    const scan = (await this.store.redis.sendCommand([
      "SCAN",
      pass.gcCursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "500",
    ])) as [string, string[]];
    const ids = scan[1]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    for (let i = 0; i < ids.length; i += 500) {
      const sources = await loadEmbeddingSources(
        this.options.db,
        pass.gcKind,
        ids.slice(i, i + 500),
        this.venues,
      );
      for (const source of sources)
        if (!source.eligible) await this.store.commit(generation, source, "");
    }
    pass.gcCursor = scan[0];
    if (pass.gcCursor === "0") {
      if (pass.gcKind === "event") pass.gcKind = "market";
      else pass.gcDone = true;
    }
  }
  private async advance(
    active: EmbeddingGeneration,
    desired: EmbeddingGeneration,
  ) {
    let pass = await this.store.get<Pass>(stateKey(desired));
    const now = Date.now();
    // ID cursors cannot resume a venue/time ordered scan. Recheck coverage
    // from its start, keeping cached vectors and monetary reservations intact.
    if (pass?.scanVersion !== 3) pass = null;
    if (pass && pass.eligibilityRevision !== [...this.venues].sort().join(","))
      pass = null;
    if (
      pass?.phase === "ready" &&
      now - Date.parse(pass.verifiedAt ?? "1970-01-01") > 60000
    )
      pass = null;
    if (active.id !== desired.id && pass?.phase === "active")
      pass = await this.newPass("verifying");
    if (
      pass?.phase === "active" &&
      now - pass.startedAt < 6 * 3600000 &&
      String(
        (await this.store.redis.sendCommand(["GET", `${CONTROL}reconcile`])) ??
          "0",
      ) === pass.overflow
    )
      return pass;
    if (pass?.phase === "active") pass = null;
    if (
      !pass ||
      (pass.phase === "active" && now - pass.startedAt >= 6 * 3600000)
    )
      pass = await this.newPass();
    if ((pass.notBefore ?? 0) > now)
      throw new Error("embedding_coverage_retry_wait");
    if (!pass.countsReady) {
      const census = await this.background("source_census", () =>
        this.advanceCensus(),
      );
      if (census?.completedAt != null) {
        pass.coverage.events.eligible = census.counts.event;
        pass.coverage.markets.eligible = census.counts.market;
        pass.countsReady = true;
        // Live work can grow Redis during a long census. Do not attribute that
        // unrelated growth to the first 1,000 items of the background pilot.
        if (pass.phase === "building" && pass.pilotItems === 0)
          pass.pilotStartBytes = await this.usedMemory();
      }
      await this.store.put(stateKey(desired), pass);
      if (!pass.countsReady) return pass;
    }
    await this.memoryCheck(desired, pass);
    if (!pass.gcDone) {
      await this.cleanTerminal(desired, pass);
      await this.store.put(stateKey(desired), pass);
      return pass;
    }
    if (pass.phase === "ready") {
      if (!this.policy?.autoActivate && active.id !== desired.id) return pass;
      await this.refreshPolicy(true);
      if (
        this.policyError ||
        !this.policy?.enabled ||
        (active.id !== desired.id &&
          (!this.policy.autoActivate ||
            generationForPolicy(this.policy).id !== desired.id))
      )
        return pass;
      if (pass.eligibilityRevision !== [...this.venues].sort().join(",")) {
        await this.store.put(stateKey(desired), await this.newPass());
        return pass;
      }
      const pending = (await this.store.redis.sendCommand([
        "XPENDING",
        STREAM,
        GROUP,
      ])) as unknown[];
      const groups = (await this.store.redis.sendCommand([
        "XINFO",
        "GROUPS",
        STREAM,
      ])) as unknown[][];
      const group = groups.map(record).find((g) => g.name === GROUP);
      if (
        !group ||
        compareStreamId(String(group["last-delivered-id"]), pass.watermark) <
          0 ||
        (Number(pending[0]) > 0 &&
          compareStreamId(String(pending[1]), pass.watermark) <= 0)
      )
        return pass;
      if (
        String(
          (await this.store.redis.sendCommand([
            "GET",
            `${CONTROL}reconcile`,
          ])) ?? "0",
        ) !== pass.overflow
      ) {
        pass = await this.newPass();
        await this.store.put(stateKey(desired), pass);
        return pass;
      }
      // A real search admission check, not document-count arithmetic.
      for (const kind of ["event", "market"] as const) {
        await this.store.ensureIndex(desired, kind);
        const probeId = pass.probes[kind];
        if (
          pass.coverage[kind === "event" ? "events" : "markets"].verified > 0 &&
          !probeId
        )
          throw new Error("embedding_knn_probe_missing");
        if (probeId) {
          // Redis Lua returns binary directly to FT.SEARCH without UTF-8 roundtripping.
          const result = (await this.store.fenced(
            `local vector=redis.call('HGET',KEYS[2],'embedding')
if not vector then return redis.error_reply('embedding_probe_missing') end
return redis.call('FT.SEARCH',KEYS[3],'(@status:{ACTIVE})=>[KNN 1 @embedding $vec]','PARAMS','2','vec',vector,'LIMIT','0','1','DIALECT','2')`,
            [
              embeddingKey(desired, kind, probeId),
              embeddingIndex(desired, kind),
            ],
          )) as unknown[];
          if (Number(result[0]) < 1)
            throw new Error("embedding_knn_probe_failed");
        }
      }
      // Probes may take time; honor newly disabled activation immediately before
      // the fenced swap, rather than relying on the earlier cached policy.
      await this.refreshPolicy(true);
      if (
        this.policyError ||
        !this.policy?.enabled ||
        (active.id !== desired.id &&
          (!this.policy.autoActivate ||
            generationForPolicy(this.policy).id !== desired.id)) ||
        pass.eligibilityRevision !== [...this.venues].sort().join(",")
      )
        return pass;
      if (
        active.id === desired.id ||
        (await this.store.activate(active, desired, pass.overflow))
      ) {
        pass.phase = "active";
        pass.verifiedAt = new Date().toISOString();
        pass.startedAt = Date.now();
        await this.store.put(stateKey(desired), pass);
      }
      return pass;
    }
    const page = await readEmbeddingSourcePage(
      this.options.db,
      pass.kind,
      pass.after,
      this.venues,
      500,
    );
    if (page.ids.length) {
      // Orphan event pages and terminal-vector GC can take time after census.
      // Start the pilot measurement immediately before its first actual page.
      if (pass.phase === "building" && pass.pilotItems === 0)
        pass.pilotStartBytes = await this.usedMemory();
      const stats = await this.process(
        desired,
        pass.kind,
        page.ids,
        active.id !== desired.id,
        pass.phase === "verifying",
      );
      const bucket =
        pass.kind === "event" ? pass.coverage.events : pass.coverage.markets;
      bucket.verified += stats.verified;
      bucket.missing += stats.missing;
      if (
        pass.phase === "verifying" &&
        stats.verifiedId &&
        !pass.probes[pass.kind]
      )
        pass.probes[pass.kind] = stats.verifiedId;
      if (pass.phase === "building") {
        pass.pilotItems += page.ids.length;
      }
    }
    pass.after = page.after;
    if (!page.done) {
      // Empty venue/orphan pages still advance, without finishing verification.
    } else if (pass.kind === "event") {
      pass.kind = "market";
      pass.after = null;
    } else if (pass.phase === "building") {
      const next = await this.newPass("verifying");
      next.gcDone = true;
      next.projectedBytes = pass.projectedBytes;
      pass = next;
    } else if (
      pass.coverage.events.missing + pass.coverage.markets.missing >
      0
    ) {
      pass = await this.newPass();
      pass.notBefore = Date.now() + 6 * 3600000;
    } else {
      pass.phase = "ready";
      // Rows can close or arrive while a read-committed sweep is running. Report
      // the eligible set actually checked, not a stale pre-sweep COUNT estimate.
      for (const coverage of [pass.coverage.events, pass.coverage.markets])
        coverage.eligible = coverage.verified + coverage.missing;
      pass.verifiedAt = new Date().toISOString();
    }
    await this.store.put(stateKey(desired), pass);
    return pass;
  }
  private async report(
    active: EmbeddingGeneration,
    desired: EmbeddingGeneration | null,
    state: string,
    reason: string | null,
  ) {
    if (Date.now() - this.lastReport < 10000) return;
    this.lastReport = Date.now();
    const pass = desired ? await this.store.get<Pass>(stateKey(desired)) : null;
    const census =
      pass && !pass.countsReady
        ? await this.store.get<SourceCensus>(CENSUS_KEY)
        : null;
    const pending = (await this.store.redis.sendCommand([
      "XPENDING",
      STREAM,
      GROUP,
    ])) as unknown[];
    const circuit = await this.store.get<number>(`${CONTROL}circuit`);
    const spent = desired ? await this.store.spent(desired) : 0;
    const actual = desired
      ? Number(
          (await this.store.redis.get(`${CONTROL}actual-cost:${desired.id}`)) ??
            0,
        )
      : 0;
    const memoryInfo = String(
      await this.store.redis.sendCommand(["INFO", "memory"]),
    );
    const persistenceInfo = String(
      await this.store.redis.sendCommand(["INFO", "persistence"]),
    );
    await this.store.put(`${CONTROL}status`, {
      updatedAt: new Date().toISOString(),
      activeGeneration: active.id,
      desiredGeneration: desired?.id ?? null,
      state,
      reason:
        reason ??
        (this.backgroundFailures.size
          ? `background_sql_retry:${[...this.backgroundFailures].map(([stage, failure]) => `${stage}:${failure.code}`).join(",")}`
          : census && census.completedAt == null
            ? "counting_embedding_sources"
            : null),
      checkpoint:
        census && census.completedAt == null
          ? { entityType: census.kind, afterId: census.after }
          : pass
            ? { entityType: pass.kind, afterId: pass.after }
            : null,
      coverage: pass?.coverage ?? emptyCoverage(),
      verifiedAt: pass?.verifiedAt ?? null,
      budget: {
        limitUsd: this.policy?.generationBudgetUsd ?? 5,
        spentUsd: spent,
        reservedUsd: 0,
        actualUsd:
          desired &&
          (await this.store.redis.get(`${CONTROL}unknown-cost:${desired.id}`))
            ? null
            : actual,
        remainingUsd: Math.max(
          0,
          (this.policy?.generationBudgetUsd ?? 5) - spent,
        ),
      },
      retries: this.retries,
      circuitUntil: circuit ? new Date(circuit).toISOString() : null,
      oldestPendingAgeMs:
        Number(pending[0]) > 0
          ? Date.now() - Number(String(pending[1]).split("-")[0])
          : null,
      dlqLength: Number(await this.store.redis.sendCommand(["XLEN", DLQ])),
      memory: {
        pauses: [...this.memoryPauses.values()],
        redisUsedBytes: await this.usedMemory(),
        workerAvailableBytes: await (
          this.options.availableMemory ?? workerAvailableMemory
        )(),
        projectedBytes:
          (desired
            ? this.memoryPauses.get(desired.id)?.projectedBytes
            : null) ??
          pass?.projectedBytes ??
          null,
        workerRssBytes: process.memoryUsage().rss,
        redisRssBytes: Number(
          /^used_memory_rss:(\d+)/m.exec(memoryInfo)?.[1] ?? 0,
        ),
        redisPersistenceActive:
          /^(rdb_bgsave_in_progress|aof_rewrite_in_progress):1\r?$/m.test(
            persistenceInfo,
          ),
      },
    });
  }
  private async retainPinned(active: EmbeddingGeneration) {
    const registered =
      (await this.store.get<EmbeddingGeneration[]>(`${CONTROL}generations`)) ??
      [];
    for (const generation of registered) {
      const pinsKey = `${CONTROL}pins:${generation.id}`;
      // Old published snapshots are disposable. Remove only their legacy pins,
      // never pins owned by requests or running jobs, in bounded increments.
      const snapshotCursorKey = `${CONTROL}snapshot-pins-gc:${generation.id}`;
      const snapshotPins = (await this.store.redis.sendCommand([
        "ZSCAN",
        pinsKey,
        (await this.store.get<string>(snapshotCursorKey)) ?? "0",
        "MATCH",
        "map:*",
        "COUNT",
        "200",
      ])) as [string, string[]];
      const snapshotOwners = snapshotPins[1].filter(
        (_, index) => index % 2 === 0,
      );
      if (snapshotOwners.length)
        await this.store.fenced(
          "return redis.call('ZREM',KEYS[2],unpack(ARGV,2))",
          [pinsKey],
          snapshotOwners,
        );
      await this.store.put(snapshotCursorKey, snapshotPins[0]);
      // Select and prune atomically: an API request may renew a shared owner
      // while cleanup is running. Never erase a newly renewed request pin.
      await this.store.fenced(
        `local expired = redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[2],'LIMIT',0,200)
if #expired > 0 then return redis.call('ZREM',KEYS[2],unpack(expired)) end
return 0`,
        [pinsKey],
        [String(Date.now())],
      );
      if (generation.id === active.id) continue;
      if (await this.store.redis.get(`${CONTROL}deleting:${generation.id}`))
        continue;
      const pins = (await this.store.redis.sendCommand([
        "ZREVRANGE",
        pinsKey,
        "0",
        "0",
        "WITHSCORES",
      ])) as string[];
      const until = Number(pins[1] ?? 0);
      if (until <= Date.now()) continue;
      const key = `${CONTROL}retain:${generation.id}`;
      const progress = (await this.store.get<{
        kind: EmbeddingKind;
        cursor: string;
      }>(key)) ?? { kind: "event", cursor: "0" };
      const scan = (await this.store.redis.sendCommand([
        "SCAN",
        progress.cursor,
        "MATCH",
        `${embeddingKey(generation, progress.kind, "")}*`,
        "COUNT",
        "500",
      ])) as [string, string[]];
      const ttl = Math.ceil((until - Date.now()) / 1000) + 3600;
      for (let start = 0; start < scan[1].length; start += 500) {
        let keys = scan[1].slice(start, start + 500);
        // Pins protect eligible historical vectors, not closed seeds beyond their
        // existing 48-hour allowance. A missing old seed is skipped by consumers.
        if (this.policy && !this.policyError) {
          const prefix = embeddingKey(generation, progress.kind, "");
          const sources = await loadEmbeddingSources(
            this.options.db,
            progress.kind,
            keys.map((k) => k.slice(prefix.length)),
            this.venues,
          );
          for (const source of sources)
            if (!source.eligible)
              await this.store.commit(generation, source, "");
          const eligible = new Set(
            sources
              .filter((s) => s.eligible)
              .map((s) => embeddingKey(generation, progress.kind, s.id)),
          );
          keys = keys.filter((k) => eligible.has(k));
        }
        if (keys.length)
          await this.store.fenced(
            "for i=2,#KEYS do if redis.call('TTL',KEYS[i])<tonumber(ARGV[2]) then redis.call('EXPIRE',KEYS[i],ARGV[2]) end end return 1",
            keys,
            [String(ttl)],
          );
      }
      progress.cursor = scan[0];
      if (progress.cursor === "0")
        progress.kind = progress.kind === "event" ? "market" : "event";
      await this.store.put(key, progress);
    }
  }
  private async maintainServingMetadata(active: EmbeddingGeneration) {
    // No provider calls or memory admission here. A paused replacement, exhausted
    // budget or provider outage must not expire unchanged serving vectors.
    if (!this.policy) return;
    const key = `${CONTROL}maintenance:${active.id}`;
    const revision = `time-v3:${[...this.venues].sort().join(",")}`;
    let pass = await this.store.get<{
      kind: EmbeddingKind;
      after: string | null;
      nextAt: number;
      revision: string;
    }>(key);
    if (!pass || pass.revision !== revision)
      pass = { kind: "event", after: null, nextAt: 0, revision };
    if (pass.nextAt > Date.now()) return;
    const page = await readEmbeddingSourcePage(
      this.options.db,
      pass.kind,
      pass.after,
      this.venues,
      500,
    );
    if (page.ids.length)
      await this.process(active, pass.kind, page.ids, false, true);
    pass.after = page.after;
    if (!page.done) {
      // Keep traversing empty venues and orphan-event pages.
    } else if (pass.kind === "event") {
      pass.kind = "market";
      pass.after = null;
    } else {
      pass.kind = "event";
      pass.after = null;
      pass.nextAt = Date.now() + 6 * 3600000;
    }
    await this.store.put(key, pass);
  }
  private async background<T>(
    stage: string,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    if ((this.backgroundFailures.get(stage)?.retryAt ?? 0) > Date.now()) return;
    try {
      const result = await work();
      this.backgroundFailures.delete(stage);
      return result;
    } catch (error) {
      // Only PostgreSQL timeout/lock/capacity/transient-connection errors are
      // isolated. Lease loss and provider/budget/memory/verification errors keep
      // their existing fail-closed path; no failed page checkpoint is advanced.
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (
        !["57014", "55P03", "53300", "57P01", "40001", "40P01"].includes(
          code,
        ) &&
        !/^08\d{3}$/.test(code)
      )
        throw error;
      this.backgroundFailures.set(stage, { code, retryAt: Date.now() + 60000 });
      console.warn("[ai-worker] background SQL deferred", {
        stage,
        code,
        retryInMs: 60000,
      });
      return;
    }
  }
  private async maintain(active: EmbeddingGeneration) {
    await this.background("serving_metadata", () =>
      this.maintainServingMetadata(active),
    );
  }
  async tick() {
    await this.store.renew();
    await this.refreshPolicy();
    const active = await readActiveGeneration(this.store.redis);
    const desired = this.policy ? generationForPolicy(this.policy) : null;
    for (const id of this.memoryPauses.keys())
      if (id !== active.id && id !== desired?.id) this.memoryPauses.delete(id);
    try {
      if (Date.now() - this.lastMaintenance > 1000) {
        await this.store.prune();
        this.lastMaintenance = Date.now();
      }
      // Expired-pin cleanup precedes retirement admission: a concurrent renewal
      // must be observed before generations() can mark an old generation deleting.
      await this.background("pinned_metadata", () => this.retainPinned(active));
      if (this.policyError || !this.policy?.enabled || !desired) {
        await this.maintain(active);
        await this.report(
          active,
          desired,
          "paused",
          this.policyError ?? "disabled",
        );
        return;
      }
      // Maintain the serving generation even when admission of its replacement is paused.
      for (const kind of ["event", "market"] as const)
        await this.store.ensureIndex(active, kind);
      // Retirement is local Redis housekeeping, not provider work: a credit or
      // network outage must not indefinitely retain an unused old generation.
      const canBuild = await this.generations(active, desired);
      const circuit = await this.store.get<number>(`${CONTROL}circuit`);
      if (circuit && circuit > Date.now()) {
        await this.maintain(active);
        await this.report(active, desired, "paused", "provider_circuit_open");
        return;
      }
      let hadMessages = false;
      try {
        hadMessages = await this.processMessages(active, desired, canBuild);
      } finally {
        // Live work gets the first DB slot; housekeeping still runs on provider
        // failure, without turning one timeout into a tight retry loop.
        await this.maintain(active);
      }
      if (active.id !== desired.id) {
        try {
          await this.background(`advance:${active.id}`, () =>
            this.advance(active, active),
          );
        } catch (error) {
          // A serving-generation projection is not admission for its replacement.
          // The desired pass independently checks actual global limits as well.
          if (!(error instanceof EmbeddingMemoryError)) throw error;
        }
      }
      // Bounded live priority: allow one background page after every message batch.
      const pass = canBuild
        ? await this.background(`advance:${desired.id}`, () =>
            this.advance(active, desired),
          )
        : null;
      await this.report(
        await readActiveGeneration(this.store.redis),
        desired,
        canBuild
          ? pass?.phase === "ready"
            ? "verifying"
            : (pass?.phase ?? "building")
          : "paused",
        canBuild
          ? this.memoryPauses.has(active.id)
            ? `background_memory_paused:${active.id}:${this.memoryPauses.get(active.id)?.blockedBy}`
            : null
          : "previous_generation_retained",
      );
      if (!hadMessages) await sleep(200);
    } catch (error) {
      let reason =
        error instanceof Error ? error.message : "embedding_worker_error";
      if (error instanceof EmbeddingMemoryError)
        reason = `${reason}:${error.admission.generation}:${error.admission.blockedBy}`;
      if (error instanceof EmbeddingProviderError) {
        reason = `${error.code}${error.status ? `_${error.status}` : ""}`;
        await this.store.put(
          `${CONTROL}circuit`,
          Date.now() + Math.max(300000, error.retryAfterMs),
        );
      }
      if (/lease_lost/.test(reason)) throw error;
      await this.report(active, desired, "paused", reason.slice(0, 200));
      console.warn("[ai-worker] paused", { reason: reason.slice(0, 200) });
      await sleep(1000);
    }
  }
}

export async function initializeEmbeddingWorker(store: EmbeddingStore) {
  try {
    await store.fenced(
      "return redis.call('XGROUP','CREATE',KEYS[2],ARGV[2],'0','MKSTREAM')",
      [STREAM],
      [GROUP],
    );
  } catch (error) {
    if (!String(error).includes("BUSYGROUP")) throw error;
  }
  if (!(await store.get(`${CONTROL}active`)))
    await store.put(`${CONTROL}active`, LEGACY_EMBEDDING_GENERATION);
}
