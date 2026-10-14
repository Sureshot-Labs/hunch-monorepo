import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Signature, TypedDataEncoder, Wallet } from "ethers";
import {
  validateRelayHypercoreActions,
  hypercoreSendAssetTypedData,
  verifyHypercoreActionSignature,
} from "./hypercore-actions.js";
function required<T>(value: T | null | undefined): T {
  assert.ok(value != null, "required fixture field");
  return value;
}

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-core-observations-20261012.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const sdk = JSON.parse(
  readFileSync(
    new URL("../../fixtures/hip4/signing-sdk-0.24.0.json", import.meta.url),
    "utf8",
  ),
);
// Public unfunded SDK test key. These tests are offline and never submit.
const wallet = new Wallet(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
function example(index = 0) {
  const observed = captured.withdrawals[index];
  const binding = {
    requestId: `0x${"a".repeat(64)}`,
    protocolOrderId: `0x${"b".repeat(64)}`,
    owner: wallet.address,
    authorizationDepositor: wallet.address,
    depository: `0x${"2".repeat(40)}`,
    sourceDex: observed.withdrawal.action.sourceDex as "spot" | "",
    destinationDex: "" as const,
    nonce: 1791806400000,
    sourceRaw: "1000000000",
  };
  const message = {
    chainId: "hyperliquid",
    wallet: binding.owner,
    depositor: binding.authorizationDepositor,
    id: binding.protocolOrderId,
    nonce: binding.nonce,
  };
  // Selected real wire shape plus synthetic private identities and protocol
  // bindings. This is deliberately not represented as an executable quote.
  const steps = [
    {
      id: "authorize",
      kind: "signature",
      requestId: binding.requestId,
      items: [
        {
          status: "incomplete",
          data: {
            sign: {
              signatureKind: "eip712",
              primaryType: "NonceMapping",
              domain: {
                ...observed.steps[0].items[0].typedData.domain,
                verifyingContract: `0x${"0".repeat(40)}`,
              },
              types: observed.steps[0].items[0].typedData.types,
              value: message,
            },
            post: {
              endpoint: "/authorize",
              method: "POST",
              body: {
                type: "nonce-mapping",
                walletChainId: 1337,
                wallet: binding.owner,
                depositor: binding.authorizationDepositor,
                nonce: binding.nonce,
                id: binding.protocolOrderId,
                signatureChainId: 1,
              },
            },
          },
        },
      ],
    },
    {
      id: "deposit",
      kind: "transaction",
      requestId: binding.requestId,
      depositAddress: "",
      items: [
        {
          status: "incomplete",
          data: {
            action: {
              type: "sendAsset",
              parameters: {
                ...observed.withdrawal.action,
                destination: binding.depository,
                nonce: binding.nonce,
              },
            },
            nonce: binding.nonce,
            eip712Types: observed.withdrawal.eip712Types,
            eip712PrimaryType: observed.withdrawal.eip712PrimaryType,
          },
          check: {
            method: "GET",
            endpoint: `/intents/status/v3?requestId=${binding.requestId}`,
          },
        },
      ],
    },
  ] satisfies [unknown, unknown];
  return { binding, steps };
}

test("native SendAsset typed data matches the independent official SDK golden", async () => {
  const vector = sdk.vectors.find(
    (row: { name: string }) => row.name === "send-asset-mainnet",
  );
  const {
    type: _type,
    signatureChainId: _chain,
    ...parameters
  } = vector.typedData.message;
  const typed = hypercoreSendAssetTypedData(parameters);
  assert.equal(
    TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
    vector.digest,
  );
  const signature = await wallet.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  assert.equal(signature, Signature.from(vector.signature).serialized);
  assert.equal(
    verifyHypercoreActionSignature(typed, signature, wallet.address),
    signature,
  );
  assert.throws(() =>
    verifyHypercoreActionSignature(typed, signature, `0x${"1".repeat(40)}`),
  );
  assert.throws(() =>
    verifyHypercoreActionSignature(
      { ...typed, message: { ...typed.message, amount: "1.00000002" } },
      signature,
      wallet.address,
    ),
  );
});

for (const index of [0, 1]) {
  test(`native two-step binding preserves exact nonce/amount for ${index === 0 ? "spot" : "perps"}`, async () => {
    const fixture = example(index);
    const validated = validateRelayHypercoreActions(
      fixture.steps,
      fixture.binding,
    );
    assert.equal(validated.transfer.action.amount, "10.000000");
    assert.notEqual(
      validated.binding.authorizationDepositor,
      validated.binding.depository,
    );
    assert.notEqual(
      validated.binding.protocolOrderId,
      validated.binding.requestId,
    );
    assert.equal(
      validated.transfer.action.nonce,
      validated.authorization.typedData.message.nonce,
    );
    const typed = validated.authorization.typedData;
    const signed = await wallet.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    );
    assert.equal(
      verifyHypercoreActionSignature(typed, signed, wallet.address),
      signed,
    );
    assert.deepEqual(
      validateRelayHypercoreActions(fixture.steps, fixture.binding),
      validated,
    );
  });
}

test("native owner casing is semantic for address-typed authorization but preserves transfer strings", () => {
  const fixture = example();
  const owner = `0x${"aB".repeat(20)}`;
  fixture.binding.owner = fixture.binding.authorizationDepositor = owner;
  const authData = required(fixture.steps[0].items[0]).data;
  authData.sign.value.wallet = authData.sign.value.depositor = owner;
  authData.post.body.wallet = authData.post.body.depositor = owner;
  fixture.binding.depository = `0x${"cD".repeat(20)}`;
  required(fixture.steps[1].items[0]).data.action.parameters.destination =
    fixture.binding.depository;
  const result = validateRelayHypercoreActions(fixture.steps, fixture.binding);
  assert.equal(
    result.authorization.typedData.message.wallet,
    owner.toLowerCase(),
  );
  assert.equal(result.authorization.post.body.depositor, owner.toLowerCase());
  assert.equal(result.transfer.action.destination, fixture.binding.depository);
  // A caller changing its own returned typed-data object cannot poison later quotes.
  required(result.authorization.typedData.types.NonceMapping[0]).type =
    "uint256";
  required(
    result.transfer.typedData.types["HyperliquidTransaction:SendAsset"][0],
  ).type = "uint256";
  assert.equal(
    required(
      validateRelayHypercoreActions(fixture.steps, fixture.binding)
        .authorization.typedData.types.NonceMapping[0],
    ).type,
    "string",
  );
  assert.equal(
    required(
      validateRelayHypercoreActions(fixture.steps, fixture.binding).transfer
        .typedData.types["HyperliquidTransaction:SendAsset"][0],
    ).type,
    "string",
  );
});

const mutations: Record<string, (fixture: ReturnType<typeof example>) => void> =
  {
    "reversed steps": (f) => {
      f.steps.reverse();
    },
    "extra step": (f) => {
      f.steps.push(required(f.steps[1]));
    },
    "request mismatch": (f) => {
      required(f.steps[1]).requestId = "different-request";
    },
    "request/order confusion": (f) => {
      f.binding.protocolOrderId = f.binding.requestId;
    },
    owner: (f) => {
      f.binding.owner = `0x${"1".repeat(40)}`;
    },
    depository: (f) => {
      f.binding.depository = `0x${"1".repeat(40)}`;
    },
    depositor: (f) => {
      f.binding.authorizationDepositor = `0x${"1".repeat(40)}`;
    },
    nonce: (f) => {
      f.binding.nonce++;
    },
    "raw units": (f) => {
      f.binding.sourceRaw = "10000000";
    },
    DEX: (f) => {
      f.binding.sourceDex = "";
    },
    "post destination": (f) => {
      required(required(required(f.steps[0]).items[0]).data.post).endpoint =
        "https://attacker.example/authorize";
    },
    "signature domain": (f) => {
      required(
        required(required(f.steps[0]).items[0]).data.sign,
      ).domain.chainId = 1337;
    },
    "signature schema": (f) => {
      required(
        required(required(f.steps[0]).items[0]).data.sign,
      ).types.NonceMapping[0].type = "uint256";
    },
    "native amount": (f) => {
      required(
        required(required(f.steps[1]).items[0]).data.action,
      ).parameters.amount = "10.00000001";
    },
    "native environment": (f) => {
      required(
        required(required(f.steps[1]).items[0]).data.action,
      ).parameters.hyperliquidChain = "Testnet";
    },
    subaccount: (f) => {
      required(
        required(required(f.steps[1]).items[0]).data.action,
      ).parameters.fromSubAccount = `0x${"1".repeat(40)}`;
    },
    "status URL": (f) => {
      required(required(required(f.steps[1]).items[0]).check).endpoint +=
        "&extra=1";
    },
  };
for (const [name, mutate] of Object.entries(mutations))
  test(`native signing rejects ${name}`, () => {
    const fixture = example();
    // Parsed JSON fixtures are shared; isolate mutations from every later test.
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.throws(() =>
      validateRelayHypercoreActions(copy.steps, copy.binding),
    );
  });
