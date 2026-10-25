import type { DiscoverySection } from "../schemas/discovery.js";
import type {
  DiscoveryBuildProgress,
  DiscoveryQuickPool,
} from "./discovery-builder.js";
import type { DiscoverySnapshot } from "./discovery-domain.js";
import {
  renewHolderResearchRunLock,
  releaseHolderResearchRunLock,
} from "./holder-research-run-lock.js";

export interface DiscoveryRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { PX: number; NX?: boolean },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}
export const DISCOVERY_LEASE_MS = 60000;
export const DISCOVERY_CHECKPOINT_SCRIPT = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',3600000)
if ARGV[3] ~= '' then redis.call('SET',KEYS[3],ARGV[3],'PX',1800000) end
return 1`;
export const DISCOVERY_PUBLISH_SCRIPT = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'PX',900000)
redis.call('SET',KEYS[3],ARGV[2],'PX',900000)
redis.call('DEL',KEYS[4])
return 1`;

/** All Redis mutations are confined to derived discovery state. Never touches trading/feed cursors. */
export class DiscoveryStore {
  constructor(
    readonly redis: DiscoveryRedis,
    readonly prefix = "discovery:v1",
  ) {}
  key(suffix: string) {
    return `${this.prefix}:${suffix}`;
  }
  async read<T>(suffix: string): Promise<T | null> {
    const value = await this.redis.get(this.key(suffix));
    return value === null ? null : (JSON.parse(value) as T);
  }
  current(section: DiscoverySection) {
    return this.read<DiscoverySnapshot>(`current:${section}`);
  }
  snapshot(id: string) {
    return this.read<DiscoverySnapshot>(`snapshot:${id}`);
  }
  progress(section: DiscoverySection) {
    return this.read<DiscoveryBuildProgress>(`progress:${section}`);
  }
  quickPool() {
    return this.read<DiscoveryQuickPool>("quick-pool");
  }
  async acquire(section: DiscoverySection, owner: string) {
    return (
      (await this.redis.set(this.key(`lock:${section}`), owner, {
        PX: DISCOVERY_LEASE_MS,
        NX: true,
      })) === "OK"
    );
  }
  renew(section: DiscoverySection, owner: string) {
    return renewHolderResearchRunLock({
      redis: this.redis,
      key: this.key(`lock:${section}`),
      owner,
      ttlMs: DISCOVERY_LEASE_MS,
    });
  }
  release(section: DiscoverySection, owner: string) {
    return releaseHolderResearchRunLock({
      redis: this.redis,
      key: this.key(`lock:${section}`),
      owner,
    });
  }
  async checkpoint(
    section: DiscoverySection,
    owner: string,
    progress: DiscoveryBuildProgress,
    pool?: DiscoveryQuickPool,
  ) {
    const ok = await this.redis.eval(DISCOVERY_CHECKPOINT_SCRIPT, {
      keys: [
        this.key(`lock:${section}`),
        this.key(`progress:${section}`),
        this.key("quick-pool"),
      ],
      arguments: [
        owner,
        JSON.stringify(progress),
        pool ? JSON.stringify(pool) : "",
      ],
    });
    if (Number(ok) !== 1) throw Error("discovery_lease_lost");
  }
  async publish(
    section: DiscoverySection,
    owner: string,
    snapshot: DiscoverySnapshot,
  ) {
    const ok = await this.redis.eval(DISCOVERY_PUBLISH_SCRIPT, {
      keys: [
        this.key(`lock:${section}`),
        this.key(`snapshot:${snapshot.id}`),
        this.key(`current:${section}`),
        this.key(`progress:${section}`),
      ],
      arguments: [owner, JSON.stringify(snapshot)],
    });
    if (Number(ok) !== 1) throw Error("discovery_lease_lost");
  }
}
