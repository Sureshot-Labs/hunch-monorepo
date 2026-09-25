type PublicHunchKind = "signal" | "context";

export type PublicHunchSource = {
  id: string;
  headline: string;
  url: string;
  publishedAt: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicHttpUrl(value: unknown): URL | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".internal")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function citationTitle(value: unknown, url: URL): string {
  const title = asString(value);
  if (
    !title ||
    title === url.href ||
    title === url.href.replace(/\/$/, "") ||
    /^@?0x[0-9a-f]{8,}$/i.test(title)
  ) {
    const lastPathPart = url.pathname.split("/").filter(Boolean).at(-1);
    let pathLabel = "";
    try {
      pathLabel = decodeURIComponent(lastPathPart ?? "")
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      // Malformed percent escapes should not break an otherwise valid link.
    }
    return /[a-z]{4}/i.test(pathLabel) && pathLabel.length <= 120
      ? `${url.hostname} · ${pathLabel}`
      : url.hostname;
  }
  return title;
}

function citationPublishedAt(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Internal candidate evidence IDs/headlines are not public source citations. */
export function publicHunchSources(input: {
  kind: PublicHunchKind;
  metrics: unknown;
  modelMeta: unknown;
}): PublicHunchSource[] {
  const metrics = asRecord(input.metrics);
  const meta = asRecord(input.modelMeta);
  const research = asRecord(meta.external_research);
  const citationValue =
    input.kind === "context" && Array.isArray(meta.public_source_citations)
      ? meta.public_source_citations
      : research.citations;
  const citations = Array.isArray(citationValue) ? citationValue : [];
  const citationDetails = new Map<
    string,
    { headline: string; publishedAt: string | null }
  >();
  for (const entry of citations) {
    const citation = asRecord(entry);
    const url = publicHttpUrl(typeof entry === "string" ? entry : citation.url);
    if (url && !citationDetails.has(url.href))
      citationDetails.set(url.href, {
        headline: citationTitle(citation.title, url),
        publishedAt: citationPublishedAt(citation.publishedAt),
      });
  }

  const publicContext = asRecord(metrics.publicContextV1);
  const references =
    input.kind === "context" ? publicContext.source_urls : citations;
  if (!Array.isArray(references)) return [];

  const sources: PublicHunchSource[] = [];
  const seen = new Set<string>();
  for (const entry of references) {
    const reference = asRecord(entry);
    const url = publicHttpUrl(
      typeof entry === "string" ? entry : reference.url,
    );
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    const citation = citationDetails.get(url.href);
    sources.push({
      id: url.href,
      headline: citation?.headline ?? citationTitle(reference.title, url),
      url: url.href,
      publishedAt: citation?.publishedAt ?? null,
    });
    if (sources.length >= 6) break;
  }
  return sources;
}

const genericWalletLabel =
  /^(?:(?:unknown|unnamed|tracked|trading|signer|safe|contract|evm|sol)\s+)?wallet(?:\s+\d+)?(?:\s+\(auto\))?$|^(?:directional|active|mixed|hedged|whale|event) trader$|^portfolio$/i;

export function publicHolderLabel(
  value: unknown,
  address: string | null,
): string | null {
  const raw = asString(value);
  const label = raw?.startsWith("@") ? raw.slice(1).trim() : raw;
  if (!label || genericWalletLabel.test(label)) return null;
  if (address && label.toLowerCase() === address.toLowerCase()) return null;
  if (/^0x[0-9a-f]{8,}(?:-\d+)?$/i.test(label)) return null;
  if (/^0x[0-9a-f]{4,}(?:\.\.\.|…)[0-9a-f]{4,}(?:-\d+)?$/i.test(label))
    return null;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      label,
    )
  )
    return null;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(label)) return null;
  return label;
}

export function publicHolderDisplayName(input: {
  identityDisplayName: unknown;
  identityDisplayNameSource: unknown;
  address: string | null;
}): string | null {
  return input.identityDisplayNameSource === "polymarket" ||
    input.identityDisplayNameSource === "ens"
    ? publicHolderLabel(input.identityDisplayName, input.address)
    : null;
}
