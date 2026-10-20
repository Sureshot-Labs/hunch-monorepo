/**
 * Contract excerpts from the saved 2026-09-18 matching dataset.
 * No later outcome or today's price is included. Test quotes are explicitly synthetic.
 */
export const agentHistoricalContracts = [
  {
    id: "limitless:36723",
    category: "politics",
    title: "Will Trump acquire Greenland before 2027?",
    condition:
      "An official announcement made by the United States and Denmark that Greenland will come under US sovereignty will qualify, even if the actual transfer of sovereignty is yet to occur. Only announcements of official agreements or actions count; mere social media posts do not.",
    closesAt: "2027-01-01T04:59:00Z",
  },
  {
    id: "limitless:115074",
    category: "sports",
    title: "Lamine Yamal",
    condition:
      "Resolves according to the winner of the 2026 Ballon d’Or. If no winner is declared by December 31, 2026, 11:59 PM ET, resolves to Other. Primary source: official France Football information.",
    closesAt: "2026-11-01T03:59:00Z",
  },
  {
    id: "limitless:33548",
    category: "crypto",
    title: "US national Ethereum reserve before 2027?",
    condition:
      "Resolves Yes if the US government holds any Ethereum in its reserves by December 31, 2026, 11:59 PM ET. Confiscating Ethereum does not count as holding Ethereum reserves. Official US government/Federal Reserve information or consensus credible reporting.",
    closesAt: "2027-01-01T04:59:00Z",
  },
] as const;
