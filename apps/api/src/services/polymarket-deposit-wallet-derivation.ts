import { ethers } from "ethers";

import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";

export const POLYMARKET_DEPOSIT_WALLET_FACTORY =
  "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
export const POLYMARKET_DEPOSIT_WALLET_IMPLEMENTATION =
  "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

const FACTORY_BEACON_SELECTOR = "0x49493a4d";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;
const ERC1967_BEACON_CONST1 =
  "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const ERC1967_BEACON_CONST2 =
  "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const ERC1967_BEACON_CONST3 =
  "0x60195155f3363d3d373d3d363d602036600436635c60da";
const ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973n;

function depositWalletArgs(owner: string, factory: string): string {
  const walletId = ethers.zeroPadValue(ethers.getAddress(owner), 32);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32"],
    [ethers.getAddress(factory), walletId],
  );
}

function proxyLength(args: string): bigint {
  return BigInt(ethers.dataLength(args));
}

function initCodeHashUups(implementation: string, args: string): string {
  const combined = ERC1967_PREFIX + (proxyLength(args) << 56n);
  return ethers.keccak256(
    ethers.concat([
      ethers.toBeHex(combined, 10),
      ethers.getAddress(implementation),
      "0x6009",
      ERC1967_CONST2,
      ERC1967_CONST1,
      args,
    ]),
  );
}

function initCodeHashBeacon(beacon: string, args: string): string {
  const combined = ERC1967_BEACON_PREFIX + (proxyLength(args) << 56n);
  return ethers.keccak256(
    ethers.concat([
      ethers.toBeHex(combined, 10),
      ethers.getAddress(beacon),
      ERC1967_BEACON_CONST3,
      ERC1967_BEACON_CONST2,
      ERC1967_BEACON_CONST1,
      args,
    ]),
  );
}

export function derivePolymarketUupsDepositWallet(input: {
  owner: string;
  factory?: string;
  implementation?: string;
}): string {
  const factory = ethers.getAddress(
    input.factory ?? POLYMARKET_DEPOSIT_WALLET_FACTORY,
  );
  const args = depositWalletArgs(input.owner, factory);
  return ethers.getCreate2Address(
    factory,
    ethers.keccak256(args),
    initCodeHashUups(
      input.implementation ?? POLYMARKET_DEPOSIT_WALLET_IMPLEMENTATION,
      args,
    ),
  );
}

export function derivePolymarketBeaconDepositWallet(input: {
  owner: string;
  beacon: string;
  factory?: string;
}): string {
  const factory = ethers.getAddress(
    input.factory ?? POLYMARKET_DEPOSIT_WALLET_FACTORY,
  );
  const args = depositWalletArgs(input.owner, factory);
  return ethers.getCreate2Address(
    factory,
    ethers.keccak256(args),
    initCodeHashBeacon(input.beacon, args),
  );
}

function decodeAddressReturnData(value: string): string {
  const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address"],
    value,
  );
  if (typeof decoded !== "string") {
    throw new Error(
      "Polymarket Deposit Wallet factory returned invalid beacon",
    );
  }
  return ethers.getAddress(decoded);
}

export type PolymarketDepositWalletDerivation = Readonly<{
  address: string;
  deployed: boolean;
  generation: "uups" | "beacon";
  factory: string;
  implementation: string;
  beacon: string | null;
}>;

/**
 * Mirrors the current builder-relayer-client derivation without submitting a
 * relayer request. The legacy UUPS address wins when already deployed;
 * otherwise a non-zero factory beacon selects the current beacon generation.
 */
export async function inspectPolymarketDepositWallet(input: {
  owner: string;
  rpcUrl: string;
  timeoutMs: number;
  factory?: string;
  implementation?: string;
}): Promise<PolymarketDepositWalletDerivation> {
  const factory = ethers.getAddress(
    input.factory ?? POLYMARKET_DEPOSIT_WALLET_FACTORY,
  );
  const implementation = ethers.getAddress(
    input.implementation ?? POLYMARKET_DEPOSIT_WALLET_IMPLEMENTATION,
  );
  const uupsAddress = derivePolymarketUupsDepositWallet({
    owner: input.owner,
    factory,
    implementation,
  });
  let beacon = ZERO_ADDRESS;
  try {
    beacon = decodeAddressReturnData(
      await fetchEvmCall({
        rpcUrl: input.rpcUrl,
        timeoutMs: input.timeoutMs,
        to: factory,
        data: FACTORY_BEACON_SELECTOR,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (
      !message.includes("revert") &&
      !message.includes("missing revert data") &&
      !message.includes("could not decode")
    ) {
      throw error;
    }
  }
  const uupsCode = await fetchEvmCode({
    rpcUrl: input.rpcUrl,
    timeoutMs: input.timeoutMs,
    address: uupsAddress,
  });
  const uupsDeployed = uupsCode !== "0x" && uupsCode !== "0x0";
  if (beacon === ZERO_ADDRESS || uupsDeployed) {
    return {
      address: uupsAddress,
      deployed: uupsDeployed,
      generation: "uups",
      factory,
      implementation,
      beacon: null,
    };
  }
  const beaconAddress = derivePolymarketBeaconDepositWallet({
    owner: input.owner,
    factory,
    beacon,
  });
  const beaconCode = await fetchEvmCode({
    rpcUrl: input.rpcUrl,
    timeoutMs: input.timeoutMs,
    address: beaconAddress,
  });
  return {
    address: beaconAddress,
    deployed: beaconCode !== "0x" && beaconCode !== "0x0",
    generation: "beacon",
    factory,
    implementation,
    beacon,
  };
}
