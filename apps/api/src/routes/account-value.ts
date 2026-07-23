import type {
  FastifyInstance,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  buildAccountValueReadModel,
  type AccountValueReadModel,
} from "../account-value/runtime-service.js";
import {
  accountAssetPreferenceBodySchema,
  accountAssetPreferenceParamsSchema,
  accountAssetPreferenceResponseSchema,
  accountAssetsQuerySchema,
  accountAssetsResponseSchema,
  accountValueAuthErrorResponseSchema,
  accountValueErrorResponseSchema,
  accountValueResponseSchema,
} from "../schemas/account-value.js";
import { upsertAssetFundingPreference } from "../account-value/asset-preferences.js";

export type AccountValueRouteDependencies = Readonly<{
  authenticate: preHandlerHookHandler;
  build: (userId: string) => Promise<AccountValueReadModel>;
  setPreference: (
    userId: string,
    component: AccountValueReadModel["projection"]["components"][number],
    preference: "ask" | "suggest" | "never_suggest",
  ) => Promise<{
    componentId: string;
    preference: "ask" | "suggest" | "never_suggest";
    revision: string;
  }>;
}>;

export function registerAccountValueRoutes(
  app: FastifyInstance,
  dependencies: AccountValueRouteDependencies,
): void {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/account/value",
    {
      preHandler: dependencies.authenticate,
      schema: {
        response: {
          200: accountValueResponseSchema,
          401: accountValueAuthErrorResponseSchema,
          403: accountValueAuthErrorResponseSchema,
          502: accountValueErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", code: "account_not_authenticated" });
      }
      try {
        const account = await dependencies.build(request.user.id);
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          accountValueResponseSchema.parse({ ok: true, account }),
        );
      } catch (error) {
        app.log.error(
          { error, userId: request.user.id },
          "Account value projection failed",
        );
        return reply.code(502).send({
          error: "Account value is temporarily unavailable",
          code: "account_value_projection_failed",
        });
      }
    },
  );

  z.get(
    "/account/assets",
    {
      preHandler: dependencies.authenticate,
      schema: {
        querystring: accountAssetsQuerySchema,
        response: {
          200: accountAssetsResponseSchema,
          401: accountValueAuthErrorResponseSchema,
          403: accountValueAuthErrorResponseSchema,
          502: accountValueErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", code: "account_not_authenticated" });
      }
      try {
        const account = await dependencies.build(request.user.id);
        const query = request.query;
        const assetItems = account.projection.components.filter(
          (component) =>
            (!query.category || query.category === component.category) &&
            (!query.valuationEligibility ||
              query.valuationEligibility === component.valuationEligibility),
        );
        const positionItems = account.projection.positionComponents.filter(
          (component) =>
            (!query.category || query.category === "position") &&
            (!query.valuationEligibility ||
              query.valuationEligibility === component.valuationEligibility),
        );
        const filteredItems = [...assetItems, ...positionItems].sort(
          (left, right) => left.componentId.localeCompare(right.componentId),
        );
        const cursor = query.cursor;
        const afterCursor = cursor
          ? filteredItems.filter((component) => component.componentId > cursor)
          : filteredItems;
        const items = afterCursor.slice(0, query.limit);
        const nextCursor =
          afterCursor.length > query.limit
            ? (items.at(-1)?.componentId ?? null)
            : null;
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          accountAssetsResponseSchema.parse({
            ok: true,
            asOf: account.projection.asOf,
            items,
            total: filteredItems.length,
            nextCursor,
          }),
        );
      } catch (error) {
        app.log.error(
          { error, userId: request.user.id },
          "Account asset projection failed",
        );
        return reply.code(502).send({
          error: "Account assets are temporarily unavailable",
          code: "account_asset_projection_failed",
        });
      }
    },
  );

  z.patch(
    "/account/assets/:componentId/funding-preference",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: accountAssetPreferenceParamsSchema,
        body: accountAssetPreferenceBodySchema,
        response: {
          200: accountAssetPreferenceResponseSchema,
          401: accountValueAuthErrorResponseSchema,
          403: accountValueAuthErrorResponseSchema,
          404: accountValueErrorResponseSchema,
          502: accountValueErrorResponseSchema,
          503: accountValueErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", code: "account_not_authenticated" });
      }
      try {
        const account = await dependencies.build(request.user.id);
        const component = account.projection.components.find(
          (item) => item.componentId === request.params.componentId,
        );
        if (!component) {
          return reply.code(404).send({
            error: "Asset component not found",
            code: "asset_component_not_found",
          });
        }
        const stored = await dependencies.setPreference(
          request.user.id,
          component,
          request.body.preference,
        );
        return reply.send({
          ok: true,
          ...stored,
          grantsTransactionAuthority: false,
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          (error as { code?: unknown }).code === "42P01"
        ) {
          return reply.code(503).send({
            error: "Asset preferences require the current database migration",
            code: "asset_preference_store_unavailable",
          });
        }
        app.log.error(
          { error, userId: request.user.id },
          "Asset funding preference update failed",
        );
        return reply.code(502).send({
          error: "Asset preference could not be updated",
          code: "asset_preference_update_failed",
        });
      }
    },
  );
}

export const accountValueRoutes: FastifyPluginAsync = async (app) => {
  registerAccountValueRoutes(app, {
    authenticate: createAuthMiddleware(),
    build: (userId) => buildAccountValueReadModel({ pool, userId }),
    setPreference: (userId, component, preference) =>
      upsertAssetFundingPreference(pool, {
        userId,
        component,
        preference,
      }),
  });
};
