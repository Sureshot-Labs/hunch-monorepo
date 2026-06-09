import { z } from "zod";
import { zVenue } from "./common.js";

const zFeeVenue = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue,
);

export const feePolicyQuerySchema = z.object({
  venue: zFeeVenue,
});
