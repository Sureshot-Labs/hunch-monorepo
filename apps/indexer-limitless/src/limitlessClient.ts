import { env } from "./env.js";
import { LimitlessActiveResponse, TLimitlessMarket } from "./types.js";

async function getJson(url: string) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Limitless ${r.status} ${url}`);
  return r.json();
}

export async function fetchActivePage(
  page: number,
  limit: number,
  sortBy = "newest",
) {
  const base = env.limitlessBase.replace(/\/+$/, "");
  const url = `${base}/markets/active?page=${page}&limit=${limit}&sortBy=${encodeURIComponent(
    sortBy,
  )}`;
  console.log("Fetching Limitless active page", page, limit, sortBy, url);
  const j = await getJson(url);
  const parsed = LimitlessActiveResponse.parse(j);
  return parsed;
}

export async function fetchAllActive(maxPages: number, pageSize: number) {
  const out: TLimitlessMarket[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchActivePage(p, pageSize, "newest");
    if (!res.data.length) break;
    out.push(...res.data);
    // cheap throttling
    await new Promise((r) => setTimeout(r, 150));
    if (res.totalPages && p >= res.totalPages) break;
  }
  return out;
}
