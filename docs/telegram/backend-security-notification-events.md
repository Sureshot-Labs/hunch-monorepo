# Backend Task: Security Notification Event Producers

Status: scoped backlog; requires domain-owner confirmation  
Priority: P2  
Depends on: authoritative mutation owners and approved event semantics

## Goal

Create durable, deduplicated security events for high-value account and bot
changes. Add a Telegram `security_events` topic only after these producers are
reliable and their delivery behavior is defined.

This is a separate backlog task because the reviewed backend does not yet have
one canonical security event stream. A visible Settings label must not imply
coverage that the system cannot provide.

## Candidate Events to Confirm

| Event                                   | Authoritative source                     | Telegram delivery note                                                                                              |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Telegram linked                         | Successful backend link transaction      | Send only after the chat is known reachable                                                                         |
| Telegram unlinked                       | Successful backend unlink transaction    | The removed chat may no longer be a valid destination; record for in-app/audit and define another channel if needed |
| Wallet linked or unlinked               | Wallet-link mutation after commit        | Include truncated wallet and action, never secrets                                                                  |
| Bot trading enabled or disabled         | Trading-permission mutation after commit | High-value, default-on candidate                                                                                    |
| Bot venue or max-order policy changed   | Same server-side policy mutation         | Include old/new safe display values when trustworthy                                                                |
| Signer authorization revoked or invalid | Authoritative signer/venue validation    | Mark whether user action is required                                                                                |
| Login or credential method changed      | Trusted identity provider/backend hook   | Include only if the backend can prove the mutation                                                                  |

The backend owner must accept or reject each event before schema work. Do not
create generic copy for mutations whose source, actor, and rollback semantics
are unknown.

## Producer Contract

Each accepted event must be written only after the underlying mutation commits
and should include:

- stable event type and schema version;
- affected user;
- immutable operation/dedupe ID;
- event timestamp;
- actor class where safely known: user, system, admin, or provider;
- old/new non-secret values when meaningful;
- whether user action is required;
- safe Mini App destination, if one exists.

Never use a frontend success toast as the source of truth. Never include wallet
private material, Telegram auth payloads, tokens, raw provider errors, or full
authorization secrets in notification data.

If a mutation and notification record cannot share a transaction, use the
domain's outbox pattern so a post-commit process cannot silently lose the
event.

## Topic and Delivery

After at least the approved minimum event set has producers:

1. add `security_events` and its `enabled_at` cutoff in a forward migration;
2. default it on for eligible linked accounts without replaying old events;
3. add it to the preference API and private bot Security screen;
4. map only accepted event types to the topic;
5. render concise copy with one recovery/settings action at most;
6. add metrics by event type and delivery result.

Do not make Security a master switch for unrelated product announcements or
general system messages.

## Abuse and Edge Cases

- A Telegram unlink event cannot assume the unlinked chat remains deliverable.
- An attacker changing a destination must not suppress every audit trail;
  preserve the durable in-app event and future multi-channel options.
- Repeated provider health checks must not emit repeated signer-invalid alerts
  for the same incident.
- Admin/system changes need a clear actor label without exposing internal IDs.
- Reverting a setting is a new event, not mutation of the previous event.
- A blocked Telegram bot does not erase Security preferences or audit events.

## Acceptance Criteria

- Every enabled event has an authoritative backend producer and stable dedupe
  key.
- Events are created after successful commits and never from frontend-only
  state.
- Sensitive data is excluded from payloads, logs, and Telegram copy.
- Duplicate retries produce one durable event and at most one Telegram message.
- Link/unlink and destination-change edge cases have explicit tests.
- The Security toggle appears only when meaningful event coverage exists.
- Enabling Security cannot replay historical changes.
- Delivery failure does not remove the underlying in-app/audit event.

## Out of Scope

- product announcements and marketing campaigns;
- a separate withdrawal topic without a canonical withdrawal product event;
- email/SMS delivery implementation;
- performing account, wallet, signer, or trading-permission mutations from a
  notification callback.
