const RARITY_MAP = new Map([
  ["rare", "R"],
  ["r", "R"],
  ["uncommon", "U"],
  ["u", "U"],
  ["common", "C"],
  ["c", "C"],
  ["mythic", "M"],
  ["mythic rare", "M"],
  ["m", "M"],
  ["token", "T"],
  ["t", "T"],
  ["land", "L"],
  ["l", "L"],
  ["promo", "P"],
  ["p", "P"],
  ["special", "S"],
  ["s", "S"],
]);

export const FIELD_DEFINITIONS = [
  { key: "card_name", label: "card_name", level: "required", aliases: ["card name", "product name", "name", "card"] },
  { key: "set_name", label: "set_name", level: "recommended", aliases: ["set name", "set"] },
  { key: "set_code", label: "set_code", level: "recommended", aliases: ["set code", "setcode", "code", "edition code"] },
  { key: "collector_number", label: "collector_number", level: "required", aliases: ["card #", "number", "cardnumber", "collector number", "collector_number", "cn"] },
  { key: "rarity", label: "rarity", level: "recommended", aliases: ["rarity", "cleanrarity"] },
  { key: "condition", label: "condition", level: "required", aliases: ["condition", "cleancondition"] },
  { key: "finish", label: "finish", level: "required", aliases: ["printing", "finish", "foil", "cleanfoil"] },
  { key: "language", label: "language", level: "recommended", aliases: ["language", "lang"] },
  { key: "quantity", label: "quantity", level: "required", aliases: ["qty", "quantity", "total quantity", "add to quantity"] },
  { key: "listing_price", label: "listing_price", level: "optional", aliases: ["listing price", "my store price", "tcg marketplace price", "price"] },
  {
    key: "physical_location_sku",
    label: "physical_location_sku",
    level: "required",
    aliases: ["bin", "physical location sku", "physical sku", "location sku", "location", "box"],
    dangerousAliases: ["sku"],
  },
  { key: "tcgplayer_product_id", label: "tcgplayer_product_id", level: "required_for_inventory", aliases: ["tcgplayer id", "tcgplayerid", "product id", "productid"] },
  { key: "tcgplayer_sku_id", label: "tcgplayer_sku_id", level: "recommended_for_inventory", aliases: ["skuid", "sku id", "tcg sku id", "tcgplayer sku id"] },
  { key: "product_line", label: "product_line", level: "optional", aliases: ["product line", "game", "line"] },
  { key: "photo_url", label: "photo_url", level: "optional", aliases: ["photo url", "main photo url"] },
  { key: "import_sequence", label: "import_sequence", level: "optional", aliases: ["import sequence", "sequence", "row order"] },
];

export function inferMapping(headers) {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const mapping = {};
  for (const field of FIELD_DEFINITIONS) {
    const safeAliases = new Set(field.aliases.map(normalizeHeader));
    const safeIndex = normalizedHeaders.findIndex((header) => safeAliases.has(header));
    if (safeIndex >= 0) {
      mapping[field.key] = headers[safeIndex];
      continue;
    }
    const dangerousAliases = new Set((field.dangerousAliases || []).map(normalizeHeader));
    const dangerousIndex = normalizedHeaders.findIndex((header) => dangerousAliases.has(header));
    if (dangerousIndex >= 0) mapping[field.key] = headers[dangerousIndex];
  }
  return mapping;
}

export function getMappingWarnings(headers, mapping, mode = "batch") {
  const warnings = [];
  for (const field of FIELD_DEFINITIONS) {
    const required = isRequiredForMode(field.key, mode);
    if (required && !mapping[field.key]) {
      warnings.push({ level: "red", field: field.key, message: `Column missing: ${field.key} is required for ${mode} imports.` });
    }
    if (mapping[field.key] && (field.dangerousAliases || []).map(normalizeHeader).includes(normalizeHeader(mapping[field.key]))) {
      warnings.push({
        level: "yellow",
        field: field.key,
        message: `${mapping[field.key]} is ambiguous. Confirm this is a physical location SKU, not a TCGplayer SKU ID.`,
      });
    }
  }
  if (mode === "inventory" && !mapping.tcgplayer_sku_id) {
    warnings.push({
      level: "yellow",
      field: "tcgplayer_sku_id",
      message: "No TCGplayer SKU ID column was detected. Chrono will preserve product IDs but cannot verify listing variants.",
    });
  }
  return warnings;
}

function isRequiredForMode(fieldKey, mode) {
  const inventoryRequired = new Set(["card_name", "collector_number", "condition", "quantity", "tcgplayer_product_id"]);
  const batchRequired = new Set(["card_name", "collector_number", "condition", "finish", "quantity", "physical_location_sku"]);
  return mode === "inventory" ? inventoryRequired.has(fieldKey) : batchRequired.has(fieldKey);
}

export function normalizeBatchRow(row, mapping, index, meta = {}) {
  return normalizeCommonRow(row, mapping, index, meta, "batch");
}

export function normalizeInventoryRow(row, mapping, index, meta = {}) {
  return normalizeCommonRow(row, mapping, index, meta, "inventory");
}

export function normalizeReferenceRow(row, mapping, index, meta = {}) {
  return normalizeInventoryRow(row, mapping, index, meta);
}

export function matchBatchRows(batchRows, inventoryRows) {
  const exactIndex = groupBy(inventoryRows, (row) => row.identity_key);
  const productNumberIndex = groupBy(inventoryRows, (row) => [norm(row.card_name), row.collector_number].join("|"));
  return batchRows.map((row) => {
    if (row.tcgplayer_product_id) {
      const direct = inventoryRows.filter((inventory) => inventory.tcgplayer_product_id === row.tcgplayer_product_id);
      if (direct.length === 1) return auditResult(row, direct, "green", 100, "existing TCGplayer Product ID");
      if (direct.length > 1) return auditResult(row, direct, "yellow", 70, "existing product ID has multiple inventory rows");
    }

    const exact = exactIndex.get(row.identity_key) || [];
    if (exact.length === 1) return auditResult(row, exact, "green", 98, "exact normalized identity match");
    if (exact.length > 1) return auditResult(row, exact, "red", 45, "multiple exact identity matches");

    const loose = productNumberIndex.get([norm(row.card_name), row.collector_number].join("|")) || [];
    const scored = scoreCandidates(row, loose.length ? loose : inventoryRows).slice(0, 8);
    if (scored.length && scored[0].score >= 80 && (!scored[1] || scored[0].score - scored[1].score >= 12)) {
      return auditResult(row, [scored[0].row], "green", scored[0].score, `high confidence score ${scored[0].score}`);
    }
    if (scored.length) return auditResult(row, scored.map((candidate) => candidate.row), "yellow", scored[0].score, "ambiguous candidate set");
    return auditResult(row, [], "red", 0, "no candidate found");
  });
}

export function matchRows(batchRows, inventoryRows) {
  return matchBatchRows(batchRows, inventoryRows);
}

export function chooseManualMatch(result, match) {
  return finalizeResult({
    ...result,
    audit_status: "green",
    status: "matched",
    match_confidence: 100,
    reason: "manual choice",
    match_reason: "manual choice",
    selected: match,
    candidates: [match, ...result.candidates.filter((candidate) => candidate !== match)],
  });
}

export function auditResults(results, inventoryRows = []) {
  const issues = [];
  const productLocationCounts = countBy(results.map((result) => productLocationKey(result)).filter(Boolean));
  const tcgIdentityCounts = countBy(inventoryRows.map((row) => tcgIdentityKey(row)).filter(Boolean));

  for (const result of results) {
    const row = result.row;
    const selected = result.selected;
    if (!row.card_name) issues.push(issue("red", row.source_row, "missing card_name"));
    if (!row.physical_location_sku) issues.push(issue("red", row.source_row, "physical_location_sku value is blank"));
    if (row.location_collision) issues.push(issue("red", row.source_row, `generated physical_location_sku collision: ${row.physical_location_sku}`));
    if (row.section_capacity_exceeded) issues.push(issue("red", row.source_row, "section capacity exceeded by row quantity"));
    if (!isGoodQuantity(row.quantity)) issues.push(issue("red", row.source_row, "bad quantity"));
    if (!selected?.tcgplayer_product_id) issues.push(issue("red", row.source_row, "TCGplayer Product ID value is blank"));
    if (selected && selected.expected_tcgplayer_sku_id && !selected.tcgplayer_sku_id) issues.push(issue("red", row.source_row, "TCGplayer SKU ID value is blank"));
    if (result.audit_status === "yellow") issues.push(issue("yellow", row.source_row, result.match_reason));
    if (result.audit_status === "red") issues.push(issue("red", row.source_row, result.match_reason));
    const locationKey = productLocationKey(result);
    if (locationKey && productLocationCounts.get(locationKey) > 1) {
      issues.push(issue("yellow", row.source_row, "same product already appears in this section; merge review may be needed"));
    }
  }

  for (const row of inventoryRows) {
    const identity = tcgIdentityKey(row);
    if (identity && tcgIdentityCounts.get(identity) > 1) {
      issues.push(issue("yellow", row.source_row, `duplicate TCGplayer identity in inventory: ${identity}`));
    }
  }

  const blockingRows = new Set(issues.filter((item) => item.level === "red").map((item) => item.row));
  const yellowRows = new Set(issues.filter((item) => item.level === "yellow").map((item) => item.row));
  return {
    issues,
    blockingRows,
    yellowRows,
    counts: {
      missing_physical_location_sku: issues.filter((item) => item.message.includes("physical_location_sku")).length,
      missing_tcgplayer_product_id: issues.filter((item) => item.message.includes("Product ID")).length,
      missing_tcgplayer_sku_id: issues.filter((item) => item.message.includes("SKU ID")).length,
      duplicate_physical_location_sku: 0,
      duplicate_product_location_combo: issues.filter((item) => item.message.includes("same product already appears")).length,
      duplicate_tcgplayer_identity: issues.filter((item) => item.message.includes("duplicate TCGplayer identity")).length,
      bad_quantities: issues.filter((item) => item.message.includes("bad quantity")).length,
      unresolved: results.filter((result) => result.audit_status === "red").length,
      ambiguous: results.filter((result) => result.audit_status === "yellow").length,
    },
  };
}

export function validateResults(results, inventoryRows = []) {
  return auditResults(results, inventoryRows).issues.map((item) => ({
    level: item.level === "red" ? "error" : "warning",
    row: item.row,
    message: item.message,
  }));
}

export function buildExportRows(results, options = {}) {
  const includeBlocked = options.includeBlocked ?? false;
  const rows = includeBlocked ? results : results.filter((result) => result.audit_status === "green");
  return rows.map((result) => resultToExportRow(result, result.merge_action || ""));
}

export function buildErrorRows(results) {
  return results.filter((result) => result.audit_status !== "green").map((result) => resultToExportRow(result, "blocked"));
}

export function summarize(results, inventoryRows = []) {
  const audit = auditResults(results, inventoryRows);
  return {
    total: results.length,
    matched: results.filter((result) => result.audit_status === "green").length,
    review: results.filter((result) => result.audit_status === "yellow").length,
    unmatched: results.filter((result) => result.audit_status === "red").length,
    green: results.filter((result) => result.audit_status === "green").length,
    yellow: results.filter((result) => result.audit_status === "yellow").length,
    red: results.filter((result) => result.audit_status === "red").length,
    ...audit.counts,
  };
}

function normalizeCommonRow(row, mapping, index, meta, sourceType) {
  const value = (field) => cleanCell(row[mapping[field]]);
  const parsedCondition = parseConditionAndFinish(value("condition"), value("finish"), Boolean(mapping.finish));
  const rawQuantity = value("quantity");
  const normalized = {
    source_row: index + 2,
    sourceRow: index + 2,
    source_type: sourceType,
    source_file: meta.source_file || "",
    import_batch: meta.import_batch || "",
    product_line: value("product_line") || "Magic",
    card_name: value("card_name"),
    productName: value("card_name"),
    set_name: value("set_name"),
    setName: value("set_name"),
    set_code: value("set_code"),
    setCode: value("set_code"),
    collector_number: normalizeNumber(value("collector_number")),
    number: normalizeNumber(value("collector_number")),
    rarity: normalizeRarity(value("rarity")),
    raw_rarity: value("rarity"),
    condition: parsedCondition.condition,
    finish: parsedCondition.finish,
    normalization_note: parsedCondition.note,
    language: normalizeLanguage(value("language")),
    quantity: parseQuantity(rawQuantity),
    raw_quantity: rawQuantity,
    listing_price: value("listing_price"),
    price: value("listing_price"),
    physical_location_sku: value("physical_location_sku"),
    physicalSku: value("physical_location_sku"),
    tcgplayer_product_id: value("tcgplayer_product_id"),
    tcgplayerId: value("tcgplayer_product_id"),
    tcgplayer_sku_id: value("tcgplayer_sku_id"),
    skuId: value("tcgplayer_sku_id"),
    photo_url: value("photo_url"),
    import_sequence: value("import_sequence"),
    raw: row,
  };
  normalized.identity_key = buildIdentityKey(normalized);
  normalized.matchKey = normalized.identity_key;
  normalized.memory_key = buildMemoryKey(normalized);
  normalized.memoryKey = normalized.memory_key;
  normalized.tcg_identity_key = tcgIdentityKey(normalized);
  normalized.expected_tcgplayer_sku_id = Boolean(mapping.tcgplayer_sku_id);
  return normalized;
}

function auditResult(row, candidates, auditStatus, confidence, reason) {
  const selected = auditStatus === "green" ? candidates[0] : null;
  const matchReason = selected?.normalization_note ? `${reason}. ${selected.normalization_note}` : reason;
  return finalizeResult({
    id: `${row.source_row}-${row.memory_key}`,
    row,
    candidates,
    selected,
    audit_status: auditStatus,
    status: auditStatus === "green" ? "matched" : auditStatus === "yellow" ? "review" : "unmatched",
    match_confidence: confidence,
    reason: matchReason,
    match_reason: matchReason,
  });
}

function finalizeResult(result) {
  const selected = result.selected;
  let auditStatus = result.audit_status;
  let reason = result.match_reason;
    if (auditStatus === "green") {
    const blocking = [];
    if (!result.row.physical_location_sku) blocking.push("physical_location_sku value is blank");
    if (result.row.location_collision) blocking.push(`generated physical_location_sku collision: ${result.row.physical_location_sku}`);
    if (result.row.section_capacity_exceeded) blocking.push("section capacity exceeded by row quantity");
    if (!isGoodQuantity(result.row.quantity)) blocking.push("bad quantity");
    if (!selected?.tcgplayer_product_id) blocking.push("TCGplayer Product ID value is blank");
    if (selected && selected.expected_tcgplayer_sku_id && !selected.tcgplayer_sku_id) blocking.push("TCGplayer SKU ID value is blank");
    if (blocking.length) {
      auditStatus = "red";
      reason = blocking.join("; ");
    }
  }
  return {
    ...result,
    audit_status: auditStatus,
    status: auditStatus === "green" ? "matched" : auditStatus === "yellow" ? "review" : "unmatched",
    match_reason: reason,
    reason,
  };
}

function resultToExportRow(result, mergeAction) {
  const row = result.row;
  const match = result.selected;
  return {
    internal_inventory_id: row.internal_inventory_id || "",
    source_row: row.source_row,
    audit_status: result.audit_status,
    match_confidence: result.match_confidence,
    match_reason: result.match_reason,
    source_file: row.source_file,
    import_batch: row.import_batch,
    import_batch_id: row.import_batch_id || "",
    merge_action: mergeAction,
    physical_location_sku: row.physical_location_sku,
    box_id: row.box_id || "",
    section_number: row.section_number || "",
    slot_number: row.slot_number || "",
    tcgplayer_product_id: match?.tcgplayer_product_id || row.tcgplayer_product_id || "",
    tcgplayer_sku_id: match?.tcgplayer_sku_id || row.tcgplayer_sku_id || "",
    product_line: match?.product_line || row.product_line,
    card_name: match?.card_name || row.card_name,
    set_name: match?.set_name || row.set_name,
    set_code: match?.set_code || row.set_code,
    collector_number: match?.collector_number || row.collector_number,
    rarity: match?.rarity || row.rarity,
    condition: row.condition || match?.condition,
    finish: row.finish || match?.finish,
    language: row.language || match?.language,
    quantity: row.quantity,
    listing_price: row.listing_price || match?.listing_price,
  };
}

function scoreCandidates(row, references) {
  return references
    .map((reference) => ({ row: reference, score: scoreCandidate(row, reference) }))
    .filter((candidate) => candidate.score >= 45)
    .sort((a, b) => b.score - a.score);
}

function scoreCandidate(row, reference) {
  let score = 0;
  if (norm(row.card_name) && norm(row.card_name) === norm(reference.card_name)) score += 42;
  else if (similarName(row.card_name, reference.card_name)) score += 24;
  if (row.collector_number && row.collector_number === reference.collector_number) score += 20;
  if (row.set_name && reference.set_name && norm(row.set_name) === norm(reference.set_name)) score += 18;
  if (row.set_code && reference.set_code && norm(row.set_code) === norm(reference.set_code)) score += 18;
  if (row.rarity && reference.rarity && row.rarity === reference.rarity) score += 8;
  if (row.condition && reference.condition && row.condition === reference.condition) score += 6;
  else if (row.condition && reference.condition) score -= 24;
  if (row.finish && reference.finish && row.finish === reference.finish) score += 6;
  else if (row.finish && reference.finish) score -= 24;
  if (row.language && reference.language && row.language === reference.language) score += 4;
  else if (row.language && reference.language) score -= 16;
  return score;
}

function similarName(a, b) {
  const left = norm(a);
  const right = norm(b);
  return left.length > 4 && right.length > 4 && (left.includes(right) || right.includes(left));
}

function buildIdentityKey(row) {
  return [
    norm(row.product_line),
    norm(row.card_name),
    norm(row.set_name || row.set_code),
    row.collector_number,
    row.rarity,
    row.condition,
    row.finish,
    row.language,
  ].join("|");
}

function buildMemoryKey(row) {
  return [
    norm(row.card_name),
    norm(row.set_name || row.set_code),
    row.collector_number,
    row.rarity,
    row.condition,
    row.finish,
    row.language,
  ].join("|");
}

function productLocationKey(result) {
  const row = result.row;
  const selected = result.selected;
  const productId = selected?.tcgplayer_product_id || row.tcgplayer_product_id;
  if (!productId || !row.physical_location_sku) return "";
  return [productId, selected?.tcgplayer_sku_id || row.tcgplayer_sku_id, row.physical_location_sku].join("|");
}

function tcgIdentityKey(row) {
  if (!row.tcgplayer_product_id) return "";
  return [row.tcgplayer_product_id, row.tcgplayer_sku_id, row.condition, row.finish, row.language].join("|");
}

function groupBy(rows, getKey) {
  const grouped = new Map();
  for (const row of rows) {
    const key = getKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function issue(level, row, message) {
  return { level, row, message };
}

function cleanCell(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeNumber(value) {
  return cleanCell(value).replace(/^0+(?=\d)/, "");
}

function parseQuantity(value) {
  if (value === "" || value == null) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function isGoodQuantity(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeRarity(value) {
  const key = norm(value);
  return RARITY_MAP.get(key) || cleanCell(value).toUpperCase();
}

function normalizeCondition(value) {
  const key = norm(value);
  if (!key) return "";
  if (key.includes("near mint")) return "Near Mint";
  if (key === "nm") return "Near Mint";
  if (key.includes("lightly played")) return "Lightly Played";
  if (key === "lp") return "Lightly Played";
  if (key.includes("moderately played")) return "Moderately Played";
  if (key === "mp") return "Moderately Played";
  if (key.includes("heavily played")) return "Heavily Played";
  if (key === "hp") return "Heavily Played";
  if (key.includes("damaged")) return "Damaged";
  return cleanCell(value);
}

function parseConditionAndFinish(conditionValue, finishValue, hasFinishColumn) {
  const rawCondition = cleanCell(conditionValue);
  if (hasFinishColumn) {
    return {
      condition: normalizeCondition(rawCondition),
      finish: normalizeFinish(finishValue || "Normal"),
      note: "",
    };
  }
  if (/\bfoil\b/i.test(rawCondition)) {
    const conditionWithoutFoil = rawCondition.replace(/\bfoil\b/gi, "").trim().replace(/\s+/g, " ");
    return {
      condition: normalizeCondition(conditionWithoutFoil),
      finish: "Foil",
      note: `Reference finish parsed from Condition: ${rawCondition} -> condition ${normalizeCondition(conditionWithoutFoil)}, finish Foil.`,
    };
  }
  return {
    condition: normalizeCondition(rawCondition),
    finish: "Normal",
    note: "",
  };
}

function normalizeFinish(value) {
  const key = norm(value);
  if (!key) return "";
  if (key.includes("etched")) return "Etched Foil";
  if (key.includes("foil")) return "Foil";
  if (key.includes("normal") || key.includes("nonfoil") || key.includes("non foil")) return "Normal";
  return cleanCell(value);
}

function normalizeLanguage(value) {
  const key = norm(value);
  if (!key) return "";
  if (key === "en" || key === "eng") return "English";
  return cleanCell(value);
}

function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
