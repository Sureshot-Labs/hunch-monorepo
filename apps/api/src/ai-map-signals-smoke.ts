import { runMapSignals } from "./ai-map-signals-run.js";

runMapSignals(process.argv.slice(2), {
  commandName: "ai:map-signals:smoke",
  scriptTag: "ai-map-signals-smoke",
  qaScriptName: "ai-map-signals-smoke",
}).catch(async error => {
  console.error("[ai-map-signals-smoke] failed", error);
  process.exit(1);
});
