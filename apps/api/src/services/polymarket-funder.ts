import { Interface, ethers } from "ethers";
import { env } from "../env.js";
import { fetchEvmCall, fetchEvmCode } from "./polygon-rpc.js";

type FunderSource = "signer" | "stored" | "magic_proxy" | "safe_proxy";
type ContractKind = "EOA" | "SAFE_LIKE" | "CONTRACT" | "NOT_DEPLOYED" | "UNKNOWN";

export type PolymarketFunderCandidate = {
  funder: string;
  signatureType: 0 | 1 | 2;
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

const SAFE_READ_IFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

const MAGIC_PROXY_INIT_PREFIX =
  "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
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

function isEmptyCode(code: string | null): boolean {
  return !code || code === "0x" || code === "0x0";
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
  const salt = ethers.keccak256(
    ethers.solidityPacked(["address"], [signer]),
  );

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
      .map((owner) => (typeof owner === "string" ? normalizeEthAddress(owner) : null))
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

async function inspectCandidate(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  funder: string;
  expectedContract: boolean;
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

export async function derivePolymarketFunders(inputs: {
  signer: string;
  storedFunder?: string | null;
  includeMagicProxy?: boolean;
}): Promise<PolymarketFunderDeriveResult> {
  const warnings: string[] = [];
  const candidates: PolymarketFunderCandidate[] = [];
  const candidateKeys = new Set<string>();

  const signerAddress = normalizeEthAddress(inputs.signer);
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

  const signerCandidate: PolymarketFunderCandidate = {
    funder: signerAddress,
    signatureType: 0,
    source: "signer",
    expectedContract: false,
    deployed: true,
    contractKind: "EOA",
  };
  const addCandidate = (candidate: PolymarketFunderCandidate): void => {
    const key = candidate.funder.toLowerCase();
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push(candidate);
  };

  addCandidate(signerCandidate);

  const safeFunder = deriveSafeProxyAddress(signerAddress);
  const magicFunder =
    inputs.includeMagicProxy ? deriveMagicProxyAddress(signerAddress) : null;

  const storedMatchesMagic =
    Boolean(storedFunder && magicFunder) && storedFunder === magicFunder;
  const storedMatchesSafe =
    Boolean(storedFunder && safeFunder) && storedFunder === safeFunder;

  if (storedFunder && storedFunder !== signerAddress) {
    addCandidate({
      funder: storedFunder,
      signatureType: storedMatchesMagic ? 1 : 2,
      source: "stored",
      expectedContract: storedMatchesMagic || storedMatchesSafe,
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
  } else {
    warnings.push("Safe proxy derivation is not configured.");
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
    } else {
      warnings.push("Magic proxy derivation is not configured.");
    }
  }

  for (const candidate of candidates) {
    if (candidate.source === "signer") continue;
    const inspection = await inspectCandidate({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      funder: candidate.funder,
      expectedContract: candidate.expectedContract,
    });
    candidate.deployed = inspection.deployed;
    candidate.contractKind = inspection.contractKind;
    candidate.safeOwners = inspection.safeOwners;
    candidate.safeThreshold = inspection.safeThreshold;
    if (candidate.source === "stored" && candidate.signatureType !== 1) {
      if (inspection.contractKind === "EOA") {
        candidate.signatureType = 0;
        candidate.expectedContract = false;
      } else {
        candidate.signatureType = 2;
        candidate.expectedContract = true;
      }
    }
  }

  const recommended =
    candidates.find((candidate) => candidate.source === "stored") ??
    candidates.find(
      (candidate) =>
        candidate.source === "safe_proxy" &&
        candidate.deployed &&
        candidate.contractKind !== "EOA",
    ) ??
    candidates.find((candidate) => candidate.source === "signer") ??
    null;

  if (storedFunder && storedFunder !== signerAddress) {
    const storedCandidate = candidates.find(
      (candidate) => candidate.source === "stored",
    );
    if (storedCandidate?.contractKind === "EOA") {
      warnings.push(
        "Stored funder is an EOA; ensure approvals are granted from that wallet.",
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
