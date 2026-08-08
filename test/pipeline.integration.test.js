import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Papa from "papaparse";
import { buildCorrectedBatchRows, buildCorrectedColumns, preflightCorrectedExport } from "../src/correctedExport.js";
import { assignLocationsToBatch } from "../src/inventoryState.js";
import { assessReadiness, auditPostAllocationResults, auditResults, inferMapping, matchBatchRows, normalizeBatchRow, normalizeInventoryRow } from "../src/matching.js";
import { parseDelimitedText } from "../src/tabular.js";

const LOCATION_SETTINGS = {
  allocation_mode: "new_empty",
  settings_confirmed: true,
  box_id: "B001",
  starting_section_number: 1,
  cards_per_section: 3,
  use_import_sequence: true,
};

function runPipeline() {
  const referenceText = readFileSync(new URL("./fixtures/pipeline_reference.csv", import.meta.url), "utf8");
  const batchText = readFileSync(new URL("./fixtures/pipeline_batch.csv", import.meta.url), "utf8");
  const referenceParsed = parseDelimitedText(referenceText);
  const batchParsed = parseDelimitedText(batchText);
  const referenceMapping = inferMapping(referenceParsed.headers);
  const batchMapping = inferMapping(batchParsed.headers);
  const referenceRows = referenceParsed.rows.map((row, index) => normalizeInventoryRow(row, referenceMapping, index, { source_file: "pipeline_reference.csv" }));
  const importedBatch = batchParsed.rows.map((row, index) => normalizeBatchRow(row, batchMapping, index, { source_file: "pipeline_batch.csv" }));

  // The catalog is intentionally not passed as physical inventory in new/empty mode.
  const allocation = assignLocationsToBatch(importedBatch, [], [], LOCATION_SETTINGS);
  const identityResults = matchBatchRows(allocation.batchRows, referenceRows);
  const results = auditPostAllocationResults(identityResults, referenceRows, { allocationSettings: LOCATION_SETTINGS });
  const referenceImport = { headers: referenceParsed.headers, rows: referenceParsed.rows, mapping: referenceMapping };
  const batchImport = { headers: batchParsed.headers, rows: batchParsed.rows, mapping: batchMapping };
  const readiness = assessReadiness({ referenceImport, batchImport, referenceRows, batchRows: allocation.batchRows, results, locationSettings: LOCATION_SETTINGS });
  const options = { allocationSettings: LOCATION_SETTINGS };
  const preflight = preflightCorrectedExport(results, referenceRows, options);
  const exportRows = buildCorrectedBatchRows(batchImport, results, "verified", referenceRows, options);
  const columns = buildCorrectedColumns(batchParsed.headers);
  return { allocation, identityResults, results, readiness, preflight, exportRows, columns, csv: Papa.unparse(exportRows, { columns }) };
}

test("fixture pipeline preserves canonical rows while sequence controls deterministic quantity-aware allocation", () => {
  const pipeline = runPipeline();
  assert.equal(pipeline.allocation.blocked, false);
  assert.deepEqual(pipeline.allocation.batchRows.map((row) => row.source_row), [2, 3, 4]);
  assert.deepEqual(pipeline.allocation.batchRows.map((row) => row.physical_location_sku), ["B001-S001", "B001-S001", "B001-S002"]);
  assert.ok(pipeline.identityResults.every((result) => result.audit_status === "green"));
  assert.ok(pipeline.results.every((result) => result.audit_status === "green"));
  assert.equal(auditResults(pipeline.results).issues.length, 0);
  assert.deepEqual(pipeline.exportRows.map((row) => row["Original Note"]), ["first, quoted", "second", "third"]);
  assert.deepEqual(pipeline.columns.slice(0, 12), ["Original Note", "Card Name", "Set Name", "Set Code", "Card #", "Condition", "Printing", "Language", "Rarity", "Qty", "Import Sequence", "Bin"]);
});

test("catalog quantities and locations do not change new/empty capacity allocation", () => {
  const pipeline = runPipeline();
  assert.deepEqual(pipeline.allocation.sectionUsage, { 1: 3, 2: 1 });
  assert.equal(pipeline.allocation.batchRows[0].physical_location_sku, "B001-S001");
});

test("fixture pipeline exposes ordered readiness gates and passes independent export preflight", () => {
  const pipeline = runPipeline();
  assert.equal(pipeline.readiness.importSchema.ready, true);
  assert.equal(pipeline.readiness.identityReconciliation.ready, true);
  assert.equal(pipeline.readiness.allocationMode.ready, true);
  assert.equal(pipeline.readiness.postAllocationAudit.ready, true);
  assert.equal(pipeline.readiness.exportReadiness.ready, true);
  assert.equal(pipeline.readiness.verifiedCount, 3);
  assert.equal(pipeline.preflight.verified.length, 3);
  assert.equal(pipeline.preflight.rejected.length, 0);
});

test("a second identical pipeline run produces byte-identical corrected CSV data", () => {
  const first = runPipeline();
  const second = runPipeline();
  assert.equal(first.csv, second.csv);
});
