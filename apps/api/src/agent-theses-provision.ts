import { pool } from "./db.js";
import { provisionAgentAuthors } from "./services/agent-theses-provision.js";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
try {
  if (args.some((arg) => !["--execute", "--dry-run"].includes(arg)))
    throw new Error("Unknown argument");
  if (args.includes("--execute") && args.includes("--dry-run"))
    throw new Error("Choose execute or dry-run");
  console.log(
    JSON.stringify(
      await provisionAgentAuthors(pool, args.includes("--execute")),
    ),
  );
} finally {
  await pool.end();
}
