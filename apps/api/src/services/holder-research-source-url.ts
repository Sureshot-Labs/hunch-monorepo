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
  const candidateStatusId = xStatusId(candidateUrl);
  if (!candidateStatusId) return null;
  return (
    providerSources.find((source) => xStatusId(source) === candidateStatusId) ??
    null
  );
}
