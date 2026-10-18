import type { Pool } from "@hunch/infra";
import {
  hip4Identity,
  hip4RawUnits,
  hip4SpotMetadataSchema,
} from "@hunch/shared";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import {
  hypercoreRecipientCashCapacity,
  hypercoreOrderCashCapacity,
  hypercoreSpotCashCapacity,
} from "../funding/domain/hypercore-cash-capacity.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreMainnetUsdc,
} from "../funding/domain/hypercore-identity.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  hip4AccountAbstractionSchema,
  hip4AccountRoleSchema,
  hip4SpotAccountStateSchema,
} from "./hip4-account-contract.js";
import { projectHip4Account } from "./hip4-account-projection.js";
import {
  createHip4AccountClient,
  createHip4ReadClient,
} from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import { projectHip4PerpsCash } from "./hip4-perps-cash.js";
import type { Hip4DefaultSpotCashEvidence } from "./hip4-spot-cash-mode.js";

/** One fresh native observation for funding sends AND order admission. This is
 * not the displayed Account Value, a reservation or permission to trade. Call
 * before a financial transaction: shared IP-budget writes must survive a later
 * admission rollback. No cached balance, history scan or account-mode mutation.
 * The caller verifies wallet ownership before using this internal reader. */
export async function readHip4FinancialObservation(
  pool: Pick<Pool, "query">,
  address: string,
  fetcher?: typeof fetch,
) {
  return readNativeCapacityObservation(pool, address, false, fetcher);
}

async function readNativeCashContext(
  pool: Pick<Pool, "query">,
  address: string,
  allowUninitializedRecipient: boolean,
  fetcher?: typeof fetch,
  allowQualifiedDefaultSpot = false,
) {
  address = hip4AccountAddressSchema.parse(address);
  const [read, account] = await Promise.all([
    readHip4Policy(pool, "accountRead"),
    readHip4AccountPolicy(pool),
  ]);
  if (
    !read.policy.enabled ||
    !account.policy.enabled ||
    read.policy.environment !== "mainnet"
  )
    throw new Error("native_account_read_unavailable");
  const admit = async (weight: number) =>
    admitHip4Request(
      pool,
      "mainnet",
      weight,
      read.policy.requestWeightPerMinute,
    );
  const accountRead = createHip4AccountClient(read.policy, admit, fetcher);
  const publicRead = createHip4ReadClient(read.policy, admit, fetcher);
  // Observation starts BEFORE IO, never at completion of a slow response.
  const observedAt = Date.now();
  const role = hip4AccountRoleSchema.parse(
    await accountRead({ type: "userRole", user: address }),
  );
  if (
    role.role !== "user" &&
    !(allowUninitializedRecipient && role.role === "missing")
  )
    throw new Error("native_account_role_unsupported");
  const mode = hip4AccountAbstractionSchema.parse(
    await accountRead({ type: "userAbstraction", user: address }),
  );
  if (
    mode !== "disabled" &&
    !(
      allowQualifiedDefaultSpot &&
      role.role === "user" &&
      mode === "default"
    ) &&
    !(
      allowUninitializedRecipient &&
      role.role === "missing" &&
      mode === "default"
    )
  )
    throw new Error("native_cash_mode_unsupported");
  let defaultSpotCashEvidence: Hip4DefaultSpotCashEvidence | undefined;
  if (allowQualifiedDefaultSpot && role.role === "user" && mode === "default") {
    defaultSpotCashEvidence = {
      legacyDexAbstraction: await accountRead({
        type: "userDexAbstraction",
        user: address,
      }),
      borrowLendState: await accountRead({
        type: "borrowLendUserState",
        user: address,
      }),
    };
  }
  const metadata = hip4SpotMetadataSchema.parse(
    await publicRead({ type: "spotMeta" }),
  );
  const quotes = metadata.tokens.filter(
    (row) => row.index === 0 || row.name === "USDC",
  );
  const quote = quotes[0];
  if (
    quotes.length !== 1 ||
    quote?.index !== 0 ||
    quote.name !== "USDC" ||
    !isHypercoreMainnetUsdc({
      networkId: "hyperliquid:mainnet",
      assetId: quote.tokenId,
      decimals: quote.weiDecimals,
    })
  )
    throw new Error("native_cash_identity_mismatch");
  return {
    accountRead,
    account,
    observedAt,
    role,
    mode,
    quote,
    read,
    defaultSpotCashEvidence,
  };
}

/** Same budget, owner role, Standard mode and exact USDC identity as spot;
 * only the physical cash class differs. No margin or account-mode mutation. */
export async function readHip4PerpsFinancialObservation(
  pool: Pick<Pool, "query">,
  address: string,
  fetcher?: typeof fetch,
) {
  address = hip4AccountAddressSchema.parse(address);
  const { accountRead, account, observedAt, role, mode } =
    await readNativeCashContext(pool, address, false, fetcher);
  const state = await accountRead({
    type: "clearinghouseState",
    user: address,
    dex: "",
  });
  if ((await accountRead({ type: "userAbstraction", user: address })) !== mode)
    throw new Error("native_cash_mode_changed");
  const cash = projectHip4PerpsCash({
    state,
    mode,
    role: role.role,
    observedAt: new Date(observedAt).toISOString(),
    now: Date.now(),
  });
  if (cash.state !== "verified" || cash.availableRaw === null)
    throw new Error(`native_perps_${cash.reason}`);
  const expiresAt = new Date(
    Date.parse(cash.observedAt) + account.policy.snapshotMaxAgeMs,
  ).toISOString();
  if (Date.parse(expiresAt) <= Date.now())
    throw new Error("native_perps_stale_snapshot");
  return {
    availableRaw: cash.availableRaw,
    observedAt: cash.observedAt,
    expiresAt,
  };
}

async function readNativeCapacityObservation(
  pool: Pick<Pool, "query">,
  address: string,
  allowUninitializedRecipient: boolean,
  fetcher?: typeof fetch,
  allowQualifiedDefaultSpot = false,
) {
  address = hip4AccountAddressSchema.parse(address);
  const {
    accountRead,
    account,
    observedAt,
    role,
    mode,
    quote,
    read,
    defaultSpotCashEvidence,
  } = await readNativeCashContext(
    pool,
    address,
    allowUninitializedRecipient,
    fetcher,
    allowQualifiedDefaultSpot,
  );
  const state = hip4SpotAccountStateSchema.parse(
    await accountRead({
      type: "spotClearinghouseState",
      user: address,
    }),
  );
  if ((await accountRead({ type: "userAbstraction", user: address })) !== mode)
    throw new Error("native_cash_mode_changed");
  if (
    defaultSpotCashEvidence &&
    (await accountRead({ type: "userDexAbstraction", user: address })) !==
      defaultSpotCashEvidence.legacyDexAbstraction
  )
    throw new Error("native_cash_mode_changed");
  const observation = projectHip4Account({
    environment: "mainnet",
    role: role.role,
    mode,
    state,
    observedAt: new Date(observedAt).toISOString(),
    quote: { tokenId: quote.tokenId, index: 0, weiDecimals: 8 },
    defaultSpotCashEvidence,
  });
  const cash = (
    allowUninitializedRecipient
      ? hypercoreRecipientCashCapacity
      : allowQualifiedDefaultSpot
        ? hypercoreOrderCashCapacity
        : hypercoreSpotCashCapacity
  )({
    observation,
    environment: "mainnet",
    snapshotMaxAgeMs: account.policy.snapshotMaxAgeMs,
    now: Date.now(),
  });
  if (!cash.known) throw new Error(`native_cash_${cash.reason}`);
  const nonOwnedOutcomeCoins = state.balances
    .filter(
      (row) =>
        row.coin.startsWith("+") &&
        (/[1-9]/u.test(row.borrowed ?? "0") ||
          /[1-9]/u.test(row.supplied ?? "0")),
    )
    .map((row) => row.coin);
  return {
    address,
    observation,
    cash,
    // Public position projections omit lending fields. Keep this restriction
    // at the financial boundary: borrowed/supplied shares are not owned stock.
    nonOwnedOutcomeCoins,
    observedAt: observation.observedAt,
    expiresAt: new Date(
      observedAt + account.policy.snapshotMaxAgeMs,
    ).toISOString(),
    revision: canonicalJsonHash({
      address,
      observation,
      nonOwnedOutcomeCoins,
      readRevision: read.revision,
      accountRevision: account.revision,
    }),
  };
}

/** Provider capacity BEFORE Hunch holds. Admission subtracts shared funding
 * reservations and durable order holds under the common physical-source lock.
 * BUY uses USDC; SELL uses the exact YES/NO side, never the opposite position,
 * entry notional, borrowed cash, or a portfolio valuation. */
export async function readHip4OrderCapacity(
  pool: Pick<Pool, "query">,
  input: {
    address: string;
    marketId: string;
    outcomeSide: "YES" | "NO";
    side: "BUY" | "SELL";
  },
  fetcher?: typeof fetch,
) {
  return readOrderCapacity(pool, input, false, fetcher);
}

/** Quote-only first-BUY preview. The strict preparation/submission/native-send
 * readers never opt into this receive-only exception. Zero is not permission. */
export async function readHip4OrderQuoteCapacity(
  pool: Pick<Pool, "query">,
  input: Parameters<typeof readHip4OrderCapacity>[1],
  fetcher?: typeof fetch,
) {
  return readOrderCapacity(pool, input, input.side === "BUY", fetcher);
}

async function readOrderCapacity(
  pool: Pick<Pool, "query">,
  input: Parameters<typeof readHip4OrderCapacity>[1],
  allowUninitializedRecipient: boolean,
  fetcher?: typeof fetch,
) {
  const match = /^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u.exec(
    input.marketId,
  );
  if (
    !match ||
    !["YES", "NO"].includes(input.outcomeSide) ||
    !["BUY", "SELL"].includes(input.side)
  )
    throw new Error("hip4_capacity_identity_invalid");
  const identity = hip4Identity("mainnet", Number(match[1]));
  const token = identity.sides[input.outcomeSide === "YES" ? 0 : 1];
  const read = await readNativeCapacityObservation(
    pool,
    input.address,
    allowUninitializedRecipient,
    fetcher,
    true,
  );
  if (
    input.side === "SELL" &&
    read.nonOwnedOutcomeCoins.includes(token.tokenName)
  )
    throw new Error("hip4_position_capacity_unverified");
  const position = read.observation.positions.find(
    (row) => row.tokenId === token.tokenId,
  );
  return {
    assetId:
      input.side === "BUY" ? HYPERCORE_MAINNET_USDC.assetId : token.tokenId,
    decimals: input.side === "BUY" ? 8 : 5,
    availableRaw:
      input.side === "BUY"
        ? read.cash.availableRaw
        : position
          ? (
              hip4RawUnits(position.quantity, 5) -
              hip4RawUnits(position.held, 5)
            ).toString()
          : "0",
    observedAt: read.observedAt,
    expiresAt: read.expiresAt,
    accountRevision: read.revision,
  };
}
