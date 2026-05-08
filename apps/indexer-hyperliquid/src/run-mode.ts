import type { HyperliquidNetwork } from "./types.js";

export type HyperliquidRunMode = {
  fixtureDir?: string;
  topBookDryRun: boolean;
  dryRun: boolean;
  watch: boolean;
  once: boolean;
  network: HyperliquidNetwork;
  startWs: boolean;
};

function readFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function parseHyperliquidRunMode(argv: string[]): HyperliquidRunMode {
  const fixtureDir = readArg(argv, "--fixture-dir");
  const topBookDryRun = readFlag(argv, "--dry-run-top-books");
  const dryRun =
    readFlag(argv, "--dry-run") || topBookDryRun || fixtureDir != null;
  const watch = readFlag(argv, "--watch");
  const once =
    readFlag(argv, "--once") || fixtureDir != null || (dryRun && !watch);
  const network =
    readArg(argv, "--network") === "testnet" ? "testnet" : "mainnet";

  return {
    fixtureDir,
    topBookDryRun,
    dryRun,
    watch,
    once,
    network,
    startWs: !once,
  };
}
