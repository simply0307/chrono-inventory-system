import assert from "node:assert/strict";
import test from "node:test";
import {
  auditPostAllocationResults,
  buildExportRows,
  chooseManualMatch,
  getMappingWarnings,
  inferMapping,
  matchBatchRows,
  normalizeBatchRow,
  normalizeInventoryRow,
  validateResults,
} from "../src/matching.js";

const ALLOCATION_SETTINGS = {
  allocation_mode: "new_empty",
  settings_confirmed: true,
  box_id: "B001",
  starting_section_number: 1,
  cards_per_section: 100,
};

function reference(overrides = {}, index = 0) {
  const raw = {
    "TCGplayer Id": "1001", "Tcgplayer SKU ID": "SKU-1001-NM-N", "Product Line": "Magic",
    "Set Name": "Gatecrash", "Set Code": "GTC", "Product Name": "Armored Transport", Number: "226",
    Rarity: "C", Condition: "Near Mint", Printing: "Normal", Language: "English", "Total Quantity": "999", Bin: "CATALOG-NOT-A-LOCATION",
    ...overrides,
  };
  return normalizeInventoryRow(raw, inferMapping(Object.keys(raw)), index, { source_file: "reference.csv" });
}

function batch(overrides = {}, index = 0) {
  const raw = {
    "Card Name": "Armored Transport", "Set Name": "Gatecrash", "Set Code": "GTC", "Card #": "226",
    Condition: "Near Mint", Printing: "Normal", Language: "English", Rarity: "Common", Qty: "1", Bin: "B001-S001",
    ...overrides,
  };
  return normalizeBatchRow(raw, inferMapping(Object.keys(raw)), index, { source_file: "batch.csv" });
}

test("automatic green requires one unique exact Product ID while SKU is verified separately", () => {
  const result = matchBatchRows([batch()], [reference()])[0];
  assert.equal(result.audit_status, "green");
  assert.equal(result.tcgplayer_product_id, "1001");
  assert.equal(result.tcgplayer_sku_id, "SKU-1001-NM-N");
  assert.equal(result.sku_verification_status, "verified");
  assert.ok(result.identity_fields_used.includes("finish"));
});

test("an existing Product ID is verified against every mutually supplied identity field", () => {
  const conflicting = batch({
    "Product ID": "1001", "Card Name": "Wrong Name", "Set Name": "Wrong Set", "Set Code": "BAD", "Card #": "999P",
    Condition: "Damaged", Printing: "Etched Foil", Language: "Japanese", Rarity: "Mythic", "Product Line": "Pokemon",
  });
  const result = matchBatchRows([conflicting], [reference()])[0];
  assert.equal(result.audit_status, "red");
  for (const field of ["card_name", "set_name", "collector_number", "condition", "finish", "language", "rarity", "product_line"]) {
    assert.match(result.match_reason, new RegExp(`${field} conflicts`));
  }
});

test("correct Product ID with wrong SKU ID is red and reports SKU conflict", () => {
  const result = matchBatchRows([batch({ "Product ID": "1001", "SKU ID": "SKU-WRONG" })], [reference()])[0];
  assert.equal(result.audit_status, "red");
  assert.equal(result.sku_verification_status, "conflict");
  assert.match(result.match_reason, /SKU ID SKU-WRONG does not exist/);
});

test("one Product ID with multiple SKUs remains product-green but SKU-unavailable unless the variant is decisive", () => {
  const refs = [
    reference({}, 0),
    reference({ "Tcgplayer SKU ID": "SKU-1001-NM-F", Printing: "Foil" }, 1),
  ];
  const foil = matchBatchRows([batch({ Printing: "Foil" })], refs)[0];
  assert.equal(foil.audit_status, "green");
  assert.equal(foil.tcgplayer_sku_id, "SKU-1001-NM-F");
  assert.equal(foil.sku_verification_status, "verified");

  const missingFinish = matchBatchRows([batch({ Printing: "" })], refs)[0];
  assert.equal(missingFinish.audit_status, "green");
  assert.equal(missingFinish.tcgplayer_product_id, "1001");
  assert.equal(missingFinish.tcgplayer_sku_id, "");
  assert.equal(missingFinish.sku_verification_status, "unavailable");
});

test("missing catalog SKU authority is a capability notice, not a per-row rejection", () => {
  const result = matchBatchRows([batch()], [reference({ "Tcgplayer SKU ID": "" })])[0];
  assert.equal(result.audit_status, "green");
  assert.equal(result.tcgplayer_product_id, "1001");
  assert.equal(result.tcgplayer_sku_id, "");
  assert.equal(result.sku_verification_status, "unavailable");

  const headers = ["TCGplayer Id", "Product Name", "Set Name", "Number", "Condition", "Language"];
  const warnings = getMappingWarnings(headers, inferMapping(headers), "catalog");
  assert.ok(warnings.some((warning) => warning.level === "yellow" && warning.field === "tcgplayer_sku_id"));
  assert.ok(!warnings.some((warning) => warning.level === "red" && warning.field === "tcgplayer_sku_id"));
});

test("missing batch Set and Language can still green when remaining exact fields identify one Product ID", () => {
  const result = matchBatchRows([batch({ "Set Name": "", "Set Code": "", Language: "" })], [reference()])[0];
  assert.equal(result.audit_status, "green");
  assert.equal(result.tcgplayer_product_id, "1001");
  assert.ok(result.identity_fields_unverified.includes("set_name"));
  assert.ok(result.identity_fields_unverified.includes("set_code"));
  assert.ok(result.identity_fields_unverified.includes("language"));
});

test("missing decisive fields remain yellow when more than one Product ID survives", () => {
  const refs = [
    reference({ "TCGplayer Id": "1001", "Set Name": "Gatecrash", "Set Code": "GTC" }, 0),
    reference({ "TCGplayer Id": "2002", "Tcgplayer SKU ID": "SKU-2002", "Set Name": "Another Set", "Set Code": "ANS" }, 1),
  ];
  const result = matchBatchRows([batch({ "Set Name": "", "Set Code": "" })], refs)[0];
  assert.equal(result.audit_status, "yellow");
  assert.deepEqual(result.product_id_candidates.sort(), ["1001", "2002"]);
});

test("a batch-wide language assumption is recorded and may resolve otherwise ambiguous Product IDs", () => {
  const refs = [
    reference({ "TCGplayer Id": "1001", Language: "English" }, 0),
    reference({ "TCGplayer Id": "2002", "Tcgplayer SKU ID": "SKU-2002", Language: "Japanese" }, 1),
  ];
  const missingLanguage = batch({ Language: "" });
  assert.equal(matchBatchRows([missingLanguage], refs)[0].audit_status, "yellow");
  const assumed = matchBatchRows([missingLanguage], refs, { batch_language_assumption: "English" })[0];
  assert.equal(assumed.audit_status, "green");
  assert.equal(assumed.tcgplayer_product_id, "1001");
  assert.equal(assumed.batch_language_assumption, "English");
  assert.match(assumed.match_reason, /Batch-wide language assumption recorded: English/);
});

test("rarity is used only when present in both files and never counted as blank agreement", () => {
  const refs = [
    reference({ "TCGplayer Id": "1001", Rarity: "Common" }, 0),
    reference({ "TCGplayer Id": "2002", "Tcgplayer SKU ID": "SKU-2002", Rarity: "Rare" }, 1),
  ];
  const result = matchBatchRows([batch({ Rarity: "" })], refs)[0];
  assert.equal(result.audit_status, "yellow");
  assert.ok(!result.identity_fields_used.includes("rarity"));
  assert.ok(result.identity_fields_unverified.includes("rarity"));
});

test("set, condition, finish, language, rarity, collector suffix, promo/token, and alternate-printing conflicts never green", () => {
  const mutations = [
    { "Set Name": "Dissension" }, { Condition: "Lightly Played" }, { Printing: "Foil" }, { Language: "Japanese" },
    { Rarity: "Rare" }, { "Card #": "226a" }, { "Card #": "P226" }, { "Set Name": "Gatecrash Tokens" }, { Printing: "Etched Foil" },
  ];
  for (const mutation of mutations) assert.notEqual(matchBatchRows([batch(mutation)], [reference()])[0].audit_status, "green", JSON.stringify(mutation));
});

test("fuzzy name similarity is yellow-only and manual selection cannot bypass a conflict", () => {
  const result = matchBatchRows([batch({ "Card Name": "Armored Transport Extended" })], [reference()])[0];
  assert.equal(result.audit_status, "yellow");
  assert.equal(chooseManualMatch(result, result.candidates[0]).audit_status, "red");
});

test("fractional, negative, zero, blank, and nonnumeric quantities are red and never exported", () => {
  for (const Qty of ["1.5", "-1", "0", "", "many"]) {
    const results = matchBatchRows([batch({ Qty })], [reference()]);
    assert.ok(validateResults(results).some((issue) => /positive integer/.test(issue.message)), Qty);
    assert.equal(buildExportRows(results, { inventoryRows: [reference()] }).length, 0, Qty);
  }
});

test("generic SKU never infers either physical or TCGplayer SKU identifier", () => {
  const mapping = inferMapping(["Card Name", "SKU"]);
  assert.equal(mapping.physical_location_sku, undefined);
  assert.equal(mapping.tcgplayer_sku_id, undefined);
});

test("catalog location and quantity are normalized but do not participate in identity matching", () => {
  const ref = reference({ "Total Quantity": "-42", Bin: "not-a-location" });
  const result = matchBatchRows([batch()], [ref])[0];
  assert.equal(result.audit_status, "green");
  assert.equal(result.tcgplayer_product_id, "1001");
});

test("physical location, Box, and Section metadata are reconciled when normalizing physical inventory", () => {
  const consistent = reference({ Bin: "", Box: "1", Section: "7" });
  assert.equal(consistent.physical_location_sku, "B001-S007");
  assert.equal(consistent.location_metadata_error, "");

  const conflicting = reference({ Bin: "B001-S007", Box: "2", Section: "8" });
  assert.match(conflicting.location_metadata_error, /conflicts with box_id B002/);
  assert.match(conflicting.location_metadata_error, /conflicts with section_number 8/);
});

test("repeated Product ID / SKU status / section rows remain green and receive informational counts", () => {
  const rows = [batch({}, 0), batch({}, 1)].map((item, index) => ({ ...item, internal_row_id: `batch:duplicate:${index}`, canonical_index: index }));
  const identity = matchBatchRows(rows, [reference()]);
  assert.ok(identity.every((result) => result.audit_status === "green" && result.duplicate_combo_unresolved === undefined));

  const audited = auditPostAllocationResults(identity, [reference()], { allocationSettings: ALLOCATION_SETTINGS });
  assert.ok(audited.every((result) => result.audit_status === "green" && result.duplicate_in_section_count === 2));
  assert.deepEqual(audited.map((result) => result.duplicate_in_section_index), [1, 2]);
  assert.deepEqual(audited.map((result) => result.row.source_row), [2, 3]);
});
