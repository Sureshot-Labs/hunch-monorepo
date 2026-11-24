import { readAwsWorkloadSecret } from "@hunch/config/secrets";
import { computeAddress, getAddress, ZeroAddress } from "ethers";

const secretId = "/hunch/prod/house-trader";
const keyName = "HUNCH_HOUSE_TRADER_PRIVATE_KEY";

export function readHouseTraderPublicSettings(env: NodeJS.ProcessEnv) {
  if (Object.hasOwn(env, keyName))
    throw new Error("house_trader_key_in_environment");
  const expected = getAddress(env.HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER ?? "");
  if (expected === ZeroAddress)
    throw new Error("invalid_house_trader_controller");
  return { expected };
}

export function parseHouseTraderKey(
  payload: Record<string, unknown>,
  expectedController: string,
) {
  const privateKey = payload[keyName];
  if (
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, keyName) ||
    typeof privateKey !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(privateKey)
  )
    throw new Error("invalid_house_trader_key");
  const controller = computeAddress(privateKey);
  if (controller !== getAddress(expectedController))
    throw new Error("house_trader_controller_mismatch");
  return { privateKey, controller };
}

export async function loadHouseTraderKey(expectedController: string) {
  return parseHouseTraderKey(
    await readAwsWorkloadSecret(secretId),
    expectedController,
  );
}
