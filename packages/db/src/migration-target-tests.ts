import assert from "node:assert/strict";

import { parseMigrationTargetOptions } from "./migration-target.js";

assert.deepEqual(parseMigrationTargetOptions([]), {
  databaseUrl: null,
  expectedDatabase: null,
});

assert.deepEqual(
  parseMigrationTargetOptions([
    "--database-url",
    "postgresql://localhost:5433/hunch_slice_c",
    "--expect-database=hunch_slice_c",
  ]),
  {
    databaseUrl: "postgresql://localhost:5433/hunch_slice_c",
    expectedDatabase: "hunch_slice_c",
  },
);

assert.throws(
  () =>
    parseMigrationTargetOptions([
      "--database-url=postgresql://localhost:5433/hunch_slice_c",
    ]),
  /requires --expect-database/u,
);
assert.throws(
  () =>
    parseMigrationTargetOptions([
      "--database-url=redis://localhost/hunch_slice_c",
      "--expect-database=hunch_slice_c",
    ]),
  /postgres: or postgresql:/u,
);
assert.throws(
  () => parseMigrationTargetOptions(["--unknown"]),
  /Unknown migration argument/u,
);

console.log("migration target tests passed");
