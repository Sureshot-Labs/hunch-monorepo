import type {
  ActionValidator,
  AssetInventoryCollector,
  BalanceCollector,
  FundingDestination,
  NetworkExecutor,
  PositionActionExecutor,
  PositionValueCollector,
  PriceAdapter,
  RoutingProviderAdapter,
  VenueAccountResolver,
  WalletOwnershipResolver,
  WalletPreparationAdapter,
} from "./contracts.js";

/**
 * Local simulation is constructor-injected by tests and development tools.
 * Production registries never import this module or resolve a simulator from a
 * runtime module path.
 */
export type LocalFundingClock = Readonly<{
  now(): Date;
  advance(milliseconds: number): void;
}>;

export type LocalFundingSimulator = Readonly<{
  ownershipResolver: WalletOwnershipResolver;
  inventoryCollectors: readonly AssetInventoryCollector[];
  priceAdapters: readonly PriceAdapter[];
  positionValueCollectors: readonly PositionValueCollector[];
  balanceCollectors: readonly BalanceCollector[];
  venueAccountResolver: VenueAccountResolver;
  destinationResolver: FundingDestination;
  preparationAdapters: readonly WalletPreparationAdapter[];
  positionActionExecutors: readonly PositionActionExecutor[];
  routingAdapters: readonly RoutingProviderAdapter[];
  actionValidators: readonly ActionValidator[];
  networkExecutors: readonly NetworkExecutor[];
  clock: LocalFundingClock;
}>;

export interface LocalFundingSimulatorFactory {
  create(seed: string): LocalFundingSimulator;
}
