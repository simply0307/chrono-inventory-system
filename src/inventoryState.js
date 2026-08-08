import { isPositiveInteger, isValidLocation, parseLocation } from "./matching.js";

export const DEFAULT_LOCATION_SETTINGS = {
  allocation_mode: "",
  settings_confirmed: false,
  box_id: "B001",
  cards_per_section: 100,
  starting_section_number: 1,
  sku_format: "{box_id}-S{section_number_padded}",
  regenerate_locations: false,
  use_import_sequence: false,
};

export function assignLocationsToBatch(batchRows, existingInventory = [], boxes = [], settings = {}) {
  const config = { ...DEFAULT_LOCATION_SETTINGS, ...settings };
  const preparedBatch = batchRows.map((row, index) => ({ ...row, internal_row_id: row.internal_row_id || `batch:runtime:${index + 1}`, canonical_index: Number.isInteger(row.canonical_index) ? row.canonical_index : index }));
  const boxId = normalizeBoxId(config.box_id);
  const settingErrors = validateSettings(config, boxId);
  const capacity = Number(config.cards_per_section);
  const nextBoxes = settingErrors.length ? boxes : upsertBox(boxes, boxId, capacity);
  if (settingErrors.length) return blockedResult(preparedBatch, nextBoxes, settingErrors.join("; "));

  const sequenceIssues = config.use_import_sequence ? validateImportSequence(preparedBatch) : [];
  if (sequenceIssues.length) {
    return blockedResult(preparedBatch, nextBoxes, `Import Sequence cannot control allocation: ${sequenceIssues.map((item) => `row ${item.source_row} ${item.message}`).join("; ")}`, { sequenceIssues });
  }

  let existing = { usage: new Map(), issues: [], collisions: [], capacityIssues: [] };
  if (config.allocation_mode === "append_existing") {
    if (!existingInventory.length) return blockedResult(preparedBatch, nextBoxes, "Append-to-existing mode requires a separate physical inventory file with rows.");
    existing = inspectExistingInventory(existingInventory, boxId, capacity);
    if (existing.issues.length) {
      return blockedResult(preparedBatch, nextBoxes, `Location allocation is blocked by invalid physical inventory state: ${existing.issues.map((item) => `row ${item.source_row} ${item.message}`).join("; ")}`, { existingInventoryIssues: existing.issues, collisions: existing.collisions, capacityIssues: existing.capacityIssues });
    }
  }

  const usage = new Map(existing.usage);
  const allocationOrder = [...preparedBatch].sort(config.use_import_sequence ? compareSequence : compareCanonical);
  const assigned = new Map();
  const collisions = [...existing.collisions];
  const capacityIssues = [...existing.capacityIssues];

  for (const original of allocationOrder) {
    const row = {
      ...original,
      allocation_mode: config.allocation_mode,
      allocation_settings_confirmed: true,
      allocation_starting_box: boxId,
      allocation_starting_section: Number(config.starting_section_number),
      allocation_section_capacity: capacity,
      location_allocation_error: "",
      location_collision: false,
      section_capacity_exceeded: false,
    };
    if (!isPositiveInteger(row.quantity)) {
      assigned.set(row.internal_row_id, clearLocation(row, "quantity must be a positive integer before location allocation"));
      continue;
    }
    const quantity = Number(row.quantity);
    if (quantity > capacity) {
      const message = `row quantity ${quantity} exceeds section capacity ${capacity}`;
      capacityIssues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, quantity, cards_per_section: capacity, message });
      assigned.set(row.internal_row_id, clearLocation({ ...row, section_capacity_exceeded: true }, message));
      continue;
    }

    if (row.physical_location_sku && !config.regenerate_locations) {
      const parsed = parseLocation(row.physical_location_sku);
      if (!parsed) {
        assigned.set(row.internal_row_id, { ...row, location_generation_status: "invalid_preserved_location", location_allocation_error: `preserved physical_location_sku is malformed: ${row.physical_location_sku}` });
        continue;
      }
      if (parsed.box_id !== boxId) {
        assigned.set(row.internal_row_id, { ...row, ...parsed, location_generation_status: "wrong_box_preserved_location", location_allocation_error: `preserved location ${row.physical_location_sku} belongs to ${parsed.box_id}, not confirmed box ${boxId}` });
        continue;
      }
      const used = usage.get(parsed.section_number) || 0;
      if (used + quantity > capacity) {
        const message = `preserved location ${row.physical_location_sku} would overfill section (${used} + ${quantity} > ${capacity})`;
        collisions.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, physical_location_sku: row.physical_location_sku, message });
        assigned.set(row.internal_row_id, { ...row, ...parsed, location_collision: true, location_generation_status: "preserved_capacity_collision", location_allocation_error: message });
        continue;
      }
      usage.set(parsed.section_number, used + quantity);
      assigned.set(row.internal_row_id, { ...row, ...parsed, physical_location_sku: parsed.physical_location_sku, physicalSku: parsed.physical_location_sku, location_generation_status: "preserved_existing_location" });
      continue;
    }

    const sectionNumber = findNextSection(usage, Number(config.starting_section_number), quantity, capacity);
    const physicalLocationSku = formatLocationSku({ box_id: boxId, section_number: sectionNumber, sku_format: config.sku_format });
    if (!isValidLocation(physicalLocationSku)) {
      assigned.set(row.internal_row_id, clearLocation(row, `configured formatter produced noncanonical location ${physicalLocationSku}`));
      continue;
    }
    usage.set(sectionNumber, (usage.get(sectionNumber) || 0) + quantity);
    assigned.set(row.internal_row_id, { ...row, box_id: boxId, section_number: sectionNumber, slot_number: "", physical_location_sku: physicalLocationSku, physicalSku: physicalLocationSku, location_generation_status: "generated" });
  }

  return {
    batchRows: canonicalRows(preparedBatch).map((row) => assigned.get(row.internal_row_id) || row),
    boxes: nextBoxes,
    collisions,
    capacityIssues,
    existingInventoryIssues: existing.issues,
    sequenceIssues,
    blocked: false,
    allocationMode: config.allocation_mode,
    sectionUsage: Object.fromEntries([...usage.entries()].sort((a, b) => a[0] - b[0])),
  };
}

export function validateImportSequence(rows) {
  const issues = [];
  const seen = new Map();
  for (const row of rows) {
    const raw = String(row.import_sequence ?? "").trim();
    const numeric = Number(raw);
    if (!raw) issues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, message: "is blank" });
    else if (!Number.isFinite(numeric)) issues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, message: `is nonnumeric (${raw})` });
    else if (!Number.isInteger(numeric)) issues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, message: `is fractional (${raw})` });
    else if (numeric <= 0) issues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, message: `must be positive (${raw})` });
    else if (seen.has(numeric)) issues.push({ internal_row_id: row.internal_row_id, source_row: row.source_row, message: `duplicates row ${seen.get(numeric)} (${raw})` });
    else seen.set(numeric, row.source_row);
  }
  return issues;
}

function validateSettings(config, boxId) {
  const errors = [];
  if (!config.allocation_mode || !["new_empty", "append_existing"].includes(config.allocation_mode)) errors.push("Explicitly select New/empty allocation or Append to existing inventory");
  if (!config.settings_confirmed) errors.push("Confirm the allocation Box, starting Section, and section capacity");
  if (!/^B\d{3}$/.test(boxId)) errors.push("box_id must identify a canonical Bnnn box");
  if (!isPositiveInteger(config.cards_per_section)) errors.push("cards_per_section must be a positive integer");
  if (!isPositiveInteger(config.starting_section_number)) errors.push("starting_section_number must be a positive integer");
  return errors;
}

function inspectExistingInventory(rows, targetBoxId, capacity) {
  const usage = new Map();
  const issues = [];
  const collisions = [];
  const capacityIssues = [];
  for (const row of canonicalRows(rows).filter((item) => item.active !== false)) {
    if (row.location_metadata_error) {
      issues.push({ source_row: row.source_row, internal_row_id: row.internal_row_id, message: row.location_metadata_error });
      continue;
    }
    if (!isPositiveInteger(row.quantity)) {
      issues.push({ source_row: row.source_row, internal_row_id: row.internal_row_id, message: "physical inventory quantity is not a positive integer" });
      continue;
    }
    const parsed = parseLocation(row.physical_location_sku);
    if (!parsed) {
      issues.push({ source_row: row.source_row, internal_row_id: row.internal_row_id, message: `physical inventory location is malformed or blank: ${row.physical_location_sku || "blank"}` });
      continue;
    }
    if (parsed.box_id !== targetBoxId) continue;
    const next = (usage.get(parsed.section_number) || 0) + Number(row.quantity);
    usage.set(parsed.section_number, next);
    if (next > capacity) {
      const item = { source_row: row.source_row, internal_row_id: row.internal_row_id, physical_location_sku: parsed.physical_location_sku, message: `existing section is over capacity (${next} > ${capacity})` };
      issues.push(item); collisions.push(item); capacityIssues.push(item);
    }
  }
  return { usage, issues, collisions, capacityIssues };
}

function blockedResult(rows, boxes, message, details = {}) {
  return {
    batchRows: canonicalRows(rows).map((row) => ({ ...row, location_allocation_error: message })),
    boxes,
    collisions: details.collisions || [],
    capacityIssues: details.capacityIssues || [],
    existingInventoryIssues: details.existingInventoryIssues || [],
    sequenceIssues: details.sequenceIssues || [],
    blocked: true,
  };
}

function clearLocation(row, message) {
  return { ...row, physical_location_sku: "", physicalSku: "", box_id: "", section_number: "", location_generation_status: "allocation_blocked", location_allocation_error: message };
}

function findNextSection(usage, startingSection, quantity, capacity) {
  const lastUsed = usage.size ? Math.max(...usage.keys()) : startingSection;
  let section = Math.max(startingSection, lastUsed);
  while ((usage.get(section) || 0) + quantity > capacity) section += 1;
  return section;
}

function compareSequence(a, b) {
  return Number(a.import_sequence) - Number(b.import_sequence) || compareCanonical(a, b);
}

function compareCanonical(a, b) {
  return a.canonical_index - b.canonical_index || a.internal_row_id.localeCompare(b.internal_row_id);
}

function canonicalRows(rows) {
  return [...rows].sort(compareCanonical);
}

function upsertBox(boxes, boxId, cardsPerSection) {
  const existing = boxes.find((box) => normalizeBoxId(box.box_id) === boxId);
  if (existing) return boxes.map((box) => normalizeBoxId(box.box_id) === boxId ? { ...box, box_id: boxId, cards_per_section: cardsPerSection } : box);
  return [...boxes, { box_id: boxId, cards_per_section: cardsPerSection }];
}

function formatLocationSku({ box_id, section_number, sku_format }) {
  return sku_format.replaceAll("{box_id}", normalizeBoxId(box_id)).replaceAll("{section_number}", String(section_number)).replaceAll("{section_number_padded}", String(section_number).padStart(3, "0"));
}

function normalizeBoxId(boxId) {
  const trimmed = String(boxId || "").trim().toUpperCase();
  if (!trimmed) return "";
  const digits = trimmed.startsWith("B") ? trimmed.slice(1) : trimmed;
  return /^\d+$/.test(digits) ? `B${digits.padStart(3, "0")}` : trimmed;
}
