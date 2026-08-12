import { pool } from "./db.js";
import {
  integrationDatabaseTargetFromEnv,
  verifyIntegrationDatabaseTarget,
} from "./test-database-target.js";

// Integration files are executable modules, not only test-runner inputs.
// Keep direct invocation fail-closed before the first fixture can mutate data.
await verifyIntegrationDatabaseTarget(pool, integrationDatabaseTargetFromEnv());
