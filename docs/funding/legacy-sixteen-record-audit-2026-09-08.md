# Read-only audit: nine authorization reservations, six bridges, one trade

Production inspection on 2026-09-08 after backend `ac37e9e`. No production
writes, reconciliation replay, signing, credential creation or trade submission.
This replaces the previous inventory-only statement: each group was queried
individually against persisted facts and external evidence.

## Nine authorization reservations

All nine remain `reserved`, while their funding operations are completed and
the current pure lifecycle projection also returns completed. Source Base USDC
receipts were verified against persisted token, sender, recipient, amount and
canonical block. Relay now reports success for every request and its input hash
matches the persisted source transaction.

The old destination observations are synthetic `owned-route:...` balance-delta
references, NOT transaction hashes. The real Relay destination transactions were
retrieved separately. Each Polygon receipt succeeds and contains the expected
pUSD Transfer to the observation's recipient. Actual credits below match the
old observed balance deltas and exceed the requested minimums.

| Reservation | Funding operation | Actual pUSD raw | Destination transaction |
| --- | --- | ---: | --- |
| 2c92f39e-371a-4bb8-b545-81b53b1c345e | ba4164df-a785-497a-95f2-8ca7b235b0ad | 828278 | 0x67e062063470f41f6bc64184b7b712476bb27dbc412f9fa5bbfbd3ab31279a80 |
| 79420c16-d1fa-483b-9249-e4bbaf45238c | c177bbfd-76d5-4012-bfc0-b7a63a32233d | 737378 | 0x9e41be50f4ce89452af3ab4ed9c4c0761a86dd15090d62b9a5af437ea8ec334b |
| 71b8ec03-9cc5-44d5-b61e-3c91b49f2d7a | 2c9e1483-0449-4492-9867-b3067a4931d3 | 1030256 | 0x78c7ff9d276860cc6568f576c8d6bf3d8b5d25c43254ceb261a73a599c24265a |
| 16486a36-8c24-4c88-a00d-eecd08c21f20 | 01a02d2d-b83e-4606-9db7-8a6dcf35ae2a | 1030279 | 0x8bf4e91e7e226e1deb2d9267e1e552f2f44426adc4eb64056e58c22bb49920b6 |
| 1243b15c-fff4-4727-81ad-4a617028eb46 | 9350a572-2341-4530-bed3-4d134a5e34f9 | 999993 | 0x67a4724f4cad3a548d82062cb56014dcc983afcc7367fd4fb2d62786c8872633 |
| 047057fe-de0a-4c3d-877b-2a47ed4d91bc | 9d743cb5-505b-41b6-9578-e9fec81595bd | 979668 | 0x23326fb7ac096340862c3f9b67727c7d217ace923c8f3efd6dfd2626c9ef9cdb |
| 04a954c0-b683-486d-b912-ced5e8e31d39 | ed1d8298-964a-46e6-97ad-360882d09d57 | 1070706 | 0x17d7f5e0e256a4cbb507e414ff65c07f9bacb60ad7f325c1da8b3f8bcd359e28 |
| 5c448e33-7213-4244-aad8-e50f84e7c88f | aec6b58e-3600-4e07-895d-02d0b1db4512 | 989843 | 0x79d874142fd5d41a58a08563e2c932f1518700e107ab9b6da25e17070d57c57e |
| 05383ed6-70aa-4fa9-b813-3846c11837e9 | afc2eb6f-3627-434c-aa10-408c1dbd4563 | 1228757 | 0x3d958f56f73656027660229befabccd8fdf38197b943804f7f7c18e1371f7c40 |

Conclusion: stale authorization accounting, not missing destination money.
Current `funding-reducer.ts` already settles authorization rows for completed
funding. Deployment does not replay already finished operations. Repair should
settle these exact reservations with evidence under operation locks and fresh
state assertions, without new credits, consumer continuation or transfers.
Do not add real receipts as additional credits alongside synthetic observations.

## Six April deBridge records

All six database rows still say `submitted`. Four are same-chain swaps, not
cross-chain orders. The three Polygon swap receipts succeed; call traces show
successful native payouts (no trace error). Solana swap is finalized, meta.err
null: 2150951 USDC raw debited, pool wrapped-SOL decreases by 25358480 lamports;
recipient `6vzWaUg9cRnqpKc4R7GMkAw26nbNrCBs2Kfhk2Meh4Jp` receives native SOL.
Its total lamport increase also includes rent, so do not book that increase as
swap output alone.

| Record | Evidence / actual output |
| --- | --- |
| eea63c47-a8a7-45d7-93ad-1ac92babc8dd | Solana USDC → SOL; finalized transaction `5cUx6VxNKRNuAzzhXSaLrFQVYoPoCF6xaDXXDUxzsn3ghFWsBda1vcBBr4k1M7G2vw7LMjWwfRuUva4cF3hcvYSF` |
| 7883d541-a214-4061-b89b-1ebe4b9d6bb0 | 508667387629200707 native raw to `0x1a9ec8b3c44a748f7fad6623fd79332ce683ceb0`; source tx `0x4d8d608703797493ab31a4faae5da2ea0ce02d76bd39ce929aeb12d356f123d3` |
| 48baa18c-a8f3-402c-b88e-fa7ffc43d549 | 518056483029766330 native raw to `0x175dc2c9006af7e6dab66539b001bad322fefa5f`; source tx `0xe8223fc9365073471fe5a67af59d1ac65c74414d3d4f4508f173739631a64c4f` |
| b4674758-11f9-4f99-82f9-81248450bc1a | 499463631602162723 native raw to `0x175dc2c9006af7e6dab66539b001bad322fefa5f`; source tx `0x60bc967c2e6a3afe5c78ec4e07940b5d80a52375fca741bd42261f9d16400731` |
| 6195042d-354d-439a-a5e3-77f164b8f817 | Base receipt succeeds, exact 1994268 USDC to `0x175dc2c9006af7e6dab66539b001bad322fefa5f`; destination tx `0xb0e1a43e1669168613ee4b0462797ae082044f4876edf4b2445dd9f24fc381d0` |
| 31c73ec6-78f4-4674-b7ee-94d0f4e7486a | Solana finalized receipt succeeds, exact 935461 USDC credited to `Fj49czB8o7q64zUTCDiQfxUKTxb7P9VXt5qGhWJAW34u`; destination tx `4DdCBsGNYext1MrppkTJLoYs6GAHZ9N3VF8Lm2g3FQSKEA7TpDKAdBnfFhG7HJyrBSEtBjXPfcBekv66GhZud8xs` |

The two cross-chain rows contain incorrect order IDs. Looking up the stored ID
returns HTTP 422 Order not found. Looking up `/Transaction/{sourceHash}/orderIds`
finds the actual order, whose source transaction matches exactly:

| Record prefix | Actual DLN order ID |
| --- | --- |
| 6195042d | 0xaff105979a1aafeb90bde02c0765a8658ff0b0378ce08ec13fc11b15546722c0 |
| 31c73ec6 | 0x2f9cc2bd087299f3737d9f30662453b800c5b08821a6ca8008ffe8d9da423f0e |

Both actual orders report `ClaimedUnlock`, with the destination transactions
independently verified above. These transfers are not still pending. For repair,
preserve the incorrect ID in audit metadata, persist the actual ID and canonical
destination evidence, and terminalize the legacy record. Same-chain records
must not be sent through DLN order-status reconciliation. Before a write, assert
the saved recipient/quote and account ownership against these exact payouts.
Do not initiate migration, conversion, refund or repeat swap.

## Ambiguous trade: a different evidence quality

Attempt `57e72ba3-4637-4a27-8e3f-30d3187e0def`, funding
`d2338926-dd39-4ca3-8bba-e599ad08f389`, 2026-08-30 17:59:16 UTC.
BUY on `polymarket:561251`, spend bound 1049962 pUSD raw.
Order hash `0x3263951e5194efa972642bd1c42fcbc28d2e4c521e93c17d43a0505c42e76703`.

- Attempt reports `polymarket_submit_state_unknown`, broadcast may have occurred.
- No linked order/execution, nor orders for this user in 17:50–18:20 UTC.
- Authenticated GET by hash with all three existing active signer credentials
  returns no normalized order. No credentials were created or modified.
- The hash is not a Polygon transaction hash. No matching indexed order-hash
  log was found in the bounded window from block 92938386 through 92940885.
  This bounded absence is NOT a proof of no later execution.
- Current `getOrderStatus` on both V2 exchanges returns `filled=false`,
  `remaining=0`. This is consistent with an untouched/default order mapping,
  not positive evidence that CLOB rejected or cancelled the submission.
- Both source and consumer balance reservations are already released. Funding
  support metadata explicitly says `released_to_venue_cash`, reason
  `reservation_expired`, at 18:29:17.099 UTC. Funding completion is therefore
  NOT evidence that the Buy completed.

Do not fabricate a failed or filled result, or revive this Buy. This record
requires an explicit historical-unknown disposition unless an authoritative
order/trade receipt can be recovered. It is not an active balance reservation.
The missing immutable order response/payload prevents a definitive historical
execution verdict from the evidence currently available.

## Operational distinction

The audit has inspected all 16 records; 15 have positive movement evidence.
One has a genuinely unknown consumer outcome, not an unperformed inventory
check. Production status repairs remain separate, approved writes. Never use
age, an expired reservation, or a successful funding transfer as proof of a
failed or successful consumer order.
