import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

/** Exclude known infrastructure, never all smart contracts (Safes are traders).
 * Extra entries must be configured protocol contracts, not user/funder wallets.
 */
export function walletIntelProtocolAddresses(
  extra: readonly (string | null | undefined)[] = [],
): string[] {
  return [
    ...new Set(
      [
        "0x0000000000000000000000000000000000000000",
        ...Object.values(POLYMARKET_PROTOCOL_CONTRACTS),
        "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296", // legacy NegRisk adapter
        // NegRiskAdapter.NO_TOKEN_BURN_ADDRESS = bytes20(keccak256("NO_TOKEN_BURN_ADDRESS")); not a trader.
        "0xa5ef39c3d3e10d0b270233af41cac69796b12966",
        ...extra,
      ]
        .filter(
          (value): value is string =>
            typeof value === "string" && /^0x[a-f0-9]{40}$/i.test(value),
        )
        .map((value) => value.toLowerCase()),
    ),
  ];
}
