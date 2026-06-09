import assert from "node:assert/strict";
import { parseMarketTextDates, resolveMarketCategory } from "./index.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("resolveMarketCategory maps CPI and Fed prose to macro", () => {
  const cpi = resolveMarketCategory({
    title: "May CPI",
    description:
      "The CPI release is scheduled for June 10, 2026 at 8:30 AM ET.",
  });
  assert.equal(cpi.category, "macro");
  assert.equal(cpi.categorySource, "text_keyword");
  assert.equal(cpi.categoryConfidence, "medium");

  const fed = resolveMarketCategory({
    title: "June Fed rate change",
    description:
      "This market resolves based on the Federal Reserve FOMC rate decision.",
  });
  assert.equal(fed.category, "macro");
});

test("resolveMarketCategory preserves source-first category metadata", () => {
  const category = resolveMarketCategory({
    metadata: { category: "sports", subCategory: "basketball" },
    title: "Federal Reserve wins the NBA Finals?",
    description: "Text has mixed keywords but metadata is authoritative.",
  });
  assert.equal(category.category, "sports");
  assert.equal(category.categorySource, "embedded_metadata");
  assert.equal(category.categoryConfidence, "high");
});

test("resolveMarketCategory normalizes venue aliases to UI categories", () => {
  assert.equal(
    resolveMarketCategory({ sourceCategory: "financials" }).category,
    "macro",
  );
  assert.equal(
    resolveMarketCategory({ sourceCategory: "science and technology" })
      .category,
    "tech",
  );
  assert.equal(
    resolveMarketCategory({ sourceCategory: "entertainment" }).category,
    "culture",
  );
});

test("resolveMarketCategory does not force weak unknown text", () => {
  const category = resolveMarketCategory({
    title: "Will this happen?",
    description: "The market resolves according to the official source.",
  });
  assert.equal(category.category, undefined);
});

test("parseMarketTextDates parses UTC, ET, scheduled ET, and date-only macro deadlines", () => {
  const utc = parseMarketTextDates({
    text: "Resolves by July 19, 2026 at 23:59 UTC.",
  });
  assert.equal(utc.deadlineTime?.toISOString(), "2026-07-19T23:59:00.000Z");
  assert.equal(utc.deadlineSource, "explicit_utc_deadline");

  const et = parseMarketTextDates({
    text: "No FOMC statement by 23:59 ET on July 29, 2026.",
  });
  assert.equal(et.deadlineTime?.toISOString(), "2026-07-30T03:59:00.000Z");
  assert.equal(et.deadlineSource, "explicit_et_deadline");

  const scheduled = parseMarketTextDates({
    text: "The release is scheduled for June 10, 2026 at 8:30 AM ET.",
  });
  assert.equal(
    scheduled.scheduledTime?.toISOString(),
    "2026-06-10T12:30:00.000Z",
  );
  assert.equal(scheduled.scheduledSource, "scheduled_et");

  const dateOnly = parseMarketTextDates({
    text: "If CPI is not published by July 15, 2026, the market resolves no.",
    allowDateOnlyUsEasternDeadline: true,
  });
  assert.equal(
    dateOnly.deadlineTime?.toISOString(),
    "2026-07-16T03:59:00.000Z",
  );
  assert.equal(dateOnly.deadlineSource, "date_only_us_eastern_deadline");
  assert.equal(
    dateOnly.deadlineAssumption,
    "date_only_deadline_interpreted_as_23:59_ET",
  );
});
