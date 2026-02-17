export type LockKey = string;

export class InMemoryLockManager {
  private readonly held = new Set<LockKey>();

  tryAcquire(lockKey: LockKey): boolean {
    if (this.held.has(lockKey)) return false;
    this.held.add(lockKey);
    return true;
  }

  release(lockKey: LockKey): void {
    this.held.delete(lockKey);
  }
}
