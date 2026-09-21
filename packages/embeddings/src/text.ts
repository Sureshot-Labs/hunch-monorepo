import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenizer } from "@huggingface/tokenizers";
import { Parser } from "htmlparser2";
import type {
  EmbeddingGeneration,
  EmbeddingModel,
  EmbeddingSource,
} from "./contracts.js";
import { LEGACY_EMBEDDING_GENERATION } from "./contracts.js";

// Assets are local, immutable and verified; initializing a tokenizer never downloads a model.
const ASSETS: Record<
  EmbeddingModel,
  { name: string; tokenizer: string; config: string }
> = {
  "intfloat/e5-large-v2": {
    name: "e5",
    tokenizer:
      "8c44811352cd5a8d7afd7ab03898c4b3f30246527fb15c51efab6a9f8901391e",
    config: "ae83fa6ca0333117ff12606020af925d648667ef70d92ff7f27d781ba0ca4544",
  },
  "qwen/qwen3-embedding-8b": {
    name: "qwen",
    tokenizer:
      "6f7f875b7bb97c2a5f3d5a49bac3ca579bf03684ce4972bd47c869d6493adf7f",
    config: "2f58f4bbd7bbce15d683f525954ef3a92cd82f5e06415a9c513859bf8ab72436",
  },
};
const tokenizers = new Map<EmbeddingModel, Tokenizer>();
function tokenizerFor(model: EmbeddingModel): Tokenizer {
  const existing = tokenizers.get(model);
  if (existing) return existing;
  const asset = ASSETS[model];
  const load = (kind: "tokenizer" | "config") => {
    const bytes = readFileSync(
      new URL(`../assets/${asset.name}-${kind}.asset`, import.meta.url),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== asset[kind])
      throw new Error(
        `Embedding tokenizer asset checksum mismatch: ${asset.name}-${kind}`,
      );
    return JSON.parse(bytes.toString("utf8")) as object;
  };
  const tokenizer = new Tokenizer(load("tokenizer"), load("config"));
  tokenizers.set(model, tokenizer);
  return tokenizer;
}
export const embeddingTokenLimit = (generation: EmbeddingGeneration): number =>
  generation.legacy
    ? 512
    : generation.model === "intfloat/e5-large-v2"
      ? 480
      : 2048;
export function countEmbeddingTokens(
  text: string,
  generation: EmbeddingGeneration,
): number {
  return tokenizerFor(generation.model).encode(text, {
    add_special_tokens: true,
  }).ids.length;
}

const HTML_TAGS = new Set(
  "a abbr address article aside audio b bdi bdo blockquote body br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr".split(
    " ",
  ),
);
const BOOLEAN_HTML_ATTRIBUTES = new Set(
  "allowfullscreen async autofocus autoplay checked controls default defer disabled hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected".split(
    " ",
  ),
);
function protectLiteralComparisons(value: string): string {
  // Venue fields mix HTML with expressions like BTC<ETH and x<y. htmlparser2
  // otherwise consumes unknown/incomplete angle expressions as unfinished tags.
  return value.replace(/</g, (_match, position: number) => {
    const fragment = value.slice(position, position + 4096);
    if (fragment.startsWith("<!--")) return "<";
    const tag = fragment.match(
      /^<\/?([a-z][\w:-]*)(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i,
    );
    if (!tag || !HTML_TAGS.has((tag[1] ?? "").toLowerCase())) return "&lt;";
    const attributes = (tag[2] ?? "").replace(/\/\s*$/, "").trim();
    // Bare words after a variable (A<B and C>D) aren't meaningful HTML attrs.
    if (
      attributes &&
      !attributes.includes("=") &&
      !attributes
        .toLowerCase()
        .split(/\s+/)
        .every((value) => BOOLEAN_HTML_ATTRIBUTES.has(value))
    )
      return "&lt;";
    return "<";
  });
}

export function cleanEmbeddingText(value?: string | null): string {
  if (!value) return "";
  const chunks: string[] = [];
  let ignoredDepth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (ignoredDepth || name === "script" || name === "style") {
          if (!ignoredDepth) chunks.push(" ");
          ignoredDepth++;
        } else if (
          [
            "p",
            "div",
            "br",
            "li",
            "ul",
            "ol",
            "tr",
            "td",
            "h1",
            "h2",
            "h3",
          ].includes(name)
        )
          chunks.push(" ");
      },
      ontext(text) {
        if (!ignoredDepth) chunks.push(text);
      },
      onclosetag(name) {
        if (ignoredDepth) {
          ignoredDepth--;
          if (!ignoredDepth) chunks.push(" ");
        } else if (
          ["p", "div", "li", "ul", "ol", "tr", "td", "h1", "h2", "h3"].includes(
            name,
          )
        )
          chunks.push(" ");
      },
    },
    { decodeEntities: true },
  );
  parser.end(protectLiteralComparisons(value));
  // Keep meaningful punctuation, signs, dates, negatives and units intact.
  return (
    chunks
      .join("")
      .normalize("NFC")
      .replace(/https?:\/\/\S+/giu, " ")
      // eslint-disable-next-line no-control-regex -- Strip non-text C0 characters before model input.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}
const QUERY_INSTRUCTION =
  "Instruct: Given prediction-market news or a search query, retrieve related prediction markets and events.\nQuery: ";
function adapted(
  text: string,
  generation: EmbeddingGeneration,
  query: boolean,
): string {
  if (generation.legacy) return text;
  return generation.model === "intfloat/e5-large-v2"
    ? `query: ${text}`
    : query
      ? `${QUERY_INSTRUCTION}${text}`
      : text;
}
function truncateToFit(
  value: string,
  render: (value: string) => string,
  generation: EmbeddingGeneration,
  limit = embeddingTokenLimit(generation),
): string {
  if (countEmbeddingTokens(render(value), generation) <= limit) return value;
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (
      countEmbeddingTokens(render(chars.slice(0, mid).join("")), generation) <=
      limit
    )
      low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("").trimEnd();
}

/** Compatibility renderer for the already-published E5 passage generation.
 * Keep raw HTML and old field names here; clean-v1 belongs to another space.
 */
export function buildLegacyEmbeddingText(source: EmbeddingSource): string {
  const normalize = (value?: string | null) =>
    value?.replace(/\s+/g, " ").trim() || "";
  const truncate = (value: string, limit: number) =>
    value.length <= limit ? value : value.slice(0, limit).trim();
  const title = normalize(source.title);
  const parent = normalize(source.eventTitle);
  const category = normalize(source.category);
  const description = truncate(normalize(source.description), 500);
  const lines = [`passage: ${source.kind}`];
  if (source.kind === "market") {
    const outcomes = normalize(source.outcomes?.join(", "))
      .split(",")
      .map((value) => normalize(value))
      .filter(Boolean);
    const lowers = new Set(outcomes.map((value) => value.toLowerCase()));
    const binary =
      lowers.size <= 2 &&
      ((lowers.has("yes") && lowers.has("no")) ||
        (lowers.has("true") && lowers.has("false")));
    const marketType = normalize(source.marketType);
    if (title) lines.push(`market_title=${title}`);
    if (parent && parent !== title) lines.push(`event_title=${parent}`);
    if (category) lines.push(`category=${category}`);
    if (outcomes.length && !binary)
      lines.push(`outcomes=${outcomes.join(", ")}`);
    if (marketType && marketType !== "binary")
      lines.push(`market_type=${marketType}`);
  } else {
    const seen = new Set<string>();
    const markets = normalize(source.topMarkets?.join(" | "))
      .split("|")
      .map((value) => normalize(value))
      .filter((value) => {
        const lower = value.toLowerCase();
        if (
          !value ||
          lower === title.toLowerCase() ||
          /^(yes|no|true|false)$/.test(lower) ||
          seen.has(lower)
        )
          return false;
        seen.add(lower);
        return true;
      })
      .slice(0, 20);
    if (title) lines.push(`event_title=${title}`);
    if (markets.length)
      lines.push(`top_markets=${truncate(markets.join(" | "), 320)}`);
    if (category) lines.push(`category=${category}`);
  }
  if (description) lines.push(`description=${description}`);
  // The former character cap could exceed E5's context for punctuation/Unicode.
  // Preserve byte-for-byte legacy text whenever it already fits the model.
  const text = truncate(lines.join("\n"), 1500);
  return truncateToFit(
    text,
    (value) => value,
    LEGACY_EMBEDDING_GENERATION,
    510,
  );
}
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => cleanEmbeddingText(value))
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildEmbeddingText(
  source: EmbeddingSource,
  generation: EmbeddingGeneration,
): string {
  if (generation.legacy) return buildLegacyEmbeddingText(source);
  const title = cleanEmbeddingText(source.title);
  const parent = cleanEmbeddingText(source.eventTitle);
  const category = cleanEmbeddingText(source.category);
  if (!title) throw new Error("Embedding source has no meaningful title");
  const headline =
    source.kind === "market"
      ? // The defining outcome must survive even when a verbose parent is truncated.
        `Market: ${title}${parent && parent.toLowerCase() !== title.toLowerCase() ? `\nEvent: ${parent}` : ""}`
      : `Event: ${title}`;
  const core = `${headline}${category ? `\nCategory: ${category}` : ""}`;
  let outcomes = distinct(
    source.kind === "event"
      ? [...(source.topMarkets ?? [])].sort()
      : (source.outcomes ?? []),
  )
    .filter(
      (value) =>
        !/^(yes|no|true|false)$/iu.test(value) &&
        value.toLowerCase() !== title.toLowerCase(),
    )
    .slice(0, 8);
  let description = cleanEmbeddingText(source.description);
  if (
    description.toLowerCase() === title.toLowerCase() ||
    description.toLowerCase() === parent.toLowerCase()
  )
    description = "";
  const compose = (descriptionValue: string) =>
    adapted(
      `${core}${outcomes.length ? `\nOutcomes: ${outcomes.join("; ")}` : ""}${descriptionValue ? `\nDetails: ${descriptionValue}` : ""}`,
      generation,
      false,
    );
  description = truncateToFit(description, compose, generation);
  while (
    outcomes.length &&
    countEmbeddingTokens(compose(description), generation) >
      embeddingTokenLimit(generation)
  )
    outcomes = outcomes.slice(0, -1);
  const result = compose(description);
  if (
    countEmbeddingTokens(result, generation) <= embeddingTokenLimit(generation)
  )
    return result;
  return adapted(
    truncateToFit(core, (text) => adapted(text, generation, false), generation),
    generation,
    false,
  );
}

export function buildNewsEmbeddingText(
  headline: string,
  summary: string | null | undefined,
  generation: EmbeddingGeneration,
): string {
  // Legacy callers used raw headline + summary. Keep its old space unchanged for pinned old maps.
  const text = generation.legacy
    ? `${headline}${summary ? ` ${summary}` : ""}`
    : distinct([headline, summary ?? ""]).join("\n");
  return adapted(
    truncateToFit(
      text,
      (value) => adapted(value, generation, true),
      generation,
    ),
    generation,
    true,
  );
}
