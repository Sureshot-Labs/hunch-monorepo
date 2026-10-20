import { z } from "zod";

export const nativePreferencesFields = {
  enabled: z.boolean(),
  marketResolution: z.boolean(),
  followedHunches: z.boolean(),
  newMarkets: z.boolean(),
  bigMoves: z.boolean(),
};
export const nativePreferencesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ...nativePreferencesFields,
});
export const nativePreferencesBody = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    ...nativePreferencesFields,
  })
  .strict();
export const nativeDeviceParams = z.object({ id: z.string().uuid() });
export const nativeDeviceBody = z
  .object({
    token: z.string().regex(/^[0-9a-f]{32,512}$/),
    environment: z.enum(["sandbox", "production"]),
    authorization: z.enum([
      "authorized",
      "provisional",
      "ephemeral",
      "denied",
      "notDetermined",
    ]),
  })
  .strict();
export const nativeNotificationError = z.object({
  error: z.string(),
  preferences: nativePreferencesSchema.optional(),
});
export type NativePreferences = z.infer<typeof nativePreferencesSchema>;
export type NativePreferencesInput = z.infer<typeof nativePreferencesBody>;
export type NativeDeviceInput = z.infer<typeof nativeDeviceBody>;
