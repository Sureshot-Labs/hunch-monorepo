import { ethers } from "ethers";

// Sidecar-safe address derivation: never import the API-wide env module here.
export function deriveSafeProxyAddress(
  signer: string,
  factory = process.env.POLYMARKET_SAFE_FACTORY_ADDRESS?.trim() ||
    "0xaacfeea03eb1561c4e67d661e40682bd20e3541b",
  initCodeHash = process.env.POLYMARKET_SAFE_INIT_CODE_HASH?.trim() ||
    "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf",
): string | null {
  try {
    const salt = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [signer]),
    );
    return ethers.getCreate2Address(
      ethers.getAddress(factory),
      salt,
      initCodeHash,
    );
  } catch {
    return null;
  }
}
