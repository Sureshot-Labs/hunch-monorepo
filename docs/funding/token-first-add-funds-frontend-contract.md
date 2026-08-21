# Token-first Add Funds: frontend contract

## Purpose and scope

This contract changes only the ordinary **Add Funds** entry flow. A user
chooses an exact token and network; the API keeps destination venue, binding,
receiver, observer baseline, and routing decisions private.

It does **not** replace or alter the existing exact destination/binding API.
In particular, trade-shortfall, Buy continuations, Telegram funding, and
already-open receive sessions continue to use their existing contracts.

## User flow

1. Open Add Funds and fetch `GET /funding/receive-options`.
2. Show top-level entry methods from the returned options:
   - **Crypto**: options with `manual_receive` or `connected_wallet`.
   - **Card**: options with `privy_card`.
3. Let the user choose one exact `asset + network` option. Do not show or ask
   them to choose a venue.
4. Open a receive session with that option:

   ```json
   POST /funding/receive-sessions
   {
     "receiveOptionId": "receive_option_v1_<opaque>",
     "idempotencyKey": "<client-generated-stable-key>"
   }
   ```

5. Only after the successful response, show its `methods`, `receiveTargets`,
   address/QR, connected-wallet transfer, or Privy Card handoff. Continue to
   use the existing receive-session polling, receipt review, operation, and
   cancellation APIs.

The selection is **one exact token variant on one network**. Examples that
must remain distinct in the UI are `USDC · Base`, `USDC · Solana`, native
`USDC · Polygon`, `USDC.e · Polygon`, `pUSD · Polygon`, and `SOL · Solana`.
The API, not the frontend, determines whether an option is direct,
automatically converted, or needs a review.

## Read contract

`GET /funding/receive-options` is authenticated and responds with
`Cache-Control: private, no-store`.

```ts
type FundingReceiveOptionsResponse = {
  ok: true;
  revision: string;
  expiresAt: string;
  receiveOptions: Array<{
    receiveOptionId: string; // opaque and user-bound
    asset: {
      networkId: string;
      assetId: string;
      decimals: number;
      symbol: string;
      name: string;
      variant?: "native" | "bridged";
    };
    network: { networkId: string; name: string };
    ingressMethods: Array<
      "connected_wallet" | "manual_receive" | "privy_card"
    >;
    handling: "direct" | "automatic_conversion" | "review_required";
    minimumDepositRaw: string | null;
    recommendedFor: Array<"crypto" | "card">;
    displayOrder: number;
  }>;
};
```

The response contains neither a receive address nor an internal
`destinationOptionId` or `venueBindingOptionId`. Treat it as short-lived UI
discovery only. `receiveOptionId` encodes neither a public destination nor an
authorization to display an address.

Suggested presentation rules:

- filter networks locally from `receiveOptions`; do not hardcode the asset
  list or network list;
- use `displayOrder` for stable ordering and `recommendedFor` only as a
  default, never as an exclusive choice;
- Crypto requires either crypto ingress method; Card requires `privy_card`;
- Card remains an entry method, not a generic attribute of a symbol. An asset
  may be crypto-only because Card is checked against the exact asset and
  receiver; and
- use `handling` for explanatory copy only. The session response is the
  authority for the actual post-deposit handling.

## Opening and idempotency

For the opaque token-first request, `idempotencyKey` is required. Generate it
once per selected `receiveOptionId`, retain it until the open succeeds or the
user deliberately chooses another asset, and reuse it for a transport retry.
Do not use the option ID as the key.

The API persists this mapping. Therefore a retry with the same key and exact
option can return the original session even after the five-minute catalogue
token expires. A key reused for a different selection is a conflict, not a
request to move the existing session.

The POST accepts **exactly one** of these request shapes:

```ts
// New ordinary Add Funds path
{ receiveOptionId: string; idempotencyKey: string }

// Existing compatibility / trade-scoped path
{
  destinationOptionId: string;
  venueBindingOptionId: string;
  selectedReceiveTargetId?: string | null;
}
```

Never combine the fields from both shapes.

## Errors and refresh rules

| Response | Meaning | Frontend action |
| --- | --- | --- |
| `410 receive_option_expired` | The opaque catalogue token expired before a session opened. | Refetch the catalogue, preserve the entry method/filter if possible, and ask the user to select a current option. |
| `410 stale_projection` | The policy/capability changed while opening. | Refetch the catalogue and select again. |
| `409 receive_session_selection_conflict` | A different exact asset/network is already post-money in the same protected receive scope. | Show the active session/status; do not replace its address or silently switch assets. |
| `409 receive_session_idempotency_conflict` | The caller reused one idempotency key for a different option. | Generate a new key only after an explicit new selection. |
| `409 receive_channel_conflict` | Another channel owns the incompatible active receive route. | Direct the user to that route; do not create a second address. |
| other `destination_unavailable` / `funding_policy_disabled` | The option is no longer safely usable. | Refresh discovery and present the current list. |

A failed or expired selection never discloses an address. The UI must not
reuse a previously cached address or manually reconstruct a destination from
the option's visible asset fields.

## Session lifecycle after the open

On success the response is the existing `FundingReceiveSessionResponse`:

- `session.methods` identifies available manual and/or Privy methods;
- `session.receiveTargets` contains the verified address and exact accepted
  asset/network for this session only;
- receipt detection, automatic conversion, review-required conversion,
  operation execution, and terminal states are unchanged;
- before a receipt/broadcast boundary, existing cancellation controls remain
  valid; after that boundary, show status/progress rather than offering a
  false financial cancellation.

Persist only the returned `receiveSessionId` for restoration. If local UI
state also remembers the selected opaque option for copy, treat it as display
metadata only: session data always wins after a reload.

## Compatibility boundaries

Keep these paths on their current exact-ID contracts:

- `purpose: "trade_shortfall"` and Buy/Fund-and-Buy continuation;
- conversion and withdrawal;
- Telegram funding and bot cards;
- existing recover/resume logic for a known receive session; and
- legacy callers using destination/binding IDs.

The token-first API is additive. It must be adopted only by ordinary web Add
Funds. No frontend feature flag is required: availability is determined by
the authenticated `GET /funding/receive-options` response. An empty list is a
safe unavailable state, not a cue to fall back to client-side venue routing.

## Integration checklist

1. Regenerate frontend OpenAPI types from the backend schema after the backend
   release or a local API schema dump.
2. Add a `receiveOptions` React Query key with no persistent/public cache.
3. Replace only the generic Add Funds destination picker with entry-method and
   asset/network selection screens.
4. Call opaque POST and retain its caller idempotency key across retries.
5. Feed its unchanged receive-session response into the existing method,
   manual-address, connected-wallet, Card, receipt, and operation UI.
6. Test Crypto and Card for each advertised exact variant, stale option,
   conflict, reload/retry, and ensure all trade-shortfall paths still use the
   legacy request shape.
