import {
  createPrivateKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

export type APNsEnvironment = "sandbox" | "production";
export type APNsResult = {
  status: number;
  reason: string | null;
  invalidatedAt: number | null;
};
export type APNsSend = (input: {
  token: string;
  environment: APNsEnvironment;
  id: string;
  payload: Record<string, unknown>;
  expiresAt: number;
}) => Promise<APNsResult>;

export class APNsClient {
  private readonly key: KeyObject;
  private cachedToken: { value: string; issuedAt: number } | null = null;
  private readonly connections = new Map<APNsEnvironment, ClientHttp2Session>();

  constructor(
    private readonly configuration: {
      keyID: string;
      teamID: string;
      privateKey: string;
      bundleID: string;
      now?: () => number;
    },
  ) {
    if (
      !/^[A-Z0-9]{10}$/.test(configuration.keyID) ||
      !/^[A-Z0-9]{10}$/.test(configuration.teamID)
    )
      throw new Error("Invalid APNs key/team identifier");
    if (configuration.bundleID !== "trade.hunch.app")
      throw new Error("Unexpected native APNs topic");
    this.key = createPrivateKey(
      configuration.privateKey.replaceAll("\\n", "\n"),
    );
    if (
      this.key.asymmetricKeyType !== "ec" ||
      this.key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error("APNs requires an ES256 signing key");
  }

  private now() {
    return Math.floor((this.configuration.now?.() ?? Date.now()) / 1000);
  }

  providerToken() {
    const now = this.now();
    if (
      this.cachedToken &&
      now >= this.cachedToken.issuedAt &&
      now - this.cachedToken.issuedAt < 1_500
    )
      return this.cachedToken.value;
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: this.configuration.keyID }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({ iss: this.configuration.teamID, iat: now }),
    ).toString("base64url");
    const unsigned = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const value = `${unsigned}.${signature}`;
    this.cachedToken = { value, issuedAt: now };
    return value;
  }

  readonly send: APNsSend = async (input) => {
    const payload = JSON.stringify(input.payload);
    if (Buffer.byteLength(payload) > 4_096)
      return { status: 413, reason: "PayloadTooLarge", invalidatedAt: null };
    const result = await this.request(input, payload);
    if (result.status === 403 && result.reason === "ExpiredProviderToken") {
      this.cachedToken = null;
      return this.request(input, payload);
    }
    return result;
  };

  private request(
    input: Parameters<APNsSend>[0],
    payload: string,
  ): Promise<APNsResult> {
    if (!/^[0-9a-f]{32,512}$/.test(input.token))
      throw new Error("Invalid APNs device token");
    let connection = this.connections.get(input.environment);
    if (!connection || connection.closed || connection.destroyed) {
      connection = connect(
        input.environment === "sandbox"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com",
      );
      connection.on("error", () => {
        /* Request errors are handled without logging credentials. */
      });
      connection.on("goaway", () => {
        connection?.close();
      });
      this.connections.set(input.environment, connection);
    }
    const session = connection;
    return new Promise((resolve, reject) => {
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${input.token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-topic": this.configuration.bundleID,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(input.expiresAt),
        "apns-id": input.id || randomUUID(),
        "apns-collapse-id": input.id,
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      stream.setTimeout(15_000, () => {
        stream.destroy(new Error("APNs request timed out"));
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        body += String(chunk);
        if (body.length > 8_192)
          stream.destroy(new Error("Invalid APNs response"));
      });
      stream.on("error", reject);
      stream.on("end", () => {
        let error: { reason?: unknown; timestamp?: unknown } = {};
        try {
          error = JSON.parse(body || "{}");
        } catch {
          /* Treat malformed responses as retryable. */
        }
        resolve({
          status,
          reason: typeof error.reason === "string" ? error.reason : null,
          invalidatedAt:
            typeof error.timestamp === "number" ? error.timestamp : null,
        });
      });
      stream.end(payload);
    });
  }

  close() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

export function classifyAPNsResult(
  result: APNsResult,
): "sent" | "invalid_device" | "retry" | "failed" {
  if (result.status === 200) return "sent";
  if (
    result.status === 410 ||
    (result.status === 400 &&
      ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(
        result.reason ?? "",
      ))
  )
    return "invalid_device";
  if (
    result.status === 0 ||
    result.status === 403 ||
    result.status === 429 ||
    result.status >= 500
  )
    return "retry";
  return "failed";
}
