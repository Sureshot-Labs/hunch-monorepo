import { z } from "zod";

export const zVenue = z.enum(["polymarket", "kalshi", "limitless"]);

export const zEthAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address format");

export const zEthAddressRequired = z.preprocess(
  (v) => (v == null ? "" : v),
  z
    .string()
    .min(1, "walletAddress is required")
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address format"),
);

export const zNonEmptyString = (message: string) => z.string().min(1, message);

export const zRequiredString = (message: string) =>
  z.preprocess((v) => (v == null ? "" : v), z.string().min(1, message));

export const zCsvString = (message: string) =>
  z
    .string()
    .min(1, message)
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    );
