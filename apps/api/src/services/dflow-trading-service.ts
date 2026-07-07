import {
  dflowRequest,
  type DflowRequestResult,
} from "./dflow-client.js";
import { sendSolanaRawTransaction } from "./solana-rpc.js";

type DflowQueryValue = string | number | boolean | undefined;

export function quoteDflowTrade(input: {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
  query: Record<string, DflowQueryValue>;
}): Promise<DflowRequestResult> {
  return dflowRequest({
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    method: "GET",
    requestPath: "/quote",
    apiKey: input.apiKey,
    query: input.query,
  });
}

export function buildDflowOrder(input: {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
  query: Record<string, DflowQueryValue>;
}): Promise<DflowRequestResult> {
  return dflowRequest({
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    method: "GET",
    requestPath: "/order",
    apiKey: input.apiKey,
    query: input.query,
  });
}

export function buildDflowSwap(input: {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
  body: unknown;
}): Promise<DflowRequestResult> {
  return dflowRequest({
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    method: "POST",
    requestPath: "/swap",
    apiKey: input.apiKey,
    body: input.body,
  });
}

export function submitDflowSignedTransaction(input: {
  rpcUrls: string[];
  timeoutMs: number;
  signedTransaction: string;
  skipPreflight?: boolean;
  maxRetries?: number;
}): Promise<string> {
  return sendSolanaRawTransaction(input);
}
