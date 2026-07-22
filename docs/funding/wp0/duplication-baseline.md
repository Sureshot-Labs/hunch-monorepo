# Deterministic duplication baseline

Owner: `FundingUIOwner` for frontend scopes and `FundingPlatformOwner` for
backend scopes.

Captured 2026-07-23 with the bundled deterministic analyzer using type-1 token
clones, minimum 60 tokens and minimum 5 lines. Git status was checked before
and after; the analyzer did not modify either repository.

| Scope                                               | Files | Source lines | Clone classes | Occurrences | Duplicate coverage | Redundancy ratio |
| --------------------------------------------------- | ----: | -----------: | ------------: | ----------: | -----------------: | ---------------: |
| Frontend Deposit/hooks/libs                         |    76 |       42,843 |           284 |         808 |           73.7647% |         42.3056% |
| Frontend Header/Wallet/Portfolio/Events/hooks       |   135 |       37,054 |           181 |         385 |           19.0398% |         10.2310% |
| Backend bridge/status/deposit                       |     5 |        5,423 |             8 |          16 |            5.9008% |          2.9504% |
| Backend PM/Limitless readiness/execution/redemption |     6 |       15,708 |            29 |          59 |            6.5253% |          3.3932% |
| Telegram funding/trade                              |     5 |        9,210 |             3 |           6 |            0.8903% |          0.4452% |

The strongest exact frontend clones are the desktop/mobile Deposit Convert,
Bridge, Withdraw, recovery banner, and confirmation-dialog implementations;
some clone classes span roughly 500–900 lines. This is direct evidence for one
shared controller/reducer before adding Tokens, Prepare Funds, Relay, and new
wallet-readiness branches.

The metrics measure exact token equality, not semantic duplication. The
redundancy ratio is not a guaranteed removable-line estimate. The gate is a
directional comparison on the same analyzer/settings: the new funding path must
not introduce a third business-state implementation, and removal should reduce
Deposit clone occurrences without copying behavior into another folder.
