import { z } from "zod";
import type { WalletExecutionProfile } from "../funding/domain/types.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
/** User-executed controller identity, not a bot trading grant. External EVM
 * controllers are valid when ordinary native trading supports web_client;
 * requiring a Privy server-wallet authorization would change that authority.
 */
export const telegramAppHandoffNativeAuthoritySchema = z
  .object({
    version: z.literal("hip4-controller-v1"),
    userId: uuid,
    telegramAccountLinkId: uuid,
    controllerWalletRef: uuid,
    walletAddress: z
      .string()
      .regex(/^0x[\da-f]{40}$/iu)
      .transform((value) => value.toLowerCase()),
    walletSource: z.enum(["external", "embedded"]),
    serverWalletRef: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.walletSource === "external") !==
      (value.serverWalletRef === null)
    )
      ctx.addIssue({ code: "custom", message: "controller source mismatch" });
  });
export type TelegramAppHandoffNativeAuthority = z.infer<
  typeof telegramAppHandoffNativeAuthoritySchema
>;

export function buildTelegramAppHandoffNativeAuthority(input: {
  userId: string;
  telegramAccountLinkId: string;
  profile: WalletExecutionProfile;
}): TelegramAppHandoffNativeAuthority {
  if (
    input.profile.networkId !== "hyperliquid:mainnet" ||
    !input.profile.signingModes.includes("web_client")
  )
    throw new Error("hip4_controller_changed");
  return telegramAppHandoffNativeAuthoritySchema.parse({
    version: "hip4-controller-v1",
    userId: input.userId,
    telegramAccountLinkId: input.telegramAccountLinkId,
    controllerWalletRef: input.profile.controllerWalletRef,
    walletAddress: input.profile.address,
    walletSource: input.profile.source,
    serverWalletRef: input.profile.serverWalletRef,
  });
}
export function telegramAppHandoffNativeAuthorityFingerprint(
  authority: TelegramAppHandoffNativeAuthority,
) {
  return canonicalJsonHash(
    telegramAppHandoffNativeAuthoritySchema.parse(authority),
  );
}
