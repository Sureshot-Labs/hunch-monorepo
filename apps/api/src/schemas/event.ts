import { z } from "zod";
import { zRequiredString } from "./common.js";

export const eventParamsSchema = z.object({
  eventId: zRequiredString("eventId parameter is required"),
});

export const eventSeriesQuerySchema = z.object({
  statuses: z.string().optional(),
});
