// Shared registration contracts for generic read paths extended to native
// venues. Importable by the offline OpenAPI generator without API startup.
import { eventParamsSchema, eventSimilarQuerySchema } from "./event.js";
import {
  marketParamsSchema,
  marketSimilarQuerySchema,
  marketsByTokenQuerySchema,
} from "./market.js";
import { scopedSignalsQuerySchema, signalsQuerySchema } from "./signals.js";
import {
  walletActivityQuerySchema,
  walletPositionHistoryQuerySchema,
  walletPositionsQuerySchema,
} from "./wallet-intel.js";

export const publicReadRouteSchemas = {
  "/markets/by-token": { querystring: marketsByTokenQuerySchema },
  "/markets/:marketId/similar": {
    params: marketParamsSchema,
    querystring: marketSimilarQuerySchema,
  },
  "/events/:eventId/similar": {
    params: eventParamsSchema,
    querystring: eventSimilarQuerySchema,
  },
  "/signals": { querystring: signalsQuerySchema },
  "/signals/holder-research": { querystring: signalsQuerySchema },
  "/events/:eventId/signals": {
    params: eventParamsSchema,
    querystring: scopedSignalsQuerySchema,
  },
  "/markets/:marketId/signals": {
    params: marketParamsSchema,
    querystring: scopedSignalsQuerySchema,
  },
  "/wallets/activity": { querystring: walletActivityQuerySchema },
  "/wallets/positions": { querystring: walletPositionsQuerySchema },
  "/wallets/positions/history": {
    querystring: walletPositionHistoryQuerySchema,
  },
} as const;
