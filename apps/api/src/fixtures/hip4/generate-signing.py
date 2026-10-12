# /// script
# requires-python = ">=3.10"
# dependencies = ["hyperliquid-python-sdk==0.24.0", "eth-account==0.13.7", "msgpack==1.2.3", "eth-utils==5.3.1"]
# ///
"""Offline SDK oracle. Never reads .env, real keys, accounts or sends requests.

Run with uv run --no-project <this file> (add --offline after caching dependencies).
Prints deterministic JSON to stdout; dependencies are only needed to regenerate,
not to run the normal TypeScript regression tests.
"""

import hashlib
import importlib.metadata
import json
from copy import deepcopy

import eth_account
import eth_account.messages
import eth_utils
import msgpack
import hyperliquid.utils.signing as sdk

assert importlib.metadata.version("hyperliquid-python-sdk") == "0.24.0"
with open(sdk.__file__, "rb") as signing_source:
    signing_source_hash = hashlib.sha256(signing_source.read()).hexdigest()
assert signing_source_hash == "938ec0a1f9611874b423ca946696e19a71d32d14709f521ea5d526f4398c0b85"
# Public example key from the SDK's own tests. NEVER fund this account.
wallet = eth_account.Account.from_key(
    "0x0123456789012345678901234567890123456789012345678901234567890123"
)


def json_value(value):
    if isinstance(value, bytes):
        return "0x" + value.hex()
    raise TypeError(type(value).__name__)


def vector(name, typed_data, signature, **extra):
    encoded = eth_account.messages.encode_typed_data(full_message=typed_data)
    digest = eth_utils.keccak(b"\x19" + encoded.version + encoded.header + encoded.body)
    return {
        "name": name,
        "typedData": typed_data,
        "digest": "0x" + digest.hex(),
        "signature": signature,
        **extra,
    }


vectors = []
for environment in ["mainnet", "testnet"]:
    is_mainnet = environment == "mainnet"
    for variant in ["direct", "expiry", "vault", "vault-expiry", "ioc-sell", "alo", "batch", "cancel-oid", "cancel-cloid"]:
        vault = "0x0000000000000000000000000000000000000001" if "vault" in variant else None
        expires_after = 1791806460000 if "expiry" in variant else None
        # Synthetic HIP asset/amounts. This proves wire encoding, NOT minimums,
        # executable precision, user roles or the existence of an order.
        action = {
            "type": "order",
            "orders": [{
                "a": 100115530, "b": True, "p": "0.4225", "s": "25",
                "r": False, "t": {"limit": {"tif": "Gtc"}},
                "c": "0x00000000000000000000000000000001",
            }],
            "grouping": "na",
        }
        if variant == "ioc-sell":
            action["orders"][0].update(b=False, t={"limit": {"tif": "Ioc"}})
        elif variant == "alo":
            action["orders"][0]["t"] = {"limit": {"tif": "Alo"}}
        elif variant == "batch":
            opposite = deepcopy(action["orders"][0])
            opposite.update(a=100115531, p="0.5775", c="0x00000000000000000000000000000002")
            action["orders"].append(opposite)
        elif variant == "cancel-oid":
            action = {"type": "cancel", "cancels": [{"a": 100115530, "o": 123456789}]}
        elif variant == "cancel-cloid":
            action = {"type": "cancelByCloid", "cancels": [{"asset": 100115530, "cloid": "0x00000000000000000000000000000001"}]}
        nonce = 1791806400000
        connection_id = sdk.action_hash(action, vault, nonce, expires_after)
        typed_data = sdk.l1_payload(sdk.construct_phantom_agent(connection_id, is_mainnet))
        vectors.append(vector(
            f"l1-{environment}-{variant}", typed_data,
            sdk.sign_l1_action(wallet, action, vault, nonce, expires_after, is_mainnet),
            action=action, packedAction="0x" + msgpack.packb(action).hex(),
            nonce=nonce, vault=vault, expiresAfter=expires_after,
            connectionId="0x" + connection_id.hex(),
        ))
    token = "0x6d1e7cde53ba9467b783cb7c530ce054" if is_mainnet else "0xeb62eee3685fc4c43992febcd9e75443"
    action = {
        "type": "sendAsset",
        "destination": "0x0000000000000000000000000000000000000002",
        "sourceDex": "spot", "destinationDex": "",
        "token": "USDC:" + token, "amount": "1.00000001",
        "fromSubAccount": "", "nonce": 1791806400000,
    }
    signature = sdk.sign_send_asset_action(wallet, action, is_mainnet)
    typed_data = sdk.user_signed_payload("HyperliquidTransaction:SendAsset", sdk.SEND_ASSET_SIGN_TYPES, action)
    vectors.append(vector(f"send-asset-{environment}", typed_data, signature))

print(json.dumps({
    "version": 1,
    "origin": "official-sdk-offline-synthetic-input",
    "sdk": {
        "package": "hyperliquid-python-sdk", "version": "0.24.0",
        "commit": "2fdb18f9517675ea03695a0962bd19eece9c83f0",
        "source": "https://github.com/hyperliquid-dex/hyperliquid-python-sdk/tree/2fdb18f9517675ea03695a0962bd19eece9c83f0",
        "signingSourceSha256": signing_source_hash,
        "dependencies": {name: importlib.metadata.version(name) for name in ["eth-account", "msgpack", "eth-utils"]},
    },
    "signer": wallet.address,
    "scope": "Offline serialization and signing goldens only. No network, wallet access, submission, minimum/precision validation, receipt or Privy-role evidence.",
    "vectors": vectors,
}, indent=2, default=json_value))
