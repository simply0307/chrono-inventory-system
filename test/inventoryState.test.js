import assert from "node:assert/strict";
import test from "node:test";
import { assignLocationsToBatch, validateImportSequence } from "../src/inventoryState.js";

const NEW_EMPTY = {
  allocation_mode: "new_empty",
  settings_confirmed: true,
  box_id: "B001",
  starting_section_number: 1,
  cards_per_section: 100,
};

const APPEND = { ...NEW_EMPTY, allocation_mode: "append_existing" };

function row(overrides = {}) {
  const source = overrides.source_row || 2;
  return {
    internal_row_id: overrides.internal_row_id || `batch:test:${source}`,
    canonical_index: overrides.canonical_index ?? source - 2,
    source_row: source,
    card_name: "Card",
    quantity: overrides.quantity ?? 1,
    raw_quantity: String(overrides.quantity ?? 1),
    import_sequence: overrides.import_sequence ?? "",
    physical_location_sku: overrides.physical_location_sku || "",
    box_id: overrides.box_id || "",
    section_number: overrides.section_number || "",
    ...overrides,
  };
}

test("allocation is blocked until the user explicitly selects a mode and confirms settings", () => {
  const missingMode = assignLocationsToBatch([row()], [], [], { settings_confirmed: true });
  assert.equal(missingMode.blocked, true);
  assert.match(missingMode.batchRows[0].location_allocation_error, /Explicitly select/);

  const unconfirmed = assignLocationsToBatch([row()], [], [], { allocation_mode: "new_empty" });
  assert.equal(unconfirmed.blocked, true);
  assert.match(unconfirmed.batchRows[0].location_allocation_error, /Confirm the allocation/);
});

test("valid Import Sequence controls allocation but canonical output order is preserved", () => {
  const batch = [
    row({ source_row: 2, canonical_index: 0, import_sequence: "2", quantity: 2 }),
    row({ source_row: 3, canonical_index: 1, import_sequence: "1", quantity: 1 }),
    row({ source_row: 4, canonical_index: 2, import_sequence: "3", quantity: 1 }),
  ];
  const assigned = assignLocationsToBatch(batch, [], [], { ...NEW_EMPTY, box_id: "7", cards_per_section: 2, use_import_sequence: true });
  assert.deepEqual(assigned.batchRows.map((item) => item.source_row), [2, 3, 4]);
  assert.deepEqual(assigned.batchRows.map((item) => item.physical_location_sku), ["B007-S002", "B007-S001", "B007-S003"]);
  assert.ok(assigned.batchRows.every((item) => item.allocation_mode === "new_empty" && item.allocation_settings_confirmed));
});

test("blank, zero, negative, fractional, duplicate, and nonnumeric Import Sequence block allocation", () => {
  const invalid = ["", "0", "-1", "1.5", "x"];
  for (const value of invalid) {
    const result = assignLocationsToBatch([row({ import_sequence: value })], [], [], { ...NEW_EMPTY, use_import_sequence: true });
    assert.equal(result.blocked, true, value);
    assert.equal(result.batchRows[0].physical_location_sku, "", value);
  }
  const duplicates = [row({ source_row: 2, import_sequence: "1" }), row({ source_row: 3, import_sequence: "1" })];
  assert.ok(validateImportSequence(duplicates).some((issue) => /duplicates/.test(issue.message)));
  assert.equal(assignLocationsToBatch(duplicates, [], [], { ...NEW_EMPTY, use_import_sequence: true }).blocked, true);
});

test("new/empty mode ignores catalog-like location and quantity data", () => {
  const catalogRows = [row({ internal_row_id: "catalog:1", physical_location_sku: "Shelf 1", quantity: 999 })];
  const assigned = assignLocationsToBatch([row({ quantity: 2 })], catalogRows, [], { ...NEW_EMPTY, cards_per_section: 3 });
  assert.equal(assigned.blocked, false);
  assert.equal(assigned.batchRows[0].physical_location_sku, "B001-S001");
  assert.deepEqual(assigned.sectionUsage, { 1: 2 });
});

test("append mode requires separate physical inventory and counts partially filled sections", () => {
  const missing = assignLocationsToBatch([row()], [], [], APPEND);
  assert.equal(missing.blocked, true);
  assert.match(missing.batchRows[0].location_allocation_error, /separate physical inventory/);

  const existing = [row({ internal_row_id: "physical_inventory:1", box_id: "B001", section_number: 1, quantity: 2, physical_location_sku: "B001-S001" })];
  const assigned = assignLocationsToBatch([row({ quantity: 2 })], existing, [], { ...APPEND, cards_per_section: 3 });
  assert.equal(assigned.batchRows[0].physical_location_sku, "B001-S002");
  assert.deepEqual(assigned.sectionUsage, { 1: 2, 2: 2 });
});

test("a row larger than section capacity remains unassigned and blocked by post-allocation state", () => {
  const assigned = assignLocationsToBatch([row({ quantity: 101 })], [], [], NEW_EMPTY);
  assert.equal(assigned.batchRows[0].section_capacity_exceeded, true);
  assert.equal(assigned.batchRows[0].physical_location_sku, "");
  assert.equal(assigned.capacityIssues.length, 1);
});

test("multiple different cards can share a section while total capacity permits", () => {
  const assigned = assignLocationsToBatch([row({ source_row: 2 }), row({ source_row: 3 })], [], [], { ...NEW_EMPTY, cards_per_section: 10 });
  assert.deepEqual(assigned.batchRows.map((item) => item.physical_location_sku), ["B001-S001", "B001-S001"]);
  assert.equal(assigned.collisions.length, 0);
});

test("malformed, wrong-box, and capacity-overflow preserved locations are blocked", () => {
  const malformed = assignLocationsToBatch([row({ physical_location_sku: "BIN-A1" })], [], [], NEW_EMPTY);
  assert.match(malformed.batchRows[0].location_allocation_error, /malformed/);

  const wrongBox = assignLocationsToBatch([row({ physical_location_sku: "B009-S009" })], [], [], NEW_EMPTY);
  assert.match(wrongBox.batchRows[0].location_allocation_error, /not confirmed box/);

  const existing = [row({ internal_row_id: "physical_inventory:1", physical_location_sku: "B001-S001", quantity: 2 })];
  const overflow = assignLocationsToBatch([row({ physical_location_sku: "B001-S001", quantity: 2 })], existing, [], { ...APPEND, cards_per_section: 3 });
  assert.equal(overflow.batchRows[0].location_collision, true);
  assert.equal(overflow.collisions.length, 1);
});

test("invalid physical inventory state blocks append mode instead of assuming empty usage", () => {
  const malformedExisting = [row({ internal_row_id: "physical_inventory:1", physical_location_sku: "Shelf 1" })];
  const result = assignLocationsToBatch([row()], malformedExisting, [], APPEND);
  assert.equal(result.blocked, true);
  assert.match(result.batchRows[0].location_allocation_error, /invalid physical inventory state/);
});

test("identical inputs and confirmed settings produce identical assigned row data", () => {
  const input = [row({ source_row: 2 }), row({ source_row: 3, quantity: 2 })];
  const first = assignLocationsToBatch(input, [], [], { ...NEW_EMPTY, cards_per_section: 2 });
  const second = assignLocationsToBatch(input, [], [], { ...NEW_EMPTY, cards_per_section: 2 });
  assert.equal(JSON.stringify(first.batchRows), JSON.stringify(second.batchRows));
});
