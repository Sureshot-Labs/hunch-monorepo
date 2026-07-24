import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { AuthService, type UserWallet } from "../../auth.js";
import { env } from "../../env.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  isOrderable,
  loadMarketForVenue,
  type ApiTradeMarket,
} from "../../services/api-trading-market-repo.js";
import { resolvePolymarketBotPolicyFundingCapRaw } from "../../services/api-trading-common.js";
import {
  fetchLimitlessAccountRoute,
  inspectLimitlessPartnerAccountProfile,
} from "../../services/limitless-trading-execution-service.js";
import {
  extractLimitlessPartnerAccountProfile,
  resolveLimitlessAuthContext,
} from "../../services/limitless-auth.js";
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
  resolvePolymarketFunderExecutionKindForMaxSpend,
  resolvePolymarketMaxSpendFunds,
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
import { canonicalJsonHash } from "../persistence/canonical.js";
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
  type LimitlessRuntimeEvidence,
  type PolymarketRuntimeEvidence,
  type RuntimeCredentialEvidence,
  type RuntimeMarketEvidence,
  type RuntimeWalletAuthority,
} from "./runtime-facts.js";
import {
  createLimitlessRuntimeActionMaterializer,
  createPolymarketRuntimeActionMaterializer,
} from "./runtime-actions.js";

const PREPARATION_TTL_MS = 45_000;
const PROFILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_APPROVAL = (1n << 255n).toString();

type RuntimeVenue = "limitless" | "polymarket";

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
    return value.trim().toLowerCase();
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
  return {
    source: wallet.walletSource,
    internal: wallet.isInternalWallet,
    privyWalletId: wallet.privyWalletId,
    profileObservedAt: wallet.privyProfileUpdatedAt?.toISOString() ?? null,
  };
}

function walletId(wallet: UserWallet, networkId: string): string {
  return stableOpaqueId(
    "wallet",
    `${wallet.walletType}:${networkId}:${wallet.walletAddress.toLowerCase()}`,
  );
}

function assetFor(venue: RuntimeVenue): AssetRef {
  return venue === "polymarket"
    ? {
        networkId: "evm:137",
        assetId: env.polymarketUsdcAddress,
        decimals: 6,
      }
    : {
        networkId: "evm:8453",
        assetId: env.limitlessUsdcAddress,
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
    `${input.accountId}:${input.venue}:${input.accountRef.toLowerCase()}`,
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
        `${bindingId}:${asset.networkId}:${asset.assetId.toLowerCase()}`,
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

function profileStale(observedAt: Date | null | undefined, now: Date): boolean {
  if (!observedAt) return true;
  const timestamp = observedAt.getTime();
  return (
    !Number.isFinite(timestamp) ||
    timestamp > now.getTime() ||
    now.getTime() - timestamp > PROFILE_MAX_AGE_MS
  );
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
    market = await loadMarketForVenue(
      input.db,
      input.marketContextId,
      input.venue,
    );
  } catch {
    return {
      market: null,
      marketClass: input.requestedMarketClass,
      adapterAddress: null,
      ammAddress: null,
      evidence: {
        resolved: false,
        orderable: false,
        adapterResolved: false,
        exchangeResolved: false,
        quoteGuardAvailable: false,
        safeMarketRef: input.marketContextId,
      },
    };
  }
  const marketClass = classForMarket(input.venue, market);
  const classMatches =
    input.requestedMarketClass == null ||
    input.requestedMarketClass === marketClass;
  const ammAddress =
    input.venue === "limitless" && marketClass.startsWith("amm")
      ? metadataString(
          market.metadata,
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
          market.metadata,
          "adapter",
          "adapterAddress",
          "adapter_address",
          "negRiskAdapter",
          "neg_risk_adapter",
        )
      : isNegRisk(market)
        ? env.polymarketNegRiskAdapterAddress || null
        : env.polymarketConditionalTokensAddress;
  const routeResolved =
    input.venue === "polymarket"
      ? Boolean(market.token_yes && market.token_no)
      : marketClass.startsWith("amm")
        ? Boolean(ammAddress && market.token_yes && market.token_no)
        : Boolean(market.slug && market.token_yes && market.token_no);
  const exchangeResolved =
    input.venue === "polymarket"
      ? Boolean(
          isNegRisk(market)
            ? env.polymarketNegRiskExchangeAddress
            : env.polymarketExchangeAddress,
        )
      : marketClass.startsWith("amm")
        ? Boolean(ammAddress)
        : Boolean(
            isNegRisk(market)
              ? env.limitlessNegRiskAddress
              : env.limitlessClobAddress,
          );
  return {
    market,
    marketClass,
    adapterAddress,
    ammAddress,
    evidence: {
      resolved: classMatches && routeResolved,
      orderable: classMatches && isOrderable(market),
      adapterResolved:
        classMatches &&
        (marketClass.includes("neg_risk")
          ? Boolean(adapterAddress)
          : routeResolved),
      exchangeResolved: classMatches && exchangeResolved,
      quoteGuardAvailable: classMatches && routeResolved && exchangeResolved,
      safeMarketRef: market.id,
    },
  };
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
  userId: string;
  walletAddress: string;
  signatureType: number;
}): Promise<{
  credentials: RuntimeCredentialEvidence;
  l2Credentials: PolymarketL2Credentials | null;
  collateralVisible: boolean;
  safeBalanceRaw: string | null;
}> {
  const credentials = await AuthService.getVenueCredentials(
    input.userId,
    "polymarket",
    input.walletAddress,
  );
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
      baseUrl: env.polymarketClobBase,
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
        and lower(asset_id) = lower($4)
        and asset_decimals = $5
        and state = 'active'
        and expires_at > now()
    `,
    [
      input.userId,
      input.locationId,
      input.asset.networkId,
      input.asset.assetId,
      input.asset.decimals,
    ],
  );
  const value = rows[0]?.reserved_raw ?? "0";
  return /^(0|[1-9][0-9]*)$/.test(value) ? value : "0";
}

function availableRaw(observedRaw: string, reservedRaw: string): string {
  const observed = BigInt(observedRaw);
  const reserved = BigInt(reservedRaw);
  return (observed > reserved ? observed - reserved : 0n).toString();
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
  reservedRaw: string;
  destinationLocationPatternId: string;
  networkLabel: string;
  sourcePlanningEvidence: FrozenPreparationDestination["sourcePlanningEvidence"];
  now: Date;
}): FrozenPreparationDestination {
  const binding = input.preparation.binding;
  const asset = binding.settlementLocation.asset;
  const available = availableRaw(input.observedRaw, input.reservedRaw);
  const expiresAt = input.preparation.expiresAt;
  const target: FundingTarget = {
    kind: "owned_location",
    location: binding.settlementLocation,
  };
  const spendability = {
    observedAmount: { asset, raw: input.observedRaw },
    lockedRaw: "0",
    reservedRaw: input.reservedRaw,
    submittedDebitRaw: "0",
    availableAmount: { asset, raw: available },
    revision: `spendability_${canonicalJsonHash({
      bindingId: binding.bindingId,
      observedRaw: input.observedRaw,
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

  constructor(
    private readonly db: Pool,
    private readonly clock: () => Date = () => new Date(),
    venueDrivers?: readonly WalletPreparationRuntimeDriver[],
  ) {
    this.venueDrivers = venueDrivers ?? this.defaultVenueDrivers();
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

  private async inspectPolymarket(input: {
    accountId: string;
    wallet: UserWallet;
    purpose: DestinationOptionsInput["purpose"];
    marketContextId: string | null;
    marketClass: string | null;
  }): Promise<PreparedRuntimeDestination> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + PREPARATION_TTL_MS);
    const credentialsInfo = await AuthService.getVenueCredentialsInfo(
      input.accountId,
      "polymarket",
      input.wallet.walletAddress,
    );
    let deposit: PolymarketDepositWalletDerivation | null = null;
    if (!credentialsInfo?.funderAddress && input.wallet.isInternalWallet) {
      try {
        deposit = await inspectPolymarketDepositWallet({
          owner: input.wallet.walletAddress,
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
        });
      } catch {
        deposit = null;
      }
    }
    const funder =
      credentialsInfo?.funderAddress ??
      deposit?.address ??
      input.wallet.walletAddress;
    const [marketContext, funderResult, accountResult] = await Promise.all([
      loadRuntimeMarketContext({
        db: this.db,
        venue: "polymarket",
        marketContextId: input.marketContextId,
        requestedMarketClass: input.marketClass,
      }),
      derivePolymarketFunders({
        signer: input.wallet.walletAddress,
        storedFunder: funder,
        includeMagicProxy: true,
        bypassCodeCache: true,
      }).catch(() => null),
      fetchPolymarketAccountRoute({
        userId: input.accountId,
        signer: input.wallet.walletAddress,
        query: { funderAddress: funder, refresh: true },
      }),
    ]);
    const effectiveMarketClass = input.marketClass ?? marketContext.marketClass;
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
    const clob = await inspectPolymarketClob({
      userId: input.accountId,
      walletAddress: input.wallet.walletAddress,
      signatureType,
    });
    const payload = accountResult.ok ? accountResult.payload : null;
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
    const funderExecutionKind =
      resolvePolymarketFunderExecutionKindForMaxSpend(candidate);
    const l2Credentials = clob.l2Credentials;
    const polymarketFunding: PolymarketRouterFundingSnapshot | null =
      topology.topology === "deposit_wallet" &&
      topology.deployed === true &&
      funderExecutionKind === "deposit_wallet" &&
      l2Credentials &&
      env.polymarketFundingRouterAddress
        ? await (async () => {
            try {
              const funds = await resolvePolymarketMaxSpendFunds({
                creds: l2Credentials,
                funder,
                funderExecutionKind,
                fundingCapRaw: await resolvePolymarketBotPolicyFundingCapRaw(),
                negRisk: effectiveMarketClass === "neg_risk",
                pool: this.db,
                signer: input.wallet.walletAddress,
                userId: input.accountId,
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
                routerAddress: env.polymarketFundingRouterAddress,
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
      position: null,
      withdrawal: null,
      collateralObserved: collateralRaw != null,
      collateralRaw,
      collateralLockedRaw: reservedRaw,
      fundingRouter:
        topology.topology === "deposit_wallet"
          ? {
              configured: Boolean(env.polymarketFundingRouterAddress),
              routerAddress: readString(payload, ["fundingRouter", "address"]),
              canonical: sameAddress(
                readString(payload, ["fundingRouter", "address"]),
                env.polymarketFundingRouterAddress,
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

  private async inspectLimitless(input: {
    accountId: string;
    wallet: UserWallet;
    purpose: DestinationOptionsInput["purpose"];
    marketContextId: string | null;
    marketClass: string | null;
  }): Promise<PreparedRuntimeDestination> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + PREPARATION_TTL_MS);
    const marketContext = await loadRuntimeMarketContext({
      db: this.db,
      venue: "limitless",
      marketContextId: input.marketContextId,
      requestedMarketClass: input.marketClass,
    });
    const effectiveMarketClass = input.marketClass ?? marketContext.marketClass;
    const credentialsInfo = await AuthService.getVenueCredentialsInfo(
      input.accountId,
      "limitless",
      input.wallet.walletAddress,
    );
    const authContext = await resolveLimitlessAuthContext(
      input.accountId,
      input.wallet.walletAddress,
    );
    const liveProfile = authContext
      ? await inspectLimitlessPartnerAccountProfile({
          account: input.wallet.walletAddress,
          clientType: "eoa",
        }).catch(() => null)
      : null;
    const profile =
      liveProfile?.profile ??
      (credentialsInfo
        ? extractLimitlessPartnerAccountProfile(
            credentialsInfo.additionalData,
            input.wallet.walletAddress,
          )
        : null);
    const accountResult = await fetchLimitlessAccountRoute({
      userId: input.accountId,
      signerRaw: input.wallet.walletAddress,
      query: {
        refresh: true,
        adapterSpender: marketContext.adapterAddress,
        ammSpender: marketContext.ammAddress,
        tokenId: null,
      },
    });
    const payload = accountResult.ok ? accountResult.payload : null;
    const cashRaw = rawAt(payload, ["usdc", "balanceRaw"]);
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
    const credentials: RuntimeCredentialEvidence = {
      present: Boolean(credentialsInfo && authContext),
      boundToExactWallet: Boolean(
        credentialsInfo &&
        sameAddress(
          credentialsInfo.walletAddress,
          input.wallet.walletAddress,
        ) &&
        (!profile?.account ||
          sameAddress(profile.account, input.wallet.walletAddress)),
      ),
      verified: Boolean(liveProfile?.profile),
      observedAt: liveProfile ? now.toISOString() : null,
      stale:
        credentialsInfo != null &&
        (profileStale(credentialsInfo.updatedAt, now) ||
          (liveProfile != null && !liveProfile.profile)),
    };
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
      rpcAvailable: accountResult.ok,
      ownerVerified: input.wallet.isVerified,
      credentials,
      market: marketContext.evidence,
      position: null,
      withdrawal: null,
      cashObserved: cashRaw != null,
      cashRaw,
      cashLockedRaw: reservedRaw,
      clobAllowance: allowanceEnough(
        rawAt(payload, ["usdc", "allowance", "clob", "allowanceRaw"]),
      ),
      negRiskClobAllowance: allowanceEnough(
        rawAt(payload, ["usdc", "allowance", "negRisk", "allowanceRaw"]),
      ),
      ammAllowance: allowanceEnough(
        rawAt(payload, ["usdc", "allowance", "amm", "allowanceRaw"]),
      ),
      clobApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "clob",
        ]) === true,
      negRiskClobApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "negRisk",
        ]) === true,
      ammApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "amm",
        ]) === true,
      marketAdapterApproval:
        readBoolean(payload, [
          "conditionalTokens",
          "isApprovedForAll",
          "adapter",
        ]) === true,
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
  ): Promise<readonly FrozenPreparationDestination[]> {
    return (await this.preparedDestinations(input)).map(
      (result) => result.frozen,
    );
  }

  private async preparedDestinations(
    input: DestinationOptionsInput,
  ): Promise<readonly PreparedRuntimeDestination[]> {
    const wallets = (await AuthService.getUserWallets(input.accountId)).filter(
      (wallet) => wallet.isVerified,
    );
    const results = await Promise.all(
      this.venueDrivers.flatMap((driver) =>
        wallets
          .filter((wallet) => driver.supportsWallet(wallet))
          .map((wallet) =>
            driver
              .inspect({
                accountId: input.accountId,
                wallet,
                purpose: input.purpose,
                marketContextId: input.marketContextId,
                marketClass: input.marketClass,
              })
              .catch(() => null),
          ),
      ),
    );
    return results.filter(
      (result): result is PreparedRuntimeDestination => result != null,
    );
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
    const wallets = (await AuthService.getUserWallets(input.accountId)).filter(
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
  ): Promise<readonly NormalizedAction[]> {
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
    return candidate.adapter.prepare({
      ...candidate.inspectionInput,
      operationId: input.operationId,
      expectedInspectionRevision: input.expectedInspectionRevision,
    });
  }

  async listDestinationOptions(
    input: DestinationOptionsInput,
  ): Promise<readonly FundingDestinationOption[]> {
    const facts = await this.frozenDestinations(input);
    const resolver = this.destinationResolver(facts);
    return resolver.listOptions(input);
  }

  async resolvedCandidates(
    input: DestinationOptionsInput,
  ): Promise<readonly ResolvedDestinationCandidate[]> {
    const facts = await this.frozenDestinations(input);
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

export const RUNTIME_PREPARATION_MAX_APPROVAL_RAW = MAX_APPROVAL;
