import { z } from "zod";
import { zRequiredString } from "./common.js";

export const eventParamsSchema = z.object({
  eventId: zRequiredString("eventId parameter is required"),
});
