// apps/api/src/metrics.ts
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();

let lastRespMs = 0;

export function onReqStart() {
  return performance.now();
}
export function onReqEnd(start: number) {
  lastRespMs = performance.now() - start;
}

export function getMetrics() {
  const p95 = h.percentile(95) / 1e6; // ms
  const lagMs = Math.round(p95);
  return { last_response_ms: Math.round(lastRespMs), event_loop_p95_ms: lagMs };
}
