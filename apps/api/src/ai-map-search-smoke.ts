import { pathToFileURL } from "node:url";
import { runMapSearch } from "./lib/map-news/map-search-core.js";

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runMapSearch(process.argv.slice(2), {
    commandName: "ai:map-search:smoke",
    scriptTag: "ai-map-search-smoke",
    qaScriptName: "ai-map-search-smoke",
  }).catch(async (error) => {
    console.error("[ai-map-search-smoke] failed", error);
    process.exit(1);
  });
}
