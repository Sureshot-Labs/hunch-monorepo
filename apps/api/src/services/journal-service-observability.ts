type RouteMetric = {
  requests: number;
  errors: number;
  samplesMs: number[];
};

const MAX_SAMPLES = 512;
const auth = new Map<string, number>();
const outcomes = new Map<string, number>();
const routes = new Map<string, RouteMetric>();

function increment(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + Math.max(0, amount));
}

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ??
    0
  );
}

export function recordJournalServiceAuth(result: "success" | string) {
  increment(auth, result);
}

export function recordJournalServiceOutcome(name: string, amount = 1) {
  increment(outcomes, name, amount);
}

export function recordJournalServiceRequest(
  route: string,
  scope: string,
  statusCode: number,
  durationMs: number,
) {
  const key = `${route}|${scope}`;
  const metric = routes.get(key) ?? { requests: 0, errors: 0, samplesMs: [] };
  metric.requests += 1;
  if (statusCode >= 400) metric.errors += 1;
  metric.samplesMs.push(Math.max(0, durationMs));
  if (metric.samplesMs.length > MAX_SAMPLES) {
    metric.samplesMs.splice(0, metric.samplesMs.length - MAX_SAMPLES);
  }
  routes.set(key, metric);
}

export function getJournalServiceProcessMetrics() {
  return {
    auth: Object.fromEntries([...auth.entries()].sort()),
    outcomes: Object.fromEntries([...outcomes.entries()].sort()),
    routes: [...routes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, metric]) => {
        const [route, scope] = key.split("|");
        return {
          route,
          scope,
          requests_total: metric.requests,
          errors_total: metric.errors,
          latency_ms_p50_recent: Math.round(percentile(metric.samplesMs, 0.5)),
          latency_ms_p95_recent: Math.round(percentile(metric.samplesMs, 0.95)),
          latency_ms_p99_recent: Math.round(percentile(metric.samplesMs, 0.99)),
        };
      }),
  };
}
