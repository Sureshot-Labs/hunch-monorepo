import { z } from "zod";
import {
  zEthAddress,
  zEthAddressRequired,
  zRequiredString,
  zVenue,
} from "./common.js";

const zVenueValue = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue,
);
const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

export const orderIdParamsSchema = z.object({
  id: zRequiredString("id parameter is required"),
});

export const ordersListQuerySchema = z.object({
  venue: zVenueOptional,
});

export const placeOrderBodySchema = z.object({
  venue: zVenueValue,
  tokenId: zRequiredString("tokenId is required"),
  side: z.enum(["BUY", "SELL"], {
    message: "Valid side (BUY/SELL) is required",
  }),
  orderType: z.enum(["GTC", "GTD", "FAK", "FOK"], {
    message: "Valid order type (GTC/GTD/FAK/FOK) is required",
  }),
  price: z.coerce.number().positive("Valid price is required"),
  size: z.coerce.number().positive("Valid size is required"),
  expiresAt: z.coerce.date().optional(),
  l1Signature: z.string().optional(),
  l1Timestamp: z.string().optional(),
  l1Nonce: z.string().optional(),
});

export const orderHistoryQuerySchema = z.object({
  venue: zVenueOptional,
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
});

export const storeOrderBodySchema = z.object({
  walletAddress: zEthAddressRequired,
  orderID: zRequiredString("orderID is required"),
  takingAmount: z.string().optional(),
  makingAmount: z.string().optional(),
  status: z.string().optional(),
  success: z.boolean().optional(),
  errorMsg: z.string().optional(),
  venue: zVenueOptional,
  tokenId: z.string().optional(),
  side: z.string().optional(),
  orderType: z.enum(["GTC", "GTD", "FAK", "FOK"]).optional(),
  price: z.coerce.number().optional(),
  size: z.coerce.number().optional(),
});

export const ordersForWalletParamsSchema = z.object({
  walletAddress: zEthAddress,
});

export const ordersForWalletQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
  status: z.string().optional(),
  venue: zVenueOptional,
});
