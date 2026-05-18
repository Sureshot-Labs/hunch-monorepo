import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";

type FunderSource = "signer" | "stored" | "magic_proxy" | "safe_proxy";
type ContractKind =
  | "EOA"
  | "SAFE_LIKE"
  | "CONTRACT"
  | "NOT_DEPLOYED"
  | "UNKNOWN";

export type PolymarketFunderCandidate = {
  funder: string;
  signatureType: 0 | 1 | 2 | 3;
  source: FunderSource;
  expectedContract: boolean;
  deployed: boolean;
  contractKind: ContractKind;
  safeOwners?: string[];
  safeThreshold?: number;
};

export type PolymarketFunderDeriveResult = {
  signer: string;
  storedFunder: string | null;
  candidates: PolymarketFunderCandidate[];
  recommended: PolymarketFunderCandidate | null;
  warnings: string[];
};

export type PolymarketDerivedFunderAddresses = {
  signer: string;
  safeProxy: string | null;
  magicProxy: string | null;
  candidates: string[];
  warnings: string[];
};

export type SafeWalletInspection =
  | { status: "safe"; owners: string[]; threshold: number }
  | { status: "not_safe" }
  | { status: "error"; error: string };

const SAFE_READ_IFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

const MAGIC_PROXY_INIT_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const MAGIC_PROXY_INIT_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function normalizeEthAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function normalizeHex32(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return trimmed;
}

function findCandidateByAddress(
  candidates: PolymarketFunderCandidate[],
  address: string | null | undefined,
): PolymarketFunderCandidate | null {
  const normalized = normalizeEthAddress(address);
  if (!normalized) return null;
  return (
    candidates.find(
      (candidate) => normalizeEthAddress(candidate.funder) === normalized,
    ) ?? null
  );
}

function isEmptyCode(code: string | null): boolean {
  return !code || code === "0x" || code === "0x0";
}

function shortErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

function buildMagicProxyInitCode(implementation: string): string {
  return `${MAGIC_PROXY_INIT_PREFIX}${implementation.slice(2)}${MAGIC_PROXY_INIT_SUFFIX}`;
}

function deriveMagicProxyAddress(signer: string): string | null {
  const factory =
    normalizeEthAddress(env.polymarketMagicProxyFactoryAddress) ?? null;
  const implementation =
    normalizeEthAddress(env.polymarketMagicProxyImplementation) ?? null;

  if (!factory || !implementation) return null;

  const initCode = buildMagicProxyInitCode(implementation);
  const initCodeHash = ethers.keccak256(initCode);
  const salt = ethers.keccak256(ethers.solidityPacked(["address"], [signer]));

  return ethers.getCreate2Address(factory, salt, initCodeHash);
}

function deriveSafeProxyAddress(signer: string): string | null {
  const factory = normalizeEthAddress(env.polymarketSafeFactoryAddress);
  const initCodeHash = normalizeHex32(env.polymarketSafeInitCodeHash);

  if (!factory || !initCodeHash) return null;

  const encodedOwner = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [signer],
  );
  const salt = ethers.keccak256(encodedOwner);

  return ethers.getCreate2Address(factory, salt, initCodeHash);
}

async function inspectSafe(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  address: string;
}): Promise<{ safe: boolean; owners?: string[]; threshold?: number }> {
  try {
    const ownersData = SAFE_READ_IFACE.encodeFunctionData("getOwners");
    const ownersRaw = await fetchEvmCall({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      to: inputs.address,
      data: ownersData,
    });
    const ownersDecoded = SAFE_READ_IFACE.decodeFunctionResult(
      "getOwners",
      ownersRaw,
    ) as unknown;
    const owners = Array.isArray(ownersDecoded)
      ? (ownersDecoded[0] as unknown)
      : null;
    if (!Array.isArray(owners) || owners.length === 0) {
      return { safe: false };
    }

    const thresholdData = SAFE_READ_IFACE.encodeFunctionData("getThreshold");
    const thresholdRaw = await fetchEvmCall({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      to: inputs.address,
      data: thresholdData,
    });
    const thresholdDecoded = SAFE_READ_IFACE.decodeFunctionResult(
      "getThreshold",
      thresholdRaw,
    ) as unknown;
    const thresholdValue = Array.isArray(thresholdDecoded)
      ? thresholdDecoded[0]
      : null;
    if (typeof thresholdValue !== "bigint") {
      return { safe: false };
    }
    const thresholdNumber = Number(thresholdValue);
    if (!Number.isFinite(thresholdNumber)) {
      return { safe: false };
    }

    const normalizedOwners = owners
      .map((owner) =>
        typeof owner === "string" ? normalizeEthAddress(owner) : null,
      )
      .filter((owner): owner is string => Boolean(owner));

    const safe =
      thresholdNumber >= 1 &&
      thresholdNumber <= normalizedOwners.length &&
      normalizedOwners.length > 0;

    return safe
      ? { safe: true, owners: normalizedOwners, threshold: thresholdNumber }
      : { safe: false };
  } catch {
    return { safe: false };
  }
}

async function inspectSafeStrict(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  address: string;
}): Promise<SafeWalletInspection> {
  try {
    const ownersData = SAFE_READ_IFACE.encodeFunctionData("getOwners");
    const ownersRaw = await fetchEvmCall({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      to: inputs.address,
      data: ownersData,
    });
    const ownersDecoded = SAFE_READ_IFACE.decodeFunctionResult(
      "getOwners",
      ownersRaw,
    ) as unknown;
    const owners = Array.isArray(ownersDecoded)
      ? (ownersDecoded[0] as unknown)
      : null;
    if (!Array.isArray(owners) || owners.length === 0) {
      return { status: "not_safe" };
    }

    const thresholdData = SAFE_READ_IFACE.encodeFunctionData("getThreshold");
    const thresholdRaw = await fetchEvmCall({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      to: inputs.address,
      data: thresholdData,
    });
    const thresholdDecoded = SAFE_READ_IFACE.decodeFunctionResult(
      "getThreshold",
      thresholdRaw,
    ) as unknown;
    const thresholdValue = Array.isArray(thresholdDecoded)
      ? thresholdDecoded[0]
      : null;
    if (typeof thresholdValue !== "bigint") {
      return { status: "not_safe" };
    }
    const thresholdNumber = Number(thresholdValue);
    if (!Number.isFinite(thresholdNumber)) {
      return { status: "not_safe" };
    }

    const normalizedOwners = owners
      .map((owner) =>
        typeof owner === "string" ? normalizeEthAddress(owner) : null,
      )
      .filter((owner): owner is string => Boolean(owner));

    const safe =
      thresholdNumber >= 1 &&
      thresholdNumber <= normalizedOwners.length &&
      normalizedOwners.length > 0;

    return safe
      ? { status: "safe", owners: normalizedOwners, threshold: thresholdNumber }
      : { status: "not_safe" };
  } catch (error) {
    const message = shortErrorMessage(error);
    if (
      message.includes("execution reverted") ||
      message.includes("call revert exception") ||
      message.includes("missing revert data") ||
      message.includes("could not decode result data")
    ) {
      return { status: "not_safe" };
    }
    return { status: "error", error: message };
  }
}

async function inspectCandidate(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  funder: string;
  expectedContract: boolean;
  bypassCodeCache?: boolean;
}): Promise<{
  deployed: boolean;
  contractKind: ContractKind;
  safeOwners?: string[];
  safeThreshold?: number;
}> {
  try {
    const code = await fetchEvmCode({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      address: inputs.funder,
      bypassCache: inputs.bypassCodeCache,
    });

    if (isEmptyCode(code)) {
      if (inputs.expectedContract) {
        return { deployed: false, contractKind: "NOT_DEPLOYED" };
      }
      return { deployed: true, contractKind: "EOA" };
    }

    const safeInfo = await inspectSafe({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      address: inputs.funder,
    });

    return {
      deployed: true,
      contractKind: safeInfo.safe ? "SAFE_LIKE" : "CONTRACT",
      safeOwners: safeInfo.owners,
      safeThreshold: safeInfo.threshold,
    };
  } catch {
    return { deployed: false, contractKind: "UNKNOWN" };
  }
}

export async function inspectSafeWallet(inputs: {
  address: string;
  rpcUrl?: string;
  timeoutMs?: number;
}): Promise<{ safe: boolean; owners?: string[]; threshold?: number }> {
  const normalized = normalizeEthAddress(inputs.address);
  if (!normalized) return { safe: false };
  const rpcUrl = inputs.rpcUrl ?? env.polygonRpcUrl;
  const timeoutMs = inputs.timeoutMs ?? env.polygonRpcTimeoutMs;

  try {
    const code = await fetchEvmCode({
      rpcUrl,
      timeoutMs,
      address: normalized,
    });
    if (isEmptyCode(code)) return { safe: false };
  } catch {
    return { safe: false };
  }

  return inspectSafe({ rpcUrl, timeoutMs, address: normalized });
}

export async function inspectSafeWalletStrict(inputs: {
  address: string;
  rpcUrl?: string;
  timeoutMs?: number;
}): Promise<SafeWalletInspection> {
  const normalized = normalizeEthAddress(inputs.address);
  if (!normalized) return { status: "not_safe" };
  const rpcUrl = inputs.rpcUrl ?? env.polygonRpcUrl;
  const timeoutMs = inputs.timeoutMs ?? env.polygonRpcTimeoutMs;

  let code: string;
  try {
    code = await fetchEvmCode({
      rpcUrl,
      timeoutMs,
      address: normalized,
    });
  } catch (error) {
    return { status: "error", error: shortErrorMessage(error) };
  }
  if (isEmptyCode(code)) return { status: "not_safe" };

  return inspectSafeStrict({ rpcUrl, timeoutMs, address: normalized });
}

export function derivePolymarketFunderAddresses(inputs: {
  signer: string;
  includeMagicProxy?: boolean;
}): PolymarketDerivedFunderAddresses {
  const signerAddress = normalizeEthAddress(inputs.signer);
  if (!signerAddress) {
    return {
      signer: inputs.signer,
      safeProxy: null,
      magicProxy: null,
      candidates: [],
      warnings: ["Signer address is not a valid EVM address."],
    };
  }

  const warnings: string[] = [];
  const safeProxy = deriveSafeProxyAddress(signerAddress);
  const magicProxy = inputs.includeMagicProxy
    ? deriveMagicProxyAddress(signerAddress)
    : null;
  const candidates = [signerAddress];

  if (safeProxy) {
    candidates.push(safeProxy);
  } else {
    warnings.push("Safe proxy derivation is not configured.");
  }

  if (inputs.includeMagicProxy) {
    if (magicProxy) {
      candidates.push(magicProxy);
    } else {
      warnings.push("Magic proxy derivation is not configured.");
    }
  }

  return {
    signer: signerAddress,
    safeProxy,
    magicProxy,
    candidates,
    warnings,
  };
}

export async function derivePolymarketFunders(inputs: {
  signer: string;
  storedFunder?: string | null;
  includeMagicProxy?: boolean;
  bypassCodeCache?: boolean;
}): Promise<PolymarketFunderDeriveResult> {
  const derivedAddresses = derivePolymarketFunderAddresses({
    signer: inputs.signer,
    includeMagicProxy: inputs.includeMagicProxy,
  });
  const warnings = [...derivedAddresses.warnings];
  const candidates: PolymarketFunderCandidate[] = [];
  const candidateKeys = new Set<string>();

  const signerAddress = normalizeEthAddress(derivedAddresses.signer);
  if (!signerAddress) {
    return {
      signer: inputs.signer,
      storedFunder: inputs.storedFunder ?? null,
      candidates: [],
      recommended: null,
      warnings: ["Signer address is not a valid EVM address."],
    };
  }

  const storedFunder = normalizeEthAddress(inputs.storedFunder ?? null);

  const addCandidate = (candidate: PolymarketFunderCandidate): void => {
    const key = candidate.funder.toLowerCase();
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push(candidate);
  };

  const safeFunder = derivedAddresses.safeProxy;
  const magicFunder = derivedAddresses.magicProxy;

  const storedMatchesMagic =
    Boolean(storedFunder && magicFunder) && storedFunder === magicFunder;
  const storedMatchesSafe =
    Boolean(storedFunder && safeFunder) && storedFunder === safeFunder;
  const storedMatchesCanonical =
    storedMatchesSafe ||
    (Boolean(inputs.includeMagicProxy) && storedMatchesMagic);

  if (
    storedFunder &&
    storedFunder !== signerAddress &&
    !storedMatchesCanonical
  ) {
    addCandidate({
      funder: storedFunder,
      signatureType: storedMatchesMagic ? 1 : 3,
      source: "stored",
      expectedContract: true,
      deployed: false,
      contractKind: "UNKNOWN",
    });
  }

  if (safeFunder) {
    addCandidate({
      funder: safeFunder,
      signatureType: 2,
      source: "safe_proxy",
      expectedContract: true,
      deployed: false,
      contractKind: "UNKNOWN",
    });
  }

  if (inputs.includeMagicProxy) {
    if (magicFunder) {
      addCandidate({
        funder: magicFunder,
        signatureType: 1,
        source: "magic_proxy",
        expectedContract: true,
        deployed: false,
        contractKind: "UNKNOWN",
      });
    }
  }

  for (const candidate of candidates) {
    if (candidate.source === "signer") continue;
    const inspection = await inspectCandidate({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      funder: candidate.funder,
      expectedContract: candidate.expectedContract,
      bypassCodeCache: inputs.bypassCodeCache,
    });
    candidate.deployed = inspection.deployed;
    candidate.contractKind = inspection.contractKind;
    candidate.safeOwners = inspection.safeOwners;
    candidate.safeThreshold = inspection.safeThreshold;
    if (candidate.source === "stored" && candidate.signatureType !== 1) {
      if (inspection.contractKind === "EOA") {
        candidate.signatureType = 0;
        candidate.expectedContract = false;
      } else if (inspection.contractKind === "SAFE_LIKE") {
        candidate.signatureType = 2;
        candidate.expectedContract = true;
      } else {
        candidate.signatureType = 3;
        candidate.expectedContract = true;
      }
    }
  }

  const isSupportedExecutionCandidate = (
    candidate: PolymarketFunderCandidate | null | undefined,
  ) =>
    Boolean(
      candidate?.deployed &&
      (candidate.signatureType === 3 ||
        (candidate.signatureType === 2 && candidate.contractKind !== "EOA")),
    );
  const storedRecommended = findCandidateByAddress(candidates, storedFunder);
  const recommended =
    (isSupportedExecutionCandidate(storedRecommended)
      ? storedRecommended
      : null) ??
    candidates.find(
      (candidate) =>
        candidate.source === "stored" &&
        isSupportedExecutionCandidate(candidate),
    ) ??
    candidates.find(
      (candidate) =>
        candidate.source === "safe_proxy" &&
        isSupportedExecutionCandidate(candidate),
    ) ??
    null;

  if (storedFunder && storedFunder !== signerAddress) {
    const storedCandidate = candidates.find(
      (candidate) => candidate.source === "stored",
    );
    if (storedCandidate?.contractKind === "EOA") {
      warnings.push(
        "Stored Polymarket funder is an EOA and can no longer execute trades. Deploy a deposit wallet.",
      );
    }
  }

  return {
    signer: signerAddress,
    storedFunder: storedFunder ?? null,
    candidates,
    recommended,
    warnings,
  };
}

export async function validatePolymarketFunderSelection(inputs: {
  signer: string;
  funderAddress: string | null | undefined;
  includeMagicProxy?: boolean;
}): Promise<{
  funderAddress: string | null;
  candidate: PolymarketFunderCandidate | null;
}> {
  const signer = normalizeEthAddress(inputs.signer);
  if (!signer) {
    throw new Error("Signer address is not a valid EVM address.");
  }

  const funderAddress = normalizeEthAddress(inputs.funderAddress ?? null);
  if (!funderAddress) {
    return { funderAddress: null, candidate: null };
  }
  if (funderAddress === signer) {
    throw new Error(
      "Polymarket requires a deposit wallet or deployed legacy Safe funder.",
    );
  }

  const result = await derivePolymarketFunders({
    signer,
    storedFunder: funderAddress,
    includeMagicProxy: inputs.includeMagicProxy ?? true,
    bypassCodeCache: true,
  });
  const candidate = findCandidateByAddress(result.candidates, funderAddress);
  if (
    !candidate ||
    candidate.signatureType === 0 ||
    candidate.signatureType === 1
  ) {
    throw new Error(
      "Polymarket requires a deposit wallet or deployed legacy Safe funder.",
    );
  }
  if (candidate?.expectedContract && candidate.deployed === false) {
    throw new Error("Polymarket wallet is not deployed yet.");
  }

  return {
    funderAddress: candidate?.funder ?? funderAddress,
    candidate,
  };
}
