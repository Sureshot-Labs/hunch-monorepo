# Relay fixture corpus

This directory pins Relay facts captured first read-only, then through an
explicitly authorized quote-only phase, and finally through a bounded
dedicated-burner live rehearsal. The live phase executed six tiny Relay routes
across Polygon, Base, and Solana while staying below the authorized aggregate
budget. It made no Deposit Address request or configuration change and does not
enable any product capability or route.

## Evidence classes

- `live-read-only`: captured from authenticated or public Relay `GET`
  endpoints on 2026-07-23. Provider identifiers and transaction references are
  removed or replaced with deterministic fingerprints.
- `live-quote-only-sanitized`: captured from `POST /quote/v2` using
  deterministic public fixture addresses with no known private keys. Request,
  order, lookup-table, and response identifiers are fingerprinted; actions were
  never signed or submitted.
- `live-execution-sanitized`: exact-spend preflight and settlement evidence from
  dedicated EVM/Solana burners. Raw keys, request IDs, transaction hashes,
  calldata/instruction data, and RPC credentials are replaced by fingerprints
  or omitted.
- `official-docs-sanitized`: copied from the documented request/response shape
  and replaced with reserved fixture identities. No corresponding Relay request
  was created.
- `contract-extract`: the relevant OpenAPI fields and operation hashes, not the
  full generated document.
- `negative-policy`: deliberately invalid or unsupported inputs that a future
  Hunch Relay adapter must reject before any provider call or execution.

The local `RELAY_API_KEY` was used only in the request header for permitted
GET/Quote calls. Alchemy RPC URLs and wallet keys remained in ignored local
files/environment. None are stored here. The fixture integrity test rejects
secret-shaped JSON fields and accidental raw provider request IDs in live
captures.

## Capture boundaries

Initial read-only phase:

Called:

- `GET /documentation/json`
- `GET /chains`
- `GET /intents/status/v3` for two request IDs published by Relay documentation
  and one synthetic, nonexistent ID

Subsequent explicitly authorized quote-only phase:

- six `POST /quote/v2` calls: the three target routes plus three bounded repeats
  needed to recover truncated capture data and pin empty `depositAddress` and
  Solana instruction fields;
- an exact `GET /intents/status/v3` for each created quote request;
- an exact `GET /requests/v3?id=...&includeChildRequests=true` for each created
  quote request.

Every quote used a deterministic public fixture address without a known private
key. `useDepositAddress` was omitted, and no signing or execution method was
called.

Subsequent explicitly authorized live rehearsal:

- 36 guarded `POST /quote/v2` calls across preflight, bounded rent/route
  discovery, approval refreshes, and six executed requests;
- eight EVM broadcasts and one Solana broadcast, all successful;
- six independently observed destination settlements;
- exact `GET /requests/v3?depositTxHash=...` reconciliation for every executed
  request;
- EVM/Solana Alchemy RPC reads, EVM gas simulation, Solana account/program/LUT
  validation, and unsigned/signed Solana simulation;
- gross initial inputs of 3 POL and 1.5 pUSD, below the authorized 10 POL and
  3 pUSD limits.

Deliberately not called:

- `POST /quote/v2` with `useDepositAddress: true`;
- broad or unfiltered `GET /requests/v3` listing that could expose unrelated
  customer request data;
- Relay execution, permit, gasless, index/reindex, fast-fill, fee, or
  transaction endpoints other than Quote/Status/Requests;
- Privy mutation/signing, venue mutation, order, or readiness endpoints.

## Findings encoded by the fixtures

1. Relay's Solana provider chain ID is `792703809`; Hunch's internal Solana ID
   `7565164` must be mapped explicitly and must never escape into provider DTOs.
2. Polygon USDC.e, Polygon native USDC, Base USDC, and Solana USDC have exact
   catalog matches. Polygon pUSD did not appear in `/chains`, but live Quote v2
   successfully returned a direct Base USDC to Polygon pUSD quote. This proves
   quote-time route discovery, not execution or venue-visible settlement.
3. Status v3 returned `unknown` with HTTP 200 for unknown request IDs. `unknown`
   is missing from the pinned OpenAPI enum. Relay documentation also describes
   `delayed`, which is missing from that enum. Both must preserve the raw status
   and fail closed into reconciliation.
4. Strict Deposit Addresses require `strict: true` and `refundTo`; open
   `EXACT_OUTPUT` is rejected by Relay documentation. Hunch's initial policy
   rejects open/variable Deposit Addresses regardless of provider support.
5. Quote fields for gas top-up, fee subsidy, deposit fee payer, gasless flows,
   arbitrary authorization lists, and supplied transactions remain disabled
   until separately implemented and tested.
6. EVM USDC wallet quotes returned `approve` (`0x095ea7b3`) followed by `deposit`
   (`0xe8017952`) transaction actions. The Solana wallet quote returned one
   instruction for program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`,
   ten accounts, one signer, three writable accounts, and one address lookup
   table.
7. Wallet quotes included a `depositAddress` field containing an empty string
   even though Deposit Address mode was not requested. Empty string must be
   normalized as absent and never shown as an instruction.
8. Immediately after creation, Status v3 returned `waiting`, while exact
   Requests v3 lookup returned `{ "requests": [] }`. Quote creation and Requests
   visibility are therefore not the same lifecycle boundary.
9. The six executed tiny-value routes all settled above their authorized
   minimum output. EVM action shapes observed Router V3, Approval Proxy V3, and
   Depository V2; remaining ERC-20 allowances were zero.
10. Relay's Solana adapter decodes instruction data as hex without `0x`, not
    base64. The executed action contained one allowlisted Relay program
    instruction, one controlled signer, the derived source ATA, three writable
    accounts, and one lookup table. Both unsigned and signed simulations passed.
11. A new Solana account required at least `0.000891 SOL`. One POL was
    insufficient; 1.5 POL quoted but lacked robust rent-plus-return-fee
    headroom, so the rehearsal selected 2 POL and avoided an external SOL
    top-up.
12. Alchemy HTTP RPC accepted and finalized the Solana transaction, while its
    derived WebSocket endpoint returned `signatureSubscribe` method-not-found.
    The runner now confirms by HTTP status polling and never retries an
    already-broadcast transaction blindly.

## Validation scope

`fixtures-tests.ts` checks provenance, source pins, chain/currency mappings,
Deposit Address cross-field rules, live quote/execution summaries, EVM and
Solana action constraints, status drift, webhook shape, sanitization, and
negative-policy mutations. The live fixtures prove bounded burner execution
and owned-destination settlement only at the captured amount bands. They do not
prove Privy delegated execution, venue-visible readiness, Deposit Address
recovery, timeout/refund convergence, or production activation.

Sources:

- <https://api.relay.link/documentation/json>
- <https://docs.relay.link/references/api/get-quote-v2>
- <https://docs.relay.link/references/api/get-intents-status-v3>
- <https://docs.relay.link/references/api/get-requests>
- <https://docs.relay.link/features/deposit-addresses>
- <https://docs.relay.link/references/api/api_guides/webhooks>
- <https://docs.relay.link/references/api/api_guides/solana>
- <https://github.com/relayprotocol/relay-kit/blob/main/packages/relay-svm-wallet-adapter/src/adapter.ts>
