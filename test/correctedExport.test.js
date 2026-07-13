import assert from "node:assert/strict";
import test from "node:test";
import { buildCorrectedBatchRows, buildCorrectedColumns } from "../src/correctedExport.js";

test("corrected export preserves original batch columns and fills Chrono output fields", () => {
  const batchImport = {
    headers: ["Card Name", "Card #", "Condition", "Printing", "Qty", "Bin"],
    mapping: { physical_location_sku: "Bin" },
  };
  const rows = buildCorrectedBatchRows(batchImport, [
    {
      audit_status: "green",
      match_reason: "exact normalized identity match",
      row: {
        raw: { "Card Name": "Foil Test", "Card #": "7", Condition: "Near Mint", Printing: "Foil", Qty: "1", Bin: "" },
        physical_location_sku: "B001-S001",
      },
      selected: {
        tcgplayer_product_id: "1001",
        tcgplayer_sku_id: "SKU-1001",
        set_name: "Test Set",
      },
    },
  ]);
  const columns = buildCorrectedColumns(batchImport.headers);

  assert.deepEqual(columns.slice(0, batchImport.headers.length), batchImport.headers);
  assert.equal(rows[0]["Card Name"], "Foil Test");
  assert.equal(rows[0].Bin, "B001-S001");
  assert.equal(rows[0].physical_location_sku, "B001-S001");
  assert.equal(rows[0].tcgplayer_product_id, "1001");
  assert.equal(rows[0].tcgplayer_sku_id, "SKU-1001");
  assert.equal(rows[0].matched_set_name, "Test Set");
  assert.equal(rows[0].match_status, "green");
  assert.equal(rows[0].match_reason, "exact normalized identity match");
});

test("safe export excludes red rows while error export includes review and blocked rows", () => {
  const batchImport = { headers: ["Card Name", "Bin"], mapping: { physical_location_sku: "Bin" } };
  const results = [
    { audit_status: "green", match_reason: "ok", row: { raw: { "Card Name": "A" }, physical_location_sku: "B001-S001" }, selected: {} },
    { audit_status: "yellow", match_reason: "review", row: { raw: { "Card Name": "B" }, physical_location_sku: "B001-S001" }, selected: null },
    { audit_status: "red", match_reason: "blocked", row: { raw: { "Card Name": "C" }, physical_location_sku: "" }, selected: null },
  ];

  assert.deepEqual(buildCorrectedBatchRows(batchImport, results, "safe").map((row) => row["Card Name"]), ["A", "B"]);
  assert.deepEqual(buildCorrectedBatchRows(batchImport, results, "errors").map((row) => row["Card Name"]), ["B", "C"]);
});
