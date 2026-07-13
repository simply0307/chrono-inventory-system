export const DEFAULT_LOCATION_SETTINGS = {
  box_id: "B001",
  cards_per_section: 100,
  starting_section_number: 1,
  sku_format: "{box_id}-S{section_number_padded}",
  append_chronologically: true,
  regenerate_locations: false,
  use_import_sequence: true,
};

export function assignLocationsToBatch(batchRows, existingInventory = [], boxes = [], settings = {}) {
  const config = { ...DEFAULT_LOCATION_SETTINGS, ...settings };
  const box_id = normalizeBoxId(config.box_id);
  if (!box_id) throw new Error("box_id is required for location generation.");

  const nextBoxes = upsertBox(boxes, box_id, config.cards_per_section);
  const box = nextBoxes.find((item) => normalizeBoxId(item.box_id) === box_id);
  const existingInBox = existingInventory.filter((row) => row.active !== false && normalizeBoxId(row.box_id) === box_id);
  const sectionUsage = getSectionUsage(existingInBox);
  let cursor = sectionUsage.size ? getLastSectionCursor(sectionUsage) : { section_number: Number(config.starting_section_number) || 1 };

  const sortedRows = [...batchRows].sort((a, b) => {
    if (!config.append_chronologically || !config.use_import_sequence) return a.source_row - b.source_row;
    const ai = Number(a.import_sequence);
    const bi = Number(b.import_sequence);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    return a.source_row - b.source_row;
  });

  const generatedSections = new Map(sectionUsage);
  const assignedBySourceRow = new Map();
  const capacityIssues = [];

  for (const row of sortedRows) {
    if (row.physical_location_sku && !config.regenerate_locations) {
      assignedBySourceRow.set(row.source_row, { ...row, location_generation_status: "preserved_existing_location" });
      continue;
    }

    const quantity = safeQuantity(row.quantity);
    const sectionCapacityExceeded = quantity > box.cards_per_section;
    if (sectionCapacityExceeded) {
      capacityIssues.push({ source_row: row.source_row, quantity, cards_per_section: box.cards_per_section });
    }

    cursor = nextSectionForQuantity(cursor, generatedSections, quantity, box.cards_per_section);
    const physical_location_sku = formatLocationSku({
      box_id,
      section_number: cursor.section_number,
      sku_format: config.sku_format,
    });
    generatedSections.set(cursor.section_number, (generatedSections.get(cursor.section_number) || 0) + quantity);

    assignedBySourceRow.set(row.source_row, {
      ...row,
      box_id,
      section_number: cursor.section_number,
      slot_number: "",
      physical_location_sku,
      physicalSku: physical_location_sku,
      location_collision: false,
      section_capacity_exceeded: sectionCapacityExceeded,
      location_generation_status: "generated",
    });
  }

  return {
    batchRows: batchRows.map((row) => assignedBySourceRow.get(row.source_row) || row),
    boxes: nextBoxes,
    collisions: [],
    capacityIssues,
  };
}

function upsertBox(boxes, box_id, cards_per_section) {
  const existing = boxes.find((box) => normalizeBoxId(box.box_id) === box_id);
  if (existing) {
    return boxes.map((box) =>
      normalizeBoxId(box.box_id) === box_id
        ? { ...box, box_id, cards_per_section: Number(cards_per_section) || box.cards_per_section || 100 }
        : box,
    );
  }
  return [...boxes, { box_id, cards_per_section: Number(cards_per_section) || 100 }];
}

function getSectionUsage(rows) {
  const usage = new Map();
  for (const row of rows) {
    const section = Number(row.section_number) || parseSectionNumber(row.physical_location_sku);
    if (!section) continue;
    usage.set(section, (usage.get(section) || 0) + safeQuantity(row.quantity));
  }
  return usage;
}

function getLastSectionCursor(sectionUsage) {
  const sections = [...sectionUsage.keys()].sort((a, b) => a - b);
  return { section_number: sections[sections.length - 1] || 1 };
}

function nextSectionForQuantity(cursor, sectionUsage, quantity, cardsPerSection) {
  const limit = Number(cardsPerSection) || 100;
  let section = cursor.section_number || 1;
  const used = sectionUsage.get(section) || 0;
  if (used > 0 && used + quantity > limit) section += 1;
  return { section_number: section };
}

function formatLocationSku({ box_id, section_number, sku_format = DEFAULT_LOCATION_SETTINGS.sku_format }) {
  return sku_format
    .replaceAll("{box_id}", normalizeBoxId(box_id))
    .replaceAll("{section_number}", String(section_number))
    .replaceAll("{section_number_padded}", String(section_number).padStart(3, "0"));
}

function parseSectionNumber(physicalLocationSku = "") {
  const match = String(physicalLocationSku).match(/-S(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function safeQuantity(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

function normalizeBoxId(boxId) {
  const trimmed = String(boxId || "").trim().toUpperCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("B")) return trimmed;
  return `B${trimmed.padStart(3, "0")}`;
}
