import { z } from "zod";

const zFeeVenue = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["polymarket", "kalshi", "limitless"]),
);

export const feePolicyQuerySchema = z.object({
  venue: zFeeVenue,
});
