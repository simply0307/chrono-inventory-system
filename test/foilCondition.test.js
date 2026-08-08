import assert from "node:assert/strict";
import test from "node:test";
import { inferMapping, matchBatchRows, normalizeBatchRow, normalizeInventoryRow } from "../src/matching.js";

function normalizeReference(condition) {
  const row = {
    "TCGplayer Id": "1001",
    "Tcgplayer SKU ID": "SKU-1001",
    "Product Line": "Magic",
    "Set Name": "Test Set",
    "Product Name": "Foil Test",
    Number: "7",
    Rarity: "R",
    Condition: condition,
    Language: "English",
    "Total Quantity": "1",
  };
  const mapping = inferMapping(Object.keys(row));
  return normalizeInventoryRow(row, mapping, 0);
}

function normalizeBatch(printing) {
  const row = {
    "Card Name": "Foil Test",
    "Set Name": "Test Set",
    "Card #": "7",
    Condition: "Near Mint",
    Printing: printing,
    Language: "English",
    Rarity: "Rare",
    Qty: "1",
    Bin: "B001-S001",
  };
  const mapping = inferMapping(Object.keys(row));
  return normalizeBatchRow(row, mapping, 0);
}

test("reference foil embedded in Condition is split into condition and finish", () => {
  const nearMintFoil = normalizeReference("Near Mint Foil");
  assert.equal(nearMintFoil.condition, "Near Mint");
  assert.equal(nearMintFoil.finish, "Foil");
  assert.match(nearMintFoil.normalization_note, /Near Mint Foil -> condition Near Mint, finish Foil/);

  const lightlyPlayedFoil = normalizeReference("Lightly Played Foil");
  assert.equal(lightlyPlayedFoil.condition, "Lightly Played");
  assert.equal(lightlyPlayedFoil.finish, "Foil");

  const nearMint = normalizeReference("Near Mint");
  assert.equal(nearMint.condition, "Near Mint");
  assert.equal(nearMint.finish, "Normal");
});

test("batch Near Mint Foil matches reference Near Mint Foil", () => {
  const results = matchBatchRows([normalizeBatch("Foil")], [normalizeReference("Near Mint Foil")]);
  assert.equal(results[0].audit_status, "green");
  assert.equal(results[0].selected.tcgplayer_product_id, "1001");
  assert.match(results[0].match_reason, /Catalog finish parsed from Condition/);
});

test("batch Normal/Foil mismatches do not auto-match opposite reference finish", () => {
  assert.notEqual(matchBatchRows([normalizeBatch("Normal")], [normalizeReference("Near Mint Foil")])[0].audit_status, "green");
  assert.notEqual(matchBatchRows([normalizeBatch("Foil")], [normalizeReference("Near Mint")])[0].audit_status, "green");
});

test("nonfoil and etched foil remain distinct normalized variants", () => {
  const nonfoilReference = normalizeReference("Near Mint Non-Foil");
  assert.equal(nonfoilReference.condition, "Near Mint");
  assert.equal(nonfoilReference.finish, "Normal");
  assert.equal(matchBatchRows([normalizeBatch("Nonfoil")], [nonfoilReference])[0].audit_status, "green");

  const etchedReference = normalizeReference("Near Mint Etched Foil");
  assert.equal(etchedReference.finish, "Etched Foil");
  assert.equal(matchBatchRows([normalizeBatch("Foil")], [etchedReference])[0].audit_status, "red");
});
