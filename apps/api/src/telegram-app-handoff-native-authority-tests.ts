import assert from "node:assert/strict";
import { test } from "node:test";
import type { WalletExecutionProfile } from "./funding/domain/types.js";
import {
  buildTelegramAppHandoffNativeAuthority as build,
  telegramAppHandoffNativeAuthorityFingerprint as fingerprint,
  telegramAppHandoffNativeAuthoritySchema as schema,
} from "./services/telegram-app-handoff-native-authority.js";

const profile: WalletExecutionProfile = {
  walletId: "11111111-1111-4111-8111-111111111111",
  controllerWalletRef: "11111111-1111-4111-8111-111111111111",
  networkId: "hyperliquid:mainnet",
  address: `0x${"ab".repeat(20)}`,
  source: "external",
  signingModes: ["web_client"],
  serverWalletRef: null,
  sponsorshipPolicyIds: [],
};
const identity = {
  userId: "22222222-2222-4222-8222-222222222222",
  telegramAccountLinkId: "33333333-3333-4333-8333-333333333333",
};
test("native handoff uses exact user/link/web controller identity, no bot grant", () => {
  const value = build({ ...identity, profile });
  assert.equal(value.serverWalletRef, null);
  assert.equal(
    fingerprint(value),
    fingerprint(
      schema.parse({
        ...value,
        walletAddress: value.walletAddress.toUpperCase().replace("0X", "0x"),
      }),
    ),
  );
  for (const changed of [
    { userId: "44444444-4444-4444-8444-444444444444" },
    { telegramAccountLinkId: "44444444-4444-4444-8444-444444444444" },
    { controllerWalletRef: "44444444-4444-4444-8444-444444444444" },
    { walletAddress: `0x${"cd".repeat(20)}` },
    {
      walletSource: "embedded" as const,
      serverWalletRef: "offline-privy-wallet",
    },
  ])
    assert.notEqual(
      fingerprint(schema.parse({ ...value, ...changed })),
      fingerprint(value),
    );
});
test("native authority rejects unsupported controller source/network/mode and mixed identities", () => {
  for (const changed of [
    { networkId: "eip155:137" },
    { source: "smart" as const },
    { signingModes: [] },
    { source: "embedded" as const },
    { serverWalletRef: "unexpected-server-ref" },
    { controllerWalletRef: null },
  ])
    assert.throws(() =>
      build({ ...identity, profile: { ...profile, ...changed } }),
    );
  assert.throws(() =>
    schema.parse({
      ...build({ ...identity, profile }),
      authorizationId: identity.userId,
    }),
  );
});
