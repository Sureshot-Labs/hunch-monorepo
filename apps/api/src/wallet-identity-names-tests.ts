import assert from "node:assert/strict";

import {
  buildIdentityNamesMetadataPatch,
  extractWalletIdentityDisplayFields,
  fetchPolymarketIdentityName,
  resolveEnsIdentityName,
  resolveWalletIdentityNames,
} from "./services/wallet-identity-names.js";

const NOW = "2026-06-25T12:00:00.000Z";
const WALLET = "0x1111111111111111111111111111111111111111";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const tests = [
  {
    name: "polymarket resolver stores public username and profile URL",
    async run() {
      const calls: string[] = [];
      const result = await fetchPolymarketIdentityName({
        address: WALLET,
        nowIso: NOW,
        fetchImpl: (async (url: RequestInfo | URL) => {
          calls.push(String(url));
          return jsonResponse({
            name: "helldfkdsf",
            pseudonym: "Nimble-Cornet",
            verifiedBadge: false,
            displayUsernamePublic: true,
          });
        }) as typeof fetch,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.source.username, "helldfkdsf");
      assert.equal(result.source.pseudonym, "Nimble-Cornet");
      assert.equal(result.source.profileUrl, "https://polymarket.com/@helldfkdsf");
      assert.equal(result.source.resolvedAt, NOW);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /profile\/userData/);
    },
  },
  {
    name: "polymarket resolver treats missing or private username as not found",
    async run() {
      const result = await fetchPolymarketIdentityName({
        address: WALLET,
        nowIso: NOW,
        fetchImpl: (async () =>
          jsonResponse({
            name: "hidden",
            displayUsernamePublic: false,
          })) as typeof fetch,
      });

      assert.equal(result.status, "not_found");
      assert.equal(result.source.status, "not_found");
      assert.equal(result.source.checkedAt, NOW);
    },
  },
  {
    name: "polymarket resolver treats 429 as non-fatal error",
    async run() {
      const result = await fetchPolymarketIdentityName({
        address: WALLET,
        nowIso: NOW,
        fetchImpl: (async () =>
          new Response("rate limited", { status: 429 })) as typeof fetch,
      });

      assert.equal(result.status, "error");
      assert.equal(result.error, "http_429");
      assert.equal(result.source.status, "error");
      assert.equal(result.source.error, "http_429");
      assert.equal(result.source.errorCheckedAt, NOW);
    },
  },
  {
    name: "ENS resolver skips 403 without throwing",
    async run() {
      const result = await resolveEnsIdentityName({
        address: WALLET,
        nowIso: NOW,
        rpcUrl: "https://eth.example.invalid",
        fetchImpl: (async () =>
          new Response("forbidden", { status: 403 })) as typeof fetch,
      });

      assert.deepEqual(result, { status: "skipped", reason: "forbidden" });
    },
  },
  {
    name: "ENS resolver accepts reverse name only when forward matches",
    async run() {
      const result = await resolveEnsIdentityName({
        address: WALLET,
        nowIso: NOW,
        rpcUrl: "https://eth.example.invalid",
        fetchImpl: (async () =>
          jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })) as typeof fetch,
        client: {
          async lookupAddress(address: string) {
            assert.equal(address, WALLET);
            return "name.eth";
          },
          async resolveName(name: string) {
            assert.equal(name, "name.eth");
            return WALLET;
          },
        },
      });

      assert.equal(result.status, "ok");
      assert.equal(result.source.name, "name.eth");
      assert.equal(result.source.resolvedAt, NOW);
    },
  },
  {
    name: "metadata patch preserves existing source when another source updates",
    run() {
      const patch = buildIdentityNamesMetadataPatch({
        existingMetadata: {
          identityNames: {
            ens: {
              status: "ok",
              name: "name.eth",
              resolvedAt: "2026-06-24T00:00:00.000Z",
            },
          },
          unrelated: true,
        },
        polymarket: {
          status: "ok",
          username: "helldfkdsf",
          profileUrl: "https://polymarket.com/@helldfkdsf",
          resolvedAt: NOW,
        },
      });

      assert.equal(patch?.primary?.name, "@helldfkdsf");
      assert.equal(patch?.primary?.source, "polymarket");
      assert.equal(patch?.ens?.name, "name.eth");
      assert.equal(patch?.polymarket?.username, "helldfkdsf");
    },
  },
  {
    name: "display fields use computed primary identity",
    run() {
      const fields = extractWalletIdentityDisplayFields({
        identityNames: {
          primary: {
            name: "@helldfkdsf",
            source: "polymarket",
            profileUrl: "https://polymarket.com/@helldfkdsf",
            resolvedAt: NOW,
          },
        },
      });

      assert.deepEqual(fields, {
        identityDisplayName: "@helldfkdsf",
        identityDisplayNameSource: "polymarket",
        identityProfileUrl: "https://polymarket.com/@helldfkdsf",
      });
    },
  },
  {
    name: "display fields can fill empty response label from identity",
    run() {
      const fields = extractWalletIdentityDisplayFields(
        {
          identityNames: {
            ens: {
              status: "ok",
              name: "name.eth",
              resolvedAt: NOW,
            },
          },
        },
        null,
      );

      assert.equal(fields.label, "name.eth");
      assert.equal(fields.identityDisplayName, "name.eth");
    },
  },
  {
    name: "display fields preserve existing response label over identity",
    run() {
      const fields = extractWalletIdentityDisplayFields(
        {
          identityNames: {
            ens: {
              status: "ok",
              name: "name.eth",
              resolvedAt: NOW,
            },
          },
        },
        "Saved label",
      );

      assert.equal(fields.label, "Saved label");
      assert.equal(fields.identityDisplayName, "name.eth");
    },
  },
  {
    name: "display fields use polymarket pseudonym for address-like usernames",
    run() {
      const fields = extractWalletIdentityDisplayFields(
        {
          identityNames: {
            polymarket: {
              status: "ok",
              username: "0x8c66E28FbE7Ede7F57bA6CBc70408DfF442944F3-1777220320442",
              pseudonym: "Solid-Airfare",
              profileUrl:
                "https://polymarket.com/@0x8c66E28FbE7Ede7F57bA6CBc70408DfF442944F3-1777220320442",
              resolvedAt: NOW,
            },
          },
        },
        null,
      );

      assert.equal(fields.label, "Solid-Airfare");
      assert.equal(fields.identityDisplayName, "Solid-Airfare");
      assert.equal(fields.identityDisplayNameSource, "polymarket");
      assert.equal(
        fields.identityProfileUrl,
        "https://polymarket.com/@0x8c66E28FbE7Ede7F57bA6CBc70408DfF442944F3-1777220320442",
      );
    },
  },
  {
    name: "display fields suppress bad polymarket usernames without good fallback",
    run() {
      const fields = extractWalletIdentityDisplayFields(
        {
          identityNames: {
            polymarket: {
              status: "ok",
              username: "0x8c66E28FbE7Ede7F57bA6CBc70408DfF442944F3-1777220320442",
              pseudonym: "0x736c3A4b755444f7ce7f65C4158157862675BC72",
              resolvedAt: NOW,
            },
          },
        },
        null,
      );

      assert.equal(fields.label, null);
      assert.equal(fields.identityDisplayName, null);
      assert.equal(fields.identityDisplayNameSource, null);
      assert.equal(fields.identityProfileUrl, null);
    },
  },
  {
    name: "wallet resolver skipEns preserves existing ENS source",
    async run() {
      const report = await resolveWalletIdentityNames({
        address: WALLET,
        chain: "polygon",
        venue: "polymarket",
        metadata: {
          identityNames: {
            ens: {
              status: "ok",
              name: "name.eth",
              resolvedAt: "2026-06-24T00:00:00.000Z",
            },
          },
        },
        now: new Date(NOW),
        skipEns: true,
        fetchImpl: (async () =>
          jsonResponse({
            name: "helldfkdsf",
            displayUsernamePublic: true,
          })) as typeof fetch,
      });

      assert.equal(report.changed, true);
      assert.equal(report.polymarketStatus, "resolved");
      assert.equal(report.ensStatus, "skipped");
      assert.equal(report.identityNames?.primary?.name, "@helldfkdsf");
      assert.equal(report.identityNames?.ens?.name, "name.eth");
    },
  },
  {
    name: "wallet resolver caches polymarket errors without dropping old username",
    async run() {
      const report = await resolveWalletIdentityNames({
        address: WALLET,
        chain: "polygon",
        venue: "polymarket",
        metadata: {
          identityNames: {
            polymarket: {
              status: "ok",
              username: "oldname",
              profileUrl: "https://polymarket.com/@oldname",
              resolvedAt: "2026-06-01T00:00:00.000Z",
            },
          },
        },
        now: new Date(NOW),
        skipEns: true,
        fetchImpl: (async () =>
          new Response("rate limited", { status: 429 })) as typeof fetch,
      });

      assert.equal(report.changed, true);
      assert.equal(report.polymarketStatus, "error");
      assert.equal(report.polymarketError, "http_429");
      assert.equal(report.identityNames?.primary?.name, "@oldname");
      assert.equal(report.identityNames?.polymarket?.username, "oldname");
      assert.equal(report.identityNames?.polymarket?.status, "error");
      assert.equal(report.identityNames?.polymarket?.error, "http_429");
      assert.equal(report.identityNames?.polymarket?.errorCheckedAt, NOW);
    },
  },
  {
    name: "wallet resolver backs off fresh polymarket errors",
    async run() {
      let calls = 0;
      const report = await resolveWalletIdentityNames({
        address: WALLET,
        chain: "polygon",
        venue: "polymarket",
        metadata: {
          identityNames: {
            polymarket: {
              status: "error",
              error: "http_429",
              errorCheckedAt: NOW,
              checkedAt: NOW,
            },
          },
        },
        now: new Date("2026-06-25T13:00:00.000Z"),
        skipEns: true,
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse({ name: "should-not-fetch" });
        }) as typeof fetch,
      });

      assert.equal(report.changed, false);
      assert.equal(report.polymarketStatus, "fresh");
      assert.equal(calls, 0);
    },
  },
  {
    name: "wallet resolver retries stale polymarket error even with preserved username",
    async run() {
      let calls = 0;
      const report = await resolveWalletIdentityNames({
        address: WALLET,
        chain: "polygon",
        venue: "polymarket",
        metadata: {
          identityNames: {
            polymarket: {
              status: "error",
              username: "oldname",
              profileUrl: "https://polymarket.com/@oldname",
              resolvedAt: "2026-06-25T11:00:00.000Z",
              error: "http_429",
              errorCheckedAt: "2026-06-25T05:00:00.000Z",
              checkedAt: "2026-06-25T05:00:00.000Z",
            },
          },
        },
        now: new Date(NOW),
        skipEns: true,
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse({
            name: "newname",
            displayUsernamePublic: true,
          });
        }) as typeof fetch,
      });

      assert.equal(report.changed, true);
      assert.equal(report.polymarketStatus, "resolved");
      assert.equal(calls, 1);
      assert.equal(report.identityNames?.primary?.name, "@newname");
      assert.equal(report.identityNames?.polymarket?.status, "ok");
      assert.equal(report.identityNames?.polymarket?.username, "newname");
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[wallet-identity-names-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`passed ${passed}/${tests.length} wallet-identity-names tests`);
