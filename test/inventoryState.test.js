import assert from "node:assert/strict";
import test from "node:test";
import { assignLocationsToBatch } from "../src/inventoryState.js";

function row(overrides = {}) {
  return {
    source_row: overrides.source_row || 2,
    card_name: overrides.card_name || "Armored Transport",
    collector_number: overrides.collector_number || "226",
    condition: overrides.condition || "Near Mint",
    finish: overrides.finish || "Normal",
    quantity: overrides.quantity ?? 1,
    import_sequence: overrides.import_sequence || "",
    physical_location_sku: overrides.physical_location_sku || "",
    box_id: overrides.box_id || "",
    section_number: overrides.section_number || "",
    ...overrides,
  };
}

test("new box section location generation is quantity-aware and chronological", () => {
  const batch = [
    row({ source_row: 2, import_sequence: "2" }),
    row({ source_row: 3, import_sequence: "1" }),
    row({ source_row: 4, import_sequence: "3" }),
  ];
  const assigned = assignLocationsToBatch(batch, [], [], { box_id: "7", cards_per_section: 2 });
  const byRow = new Map(assigned.batchRows.map((item) => [item.source_row, item]));
  assert.equal(byRow.get(3).physical_location_sku, "B007-S001");
  assert.equal(byRow.get(2).physical_location_sku, "B007-S001");
  assert.equal(byRow.get(4).physical_location_sku, "B007-S002");
  assert.equal(assigned.boxes[0].box_id, "B007");
});

test("existing section usage rolls whole row to the next section", () => {
  const existing = [row({ box_id: "B001", section_number: 1, quantity: 2, physical_location_sku: "B001-S001" })];
  const assigned = assignLocationsToBatch([row()], existing, [{ box_id: "B001", cards_per_section: 2 }], {
    box_id: "B001",
    cards_per_section: 2,
  });
  assert.equal(assigned.batchRows[0].physical_location_sku, "B001-S002");
});

test("row larger than section capacity is flagged red-ready", () => {
  const assigned = assignLocationsToBatch([row({ quantity: 101 })], [], [{ box_id: "B001", cards_per_section: 100 }], {
    box_id: "B001",
    cards_per_section: 100,
  });
  assert.equal(assigned.batchRows[0].section_capacity_exceeded, true);
  assert.equal(assigned.capacityIssues.length, 1);
});

test("blank Bin becomes a generated section location", () => {
  const assigned = assignLocationsToBatch([row({ physical_location_sku: "" })], [], [], { box_id: "B001", cards_per_section: 10 });
  assert.equal(assigned.batchRows[0].physical_location_sku, "B001-S001");
  assert.equal(assigned.batchRows[0].location_generation_status, "generated");
});

test("duplicate section locations are allowed because sections hold multiple cards", () => {
  const assigned = assignLocationsToBatch([row({ source_row: 2 }), row({ source_row: 3 })], [], [], {
    box_id: "B001",
    cards_per_section: 10,
  });
  assert.equal(assigned.batchRows[0].physical_location_sku, "B001-S001");
  assert.equal(assigned.batchRows[1].physical_location_sku, "B001-S001");
  assert.equal(assigned.collisions.length, 0);
});

test("existing Bin values are preserved unless regeneration is selected", () => {
  const preserved = assignLocationsToBatch([row({ physical_location_sku: "B009-S009" })], [], [], { box_id: "B001" });
  assert.equal(preserved.batchRows[0].physical_location_sku, "B009-S009");

  const regenerated = assignLocationsToBatch([row({ physical_location_sku: "B009-S009" })], [], [], {
    box_id: "B001",
    regenerate_locations: true,
  });
  assert.equal(regenerated.batchRows[0].physical_location_sku, "B001-S001");
});
