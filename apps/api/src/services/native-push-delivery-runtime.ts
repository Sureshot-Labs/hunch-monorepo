import { APNsClient, type APNsSend } from "./apns-client.js";

export type NativeDeliveryState =
  | { state: "disabled"; code: null }
  | { state: "ready"; code: null }
  | {
      state: "configuration_error";
      code: "missing_apns_configuration" | "invalid_apns_configuration";
    };

/** Delivery is independent of statistics. Correct secrets and restart to recover. */
export function createNativePushDelivery(
  source: NodeJS.ProcessEnv = process.env,
  createClient: (
    configuration: ConstructorParameters<typeof APNsClient>[0],
  ) => Pick<APNsClient, "send" | "close"> = (configuration) =>
    new APNsClient(configuration),
): { status: NativeDeliveryState; send?: APNsSend; close: () => void } {
  if (source.HUNCH_APNS_DELIVERY_ENABLED !== "true")
    return { status: { state: "disabled", code: null }, close() {} };
  const keyID = source.APNS_KEY_ID?.trim();
  const teamID = source.APNS_TEAM_ID?.trim();
  const privateKey = source.APNS_PRIVATE_KEY?.trim();
  if (!keyID || !teamID || !privateKey)
    return {
      status: {
        state: "configuration_error",
        code: "missing_apns_configuration",
      },
      close() {},
    };
  try {
    const client = createClient({
      keyID,
      teamID,
      privateKey,
      bundleID: "trade.hunch.app",
    });
    return {
      status: { state: "ready", code: null },
      send: client.send,
      close: () => client.close(),
    };
  } catch {
    return {
      status: {
        state: "configuration_error",
        code: "invalid_apns_configuration",
      },
      close() {},
    };
  }
}
