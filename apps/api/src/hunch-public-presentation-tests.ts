import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  publicHolderDisplayName,
  publicHolderLabel,
  publicHunchSources,
} from "./services/hunch-public-presentation.js";

const walletAddress = "0x8B4bcA1D794779E66e023D44391B2A86C5ab541B";

assert.deepEqual(
  publicHunchSources({
    kind: "signal",
    metrics: {},
    modelMeta: {
      evidence_refs: [
        { evidence_id: "market:iran", headline: "September 30" },
        { evidence_id: "side:iran:NO", headline: "backing September 30 side" },
        {
          evidence_id: "holder:wallet:NO",
          headline: `${walletAddress} betting against September 30`,
          source_url: null,
          source_domain: "hunch.internal",
        },
      ],
    },
  }),
  [],
  "internal candidate fragments are not public citations",
);

assert.deepEqual(
  publicHunchSources({
    kind: "signal",
    metrics: {},
    modelMeta: {
      evidence_refs: [{ headline: "internal only", source_url: null }],
      external_research: {
        citations: [
          {
            title: "Official deadline announcement",
            url: "https://example.org/announcement",
            publishedAt: "2026-09-25T12:00:00.000Z",
          },
          {
            title: "Duplicate announcement",
            url: "https://example.org/announcement",
          },
          "https://example.net/context",
          { title: "Invalid", url: "javascript:alert(1)" },
          { title: "Internal", url: "https://hunch.internal/debug" },
        ],
      },
    },
  }),
  [
    {
      id: "https://example.org/announcement",
      headline: "Official deadline announcement",
      url: "https://example.org/announcement",
      publishedAt: "2026-09-25T12:00:00.000Z",
    },
    {
      id: "https://example.net/context",
      headline: "example.net · context",
      url: "https://example.net/context",
      publishedAt: null,
    },
  ],
  "only external HTTP(S) citations are public, deduplicated and linked",
);

assert.deepEqual(
  publicHunchSources({
    kind: "context",
    metrics: {
      publicContextV1: {
        source_urls: ["https://example.org/selected", "https://example.net/"],
      },
    },
    modelMeta: {
      public_source_citations: [
        {
          title: "Selected source title",
          url: "https://example.org/selected",
          publishedAt: "2026-09-24T08:30:00Z",
        },
        { title: "Unselected source", url: "https://example.org/unused" },
      ],
    },
  }),
  [
    {
      id: "https://example.org/selected",
      headline: "Selected source title",
      url: "https://example.org/selected",
      publishedAt: "2026-09-24T08:30:00.000Z",
    },
    {
      id: "https://example.net/",
      headline: "example.net",
      url: "https://example.net/",
      publishedAt: null,
    },
  ],
  "context exposes only public-context selected URLs",
);

assert.equal(
  publicHolderDisplayName({
    identityDisplayName: `@${walletAddress}-1769764313952`,
    identityDisplayNameSource: "polymarket",
    address: walletAddress,
  }),
  null,
  "address-like public identities cannot become display names",
);
assert.equal(
  publicHolderDisplayName({
    profileLabel: "Plain-Apparatus-Acre",
    identityDisplayName: "@mr.ozi",
    identityDisplayNameSource: "polymarket",
    address: walletAddress,
  }),
  "Plain-Apparatus-Acre",
  "the public AI trader title takes priority over a venue handle",
);
assert.equal(
  publicHolderDisplayName({
    identityDisplayName: "@mr.ozi",
    identityDisplayNameSource: "polymarket",
    address: walletAddress,
  }),
  "mr.ozi",
);
assert.equal(
  publicHolderDisplayName({
    identityDisplayName: "Private desk annotation",
    identityDisplayNameSource: null,
    address: walletAddress,
  }),
  null,
  "unverified stored names cannot become public labels",
);
assert.equal(
  publicHolderDisplayName({
    identityDisplayName: null,
    identityDisplayNameSource: null,
    address: walletAddress,
    walletLabel: "Private desk annotation",
    profileLabel: "Plain-Apparatus-Acre",
  } as Parameters<typeof publicHolderDisplayName>[0]),
  "Plain-Apparatus-Acre",
  "public AI titles are shown without exposing a private wallet annotation",
);
assert.equal(
  publicHolderDisplayName({
    identityDisplayName: "@mr.ozi",
    identityDisplayNameSource: "polymarket",
    address: walletAddress,
    profileLabel: `Trader ${walletAddress}`,
  }),
  "mr.ozi",
  "an address-bearing AI label falls back to the public venue handle",
);
const hunchRouteSource = readFileSync(
  new URL("./routes/hunches.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  hunchRouteSource,
  /\bw\.label\b|wallet_label|wallet_user_names/,
);
assert.match(hunchRouteSource, /wp\.profile->>'label_short'/);
assert.doesNotMatch(hunchRouteSource, /meta\.holderDescriptor/);
assert.equal(publicHolderLabel(walletAddress, walletAddress), null);
assert.equal(
  publicHolderLabel(`@${walletAddress}-1769764313952`, walletAddress),
  null,
);
assert.equal(publicHolderLabel("0x8B4b...541B", walletAddress), null);
assert.equal(
  publicHolderLabel("a69d1c1c-8a6d-44ae-a4fb-1bc47a19915a", null),
  null,
);
assert.equal(
  publicHolderLabel("7dHbWXadqHHYB7sTUSF9L3SsPAgJTS8CthJ", null),
  null,
);

console.log("hunch public presentation tests passed");
