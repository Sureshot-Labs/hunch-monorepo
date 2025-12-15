import { z } from "zod";
import { zRequiredString } from "./common.js";

export const marketParamsSchema = z.object({
  marketId: zRequiredString("marketId parameter is required"),
});
