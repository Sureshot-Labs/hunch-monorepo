import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import {
  AuthService,
  type UserWallet,
  type VenueCredentials,
} from "../../auth.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  findTradeMarketByRef,
  findTradeMarketByRefForVenue,
  isOrderable,
  type ApiTradeMarket,
} from "../../services/api-trading-market-repo.js";
import {
  extractLimitlessPartnerAccountProfile,
  resolveLimitlessAuthContext,
} from "../../services/limitless-auth.js";
import { isLimitlessPartnerHmacConfigured } from "../../services/limitless-client.js";
import { fetchLimitlessOnchainSnapshot } from "../../services/limitless-onchain.js";
import { fetchOpenOrderCollateralLocks } from "../../services/open-order-collateral.js";
import {
  polymarketL2Request,
  type PolymarketL2Credentials,
} from "../../services/polymarket-clob-l2.js";
import {
  inspectPolymarketDepositWallet,
  type PolymarketDepositWalletDerivation,
} from "../../services/polymarket-deposit-wallet-derivation.js";
import {
  derivePolymarketFunders,
  type PolymarketFunderCandidate,
} from "../../services/polymarket-funder.js";
import {
  fetchPolymarketAccountRoute,
  fetchPolymarketMaxSpendLiveOpenOrderLocks,
  resolvePolymarketFunderExecutionKindForMaxSpend,
  resolvePolymarketMaxSpendFunds,
  type PolymarketMaxSpendOnchainSnapshot,
} from "../../services/polymarket-trading-execution-service.js";
import {
  polymarketFundingEvidence,
  type PolymarketRouterFundingSnapshot,
} from "./polymarket-funding-snapshot.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  DestinationOptionsInput,
  PreparationInspectionInput,
  PreparationResult,
  WalletPreparationAdapter,
} from "../domain/contracts.js";
import type {
  AssetRef,
  FundingDestinationOption,
  FundingTarget,
  Money,
  NormalizedAction,
  PreparationExecutionMode,
  VenueAccountBinding,
  VenueBindingOption,
  VenueId,
} from "../domain/types.js";
import {
  canonicalAccountAddress,
  canonicalAssetId,
  canonicalAssetKey,
} from "../domain/asset-identity.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import type {
  FrozenPreparationDestination,
  ResolvedDestinationCandidate,
} from "../planner/destination-adapters.js";
import {
  CombinedFundingDestinationResolver,
  FrozenPreparationDestinationAdapter,
} from "../planner/destination-adapters.js";
import { LimitlessWalletPreparationAdapter } from "./limitless-adapter.js";
import { PolymarketWalletPreparationAdapter } from "./polymarket-adapter.js";
import { PreparationContractError } from "./core-adapter.js";
import type { PolymarketFundingObservation } from "./polymarket-funding-followup.js";
import {
  buildLimitlessRuntimeFacts,
  buildPolymarketRuntimeFacts,
  storedCredentialEvidence,
  type LimitlessRuntimeEvidence,
  type PolymarketRuntimeEvidence,
  type RuntimeCredentialEvidence,
  type RuntimeMarketEvidence,
  type RuntimePositionEvidence,
  type RuntimeWalletAuthority,
} from "./runtime-facts.js";
import {
  createLimitlessRuntimeActionMaterializer,
  createPolymarketRuntimeActionMaterializer,
} from "./runtime-actions.js";
import {
  collectDestinationInspectionCoverage,
  isDestinationDriverApplicable,
} from "./destination-inspection-coverage.js";

const PREPARATION_TTL_MS = 45_000;
const DESTINATION_INSPECTION_REUSE_MS = 30_000;
const DESTINATION_INSPECTION_TIMEOUT_MS = 20_000;
const MAX_APPROVAL = (1n << 255n).toString();

type RuntimeVenue = "limitless" | "polymarket";
type UserWalletLoader = (accountId: string) => Promise<readonly UserWallet[]>;

type RuntimeMarketContext = Readonly<{
  market: ApiTradeMarket | null;
  marketClass: string | null;
  evidence: RuntimeMarketEvidence;
  adapterAddress: string | null;
  ammAddress: string | null;
}>;

export type PreparedRuntimeDestination = Readonly<{
  adapter: WalletPreparationAdapter;
  frozen: FrozenPreparationDestination;
  inspectionInput: PreparationInspectionInput;
  observedRaw: string;
  reservedRaw: string;
  wallet: UserWallet;
}>;

export type RuntimeVenueInspectionInput = Readonly<{
  accountId: string;
  wallet: UserWallet;
  purpose: DestinationOptionsInput["purpose"];
  marketContextId: string | null;
  marketClass: string | null;
  positionActionRef: string | null;
  resolvedMarketContext?: RuntimeMarketContext;
}>;

export interface WalletPreparationRuntimeDriver {
  readonly venueId: VenueId;
  readonly supportedMarketClasses: readonly string[];
  supportsWallet(wallet: UserWallet): boolean;
  inspect(
    input: RuntimeVenueInspectionInput,
  ): Promise<PreparedRuntimeDestination>;
  ownerCandidates(
    input: Readonly<{
      accountId: string;
      wallets: readonly UserWallet[];
      ownerAddress: string;
    }>,
  ): Promise<
    Readonly<{
      candidateWallets: readonly UserWallet[];
      ownershipHinted: boolean;
    }>
  >;
  matchesAccountRef(accountRef: string, ownerAddress: string): boolean;
}

function normalizeAddress(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return value.trim();
  }
}

function sameAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return Boolean(
    normalizeAddress(left) &&
    normalizeAddress(left) === normalizeAddress(right),
  );
}

async function withinDestinationInspectionDeadline<T>(
  promise: Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new PreparationContractError(
            "preparation_unavailable",
            "venue destination inspection exceeded its interactive deadline",
          ),
        ),
      DESTINATION_INSPECTION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadRuntimePositionEvidence(input: {
  db: Pool;
  accountId: string;
  venueId: VenueId;
  positionActionRef: string | null;
  binding: VenueAccountBinding;
}): Promise<RuntimePositionEvidence | null> {
  if (!input.positionActionRef) return null;
  const { rows } = await input.db.query<{
    size_raw: string;
    venue: string;
    wallet_address: string | null;
  }>(
    `
      select size::text as size_raw, venue, wallet_address
      from positions
      where user_id = $1
        and id = $2
        and position_scope = 'own'
        and coalesce(is_hidden, false) = false
      limit 1
    `,
    [input.accountId, input.positionActionRef],
  );
  const position = rows[0];
  if (
    !position ||
    position.venue !== input.venueId ||
    !position.wallet_address
  ) {
    return null;
  }
  let balanceRaw: string | null = null;
  try {
    balanceRaw = ethers.parseUnits(position.size_raw, 6).toString();
  } catch {
    balanceRaw = null;
  }
  return {
    ownerMatchesBinding: sameAddress(
      position.wallet_address,
      input.binding.accountRef,
    ),
    balanceRaw,
    lockedRaw: "0",
    conditionResolved: null,
    canonicalPlanAvailable: false,
    operatorApproved: null,
  };
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return cursor;
}

function readString(value: unknown, path: readonly string[]): string | null {
  const raw = readPath(value, path);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function readBoolean(value: unknown, path: readonly string[]): boolean | null {
  const raw = readPath(value, path);
  return typeof raw === "boolean" ? raw : null;
}

function rawAt(value: unknown, path: readonly string[]): string | null {
  const raw = readString(value, path);
  return raw && /^(0|[1-9][0-9]*)$/.test(raw) ? raw : null;
}

function allowanceEnough(value: string | null): boolean {
  return Boolean(
    value && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) > 0n,
  );
}

function walletAuthority(wallet: UserWallet): RuntimeWalletAuthority {
  const name = wallet.name?.trim();
  const displayLabel = wallet.isInternalWallet
    ? "Hunch Trading Wallet"
    : name || `Connected wallet ${wallet.walletAddress.slice(0, 8)}…`;
  return {
    source: wallet.walletSource,
    internal: wallet.isInternalWallet,
    privyWalletId: wallet.privyWalletId,
    profileObservedAt: wallet.privyProfileUpdatedAt?.toISOString() ?? null,
    displayLabel,
  };
}

function walletId(wallet: UserWallet, networkId: string): string {
  return stableOpaqueId(
    "wallet",
    `${wallet.walletType}:${networkId}:${canonicalAccountAddress(
      networkId,
      wallet.walletAddress,
    )}`,
  );
}

function assetFor(venue: RuntimeVenue): AssetRef {
  return venue === "polymarket"
    ? {
        networkId: "evm:137",
        assetId: fundingSidecarRuntimeConfig.polymarketUsdcAddress,
        decimals: 6,
      }
    : {
        networkId: "evm:8453",
        assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
        decimals: 6,
      };
}

function bindingFor(input: {
  accountId: string;
  venue: RuntimeVenue;
  wallet: UserWallet;
  accountRef: string;
}): VenueAccountBinding {
  const asset = assetFor(input.venue);
  const executionWalletId = walletId(input.wallet, asset.networkId);
  const bindingId = stableOpaqueId(
    "binding",
    `${input.accountId}:${input.venue}:${canonicalAccountAddress(
      asset.networkId,
      input.accountRef,
    )}`,
  );
  return {
    bindingId,
    venueId: input.venue,
    controllerWalletId: executionWalletId,
    executionWalletId,
    accountRef: input.accountRef,
    settlementLocation: {
      kind: "venue_account",
      locationId: stableOpaqueId(
        "location",
        `${bindingId}:${canonicalAssetKey(asset)}`,
      ),
      accountId: input.accountId,
      asset,
      details: {
        venueId: input.venue,
        accountRef: input.accountRef,
        controllerWalletId: executionWalletId,
        address: input.accountRef,
      },
    },
    signingMode: input.wallet.isInternalWallet
      ? "privy_authorization"
      : "web_client",
  };
}

function metadataBoolean(
  metadata: unknown,
  ...keys: readonly string[]
): boolean | null {
  if (!isRecord(metadata)) return null;
  for (const key of keys) {
    if (typeof metadata[key] === "boolean") return metadata[key];
  }
  return null;
}

function metadataString(
  metadata: unknown,
  ...keys: readonly string[]
): string | null {
  if (!isRecord(metadata)) return null;
  for (const key of keys) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) {
      return metadata[key].trim();
    }
  }
  return null;
}

function isLimitlessAmm(metadata: unknown): boolean {
  if (
    metadataBoolean(
      metadata,
      "isAmm",
      "is_amm",
      "amm",
      "ammOnly",
      "amm_only",
    ) === true
  ) {
    return true;
  }
  return (
    metadataString(
      metadata,
      "executionMode",
      "execution_mode",
      "tradingMode",
      "trading_mode",
      "marketType",
      "market_type",
    )?.toLowerCase() === "amm"
  );
}

function isNegRisk(market: ApiTradeMarket): boolean {
  return (
    market.neg_risk === true ||
    metadataBoolean(market.metadata, "negRisk", "neg_risk") === true
  );
}

function classForMarket(venue: RuntimeVenue, market: ApiTradeMarket): string {
  if (venue === "polymarket") {
    return isNegRisk(market) ? "neg_risk" : "standard";
  }
  const prefix = isLimitlessAmm(market.metadata) ? "amm" : "clob";
  return isNegRisk(market) ? `${prefix}_neg_risk` : prefix;
}

function unavailableRuntimeMarketContext(
  marketContextId: string,
  requestedMarketClass: string | null,
): RuntimeMarketContext {
  return {
    market: null,
    marketClass: requestedMarketClass,
    adapterAddress: null,
    ammAddress: null,
    evidence: {
      resolved: false,
      orderable: false,
      adapterResolved: false,
      exchangeResolved: false,
      quoteGuardAvailable: false,
      safeMarketRef: marketContextId,
    },
  };
}

function runtimeMarketContextFromMarket(input: {
  venue: RuntimeVenue;
  market: ApiTradeMarket;
  requestedMarketClass: string | null;
}): RuntimeMarketContext {
  const marketClass = classForMarket(input.venue, input.market);
  const classMatches =
    input.requestedMarketClass == null ||
    input.requestedMarketClass === marketClass;
  const ammAddress =
    input.venue === "limitless" && marketClass.startsWith("amm")
      ? metadataString(
          input.market.metadata,
          "address",
          "marketAddress",
          "market_address",
          "ammAddress",
          "amm_address",
        )
      : null;
  const adapterAddress =
    input.venue === "limitless"
      ? metadataString(
          input.market.metadata,
          "adapter",
          "adapterAddress",
          "adapter_address",
          "negRiskAdapter",
          "neg_risk_adapter",
        )
      : isNegRisk(input.market)
        ? fundingSidecarRuntimeConfig.polymarketNegRiskAdapterAddress || null
        : fundingSidecarRuntimeConfig.polymarketConditionalTokensAddress;
  const routeResolved =
    input.venue === "polymarket"
      ? Boolean(input.market.token_yes && input.market.token_no)
      : marketClass.startsWith("amm")
        ? Boolean(ammAddress && input.market.token_yes && input.market.token_no)
        : Boolean(
            input.market.slug &&
            input.market.token_yes &&
            input.market.token_no,
          );
  const exchangeResolved =
    input.venue === "polymarket"
      ? Boolean(
          isNegRisk(input.market)
            ? fundingSidecarRuntimeConfig.polymarketNegRiskExchangeAddress
            : fundingSidecarRuntimeConfig.polymarketExchangeAddress,
        )
      : marketClass.startsWith("amm")
        ? Boolean(ammAddress)
        : Boolean(
            isNegRisk(input.market)
              ? fundingSidecarRuntimeConfig.limitlessNegRiskAddress
              : fundingSidecarRuntimeConfig.limitlessClobAddress,
          );
  return {
    market: input.market,
    marketClass,
    adapterAddress,
    ammAddress,
    evidence: {
      resolved: classMatches && routeResolved,
      orderable: classMatches && isOrderable(input.market),
      adapterResolved:
        classMatches &&
        (marketClass.includes("neg_risk")
          ? Boolean(adapterAddress)
          : routeResolved),
      exchangeResolved: classMatches && exchangeResolved,
      quoteGuardAvailable: classMatches && routeResolved && exchangeResolved,
      safeMarketRef: input.market.id,
    },
  };
}

async function loadRuntimeMarketContext(input: {
  db: Pool;
  venue: RuntimeVenue;
  marketContextId: string | null;
  requestedMarketClass: string | null;
}): Promise<RuntimeMarketContext> {
  if (!input.marketContextId) {
    return {
      market: null,
      marketClass: input.requestedMarketClass,
      adapterAddress: null,
      ammAddress: null,
      evidence: {
        resolved: true,
        orderable: true,
        adapterResolved: true,
        exchangeResolved: true,
        quoteGuardAvailable: true,
        safeMarketRef: null,
      },
    };
  }
  let market: ApiTradeMarket | null = null;
  try {
    market = await findTradeMarketByRefForVenue(
      input.db,
      input.marketContextId,
      input.venue,
    );
  } catch {
    return unavailableRuntimeMarketContext(
      input.marketContextId,
      input.requestedMarketClass,
    );
  }
  if (!market) {
    return unavailableRuntimeMarketContext(
      input.marketContextId,
      input.requestedMarketClass,
    );
  }
  return runtimeMarketContextFromMarket({
    venue: input.venue,
    market,
    requestedMarketClass: input.requestedMarketClass,
  });
}

function matchingFunderCandidate(
  candidates: readonly PolymarketFunderCandidate[],
  funder: string,
): PolymarketFunderCandidate | null {
  return (
    candidates.find((candidate) => sameAddress(candidate.funder, funder)) ??
    null
  );
}

function polymarketTopology(input: {
  signer: string;
  funder: string;
  candidate: PolymarketFunderCandidate | null;
  deposit: PolymarketDepositWalletDerivation | null;
}): {
  topology: PolymarketRuntimeEvidence["topology"];
  deployed: boolean;
  ownerVerified: boolean;
  executionMode: PreparationExecutionMode;
} {
  if (sameAddress(input.signer, input.funder)) {
    return {
      topology: "signer",
      deployed: true,
      ownerVerified: true,
      executionMode: "web_client",
    };
  }
  if (input.deposit && sameAddress(input.deposit.address, input.funder)) {
    return {
      topology: "deposit_wallet",
      deployed: input.deposit.deployed,
      ownerVerified: true,
      executionMode: "venue_relayer",
    };
  }
  const candidate = input.candidate;
  if (!candidate) {
    return {
      topology: "unknown_contract",
      deployed: false,
      ownerVerified: false,
      executionMode: "web_client",
    };
  }
  if (candidate.signatureType === 1) {
    return {
      topology: "magic_proxy",
      deployed: candidate.deployed,
      ownerVerified: true,
      executionMode: "web_client",
    };
  }
  if (candidate.signatureType === 2) {
    const signerOwned =
      candidate.safeOwners?.some((owner) => sameAddress(owner, input.signer)) ??
      false;
    const oneOfOne =
      candidate.safeThreshold === 1 &&
      candidate.safeOwners?.length === 1 &&
      signerOwned;
    return {
      topology: oneOfOne ? "safe_1_1" : "safe_unsupported",
      deployed: candidate.deployed,
      ownerVerified: signerOwned,
      executionMode: "web_client",
    };
  }
  if (candidate.signatureType === 3) {
    return {
      topology: "deposit_wallet",
      deployed: candidate.deployed,
      ownerVerified: true,
      executionMode: "venue_relayer",
    };
  }
  return {
    topology: "unknown_contract",
    deployed: candidate.deployed,
    ownerVerified: false,
    executionMode: "web_client",
  };
}

async function inspectPolymarketClob(input: {
  credentials?: VenueCredentials | null;
  userId: string;
  walletAddress: string;
  signatureType: number;
}): Promise<{
  credentials: RuntimeCredentialEvidence;
  l2Credentials: PolymarketL2Credentials | null;
  collateralVisible: boolean;
  safeBalanceRaw: string | null;
}> {
  const credentials =
    input.credentials === undefined
      ? await AuthService.getVenueCredentials(
          input.userId,
          "polymarket",
          input.walletAddress,
        )
      : input.credentials;
  const bound = credentials
    ? sameAddress(credentials.walletAddress, input.walletAddress)
    : false;
  if (
    !credentials?.apiKey ||
    !credentials.apiSecret ||
    !credentials.apiPassphrase
  ) {
    return {
      credentials: {
        present: false,
        boundToExactWallet: bound,
        verified: false,
        observedAt: null,
        stale: false,
      },
      l2Credentials: null,
      collateralVisible: false,
      safeBalanceRaw: null,
    };
  }
  const l2Credentials = {
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    apiPassphrase: credentials.apiPassphrase,
  };
  const params = new URLSearchParams({
    asset_type: "COLLATERAL",
    signature_type: String(input.signatureType),
  });
  try {
    const response = await polymarketL2Request({
      baseUrl: fundingSidecarRuntimeConfig.polymarketClobBase,
      timeoutMs: 10_000,
      address: input.walletAddress,
      creds: l2Credentials,
      method: "GET",
      requestPath: `/balance-allowance?${params.toString()}`,
    });
    const safeBalanceRaw = response.ok
      ? rawAt(response.payload, ["balance"])
      : null;
    return {
      credentials: {
        present: true,
        boundToExactWallet: bound,
        verified: response.ok,
        observedAt: new Date().toISOString(),
        stale: !response.ok && response.status === 401,
      },
      l2Credentials: response.ok && bound ? l2Credentials : null,
      collateralVisible: response.ok && safeBalanceRaw != null,
      safeBalanceRaw,
    };
  } catch {
    return {
      credentials: {
        present: true,
        boundToExactWallet: bound,
        verified: false,
        observedAt: new Date().toISOString(),
        stale: false,
      },
      l2Credentials: null,
      collateralVisible: false,
      safeBalanceRaw: null,
    };
  }
}

function nonNegativeBigIntAt(
  payload: unknown,
  path: readonly string[],
): bigint | null {
  const raw = rawAt(payload, path);
  if (raw == null || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  return BigInt(raw);
}

function polymarketMaxSpendSnapshotFromAccount(
  payload: unknown,
): PolymarketMaxSpendOnchainSnapshot | null {
  const pusdBalance = nonNegativeBigIntAt(payload, ["pusd", "balanceRaw"]);
  const usdceBalance = nonNegativeBigIntAt(payload, ["usdce", "balanceRaw"]);
  const signerPusdBalance = nonNegativeBigIntAt(payload, [
    "signerPusd",
    "balanceRaw",
  ]);
  const signerUsdceBalance = nonNegativeBigIntAt(payload, [
    "signerUsdce",
    "balanceRaw",
  ]);
  const allowanceExchange = nonNegativeBigIntAt(payload, [
    "pusd",
    "allowance",
    "exchange",
    "allowanceRaw",
  ]);
  const allowanceNegRisk = nonNegativeBigIntAt(payload, [
    "pusd",
    "allowance",
    "negRiskExchange",
    "allowanceRaw",
  ]);
  if (
    pusdBalance == null ||
    usdceBalance == null ||
    signerPusdBalance == null ||
    signerUsdceBalance == null ||
    allowanceExchange == null ||
    allowanceNegRisk == null
  ) {
    return null;
  }

  return {
    pusdBalance,
    usdceBalance,
    signerPusdBalance,
    signerUsdceBalance,
    allowanceExchange,
    allowanceNegRisk,
    allowanceNegRiskAdapter: nonNegativeBigIntAt(payload, [
      "pusd",
      "allowance",
      "negRiskAdapter",
      "allowanceRaw",
    ]),
    fundingRouterNonce: nonNegativeBigIntAt(payload, [
      "fundingRouter",
      "nonce",
    ]),
    fundingRouterDepositUsdceAllowance: nonNegativeBigIntAt(payload, [
      "fundingRouter",
      "depositUsdceAllowanceRaw",
    ]),
    fundingRouterPusdAllowance: nonNegativeBigIntAt(payload, [
      "fundingRouter",
      "pUsdAllowanceRaw",
    ]),
    fundingRouterUsdceAllowance: nonNegativeBigIntAt(payload, [
      "fundingRouter",
      "usdceAllowanceRaw",
    ]),
  };
}

async function reservedRawForLocation(input: {
  db: Pool;
  userId: string;
  locationId: string;
  asset: AssetRef;
}): Promise<string> {
  const { rows } = await input.db.query<{ reserved_raw: string | null }>(
    `
      select coalesce(sum(raw_amount::numeric), 0)::text as reserved_raw
      from balance_reservations
      where user_id = $1
        and location_id = $2
        and network_id = $3
        and asset_id = $4
        and asset_decimals = $5
        and state = 'active'
        and expires_at > now()
    `,
    [
      input.userId,
      input.locationId,
      input.asset.networkId,
      canonicalAssetId(input.asset),
      input.asset.decimals,
    ],
  );
  const value = rows[0]?.reserved_raw ?? "0";
  return /^(0|[1-9][0-9]*)$/.test(value) ? value : "0";
}

function availableRaw(
  observedRaw: string,
  lockedRaw: string,
  reservedRaw: string,
): string {
  const observed = BigInt(observedRaw);
  const locked = BigInt(lockedRaw);
  const reserved = BigInt(reservedRaw);
  const unavailable = locked + reserved;
  return (observed > unavailable ? observed - unavailable : 0n).toString();
}

function bindingOption(preparation: PreparationResult): VenueBindingOption {
  return {
    venueBindingOptionId: stableOpaqueId(
      "binding_option",
      [
        preparation.binding.bindingId,
        preparation.purpose,
        preparation.marketClass ?? "none",
        preparation.topology,
      ].join("|"),
    ),
    safeLabel: preparation.safeLabel,
    readinessClass: preparation.readinessClass,
    preparationPurpose: preparation.purpose,
    marketClass: preparation.marketClass,
    topology: preparation.topology,
    inspectionRevision: preparation.inspectionRevision,
    selectable:
      preparation.status !== "unavailable" &&
      preparation.readinessClass !== "external_source_only" &&
      preparation.readinessClass !== "external_view_only",
    reasonCodes: preparation.reasonCodes,
  };
}

function frozenDestination(input: {
  preparation: PreparationResult;
  observedRaw: string;
  lockedRaw: string;
  reservedRaw: string;
  destinationLocationPatternId: string;
  networkLabel: string;
  sourcePlanningEvidence: FrozenPreparationDestination["sourcePlanningEvidence"];
  now: Date;
}): FrozenPreparationDestination {
  const binding = input.preparation.binding;
  const asset = binding.settlementLocation.asset;
  const available = availableRaw(
    input.observedRaw,
    input.lockedRaw,
    input.reservedRaw,
  );
  const expiresAt = input.preparation.expiresAt;
  const target: FundingTarget = {
    kind: "owned_location",
    location: binding.settlementLocation,
  };
  const spendability = {
    observedAmount: { asset, raw: input.observedRaw },
    lockedRaw: input.lockedRaw,
    reservedRaw: input.reservedRaw,
    submittedDebitRaw: "0",
    availableAmount: { asset, raw: available },
    revision: `spendability_${canonicalJsonHash({
      bindingId: binding.bindingId,
      observedRaw: input.observedRaw,
      lockedRaw: input.lockedRaw,
      reservedRaw: input.reservedRaw,
      expiresAt,
    }).slice(0, 32)}`,
    asOf: input.now.toISOString(),
    expiresAt,
  };
  return {
    venueId: binding.venueId,
    destinationLocationPatternId: input.destinationLocationPatternId,
    collateralValuation: {
      unitPriceUsd: "1",
      pricePolicyId: "exact-stable-usd-v1",
      asOf: input.now.toISOString(),
      expiresAt,
    },
    spendability,
    bindingOption: bindingOption(input.preparation),
    preparation: input.preparation,
    target,
    requiredAsset: asset,
    networkLabel: input.networkLabel,
    sourcePlanningEvidence: input.sourcePlanningEvidence,
  };
}

export async function observePolymarketFundingRuntime(
  input: Readonly<{
    userId: string;
    signerAddress: string;
    depositWallet: string;
  }>,
): Promise<PolymarketFundingObservation | null> {
  const [account, clob] = await Promise.all([
    fetchPolymarketAccountRoute({
      userId: input.userId,
      signer: input.signerAddress,
      query: {
        funderAddress: input.depositWallet,
        refresh: true,
      },
    }),
    inspectPolymarketClob({
      userId: input.userId,
      walletAddress: input.signerAddress,
      signatureType: 3,
    }),
  ]);
  if (!account.ok) return null;
  return {
    routerNonceRaw: rawAt(account.payload, ["fundingRouter", "nonce"]),
    depositPusdRaw: rawAt(account.payload, ["pusd", "balanceRaw"]),
    clobPusdRaw: clob.safeBalanceRaw,
    observedAt: new Date().toISOString(),
  };
}

export class WalletPreparationRuntimeService {
  private readonly venueDrivers: readonly WalletPreparationRuntimeDriver[];
  private readonly loadWallets: UserWalletLoader;
  private readonly destinationInspectionInflight = new Map<
    string,
    Promise<PreparedRuntimeDestination>
  >();
  private readonly destinationInspectionCache = new Map<
    string,
    Readonly<{
      value: PreparedRuntimeDestination;
      reusableUntil: number;
    }>
  >();

  constructor(
    private readonly db: Pool,
    private readonly clock: () => Date = () => new Date(),
    venueDrivers?: readonly WalletPreparationRuntimeDriver[],
    loadWallets: UserWalletLoader = (accountId) =>
      AuthService.getUserWallets(accountId),
  ) {
    this.venueDrivers = venueDrivers ?? this.defaultVenueDrivers();
    this.loadWallets = loadWallets;
    const venueIds = new Set(this.venueDrivers.map((driver) => driver.venueId));
    if (
      this.venueDrivers.length === 0 ||
      venueIds.size !== this.venueDrivers.length
    ) {
      throw new Error(
        "wallet preparation runtime drivers must have unique venue IDs",
      );
    }
  }

  private defaultVenueDrivers(): readonly WalletPreparationRuntimeDriver[] {
    const isSupportedEvmWallet = (wallet: UserWallet) =>
      wallet.walletType === "ethereum" && wallet.isVerified;
    return [
      {
        venueId: "polymarket",
        supportedMarketClasses: ["standard", "neg_risk"],
        supportsWallet: isSupportedEvmWallet,
        inspect: (input) => this.inspectPolymarket(input),
        ownerCandidates: async ({ accountId, wallets, ownerAddress }) => {
          const supported = wallets.filter(isSupportedEvmWallet);
          const hints = await Promise.all(
            supported.map(async (wallet) => {
              const credentials = await AuthService.getVenueCredentialsInfo(
                accountId,
                "polymarket",
                wallet.walletAddress,
              );
              return (
                sameAddress(wallet.walletAddress, ownerAddress) ||
                sameAddress(credentials?.funderAddress, ownerAddress)
              );
            }),
          );
          return {
            candidateWallets: supported,
            ownershipHinted: hints.some(Boolean),
          };
        },
        matchesAccountRef: sameAddress,
      },
      {
        venueId: "limitless",
        supportedMarketClasses: [
          "clob",
          "clob_neg_risk",
          "amm",
          "amm_neg_risk",
        ],
        supportsWallet: isSupportedEvmWallet,
        inspect: (input) => this.inspectLimitless(input),
        ownerCandidates: async ({ wallets, ownerAddress }) => {
          const supported = wallets.filter(isSupportedEvmWallet);
          const candidateWallets = supported.filter((wallet) =>
            sameAddress(wallet.walletAddress, ownerAddress),
          );
          return {
            candidateWallets,
            ownershipHinted: candidateWallets.length > 0,
          };
        },
        matchesAccountRef: sameAddress,
      },
    ];
  }

  private inspectDestinationWithReuse(input: {
    driver: WalletPreparationRuntimeDriver;
    wallet: UserWallet;
    request: DestinationOptionsInput;
    canonicalMarketContextId: string | null;
    resolvedMarketContext?: RuntimeMarketContext;
  }): Promise<PreparedRuntimeDestination> {
    const key = JSON.stringify({
      accountId: input.request.accountId,
      venueId: input.driver.venueId,
      walletId: input.wallet.id,
      purpose: input.request.purpose,
      marketContextId:
        input.canonicalMarketContextId ?? input.request.marketContextId,
      marketClass: input.request.marketClass,
      positionActionRef: input.request.positionActionRef ?? null,
    });
    const now = this.clock().getTime();
    const cached = this.destinationInspectionCache.get(key);
    if (cached && cached.reusableUntil > now) {
      return Promise.resolve(cached.value);
    }
    if (cached) this.destinationInspectionCache.delete(key);
    const pending = this.destinationInspectionInflight.get(key);
    if (pending) return pending;

    const inspection = input.driver
      .inspect({
        accountId: input.request.accountId,
        wallet: input.wallet,
        purpose: input.request.purpose,
        marketContextId: input.request.marketContextId,
        marketClass: input.request.marketClass,
        positionActionRef: input.request.positionActionRef ?? null,
        resolvedMarketContext: input.resolvedMarketContext,
      })
      .then((value) => {
        const completedAt = this.clock().getTime();
        const evidenceExpiresAt = Date.parse(
          value.frozen.preparation.expiresAt,
        );
        const reusableUntil = Math.min(
          completedAt + DESTINATION_INSPECTION_REUSE_MS,
          evidenceExpiresAt,
        );
        if (reusableUntil > completedAt) {
          this.destinationInspectionCache.set(key, { value, reusableUntil });
        }
        return value;
      })
      .finally(() => {
        this.destinationInspectionInflight.delete(key);
      });
    this.destinationInspectionInflight.set(key, inspection);
    return inspection;
  }

  private async inspectPolymarket(
    input: RuntimeVenueInspectionInput,
  ): Promise<PreparedRuntimeDestination> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + PREPARATION_TTL_MS);
    const credentials = await AuthService.getVenueCredentials(
      input.accountId,
      "polymarket",
      input.wallet.walletAddress,
    );
    let deposit: PolymarketDepositWalletDerivation | null = null;
    if (!credentials?.funderAddress && input.wallet.isInternalWallet) {
      try {
        deposit = await inspectPolymarketDepositWallet({
          owner: input.wallet.walletAddress,
          rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
          timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
        });
      } catch {
        deposit = null;
      }
    }
    const funder =
      credentials?.funderAddress ??
      deposit?.address ??
      input.wallet.walletAddress;
    const storedL2Credentials =
      credentials?.apiKey &&
      credentials.apiSecret &&
      credentials.apiPassphrase &&
      sameAddress(credentials.walletAddress, input.wallet.walletAddress)
        ? {
            apiKey: credentials.apiKey,
            apiSecret: credentials.apiSecret,
            apiPassphrase: credentials.apiPassphrase,
          }
        : null;
    const marketContextPromise = input.resolvedMarketContext
      ? Promise.resolve(input.resolvedMarketContext)
      : loadRuntimeMarketContext({
          db: this.db,
          venue: "polymarket",
          marketContextId: input.marketContextId,
          requestedMarketClass: input.marketClass,
        });
    const funderResultPromise = derivePolymarketFunders({
      signer: input.wallet.walletAddress,
      storedFunder: funder,
      includeMagicProxy: true,
      bypassCodeCache: false,
    }).catch(() => null);
    const accountResultPromise = fetchPolymarketAccountRoute({
      credentialsInfo: credentials,
      userId: input.accountId,
      signer: input.wallet.walletAddress,
      query: { funderAddress: funder, refresh: false },
    });
    const liveCollateralLocksPromise = storedL2Credentials
      ? fetchPolymarketMaxSpendLiveOpenOrderLocks({
          signer: input.wallet.walletAddress,
          creds: storedL2Credentials,
          wallets: [funder, input.wallet.walletAddress],
        }).catch(() => null)
      : Promise.resolve(null);
    const funderResult = await funderResultPromise;
    const candidate = funderResult
      ? matchingFunderCandidate(funderResult.candidates, funder)
      : null;
    const topology = polymarketTopology({
      signer: input.wallet.walletAddress,
      funder,
      candidate,
      deposit,
    });
    const signatureType =
      topology.topology === "signer"
        ? 0
        : topology.topology === "magic_proxy"
          ? 1
          : topology.topology === "safe_1_1" ||
              topology.topology === "safe_unsupported"
            ? 2
            : 3;
    const clobPromise = inspectPolymarketClob({
      credentials,
      userId: input.accountId,
      walletAddress: input.wallet.walletAddress,
      signatureType,
    });
    /*
     * Account/RPC evidence and CLOB credential evidence are independent once
     * the exact signer/funder topology is known. Keeping them concurrent avoids
     * adding a full CLOB round trip after the onchain snapshot.
     */
    const [marketContext, accountResult, clob, liveCollateralLocks] =
      await Promise.all([
        marketContextPromise,
        accountResultPromise,
        clobPromise,
        liveCollateralLocksPromise,
      ]);
    const effectiveMarketClass = input.marketClass ?? marketContext.marketClass;
    const payload = accountResult.ok ? accountResult.payload : null;
    const onchainSnapshot = polymarketMaxSpendSnapshotFromAccount(
      accountResult.payload,
    );
    const rpcAvailable = accountResult.ok;
    const collateralRaw = rawAt(payload, ["pusd", "balanceRaw"]);
    const binding = bindingFor({
      accountId: input.accountId,
      venue: "polymarket",
      wallet: input.wallet,
      accountRef: funder,
    });
    const observedRaw = collateralRaw ?? "0";
    const reservedRaw = await reservedRawForLocation({
      db: this.db,
      userId: input.accountId,
      locationId: binding.settlementLocation.locationId,
      asset: binding.settlementLocation.asset,
    });
    const position = await loadRuntimePositionEvidence({
      db: this.db,
      accountId: input.accountId,
      venueId: "polymarket",
      positionActionRef: input.positionActionRef,
      binding,
    });
    const funderExecutionKind =
      resolvePolymarketFunderExecutionKindForMaxSpend(candidate);
    const l2Credentials = clob.l2Credentials;
    const polymarketFunding: PolymarketRouterFundingSnapshot | null =
      topology.topology === "deposit_wallet" &&
      topology.deployed === true &&
      funderExecutionKind === "deposit_wallet" &&
      l2Credentials &&
      fundingSidecarRuntimeConfig.polymarketFundingRouterAddress
        ? await (async () => {
            try {
              const funds = await resolvePolymarketMaxSpendFunds({
                creds: l2Credentials,
                funder,
                funderExecutionKind,
                // Generic user funding inspection must not depend on the
                // delegated bot-buy policy. The planner applies the exact,
                // user-confirmed operation bound when it commits a route.
                fundingCapRaw: null,
                negRisk: effectiveMarketClass === "neg_risk",
                pool: this.db,
                signer: input.wallet.walletAddress,
                userId: input.accountId,
                ...(liveCollateralLocks ? { liveCollateralLocks } : {}),
                ...(onchainSnapshot ? { onchainSnapshot } : {}),
              });
              if (
                funds.fundingRouterNonce == null ||
                funds.fundingRouterDepositUsdceAllowance == null ||
                funds.fundingRouterPusdAllowance == null ||
                funds.fundingRouterUsdceAllowance == null
              ) {
                return null;
              }
              return {
                signerAddress: input.wallet.walletAddress,
                depositWallet: funder,
                depositPusdRaw: funds.funderPusdRaw.toString(),
                depositLockedRaw: funds.funderLockedRaw.toString(),
                depositUsdceRaw: funds.funderUsdceRaw.toString(),
                signerPusdRaw: funds.signerPusdTopUpRaw.toString(),
                signerUsdceRaw: funds.signerUsdceTopUpRaw.toString(),
                fundingCapRaw: funds.fundingCapRaw.toString(),
                routerAddress:
                  fundingSidecarRuntimeConfig.polymarketFundingRouterAddress,
                routerNonceRaw: funds.fundingRouterNonce.toString(),
                depositRouterUsdceAllowanceRaw:
                  funds.fundingRouterDepositUsdceAllowance.toString(),
                routerPusdAllowanceRaw:
                  funds.fundingRouterPusdAllowance.toString(),
                routerUsdceAllowanceRaw:
                  funds.fundingRouterUsdceAllowance.toString(),
                clobPusdRaw: clob.safeBalanceRaw,
                observedAt: now.toISOString(),
              };
            } catch {
              return null;
            }
          })()
        : null;
    const evidence: PolymarketRuntimeEvidence = {
      binding,
      wallet: walletAuthority(input.wallet),
      topology: topology.topology,
      executionMode:
        input.wallet.isInternalWallet && topology.executionMode === "web_client"
          ? "privy_authorization"
          : topology.executionMode,
      rpcAvailable,
      walletDeployed: topology.deployed,
      ownerVerified: topology.ownerVerified,
      credentials: clob.credentials,
      market: marketContext.evidence,
      position,
      withdrawal: null,
      collateralObserved: collateralRaw != null,
      collateralRaw,
      collateralLockedRaw: reservedRaw,
      fundingRouter:
        topology.topology === "deposit_wallet"
          ? {
              configured: Boolean(
                fundingSidecarRuntimeConfig.polymarketFundingRouterAddress,
              ),
              routerAddress: readString(payload, ["fundingRouter", "address"]),
              canonical: sameAddress(
                readString(payload, ["fundingRouter", "address"]),
                fundingSidecarRuntimeConfig.polymarketFundingRouterAddress,
              ),
              nonceRaw: rawAt(payload, ["fundingRouter", "nonce"]),
              depositUsdceAllowanceRaw: rawAt(payload, [
                "fundingRouter",
                "depositUsdceAllowanceRaw",
              ]),
              pUsdAllowanceRaw: rawAt(payload, [
                "fundingRouter",
                "pUsdAllowanceRaw",
              ]),
              usdceAllowanceRaw: rawAt(payload, [
                "fundingRouter",
                "usdceAllowanceRaw",
              ]),
            }
          : null,
      clobCollateralVisible: Boolean(
        clob.collateralVisible &&
        collateralRaw != null &&
        clob.safeBalanceRaw != null &&
        BigInt(clob.safeBalanceRaw) >= BigInt(collateralRaw),
      ),
      standardExchangeAllowance: allowanceEnough(
        rawAt(payload, ["pusd", "allowance", "exchange", "allowanceRaw"]),
      ),
      negRiskExchangeAllowance: allowanceEnough(
        rawAt(payload, [
          "pusd",
          "allowance",
          "negRiskExchange",
          "allowanceRaw",
        ]),
      ),
      negRiskAdapterAllowance: allowanceEnough(
        rawAt(payload, ["pusd", "allowance", "negRiskAdapter", "allowanceRaw"]),
      ),
      standardExchangeApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "exchange",
        ]) === true,
      negRiskExchangeApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "negRiskExchange",
        ]) === true,
      negRiskAdapterApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "negRiskAdapter",
        ]) === true,
      observedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      safeEvidence: {
        signer: normalizeAddress(input.wallet.walletAddress),
        funder: normalizeAddress(funder),
        topology: topology.topology,
        walletDeployed: topology.deployed,
        credentialPresent: clob.credentials.present,
        credentialVerified: clob.credentials.verified,
        collateralRaw: collateralRaw ?? "unknown",
        clobBalanceRaw: clob.safeBalanceRaw ?? "unknown",
        fundingRouterNonce:
          rawAt(payload, ["fundingRouter", "nonce"]) ?? "unknown",
        reservedRaw,
        marketRef: marketContext.evidence.safeMarketRef,
      },
    };
    const inspectionInput: PreparationInspectionInput = {
      accountId: input.accountId,
      binding,
      purpose: input.purpose,
      marketClass: effectiveMarketClass,
      marketContextId: input.marketContextId,
    };
    const adapter = new PolymarketWalletPreparationAdapter(
      async (requested) => buildPolymarketRuntimeFacts(requested, evidence),
      () => now,
      createPolymarketRuntimeActionMaterializer({
        wallet: input.wallet,
        topology: topology.topology,
        funder,
        redemptionOperator: marketContext.adapterAddress,
      }),
    );
    const preparation = await adapter.inspect(inspectionInput);
    return {
      adapter,
      frozen: frozenDestination({
        preparation,
        observedRaw,
        lockedRaw: "0",
        reservedRaw,
        destinationLocationPatternId: "polymarket-venue-cash-v1",
        networkLabel: "Polygon",
        sourcePlanningEvidence: polymarketFunding
          ? polymarketFundingEvidence(polymarketFunding)
          : null,
        now,
      }),
      inspectionInput,
      observedRaw,
      reservedRaw,
      wallet: input.wallet,
    };
  }

  private async inspectLimitless(
    input: RuntimeVenueInspectionInput,
  ): Promise<PreparedRuntimeDestination> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + PREPARATION_TTL_MS);
    const marketContextPromise = input.resolvedMarketContext
      ? Promise.resolve(input.resolvedMarketContext)
      : loadRuntimeMarketContext({
          db: this.db,
          venue: "limitless",
          marketContextId: input.marketContextId,
          requestedMarketClass: input.marketClass,
        });
    const authContextPromise = resolveLimitlessAuthContext(
      input.accountId,
      input.wallet.walletAddress,
    );
    const marketContext = await marketContextPromise;
    const effectiveMarketClass = input.marketClass ?? marketContext.marketClass;
    const snapshotPromise = fetchLimitlessOnchainSnapshot({
      rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
      owner: input.wallet.walletAddress,
      clobAddress: fundingSidecarRuntimeConfig.limitlessClobAddress,
      negRiskAddress: fundingSidecarRuntimeConfig.limitlessNegRiskAddress,
      adapterAddress: marketContext.adapterAddress,
      ammAddress: marketContext.ammAddress,
      conditionalTokensAddress:
        fundingSidecarRuntimeConfig.limitlessConditionalTokensAddress,
    }).catch(() => null);
    const venueLockedCollateralPromise = effectiveMarketClass?.startsWith(
      "clob",
    )
      ? fetchOpenOrderCollateralLocks(this.db, {
          userId: input.accountId,
          polymarketWallets: [],
          limitlessWallets: [input.wallet.walletAddress],
        })
      : Promise.resolve(null);
    const [authContext, snapshot, venueLockedCollateral] = await Promise.all([
      authContextPromise,
      snapshotPromise,
      venueLockedCollateralPromise,
    ]);
    const credentialsInfo = authContext?.creds ?? null;
    const profile = credentialsInfo
      ? extractLimitlessPartnerAccountProfile(
          credentialsInfo.additionalData,
          input.wallet.walletAddress,
        )
      : null;
    const accountHasCredentials = Boolean(
      authContext &&
      profile?.id &&
      (!profile.account ||
        sameAddress(profile.account, input.wallet.walletAddress)) &&
      isLimitlessPartnerHmacConfigured(),
    );
    const cashRaw = snapshot?.usdcBalance.toString() ?? null;
    const cashLockedRaw =
      venueLockedCollateral?.limitless
        .get(normalizeAddress(input.wallet.walletAddress))
        ?.toString() ?? "0";
    const binding = bindingFor({
      accountId: input.accountId,
      venue: "limitless",
      wallet: input.wallet,
      accountRef: input.wallet.walletAddress,
    });
    const observedRaw = cashRaw ?? "0";
    const reservedRaw = await reservedRawForLocation({
      db: this.db,
      userId: input.accountId,
      locationId: binding.settlementLocation.locationId,
      asset: binding.settlementLocation.asset,
    });
    const position = await loadRuntimePositionEvidence({
      db: this.db,
      accountId: input.accountId,
      venueId: "limitless",
      positionActionRef: input.positionActionRef,
      binding,
    });
    const credentials: RuntimeCredentialEvidence = storedCredentialEvidence({
      present: Boolean(
        credentialsInfo && authContext && profile && accountHasCredentials,
      ),
      boundToExactWallet: Boolean(
        credentialsInfo &&
        sameAddress(
          credentialsInfo.walletAddress,
          input.wallet.walletAddress,
        ) &&
        (!profile?.account ||
          sameAddress(profile.account, input.wallet.walletAddress)),
      ),
      observedAt: credentialsInfo?.updatedAt ?? null,
      now,
    });
    const evidence: LimitlessRuntimeEvidence = {
      binding,
      wallet: walletAuthority(input.wallet),
      topology:
        input.wallet.walletSource === "unknown"
          ? "unknown_wallet"
          : input.wallet.isInternalWallet
            ? "internal_eoa"
            : "external_eoa",
      executionMode: input.wallet.isInternalWallet
        ? "privy_authorization"
        : "web_client",
      rpcAvailable: snapshot != null,
      ownerVerified: input.wallet.isVerified,
      credentials,
      market: marketContext.evidence,
      position,
      withdrawal: null,
      cashObserved: cashRaw != null,
      cashRaw,
      cashLockedRaw,
      clobAllowance:
        snapshot != null && snapshot.allowanceClob != null
          ? snapshot.allowanceClob > 0n
          : false,
      negRiskClobAllowance:
        snapshot != null && snapshot.allowanceNegRisk != null
          ? snapshot.allowanceNegRisk > 0n
          : false,
      ammAllowance:
        snapshot != null && snapshot.allowanceAmm != null
          ? snapshot.allowanceAmm > 0n
          : false,
      clobApproval: snapshot?.approvedClob === true,
      negRiskClobApproval: snapshot?.approvedNegRisk === true,
      ammApproval: snapshot?.approvedAmm === true,
      marketAdapterRequired: Boolean(marketContext.adapterAddress),
      marketAdapterApproval: snapshot?.approvedAdapter === true,
      observedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      safeEvidence: {
        wallet: normalizeAddress(input.wallet.walletAddress),
        topology: input.wallet.isInternalWallet
          ? "internal_eoa"
          : "external_eoa",
        credentialPresent: credentials.present,
        profileVerified: credentials.verified,
        profileId: profile?.id == null ? null : String(profile.id),
        cashRaw: cashRaw ?? "unknown",
        cashLockedRaw,
        reservedRaw,
        marketRef: marketContext.evidence.safeMarketRef,
        marketAdapterRequired: Boolean(marketContext.adapterAddress),
      },
    };
    const inspectionInput: PreparationInspectionInput = {
      accountId: input.accountId,
      binding,
      purpose: input.purpose,
      marketClass: effectiveMarketClass,
      marketContextId: input.marketContextId,
    };
    const adapter = new LimitlessWalletPreparationAdapter(
      async (requested) => buildLimitlessRuntimeFacts(requested, evidence),
      () => now,
      createLimitlessRuntimeActionMaterializer({
        wallet: input.wallet,
        adapterAddress: marketContext.adapterAddress,
        ammAddress: marketContext.ammAddress,
      }),
    );
    const preparation = await adapter.inspect(inspectionInput);
    return {
      adapter,
      frozen: frozenDestination({
        preparation,
        observedRaw,
        lockedRaw: cashLockedRaw,
        reservedRaw,
        destinationLocationPatternId: "limitless-venue-cash-v1",
        networkLabel: "Base",
        sourcePlanningEvidence: null,
        now,
      }),
      inspectionInput,
      observedRaw,
      reservedRaw,
      wallet: input.wallet,
    };
  }

  async frozenDestinations(
    input: DestinationOptionsInput,
    resolvedMarket: ApiTradeMarket | null = null,
    allowPartialVenueCoverage = false,
  ): Promise<readonly FrozenPreparationDestination[]> {
    return (
      await this.preparedDestinations(
        input,
        resolvedMarket,
        allowPartialVenueCoverage,
      )
    ).map((result) => result.frozen);
  }

  private async preparedDestinations(
    input: DestinationOptionsInput,
    resolvedMarket: ApiTradeMarket | null = null,
    allowPartialVenueCoverage = false,
  ): Promise<readonly PreparedRuntimeDestination[]> {
    const wallets = (await this.loadWallets(input.accountId)).filter(
      (wallet) =>
        wallet.isVerified &&
        (!input.controllerWalletRef || wallet.id === input.controllerWalletRef),
    );
    if (
      resolvedMarket &&
      input.marketContextId &&
      resolvedMarket.id !== input.marketContextId
    ) {
      throw new PreparationContractError(
        "evidence_invalid",
        "resolved market context does not match the requested canonical market",
      );
    }
    const targetMarket =
      resolvedMarket ??
      (input.marketContextId
        ? await findTradeMarketByRef(this.db, input.marketContextId)
        : null);
    const targetVenueId = targetMarket?.venue ?? null;
    const targetRuntimeVenue =
      targetVenueId === "polymarket" || targetVenueId === "limitless"
        ? targetVenueId
        : null;
    const resolvedMarketContext =
      targetMarket && targetRuntimeVenue
        ? runtimeMarketContextFromMarket({
            venue: targetRuntimeVenue,
            market: targetMarket,
            requestedMarketClass: input.marketClass,
          })
        : input.marketContextId
          ? unavailableRuntimeMarketContext(
              input.marketContextId,
              input.marketClass,
            )
          : undefined;
    const attempts = this.venueDrivers
      .filter((driver) =>
        isDestinationDriverApplicable({
          driverVenueId: driver.venueId,
          supportedMarketClasses: driver.supportedMarketClasses,
          requestedMarketClass: input.marketClass,
          targetVenueId,
        }),
      )
      .flatMap((driver) =>
        wallets
          .filter((wallet) => driver.supportsWallet(wallet))
          .map((wallet) => ({ driver, wallet })),
      );
    const outcomes = await Promise.allSettled(
      attempts.map(({ driver, wallet }) =>
        withinDestinationInspectionDeadline(
          this.inspectDestinationWithReuse({
            driver,
            wallet,
            request: input,
            canonicalMarketContextId: targetMarket?.id ?? null,
            resolvedMarketContext,
          }),
        ),
      ),
    );
    const coverage = collectDestinationInspectionCoverage(
      attempts.map(({ driver, wallet }, index) => ({
        venueId: driver.venueId,
        internalWallet: wallet.isInternalWallet,
        outcome: outcomes[index],
      })),
    );
    const compatibleBindingOptionIds = new Set(
      input.compatibleVenueBindingOptionIds ?? [],
    );
    if (compatibleBindingOptionIds.size > 0) {
      const compatibleValues = coverage.values.filter((value) =>
        compatibleBindingOptionIds.has(
          value.frozen.bindingOption.venueBindingOptionId,
        ),
      );
      if (compatibleValues.length > 0) {
        return compatibleValues;
      }
    }
    if (!allowPartialVenueCoverage && coverage.incompleteVenueIds.length > 0) {
      throw new PreparationContractError(
        "preparation_unavailable",
        `venue destination inspection is incomplete: ${coverage.incompleteVenueIds.join(",")}`,
      );
    }
    return coverage.values;
  }

  async resolveOwnerPreparation(
    input: Readonly<{
      accountId: string;
      marketClass: string;
      marketContextId: string;
      ownerAddress: string;
      venueId: VenueId;
    }>,
  ): Promise<PreparedRuntimeDestination> {
    const driver = this.venueDrivers.find(
      (candidate) => candidate.venueId === input.venueId,
    );
    if (!driver) {
      throw new PreparationContractError(
        "preparation_unavailable",
        "requested venue has no registered preparation runtime driver",
      );
    }
    const wallets = (await this.loadWallets(input.accountId)).filter(
      (wallet) => wallet.isVerified,
    );
    const ownerCandidates = await driver.ownerCandidates({
      accountId: input.accountId,
      wallets,
      ownerAddress: input.ownerAddress,
    });
    const inspected = await Promise.allSettled(
      ownerCandidates.candidateWallets.map((wallet) =>
        driver.inspect({
          accountId: input.accountId,
          wallet,
          purpose: "redeem",
          marketContextId: input.marketContextId,
          marketClass: input.marketClass,
          positionActionRef: null,
        }),
      ),
    );
    const owned = inspected.flatMap((result) =>
      result.status === "fulfilled" &&
      driver.matchesAccountRef(
        result.value.frozen.preparation.binding.accountRef,
        input.ownerAddress,
      )
        ? [result.value]
        : [],
    );
    if (owned.length > 1) {
      throw new PreparationContractError(
        "evidence_invalid",
        "position owner resolves to multiple executable venue bindings",
      );
    }
    if (owned[0]) return owned[0];
    if (
      ownerCandidates.ownershipHinted &&
      inspected.some((result) => result.status === "rejected")
    ) {
      throw new PreparationContractError(
        "preparation_unavailable",
        "position owner binding could not be inspected with fresh evidence",
      );
    }
    throw new PreparationContractError(
      "binding_mismatch",
      "position owner is not controlled by the requested account",
    );
  }

  async inspectBindingOption(
    input: DestinationOptionsInput & Readonly<{ venueBindingOptionId: string }>,
  ): Promise<PreparationResult> {
    const candidates = await this.preparedDestinations(input);
    const candidate = candidates.find(
      (entry) =>
        entry.frozen.bindingOption.venueBindingOptionId ===
        input.venueBindingOptionId,
    );
    if (!candidate) {
      throw new PreparationContractError(
        "binding_mismatch",
        "venue binding option is not owned or no longer available",
      );
    }
    return candidate.frozen.preparation;
  }

  async prepareBindingOption(
    input: DestinationOptionsInput &
      Readonly<{
        venueBindingOptionId: string;
        operationId: string;
        expectedInspectionRevision: string;
      }>,
  ): Promise<
    Readonly<{
      actions: readonly NormalizedAction[];
      controllerWalletRef: string;
    }>
  > {
    const candidates = await this.preparedDestinations(input);
    const candidate = candidates.find(
      (entry) =>
        entry.frozen.bindingOption.venueBindingOptionId ===
        input.venueBindingOptionId,
    );
    if (!candidate) {
      throw new PreparationContractError(
        "binding_mismatch",
        "venue binding option is not owned or no longer available",
      );
    }
    const actions = await candidate.adapter.prepare({
      ...candidate.inspectionInput,
      operationId: input.operationId,
      expectedInspectionRevision: input.expectedInspectionRevision,
    });
    return {
      actions,
      controllerWalletRef: candidate.wallet.id,
    };
  }

  async listDestinationOptions(
    input: DestinationOptionsInput,
  ): Promise<readonly FundingDestinationOption[]> {
    const facts = await this.frozenDestinations(input, null, true);
    const resolver = this.destinationResolver(facts);
    return resolver.listOptions(input);
  }

  async resolvedCandidates(
    input: DestinationOptionsInput,
    resolvedMarket: ApiTradeMarket | null = null,
  ): Promise<readonly ResolvedDestinationCandidate[]> {
    const facts = await this.frozenDestinations(input, resolvedMarket);
    const resolver = this.destinationResolver(facts);
    const options = await resolver.listOptions(input);
    return options.flatMap((option): ResolvedDestinationCandidate[] => {
      const fact = facts.find(
        (entry) =>
          entry.bindingOption.venueBindingOptionId ===
          option.venueBindingOptionId,
      );
      if (!fact) return [];
      return [
        {
          destinationLocationPatternId: fact.destinationLocationPatternId,
          collateralValuation: fact.collateralValuation,
          spendability: fact.spendability,
          option,
          bindingOption: fact.bindingOption,
          target: fact.target,
          availableNow: fact.spendability.availableAmount as Money,
          preparationActions: fact.preparation.requiredActions,
          completeness: fact.preparation.evidence.checks.some(
            (check) => check.status === "unavailable",
          )
            ? "partial"
            : "complete",
          freshness:
            Date.parse(fact.preparation.expiresAt) > this.clock().getTime()
              ? "fresh"
              : "stale",
          venueBinding: fact.preparation.binding,
          sourcePlanningEvidence: fact.sourcePlanningEvidence,
        },
      ];
    });
  }

  private destinationResolver(
    facts: readonly FrozenPreparationDestination[],
  ): CombinedFundingDestinationResolver {
    return new CombinedFundingDestinationResolver(
      this.venueDrivers.map(
        (driver) =>
          new FrozenPreparationDestinationAdapter(
            driver.venueId,
            driver.supportedMarketClasses,
            async () => facts,
            this.clock,
          ),
      ),
      this.venueDrivers.map((driver) => driver.venueId),
    );
  }
}

export const walletPreparationRuntimeTestHooks = {
  availableRaw,
};

export const RUNTIME_PREPARATION_MAX_APPROVAL_RAW = MAX_APPROVAL;
