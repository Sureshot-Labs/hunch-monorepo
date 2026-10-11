import { pool } from "./db.js";
import { backfillLegacySocialHandles } from "./services/social-handle-backfill.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const afterIndex = args.indexOf("--after");
const afterId = afterIndex < 0 ? undefined : args[afterIndex + 1];
if (
  afterIndex >= 0 &&
  (!afterId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      afterId,
    ))
) {
  throw new Error("--after requires an exact UUID from the preceding page");
}
try {
  console.log(
    JSON.stringify(
      await backfillLegacySocialHandles(pool, {
        afterId,
        execute: args.includes("--execute"),
      }),
    ),
  );
} finally {
  await pool.end();
}
