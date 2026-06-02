import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { getRedis } from "../redis.js";
import {
  embeddedEvmExecuteBodySchema,
  embeddedEvmPrepareBodySchema,
  embeddedSolanaDirectTransferSponsorshipIntentBodySchema,
  embeddedSolanaExecuteBodySchema,
  embeddedSolanaPrepareBodySchema,
} from "../schemas/embedded-wallets.js";
import { env } from "../env.js";
import {
  executeEmbeddedEthereumTransactionRequests,
  prepareEmbeddedEthereumTransactionRequests,
  resolveEmbeddedEthereumWalletContext,
} from "../services/embedded-ethereum.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  executeEmbeddedSolanaSignTransactionRequests,
  executeEmbeddedSolanaTransactionRequestsDetailed,
  prepareEmbeddedSolanaSignTransactionRequests,
  prepareEmbeddedSolanaTransactionRequests,
  resolveEmbeddedSolanaWalletContext,
  type EmbeddedPrivyAuthorizationRequest,
} from "../services/embedded-solana.js";
import {
  createEmbeddedSolanaSponsorshipIntent,
  getEmbeddedSolanaDirectTransferAmountRaw,
  releaseEmbeddedSolanaSponsorshipBudget,
  reserveEmbeddedSolanaSponsorshipBudget,
  shouldRequireEmbeddedSolanaSponsorshipRedis,
  validateEmbeddedSolanaSponsorshipIntentCandidate,
} from "../services/embedded-solana-sponsorship.js";
import { resolveAuthAccessPolicy } from "../services/runtime-policies.js";
import { upsertSolanaSponsorshipLedger } from "../services/solana-sponsorship-ledger.js";

const EMBEDDED_SOLANA_PREPARED_TTL_SEC = 300;

type EmbeddedSolanaPreparedCacheEntry = {
  expiresAt: number;
  requests: EmbeddedPrivyAuthorizationRequest[];
};

type RouteLogger = {
  warn: (obj: object, message?: string) => void;
};

type SolanaSponsorshipFlow = "dflow" | "across" | "directTransfer" | "debridge";

class EmbeddedSolanaSponsorshipLedgerDurabilityError extends Error {
  cause: unknown;
  requestId: string;
  signature: string;
  transactionId: string | null;
  sponsorshipIntentId: string | null;

  constructor(inputs: {
    cause: unknown;
    requestId: string;
    signature: string;
    transactionId: string | null;
    sponsorshipIntentId: string | null;
  }) {
    super("Sponsored Solana transaction submitted but ledger update failed.");
    this.name = "EmbeddedSolanaSponsorshipLedgerDurabilityError";
    this.cause = inputs.cause;
    this.requestId = inputs.requestId;
    this.signature = inputs.signature;
    this.transactionId = inputs.transactionId;
    this.sponsorshipIntentId = inputs.sponsorshipIntentId;
  }
}

const embeddedSolanaPreparedMemory = new Map<
  string,
  EmbeddedSolanaPreparedCacheEntry
>();

function pruneExpiredEmbeddedSolanaPreparedMemory(now = Date.now()): void {
  for (const [key, entry] of embeddedSolanaPreparedMemory) {
    if (entry.expiresAt <= now) embeddedSolanaPreparedMemory.delete(key);
  }
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function buildEmbeddedSolanaPreparedCacheKey(inputs: {
  signer: string;
  operation: "sign" | "signAndSend";
  executionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `embedded-solana:prepared:${inputs.operation}:${inputs.signer.trim()}:${inputs.executionKey.trim()}`,
    )
    .digest("hex");
  return `embedded-solana:prepared:${digest}`;
}

function parseEmbeddedSolanaPreparedRequests(
  raw: string | null,
): EmbeddedPrivyAuthorizationRequest[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { requests?: unknown }).requests)
    ) {
      return null;
    }
    return (parsed as { requests: EmbeddedPrivyAuthorizationRequest[] })
      .requests;
  } catch {
    return null;
  }
}

async function cacheEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  operation: "sign" | "signAndSend";
  executionKey: string | null | undefined;
  requests: EmbeddedPrivyAuthorizationRequest[];
  log: RouteLogger;
}): Promise<void> {
  const executionKey = inputs.executionKey?.trim() ?? "";
  if (!executionKey) return;

  pruneExpiredEmbeddedSolanaPreparedMemory();

  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    operation: inputs.operation,
    executionKey,
  });
  embeddedSolanaPreparedMemory.set(key, {
    expiresAt: Date.now() + EMBEDDED_SOLANA_PREPARED_TTL_SEC * 1000,
    requests: inputs.requests,
  });

  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify({ requests: inputs.requests }), {
      EX: EMBEDDED_SOLANA_PREPARED_TTL_SEC,
    });
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to cache prepared embedded Solana requests in Redis",
    );
  }
}

async function readCachedEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  operation: "sign" | "signAndSend";
  executionKey: string;
  log: RouteLogger;
}): Promise<EmbeddedPrivyAuthorizationRequest[] | null> {
  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    operation: inputs.operation,
    executionKey: inputs.executionKey,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const cached = parseEmbeddedSolanaPreparedRequests(await redis.get(key));
      if (cached) return cached;
    }
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read prepared embedded Solana requests from Redis",
    );
  }

  const memoryEntry = embeddedSolanaPreparedMemory.get(key);
  if (!memoryEntry) return null;
  if (memoryEntry.expiresAt <= Date.now()) {
    embeddedSolanaPreparedMemory.delete(key);
    return null;
  }
  return memoryEntry.requests;
}

function getSolanaSponsorshipVenue(
  flow: SolanaSponsorshipFlow | null | undefined,
): "kalshi" | "bridge" | "wallet" | null {
  if (flow === "dflow") return "kalshi";
  if (flow === "across" || flow === "debridge") return "bridge";
  if (flow === "directTransfer") return "wallet";
  return null;
}

function isSolanaSponsorshipFlow(
  value: string | null | undefined,
): value is SolanaSponsorshipFlow {
  return (
    value === "dflow" ||
    value === "across" ||
    value === "directTransfer" ||
    value === "debridge"
  );
}

async function markSubmittedSolanaSponsorshipRequest(inputs: {
  userId: string;
  signer: string;
  request: EmbeddedPrivyAuthorizationRequest;
  signature: string;
  transactionId: string | null;
  caip2: string | null;
}): Promise<void> {
  const sponsorship = inputs.request.solanaSponsorship;
  if (!sponsorship?.actualSponsor || !sponsorship.sponsorshipIntentId) return;
  if (!isSolanaSponsorshipFlow(sponsorship.flow)) return;
  const venue = getSolanaSponsorshipVenue(sponsorship.flow);
  if (!venue) return;

  await upsertSolanaSponsorshipLedger({
    userId: inputs.userId,
    venue,
    flow: sponsorship.flow,
    status: "submitted",
    intentId: sponsorship.sponsorshipIntentId,
    walletAddress: inputs.signer,
    transactionDigest: sponsorship.transactionDigest,
    txSignature: inputs.signature,
    estimatedSponsorLamports: sponsorship.estimatedSponsorLamports,
    metadata: {
      requestId: inputs.request.id,
      label: inputs.request.label,
      submittedAt: new Date().toISOString(),
      actualSponsor: true,
      requestedSponsor: sponsorship.requestedSponsor,
      enforceWouldSponsor: sponsorship.enforceWouldSponsor,
      reasons: sponsorship.reasons,
      ...(inputs.transactionId ? { privyTransactionId: inputs.transactionId } : {}),
      ...(inputs.caip2 ? { caip2: inputs.caip2 } : {}),
    },
  });
}

export const embeddedWalletRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/wallets/embedded/ethereum/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const requests = prepareEmbeddedEthereumTransactionRequests({
          context,
          chainId: request.body.chainId,
          transactions: request.body.transactions,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          chainId: request.body.chainId,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to prepare embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/ethereum/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "ethereum",
            context.signer,
            request.body.chainId,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = prepareEmbeddedEthereumTransactionRequests({
              context,
              chainId: request.body.chainId,
              transactions: request.body.transactions,
            });
            const transactionHashes =
              await executeEmbeddedEthereumTransactionRequests({
                chainId: request.body.chainId,
                requests,
                signatures: request.body.signedRequests,
              });
            return {
              ok: true,
              signer: context.signer,
              chainId: request.body.chainId,
              transactionHashes,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to execute embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/direct-transfer/sponsorship-intent",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaDirectTransferSponsorshipIntentBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const authAccessPolicy = await resolveAuthAccessPolicy(pool);
        const disabledReasons: string[] = [];
        if (authAccessPolicy.effective.embeddedSolanaSponsorship !== true) {
          disabledReasons.push("sponsorship_disabled");
        }
        if (
          authAccessPolicy.effective.embeddedSolanaSponsorshipFlows
            .directTransfer !== true
        ) {
          disabledReasons.push("flow_directTransfer_disabled");
        }
        if (request.body.mint !== env.solanaUsdcMint) {
          disabledReasons.push("unsupported_mint");
        }
        const minAmountRaw =
          authAccessPolicy.effective.embeddedSolanaSponsorshipLimits
            .directTransfer.minAmountRaw ?? "0";
        if (BigInt(request.body.amountRaw) < BigInt(minAmountRaw)) {
          disabledReasons.push("amount_below_minimum");
        }

        const metadata = {
          directTransferSponsorshipEligible: true,
          amountRaw: request.body.amountRaw,
          mint: request.body.mint,
          recipientAddress: request.body.recipientAddress,
          maxSystemCreateLamports: "0",
        };
        const validation = validateEmbeddedSolanaSponsorshipIntentCandidate({
          flow: "directTransfer",
          userId: user.id,
          signer: context.signer,
          transaction: request.body.transaction,
          metadata,
        });
        const actualAmountRaw = getEmbeddedSolanaDirectTransferAmountRaw({
          analysis: validation.analysis,
          signer: context.signer,
        });
        if (actualAmountRaw !== request.body.amountRaw) {
          disabledReasons.push("amount_mismatch");
        }
        if (!validation.ok) disabledReasons.push(...validation.reasons);

        if (disabledReasons.length) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            sponsorshipIntentId: null,
            reasons: Array.from(new Set(disabledReasons)),
          });
        }

        const budget = await reserveEmbeddedSolanaSponsorshipBudget({
          flow: "directTransfer",
          walletAddress: context.signer,
          estimatedLamports: validation.analysis.estimatedSponsorLamports,
          limits: authAccessPolicy.effective.embeddedSolanaSponsorshipLimits,
          requireRedis: shouldRequireEmbeddedSolanaSponsorshipRedis({
            mode: authAccessPolicy.effective.embeddedSolanaSponsorshipMode,
            observeCanSponsor: env.embeddedSolanaSponsorshipObserveCanSponsor,
          }),
        });
        if (!budget.ok) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            sponsorshipIntentId: null,
            reasons: budget.reasons,
          });
        }

        const intent = await createEmbeddedSolanaSponsorshipIntent({
          flow: "directTransfer",
          userId: user.id,
          signer: context.signer,
          transaction: request.body.transaction,
          metadata,
        });
        if (!intent) {
          await releaseEmbeddedSolanaSponsorshipBudget(budget.reservation);
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            sponsorshipIntentId: null,
            reasons: ["intent_create_failed"],
          });
        }
        try {
          await upsertSolanaSponsorshipLedger({
            userId: user.id,
            venue: "wallet",
            flow: "directTransfer",
            status: "intent_created",
            intentId: intent.id,
            walletAddress: context.signer,
            inputMint: request.body.mint,
            outputMint: request.body.mint,
            amountRaw: request.body.amountRaw,
            transactionDigest: validation.analysis.digest,
            estimatedSponsorLamports:
              validation.analysis.estimatedSponsorLamports,
            metadata: {
              recipientAddress: request.body.recipientAddress,
              analysis: {
                programIds: validation.analysis.programIds,
                estimatedSponsorLamports:
                  validation.analysis.estimatedSponsorLamports,
              },
            },
          });
        } catch (error) {
          await releaseEmbeddedSolanaSponsorshipBudget(budget.reservation);
          throw error;
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          sponsorshipIntentId: intent.id,
          reasons: [],
        });
      } catch (error) {
        app.log.warn(
          { error, userId: user.id, signer },
          "Failed to create embedded Solana direct transfer sponsorship intent",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to create Solana sponsorship intent",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const authAccessPolicy = await resolveAuthAccessPolicy(pool);
        const executionKey = request.body.executionKey ?? null;
        const requests = await prepareEmbeddedSolanaTransactionRequests({
          context,
          executionKey,
          transactions: request.body.transactions,
          userId: user.id,
          embeddedSolanaSponsorshipEnabled:
            authAccessPolicy.effective.embeddedSolanaSponsorship === true,
          embeddedSolanaSponsorshipMode:
            authAccessPolicy.effective.embeddedSolanaSponsorshipMode,
          embeddedSolanaSponsorshipFlows:
            authAccessPolicy.effective.embeddedSolanaSponsorshipFlows,
          onSponsorBalanceFetchError: (error) => {
            app.log.warn(
              { error, userId: user.id, signer: context.signer },
              "Embedded Solana balance fetch failed",
            );
          },
          onAuditLogError: (error) => {
            app.log.warn(
              { error, userId: user.id, signer: context.signer },
              "Embedded Solana sponsorship audit write failed",
            );
          },
        });
        await cacheEmbeddedSolanaPreparedRequests({
          signer: context.signer,
          operation: "signAndSend",
          executionKey,
          requests,
          log: app.log,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
          },
          "Failed to prepare embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded Solana transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "solana",
            context.signer,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = await readCachedEmbeddedSolanaPreparedRequests({
              signer: context.signer,
              operation: "signAndSend",
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!requests) {
              throw new Error(
                "Prepared Solana authorization expired. Refresh quote and try again.",
              );
            }
            const results = await executeEmbeddedSolanaTransactionRequestsDetailed({
              requests,
              signatures: request.body.signedRequests,
              onResult: async (result) => {
                try {
                  await markSubmittedSolanaSponsorshipRequest({
                    userId: user.id,
                    signer: context.signer,
                    request: result.request,
                    signature: result.signature,
                    transactionId: result.transactionId,
                    caip2: result.caip2,
                  });
                } catch (error) {
                  const sponsorshipIntentId =
                    result.request.solanaSponsorship?.sponsorshipIntentId ??
                    null;
                  app.log.error(
                    {
                      error,
                      userId: user.id,
                      signer: context.signer,
                      requestId: result.request.id,
                      signature: result.signature,
                      transactionId: result.transactionId,
                      sponsorshipIntentId,
                    },
                    "Embedded Solana sponsored transaction submitted but ledger update failed",
                  );
                  throw new EmbeddedSolanaSponsorshipLedgerDurabilityError({
                    cause: error,
                    requestId: result.request.id,
                    signature: result.signature,
                    transactionId: result.transactionId,
                    sponsorshipIntentId,
                  });
                }
              },
            });
            return {
              ok: true,
              signer: context.signer,
              signatures: results.map((result) => result.signature),
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        if (error instanceof EmbeddedSolanaSponsorshipLedgerDurabilityError) {
          app.log.error(
            {
              error,
              userId: user.id,
              executionKey: request.body.executionKey,
              signer,
              requestId: error.requestId,
              signature: error.signature,
              transactionId: error.transactionId,
              sponsorshipIntentId: error.sponsorshipIntentId,
            },
            "Failed to durably record embedded Solana sponsored submit",
          );
          reply.code(500);
          return reply.send({
            error: "sponsorship_ledger_not_durable",
            message: error.message,
            requestId: error.requestId,
            signature: error.signature,
            transactionId: error.transactionId,
            sponsorshipIntentId: error.sponsorshipIntentId,
          });
        }
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer,
          },
          "Failed to execute embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded Solana transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/sign/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const executionKey = request.body.executionKey ?? null;
        const requests = prepareEmbeddedSolanaSignTransactionRequests({
          context,
          executionKey,
          transactions: request.body.transactions,
        });
        await cacheEmbeddedSolanaPreparedRequests({
          signer: context.signer,
          operation: "sign",
          executionKey,
          requests,
          log: app.log,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
          },
          "Failed to prepare embedded Solana sign transaction",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded Solana sign transaction",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/sign/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "solana-sign",
            context.signer,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = await readCachedEmbeddedSolanaPreparedRequests({
              signer: context.signer,
              operation: "sign",
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!requests) {
              throw new Error(
                "Prepared Solana sign authorization expired. Refresh quote and try again.",
              );
            }
            const signedTransactions =
              await executeEmbeddedSolanaSignTransactionRequests({
                requests,
                signatures: request.body.signedRequests,
              });
            return {
              ok: true,
              signer: context.signer,
              signedTransactions,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer,
          },
          "Failed to execute embedded Solana sign transaction",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded Solana sign transaction",
        });
      }
    },
  );
};
