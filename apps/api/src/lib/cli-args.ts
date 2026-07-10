export type ReadCliValuesOptions = {
  splitCommas?: boolean;
};

export type ReadPositiveIntOptions = ReadCliValuesOptions & {
  invalid?: "fallback" | "throw";
};

export function readCliValues(
  argv: string[],
  name: string,
  options: ReadCliValuesOptions = {},
): string[] {
  const key = `--${name}`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${key}=`)) {
      const value = arg.slice(key.length + 1).trim();
      if (value.length) values.push(value);
      continue;
    }
    if (arg === key) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value.trim());
        index += 1;
      }
    }
  }

  if (options.splitCommas === false) return values.filter(Boolean);
  return values.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function hasCliFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function readPositiveInt(
  argv: string[],
  name: string,
  fallback: number,
  options: ReadPositiveIntOptions = {},
): number {
  const raw = readCliValues(argv, name, options)[0];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (options.invalid === "fallback") return fallback;
    throw new Error(`--${name} must be a positive integer`);
  }
  return Math.trunc(parsed);
}
