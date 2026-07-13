import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import Papa from "papaparse";
import {
  buildExportRows,
  inferMapping,
  matchBatchRows,
  normalizeBatchRow,
  normalizeInventoryRow,
  validateResults,
} from "../src/matching.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);

function rows(name) {
  const csv = readFileSync(new URL(name, fixtureDir), "utf8");
  return Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
}

function normalizeFixture(referenceName = "clean_reference.csv", batchName = "clean_batch.csv") {
  const referenceRaw = rows(referenceName);
  const batchRaw = rows(batchName);
  const inventoryMapping = inferMapping(Object.keys(referenceRaw[0]));
  const batchMapping = inferMapping(Object.keys(batchRaw[0]));
  const inventory = referenceRaw.map((row, index) => normalizeInventoryRow(row, inventoryMapping, index, { source_file: referenceName }));
  const batch = batchRaw.map((row, index) => normalizeBatchRow(row, batchMapping, index, { source_file: batchName }));
  return { inventory, batch, results: matchBatchRows(batch, inventory) };
}

test("exact matches work and row order does not matter", () => {
  const clean = normalizeFixture();
  assert.equal(clean.results.filter((result) => result.audit_status === "green").length, 2);
  const shuffled = normalizeFixture("clean_reference.csv", "shuffled_batch.csv");
  assert.equal(shuffled.results.filter((result) => result.audit_status === "green").length, 2);
});

test("blank physical SKUs and bad quantities are flagged; duplicate section locations are allowed", () => {
  assert.match(validateResults(normalizeFixture("clean_reference.csv", "missing_location_batch.csv").results)[0].message, /physical_location_sku/);
  assert.ok(!validateResults(normalizeFixture("clean_reference.csv", "duplicate_location_batch.csv").results).some((issue) => issue.message.includes("duplicate physical_location_sku")));
  assert.ok(validateResults(normalizeFixture("clean_reference.csv", "bad_quantity_batch.csv").results).some((issue) => issue.message.includes("bad quantity")));
});

test("ambiguous, condition mismatch, finish mismatch, language mismatch, and missing IDs are blocked or reviewed", () => {
  assert.notEqual(normalizeFixture("clean_reference.csv", "ambiguous_batch.csv").results[0].audit_status, "green");
  assert.notEqual(normalizeFixture("clean_reference.csv", "condition_mismatch_batch.csv").results[0].audit_status, "green");
  assert.notEqual(normalizeFixture("clean_reference.csv", "finish_mismatch_batch.csv").results[0].audit_status, "green");
  assert.notEqual(normalizeFixture("language_reference.csv", "language_mismatch_batch.csv").results[0].audit_status, "green");
  assert.ok(validateResults(normalizeFixture("missing_id_reference.csv", "clean_batch.csv").results).some((issue) => issue.message.includes("Product ID")));
  assert.ok(validateResults(normalizeFixture("missing_sku_reference.csv", "clean_batch.csv").results).some((issue) => issue.message.includes("SKU ID")));
});

test("red rows are excluded from clean export by default", () => {
  const { results } = normalizeFixture("clean_reference.csv", "missing_location_batch.csv");
  assert.equal(buildExportRows(results).length, 0);
});
