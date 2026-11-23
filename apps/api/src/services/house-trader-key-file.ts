import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { computeAddress, getAddress } from "ethers";

export const HOUSE_TRADER_KEY_FILE = "/run/hunch-house-trader/key.json";
const keyName = "HUNCH_HOUSE_TRADER_PRIVATE_KEY";

export function readHouseTraderKeyFile(
  path: string,
  expectedController: string,
) {
  const expected = getAddress(expectedController);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size === 0 ||
      info.size > 4096
    )
      throw new Error("unsafe_house_trader_key_file");
    const payload: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).length !== 1 ||
      !Object.hasOwn(payload, keyName)
    )
      throw new Error("invalid_house_trader_key_file");
    const privateKey = (payload as Record<string, unknown>)[keyName];
    if (typeof privateKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(privateKey))
      throw new Error("invalid_house_trader_key");
    const controller = computeAddress(privateKey);
    if (controller !== expected)
      throw new Error("house_trader_controller_mismatch");
    return { privateKey, controller };
  } finally {
    closeSync(fd);
  }
}

export function readHouseTraderPublicSettings(env: NodeJS.ProcessEnv) {
  // Fail closed on accidental delivery through a shared secret/env bundle.
  if (Object.hasOwn(env, keyName))
    throw new Error("house_trader_key_must_be_file_only");
  const expected = getAddress(env.HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER ?? "");
  if (expected === "0x0000000000000000000000000000000000000000")
    throw new Error("invalid_house_trader_controller");
  return { expected };
}
