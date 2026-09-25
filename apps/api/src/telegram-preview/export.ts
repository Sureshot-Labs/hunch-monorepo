import { readFile, mkdir, writeFile } from "node:fs/promises";
import { format } from "prettier";

// Check before importing anything that can load API configuration.
if (
  process.env.TELEGRAM_PREVIEW_EXPORT !== "1" ||
  process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1"
) {
  throw new Error(
    "Run apps/telegram-preview/scripts/generate.mjs (isolated offline exporter).",
  );
}
const { buildScreens } = await import("./screens.js");
const screens = await buildScreens();
const output = await format(JSON.stringify({ version: 1, screens }), {
  parser: "json",
});
const directory = new URL(
  "../../../telegram-preview/snapshots/",
  import.meta.url,
);
const file = new URL("screens.json", directory);
if (process.argv.includes("--check")) {
  if ((await readFile(file, "utf8")) !== output)
    throw new Error(
      "Preview snapshots are stale. Run telegram:preview:snapshots.",
    );
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(file, output);
}
console.log(
  `${screens.length} static Telegram screens ${process.argv.includes("--check") ? "verified" : "generated"}.`,
);
