import assert from "node:assert/strict";
import test from "node:test";
import { buildCorrectedBatchRows, buildCorrectedColumns, preflightCorrectedExport } from "../src/correctedExport.js";
import { assignLocationsToBatch } from "../src/inventoryState.js";
import { inferMapping, matchBatchRows, normalizeBatchRow, normalizeInventoryRow } from "../src/matching.js";

const ALLOCATION_SETTINGS = {
  allocation_mode: "new_empty",
  settings_confirmed: true,
  box_id: "B001",
  starting_section_number: 1,
  cards_per_section: 100,
};

function setup() {
  const referenceRaw = {
    "TCGplayer Id": "1001", "Tcgplayer SKU ID": "SKU-1001", "Product Line": "Magic", "Set Name": "Test Set",
    "Product Name": "Foil Test", Number: "7", Rarity: "R", Condition: "Near Mint", Printing: "Foil", Language: "English",
  };
  const batchRaw = {
    "Original Note": "keep me", "Card Name": "Foil Test", "Set Name": "Test Set", "Card #": "7", Condition: "Near Mint",
    Printing: "Foil", Language: "English", Rarity: "Rare", Qty: "1", Bin: "B001-S001",
  };
  const reference = normalizeInventoryRow(referenceRaw, inferMapping(Object.keys(referenceRaw)), 0, { source_file: "reference.csv" });
  const row = normalizeBatchRow(batchRaw, inferMapping(Object.keys(batchRaw)), 0, { source_file: "batch.csv" });
  const allocation = assignLocationsToBatch([row], [], [], ALLOCATION_SETTINGS);
  return {
    reference: [reference],
    batchImport: { headers: Object.keys(batchRaw), mapping: inferMapping(Object.keys(batchRaw)) },
    results: matchBatchRows(allocation.batchRows, [reference]),
    options: { allocationSettings: ALLOCATION_SETTINGS },
  };
}

test("corrected export preserves original columns first and appends separate Chrono identifiers", () => {
  const { reference, batchImport, results, options } = setup();
  const rows = buildCorrectedBatchRows(batchImport, results, "verified", reference, options);
  const columns = buildCorrectedColumns(batchImport.headers);
  assert.deepEqual(columns.slice(0, batchImport.headers.length), batchImport.headers);
  assert.equal(rows[0]["Original Note"], "keep me");
  assert.equal(rows[0].Bin, "B001-S001");
  assert.equal(rows[0].physical_location_sku, "B001-S001");
  assert.equal(rows[0].tcgplayer_product_id, "1001");
  assert.equal(rows[0].tcgplayer_sku_id, "SKU-1001");
  assert.equal(rows[0].sku_verification_status, "verified");
  assert.equal(rows[0].allocation_mode, "new_empty");
  assert.equal(rows[0].match_status, "green");
});

test("verified export contains green rows only; review export contains yellow and red", () => {
  const { reference, batchImport, results, options } = setup();
  const badRow = { ...results[0].row, internal_row_id: "batch:bad:2", canonical_index: 1, card_name: "Foil Test Extended", raw: { ...results[0].row.raw, "Card Name": "Foil Test Extended" } };
  const reviewResult = matchBatchRows([badRow], reference)[0];
  const all = [...results, reviewResult];
  assert.deepEqual(buildCorrectedBatchRows(batchImport, all, "verified", reference, options).map((row) => row["Card Name"]), ["Foil Test"]);
  assert.deepEqual(buildCorrectedBatchRows(batchImport, all, "review", reference, options).map((row) => row["Card Name"]), ["Foil Test Extended"]);
});

test("export preflight independently rejects stale or tampered green status", () => {
  const { reference, batchImport, results, options } = setup();
  const tampered = [{ ...results[0], audit_status: "green", row: { ...results[0].row, condition: "Damaged" } }];
  const preflight = preflightCorrectedExport(tampered, reference, options);
  assert.equal(preflight.verified.length, 0);
  assert.equal(buildCorrectedBatchRows(batchImport, tampered, "verified", reference, options).length, 0);
});

test("verified export leaves SKU blank when Product ID is green but SKU authority is unavailable", () => {
  const { reference, batchImport, results, options } = setup();
  const noSkuReference = reference.map((row) => ({ ...row, tcgplayer_sku_id: "" }));
  const rematched = matchBatchRows(results.map((result) => result.row), noSkuReference);
  const rows = buildCorrectedBatchRows(batchImport, rematched, "verified", noSkuReference, options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tcgplayer_product_id, "1001");
  assert.equal(rows[0].tcgplayer_sku_id, "");
  assert.equal(rows[0].sku_verification_status, "unavailable");
});

test("export always preserves repeated chronological rows with lineage", () => {
  const { reference, batchImport, results, options } = setup();
  const duplicateRow = {
    ...results[0].row,
    internal_row_id: "batch:duplicate:2",
    canonical_index: 1,
    source_row: 3,
    raw: { ...results[0].row.raw },
  };
  const repeated = [...results, matchBatchRows([duplicateRow], reference)[0]];

  const preserved = buildCorrectedBatchRows(batchImport, repeated, "verified", reference, options);
  assert.equal(preserved.length, 2);
  assert.deepEqual(preserved.map((row) => row.source_row_lineage), ["2", "3"]);
  assert.deepEqual(preserved.map((row) => row.duplicate_in_section_count), [2, 2]);
  assert.ok(preserved.every((row) => row.row_handling_mode === "preserve_chronological"));
  assert.deepEqual(preserved.map((row) => row.Qty), ["1", "1"]);
});
