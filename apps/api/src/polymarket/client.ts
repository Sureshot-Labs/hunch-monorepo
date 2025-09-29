// apps/api/src/polymarket/client.ts
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const HOST = process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYGON_CHAIN_ID ?? "137");
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY!;
const FUNDER = process.env.POLYMARKET_FUNDER;
const SIG_TYPE = process.env.POLYMARKET_SIGNATURE_TYPE
  ? Number(process.env.POLYMARKET_SIGNATURE_TYPE)
  : undefined;

export async function getClobClient(): Promise<ClobClient> {
  if (!PRIVATE_KEY) throw new Error("POLYMARKET_PRIVATE_KEY is required");
  const signer = new Wallet(PRIVATE_KEY);

  const creds = await new ClobClient(
    HOST,
    CHAIN_ID,
    signer
  ).createOrDeriveApiKey();
  return new ClobClient(HOST, CHAIN_ID, signer, creds, SIG_TYPE, FUNDER);
}
