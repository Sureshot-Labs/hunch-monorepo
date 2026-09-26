function xStatusId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const statusId =
    parts[0] === "i" && parts[1] === "web" && parts[2] === "status"
      ? parts[3]
      : parts[1] === "status" || parts[1] === "statuses"
        ? parts[2]
        : null;
  return statusId && /^\d+$/.test(statusId) ? statusId : null;
}

export function resolveVerifiedExternalSourceUrl(
  candidateUrl: string,
  providerSources: readonly string[],
): string | null {
  if (providerSources.includes(candidateUrl)) return candidateUrl;
  // A fragment identifies a passage on the same page. Do not equate different
  // query strings, hosts or paths (they can identify different articles).
  const pageUrl = (value: string): string | null => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  };
  const candidatePage = pageUrl(candidateUrl);
  if (candidatePage) {
    const pageMatch = providerSources.find(
      (source) => pageUrl(source) === candidatePage,
    );
    if (pageMatch) return pageMatch;
  }
  const candidateStatusId = xStatusId(candidateUrl);
  if (!candidateStatusId) return null;
  return (
    providerSources.find((source) => xStatusId(source) === candidateStatusId) ??
    null
  );
}
