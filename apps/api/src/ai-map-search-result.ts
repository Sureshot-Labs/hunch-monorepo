export type MapSearchCallResult = {
  statusCode?: number | null;
  budgetStop?: string | null;
};

export function getMapSearchFailureReason(input: {
  callsCompact?: MapSearchCallResult[];
}): string | null {
  const calls = input.callsCompact ?? [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const reason = calls[index]?.budgetStop?.trim();
    if (reason?.startsWith("hard_fail_")) return reason;
  }

  const terminalCall = calls.at(-1);
  if (
    terminalCall?.statusCode === 400 ||
    terminalCall?.statusCode === 401 ||
    terminalCall?.statusCode === 403
  ) {
    return `hard_fail_http_${terminalCall.statusCode}`;
  }
  return null;
}

export async function restoreMapSearchValues(input: {
  store: {
    del: (key: string) => Promise<unknown>;
    set: (
      key: string,
      value: string,
      options: { EX: number },
    ) => Promise<unknown>;
  };
  ttlSec: number;
  values: Array<{ key: string; value: string | null }>;
}): Promise<void> {
  for (const entry of input.values) {
    if (entry.value == null) {
      await input.store.del(entry.key);
    } else {
      await input.store.set(entry.key, entry.value, { EX: input.ttlSec });
    }
  }
}
