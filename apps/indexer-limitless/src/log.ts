import { inspect } from "node:util";

function formatArgs(args: unknown[]): string[] {
  return args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
      return value.stack ?? value.message ?? String(value);
    }
    try {
      return inspect(value, {
        depth: 6,
        maxArrayLength: 50,
        breakLength: 120,
      });
    } catch {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
  });
}

export const log = {
  info: (...args: unknown[]) => console.log("[INFO]", ...formatArgs(args)),
  warn: (...args: unknown[]) => console.warn("[WARN]", ...formatArgs(args)),
  err: (...args: unknown[]) => console.error("[ERROR]", ...formatArgs(args)),
};
