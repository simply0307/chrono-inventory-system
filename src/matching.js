const RARITY_MAP = new Map([
  ["rare", "R"], ["r", "R"], ["uncommon", "U"], ["u", "U"], ["common", "C"], ["c", "C"],
  ["mythic", "M"], ["mythic rare", "M"], ["m", "M"], ["token", "T"], ["t", "T"],
  ["land", "L"], ["l", "L"], ["promo", "P"], ["p", "P"], ["special", "S"], ["s", "S"],
]);

export const LOCATION_PATTERN = /^B\d{3}-S\d{3}$/;

export const FIELD_DEFINITIONS = [
  { key: "card_name", label: "card_name", aliases: ["card name", "product name", "name", "card"] },
  { key: "set_name", label: "set_name", aliases: ["set name", "set"] },
  { key: "set_code", label: "set_code", aliases: ["set code", "setcode", "code", "edition code"] },
  { key: "collector_number", label: "collector_number", aliases: ["card #", "number", "cardnumber", "collector number", "collector_number", "cn"] },
  { key: "rarity", label: "rarity", aliases: ["rarity", "cleanrarity"] },
  { key: "condition", label: "condition", aliases: ["condition", "cleancondition"] },
  { key: "finish", label: "finish", aliases: ["printing", "finish", "foil", "cleanfoil"] },
  { key: "language", label: "language", aliases: ["language", "lang"] },
  { key: "quantity", label: "quantity", aliases: ["qty", "quantity", "total quantity", "add to quantity"] },
  { key: "listing_price", label: "listing_price", aliases: ["listing price", "my store price", "tcg marketplace price", "price"] },
  { key: "physical_location_sku", label: "physical_location_sku", aliases: ["bin", "physical location sku", "physical sku", "location sku", "location"] },
  { key: "box_id", label: "box_id", aliases: ["box id", "storage box", "box"] },
  { key: "section_number", label: "section_number", aliases: ["section number", "storage section", "section"] },
  { key: "tcgplayer_product_id", label: "tcgplayer_product_id", aliases: ["tcgplayer id", "tcgplayerid", "product id", "productid"] },
  { key: "tcgplayer_sku_id", label: "tcgplayer_sku_id", aliases: ["skuid", "sku id", "tcg sku id", "tcgplayer sku id"] },
  { key: "product_line", label: "product_line", aliases: ["product line", "game", "line"] },
  { key: "photo_url", label: "photo_url", aliases: ["photo url", "main photo url"] },
  { key: "import_sequence", label: "import_sequence", aliases: ["import sequence", "sequence", "row order"] },
];

const MATCH_FIELDS = ["condition", "finish", "rarity", "product_line", "set_name", "set_code", "language"];
const CATALOG_PREPARATION_CACHE = new WeakMap();

export function inferMapping(headers) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const mapping = {};
  for (const field of FIELD_DEFINITIONS) {
    const aliases = new Set(field.aliases.map(normalizeHeader));
    const index = normalizedHeaders.findIndex((header) => aliases.has(header));
    if (index >= 0) mapping[field.key] = headers[index];
  }
  return mapping;
}

export function getMappingWarnings(headers, mapping, mode = "batch") {
  const warnings = [];
  const normalizedMode = mode === "inventory" ? "catalog" : mode;
  const required = normalizedMode === "catalog"
    ? ["card_name", "collector_number", "condition", "tcgplayer_product_id"]
    : normalizedMode === "physical_inventory"
      ? ["physical_location_sku", "quantity"]
      : ["card_name", "collector_number", "condition", "finish", "quantity"];
  for (const field of required) {
    if (!mapping[field]) warnings.push({ level: "red", field, message: `Column missing: ${field} is required for ${normalizedMode} readiness.` });
  }
  if (normalizedMode === "catalog") {
    if (!mapping.tcgplayer_sku_id) warnings.push({ level: "yellow", field: "tcgplayer_sku_id", message: "Catalog has no TCGplayer SKU ID column. Product-ID reconciliation remains available; SKU verification will be unavailable." });
    if (!mapping.finish && mapping.condition) warnings.push({ level: "yellow", field: "finish", message: "No finish column is mapped. Finish will be derived from Condition when its representation is explicit; otherwise it is treated as Normal." });
    if (!mapping.language) warnings.push({ level: "yellow", field: "language", message: "Catalog has no language authority. Batch language cannot be independently verified." });
  }
  if (normalizedMode === "batch") {
    if (!mapping.set_name && !mapping.set_code) warnings.push({ level: "yellow", field: "set_identity", message: "Batch has no set identity. Rows can be green only when the remaining exact fields identify one unique catalog Product ID." });
    if (!mapping.language) warnings.push({ level: "yellow", field: "language", message: "Batch has no language. An explicit batch-wide language assumption may be supplied and will be recorded." });
  }
  if (headers.some((header) => normalizeHeader(header) === "sku") && !mapping.tcgplayer_sku_id && !mapping.physical_location_sku) {
    warnings.push({ level: "yellow", field: "sku", message: "Generic SKU is intentionally unresolved. Explicitly map it to the correct identifier if authoritative." });
  }
  return warnings;
}

export function normalizeBatchRow(row, mapping, index, meta = {}) {
  return normalizeCommonRow(row, mapping, index, meta, "batch");
}

export function normalizeInventoryRow(row, mapping, index, meta = {}) {
  return normalizeCommonRow(row, mapping, index, meta, "catalog");
}

export const normalizeReferenceRow = normalizeInventoryRow;

export function normalizePhysicalInventoryRow(row, mapping, index, meta = {}) {
  return normalizeCommonRow(row, mapping, index, meta, "physical_inventory");
}

export function getCatalogCapabilities(catalogRows) {
  return {
    product_id: catalogRows.some((row) => Boolean(row.tcgplayer_product_id)),
    sku_id: catalogRows.some((row) => Boolean(row.tcgplayer_sku_id)),
    language: catalogRows.some((row) => Boolean(row.language)),
    finish: catalogRows.some((row) => Boolean(row.finish)),
    set_name: catalogRows.some((row) => Boolean(row.set_name)),
    set_code: catalogRows.some((row) => Boolean(row.set_code)),
    product_line: catalogRows.some((row) => Boolean(row.product_line)),
    rarity: catalogRows.some((row) => Boolean(row.rarity)),
  };
}

export function matchBatchRows(batchRows, catalogRows, options = {}) {
  const prepared = prepareCatalog(catalogRows);
  const { indexes, capabilities } = prepared;
  return canonicalRows(batchRows).map((row) => matchOne(row, indexes, capabilities, options));
}

export const matchRows = matchBatchRows;

export function auditPostAllocationResults(identityResults, catalogRows = [], options = {}) {
  const allocationSettings = options.allocationSettings || {};
  const audited = canonicalResults(identityResults).map((result) => {
    const errors = allocationErrors(result.row, allocationSettings);
    if (errors.length) return updateResult(result, "red", `${result.match_reason}; Allocation blocked: ${errors.join("; ")}`);
    return {
      ...result,
      allocation_mode: allocationSettings.allocation_mode || result.row.allocation_mode || "",
      allocation_settings: allocationMetadata(allocationSettings, result.row),
    };
  });
  return annotateDuplicatesInSection(audited);
}

export function chooseManualMatch(result, match, options = {}) {
  const comparison = compareCandidate(result.row, match, options);
  if (comparison.conflicts.length) return makeResult(result.row, [match], "red", `Manual selection blocked: ${comparison.conflicts.join("; ")}`, { selected: match, fieldsUsed: comparison.fieldsUsed });
  return makeResult(result.row, [match], "yellow", "Manual candidate selected. The choice remains review-only because manual selection cannot replace a unique exact Product-ID reconciliation.", { selected: match, fieldsUsed: comparison.fieldsUsed, manualSelection: true });
}

export function auditResults(results) {
  const issues = [];
  for (const result of results) {
    if (result.audit_status !== "green") issues.push(issue(result.audit_status === "yellow" ? "yellow" : "red", result.row, result.match_reason));
  }
  const unique = dedupeIssues(issues);
  return {
    issues: unique,
    blockingRows: new Set(unique.filter((item) => item.level === "red").map((item) => item.internal_row_id)),
    yellowRows: new Set(unique.filter((item) => item.level === "yellow").map((item) => item.internal_row_id)),
    counts: {
      missing_physical_location_sku: unique.filter((item) => item.message.includes("physical_location_sku")).length,
      missing_tcgplayer_product_id: unique.filter((item) => item.message.includes("Product ID")).length,
      missing_tcgplayer_sku_id: unique.filter((item) => item.message.includes("SKU ID")).length,
      duplicate_in_section_rows: results.filter((result) => result.duplicate_in_section_count > 1).length,
      bad_quantities: unique.filter((item) => item.message.includes("quantity")).length,
      unresolved: results.filter((result) => result.audit_status === "red").length,
      ambiguous: results.filter((result) => result.audit_status === "yellow").length,
    },
  };
}

export function validateResults(results) {
  return auditResults(results).issues.map((item) => ({ level: item.level === "red" ? "error" : "warning", row: item.row, internal_row_id: item.internal_row_id, message: item.message }));
}

export function preflightResults(results, catalogRows, options = {}) {
  const identity = matchBatchRows(results.map((result) => result.row), catalogRows, options.identityOptions || {});
  const audited = auditPostAllocationResults(identity, catalogRows, options);
  return { results: audited, verified: audited.filter((result) => result.audit_status === "green"), rejected: audited.filter((result) => result.audit_status !== "green") };
}

export function buildExportRows(results, options = {}) {
  const checked = options.catalogRows ? preflightResults(results, options.catalogRows, options).results : canonicalResults(results);
  const rows = options.includeBlocked ? checked : checked.filter((result) => result.audit_status === "green");
  return rows.map((result) => resultToExportRow(result));
}

export function buildErrorRows(results, catalogRows = [], options = {}) {
  const checked = catalogRows.length ? preflightResults(results, catalogRows, options).results : canonicalResults(results);
  return checked.filter((result) => result.audit_status !== "green").map((result) => resultToExportRow(result));
}

export function summarize(results) {
  const audit = auditResults(results);
  return {
    total: results.length,
    green: results.filter((result) => result.audit_status === "green").length,
    yellow: results.filter((result) => result.audit_status === "yellow").length,
    red: results.filter((result) => result.audit_status === "red").length,
    matched: results.filter((result) => result.audit_status === "green").length,
    review: results.filter((result) => result.audit_status === "yellow").length,
    unmatched: results.filter((result) => result.audit_status === "red").length,
    ...audit.counts,
  };
}

export function assessReadiness({ referenceImport, batchImport, physicalInventoryImport = {}, referenceRows = [], batchRows = [], physicalInventoryRows = [], results = [], locationSettings = {}, identityOptions = {} }) {
  const schemaErrors = [
    ...getMappingWarnings(referenceImport.headers || [], referenceImport.mapping || {}, "catalog"),
    ...getMappingWarnings(batchImport.headers || [], batchImport.mapping || {}, "batch"),
  ].filter((warning) => warning.level === "red").map((warning) => warning.message);
  if (!referenceRows.length) schemaErrors.push("Catalog contains no rows.");
  if (!batchRows.length) schemaErrors.push("Batch contains no rows.");
  const importSchema = readinessState(schemaErrors);

  const identityErrors = [];
  if (!importSchema.ready) identityErrors.push("Import/schema readiness is blocked.");
  if (!referenceRows.some((row) => row.tcgplayer_product_id)) identityErrors.push("Catalog contains no usable Product IDs.");
  const identityReconciliation = readinessState(identityErrors);

  const allocationErrorsList = [];
  if (!results.length) allocationErrorsList.push("Run identity reconciliation first.");
  if (!locationSettings.allocation_mode) allocationErrorsList.push("Select New/empty allocation or Append to existing inventory.");
  if (!locationSettings.settings_confirmed) allocationErrorsList.push("Confirm the allocation Box, starting Section, and section capacity.");
  if (!/^B\d{3}$/.test(normalizeBoxId(locationSettings.box_id))) allocationErrorsList.push("Allocation Box must be canonical Bnnn.");
  if (!isPositiveInteger(locationSettings.starting_section_number)) allocationErrorsList.push("Starting Section must be a positive integer.");
  if (!isPositiveInteger(locationSettings.cards_per_section)) allocationErrorsList.push("Section capacity must be a positive integer.");
  if (locationSettings.use_import_sequence) {
    for (const sequenceIssue of validateSequenceValues(batchRows)) allocationErrorsList.push(`Row ${sequenceIssue.source_row}: Import Sequence ${sequenceIssue.message}.`);
  }
  if (locationSettings.allocation_mode === "append_existing") {
    const physicalWarnings = getMappingWarnings(physicalInventoryImport.headers || [], physicalInventoryImport.mapping || {}, "physical_inventory");
    allocationErrorsList.push(...physicalWarnings.filter((warning) => warning.level === "red").map((warning) => warning.message));
    if (!physicalInventoryRows.length) allocationErrorsList.push("Append mode requires a separate physical inventory file with rows.");
    for (const row of physicalInventoryRows) allocationErrorsList.push(...physicalInventoryRowErrors(row).map((message) => `Physical inventory row ${row.source_row}: ${message}`));
  }
  const allocationMode = readinessState(allocationErrorsList);

  const postErrors = [];
  if (!results.length) postErrors.push("Identity reconciliation has not run.");
  if (results.length && !results.every((result) => result.row.allocation_mode && result.row.allocation_settings_confirmed)) postErrors.push("Location allocation has not completed with confirmed settings for every row.");
  const postAllocationAudit = readinessState(postErrors);

  const preflight = results.length && postAllocationAudit.ready
    ? preflightResults(results, referenceRows, { identityOptions, allocationSettings: locationSettings, existingInventoryRows: physicalInventoryRows })
    : { verified: [], rejected: results };
  const exportErrors = [];
  if (!postAllocationAudit.ready) exportErrors.push("Post-allocation audit readiness is blocked.");
  if (!preflight.verified.length) exportErrors.push("There are zero independently verified green rows.");
  const exportReadiness = readinessState(exportErrors);

  const capabilities = getCatalogCapabilities(referenceRows);
  const notices = [];
  if (!capabilities.sku_id) notices.push("SKU verification unavailable: catalog has no authoritative TCGplayer SKU IDs.");
  if (!capabilities.language) notices.push("Language is not independently verified by the catalog.");
  if (identityOptions.batch_language_assumption) notices.push(`Batch-wide language assumption recorded: ${identityOptions.batch_language_assumption}.`);

  return {
    importSchema,
    identityReconciliation,
    allocationMode,
    postAllocationAudit,
    exportReadiness,
    catalogCapabilities: capabilities,
    capabilityNotices: notices,
    verifiedCount: preflight.verified.length,
    schema: importSchema,
    rowData: identityReconciliation,
    referenceAuthority: identityReconciliation,
    locationAllocation: allocationMode,
    verifiedExport: exportReadiness,
  };
}

export function isValidLocation(value) {
  return LOCATION_PATTERN.test(cleanCell(value).toUpperCase());
}

export function parseLocation(value) {
  const normalized = cleanCell(value).toUpperCase();
  const match = normalized.match(/^B(\d{3})-S(\d{3})$/);
  return match ? { physical_location_sku: normalized, box_id: `B${match[1]}`, section_number: Number(match[2]) } : null;
}

export function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0 && cleanCell(value) !== "";
}

function normalizeCommonRow(row, mapping, index, meta, sourceType) {
  const value = (field) => cleanCell(row[mapping[field]]);
  const parsedCondition = parseConditionAndFinish(value("condition"), value("finish"), Boolean(mapping.finish));
  const rawLocation = value("physical_location_sku").toUpperCase();
  const rawBox = value("box_id");
  const rawSection = value("section_number");
  const explicitBox = rawBox ? normalizeBoxId(rawBox) : "";
  const explicitSection = rawSection && isPositiveInteger(rawSection) ? Number(rawSection) : "";
  const parsedLocation = parseLocation(rawLocation);
  const derivedLocation = !rawLocation && /^B\d{3}$/.test(explicitBox) && explicitSection && explicitSection <= 999
    ? parseLocation(`${explicitBox}-S${String(explicitSection).padStart(3, "0")}`)
    : null;
  const location = parsedLocation || derivedLocation;
  const locationMetadataErrors = [];
  if (rawBox && !/^B\d{3}$/.test(explicitBox)) locationMetadataErrors.push(`box_id is malformed: ${rawBox}`);
  if (rawSection && (!isPositiveInteger(rawSection) || Number(rawSection) > 999)) locationMetadataErrors.push(`section_number is invalid: ${rawSection}`);
  if (parsedLocation && explicitBox && parsedLocation.box_id !== explicitBox) locationMetadataErrors.push(`physical_location_sku ${rawLocation} conflicts with box_id ${explicitBox}`);
  if (parsedLocation && explicitSection && parsedLocation.section_number !== explicitSection) locationMetadataErrors.push(`physical_location_sku ${rawLocation} conflicts with section_number ${explicitSection}`);
  const sourceFile = meta.source_file || "unspecified";
  return {
    internal_row_id: `${sourceType}:${sourceFile}:${index + 1}`,
    canonical_index: index,
    source_row: index + 2,
    source_type: sourceType,
    source_file: sourceFile,
    import_batch: meta.import_batch || "",
    product_line: value("product_line"),
    card_name: value("card_name"), productName: value("card_name"),
    set_name: value("set_name"), setName: value("set_name"),
    set_code: value("set_code"), setCode: value("set_code"),
    collector_number: normalizeCollectorNumber(value("collector_number")), number: normalizeCollectorNumber(value("collector_number")),
    rarity: normalizeRarity(value("rarity")), raw_rarity: value("rarity"),
    condition: parsedCondition.condition,
    finish: parsedCondition.finish,
    normalization_note: parsedCondition.note,
    language: normalizeLanguage(value("language")),
    quantity: parseQuantity(value("quantity")), raw_quantity: value("quantity"),
    listing_price: value("listing_price"), price: value("listing_price"),
    physical_location_sku: location?.physical_location_sku || rawLocation, physicalSku: location?.physical_location_sku || rawLocation,
    box_id: location?.box_id || "", section_number: location?.section_number || "",
    location_metadata_error: locationMetadataErrors.join("; "),
    tcgplayer_product_id: value("tcgplayer_product_id"), tcgplayerId: value("tcgplayer_product_id"),
    tcgplayer_sku_id: value("tcgplayer_sku_id"), skuId: value("tcgplayer_sku_id"),
    photo_url: value("photo_url"),
    import_sequence: value("import_sequence"),
    merge_action: "",
    raw: row,
  };
}

function buildCatalogIndexes(catalogRows) {
  const byNameNumber = new Map();
  const byName = new Map();
  const byPrefix = new Map();
  const byProductId = new Map();
  const bySkuId = new Map();
  for (const row of catalogRows) {
    addIndex(byNameNumber, `${norm(row.card_name)}|${row.collector_number}`, row);
    addIndex(byName, norm(row.card_name), row);
    addIndex(byPrefix, norm(row.card_name).slice(0, 8), row);
    if (row.tcgplayer_product_id) addIndex(byProductId, row.tcgplayer_product_id, row);
    if (row.tcgplayer_sku_id) addIndex(bySkuId, row.tcgplayer_sku_id, row);
  }
  return { catalogRows, byNameNumber, byName, byPrefix, byProductId, bySkuId };
}

function prepareCatalog(catalogRows) {
  if (catalogRows && typeof catalogRows === "object") {
    const cached = CATALOG_PREPARATION_CACHE.get(catalogRows);
    if (cached) return cached;
    const prepared = { indexes: buildCatalogIndexes(catalogRows), capabilities: getCatalogCapabilities(catalogRows) };
    CATALOG_PREPARATION_CACHE.set(catalogRows, prepared);
    return prepared;
  }
  return { indexes: buildCatalogIndexes(catalogRows || []), capabilities: getCatalogCapabilities(catalogRows || []) };
}

function matchOne(row, indexes, capabilities, options) {
  if (!isPositiveInteger(row.quantity)) return makeResult(row, [], "red", `quantity must be a positive integer (received ${row.raw_quantity || "blank"})`, { capabilities });
  if (!row.card_name) return makeResult(row, [], "red", "card_name value is blank", { capabilities });
  if (options.batch_language_assumption && row.language && norm(row.language) !== norm(options.batch_language_assumption)) {
    return makeResult(row, [], "red", `Batch language ${row.language} contradicts confirmed batch-wide language assumption ${options.batch_language_assumption}.`, { capabilities });
  }

  let pool;
  let suppliedIdentifier = "";
  if (row.tcgplayer_sku_id && capabilities.sku_id) {
    pool = indexes.bySkuId.get(row.tcgplayer_sku_id) || [];
    suppliedIdentifier = `Supplied SKU ID ${row.tcgplayer_sku_id}`;
    if (!pool.length) return makeResult(row, fuzzyCandidates(row, indexes), "red", `${suppliedIdentifier} does not exist in the catalog.`, { capabilities, skuStatus: "conflict" });
  } else if (row.tcgplayer_product_id) {
    pool = indexes.byProductId.get(row.tcgplayer_product_id) || [];
    suppliedIdentifier = `Supplied Product ID ${row.tcgplayer_product_id}`;
    if (!pool.length) return makeResult(row, fuzzyCandidates(row, indexes), "red", `${suppliedIdentifier} does not exist in the catalog.`, { capabilities });
  } else if (row.collector_number) {
    pool = indexes.byNameNumber.get(`${norm(row.card_name)}|${row.collector_number}`) || [];
  } else {
    const candidates = indexes.byName.get(norm(row.card_name)) || fuzzyCandidates(row, indexes);
    return candidates.length
      ? makeResult(row, candidates, "yellow", "Collector number is missing; name-only candidates require review.", { capabilities })
      : makeResult(row, [], "red", "Collector number is missing and no name candidate exists.", { capabilities });
  }

  const comparisons = pool.map((candidate) => ({ candidate, ...compareCandidate(row, candidate, options) }));
  const exact = comparisons.filter((item) => item.conflicts.length === 0);
  if (!exact.length) {
    if (pool.length) {
      const conflicts = [...new Set(comparisons.flatMap((item) => item.conflicts))];
      const subject = suppliedIdentifier || "Catalog candidates with the same card name and collector number";
      return makeResult(row, pool.slice(0, 8), "red", `${subject} conflicts with mutually available catalog identity: ${conflicts.join("; ") || "no exact candidate"}.`, { capabilities, skuStatus: row.tcgplayer_sku_id && capabilities.sku_id ? "conflict" : undefined });
    }
    const suggestions = fuzzyCandidates(row, indexes);
    return suggestions.length
      ? makeResult(row, suggestions, "yellow", "No exact available-field match; candidates are review-only suggestions.", { capabilities })
      : makeResult(row, [], "red", "No catalog candidate matches card name and collector number.", { capabilities });
  }

  const productIds = [...new Set(exact.map((item) => item.candidate.tcgplayer_product_id).filter(Boolean))];
  const fieldsUsed = [...new Set(exact.flatMap((item) => item.fieldsUsed))];
  const unverifiedFields = [...new Set(exact.flatMap((item) => item.unverifiedFields))];
  if (!productIds.length) return makeResult(row, exact.map((item) => item.candidate), "red", "Exact catalog candidates have no Product ID.", { capabilities, fieldsUsed, unverifiedFields });
  if (productIds.length > 1) return makeResult(row, exact.map((item) => item.candidate), "yellow", `${productIds.length} Product IDs remain after exact available-field matching; review is required.`, { capabilities, fieldsUsed, unverifiedFields, productCandidates: productIds });

  const selectedProductId = productIds[0];
  const selectedRows = exact.filter((item) => item.candidate.tcgplayer_product_id === selectedProductId).map((item) => item.candidate);
  const selected = selectedRows[0];
  const sku = resolveSku(row, selectedRows, capabilities);
  if (sku.status === "conflict") return makeResult(row, selectedRows, "red", sku.reason, { selected, capabilities, fieldsUsed, unverifiedFields, skuStatus: "conflict", productCandidates: productIds });
  const assumptionNote = options.batch_language_assumption ? ` Batch-wide language assumption recorded: ${options.batch_language_assumption}.` : "";
  const unverifiedNote = unverifiedFields.length ? ` Not independently verified: ${unverifiedFields.join(", ")}.` : "";
  const normalizationNote = selected.normalization_note ? ` ${selected.normalization_note}` : "";
  return makeResult(row, selectedRows, "green", `Unique Product ID ${selectedProductId} exact match using ${fieldsUsed.join(", ")}.${unverifiedNote}${assumptionNote}${normalizationNote}`.trim(), {
    selected,
    capabilities,
    fieldsUsed,
    unverifiedFields,
    productCandidates: productIds,
    skuStatus: sku.status,
    verifiedSkuId: sku.skuId,
    languageAssumption: options.batch_language_assumption || "",
  });
}

function compareCandidate(row, candidate, options = {}) {
  const conflicts = [];
  const fieldsUsed = [];
  const unverifiedFields = [];
  compareRequired("card_name", row.card_name, candidate.card_name, conflicts, fieldsUsed);
  compareRequired("collector_number", row.collector_number, candidate.collector_number, conflicts, fieldsUsed);
  for (const field of MATCH_FIELDS) {
    const batchValue = field === "language" ? (row.language || normalizeLanguage(options.batch_language_assumption)) : row[field];
    const catalogValue = candidate[field];
    if (batchValue && catalogValue) {
      fieldsUsed.push(field);
      if (norm(batchValue) !== norm(catalogValue)) conflicts.push(`${field} conflicts (${batchValue} vs ${catalogValue})`);
    } else if (batchValue || catalogValue) {
      unverifiedFields.push(field);
    }
  }
  if (row.tcgplayer_product_id && row.tcgplayer_product_id !== candidate.tcgplayer_product_id) conflicts.push(`Product ID conflicts (${row.tcgplayer_product_id} vs ${candidate.tcgplayer_product_id || "blank"})`);
  if (row.tcgplayer_sku_id && candidate.tcgplayer_sku_id && row.tcgplayer_sku_id !== candidate.tcgplayer_sku_id) conflicts.push(`SKU ID conflicts (${row.tcgplayer_sku_id} vs ${candidate.tcgplayer_sku_id})`);
  return { conflicts: [...new Set(conflicts)], fieldsUsed: [...new Set(fieldsUsed)], unverifiedFields: [...new Set(unverifiedFields)] };
}

function compareRequired(field, batchValue, catalogValue, conflicts, fieldsUsed) {
  if (!batchValue || !catalogValue) return;
  fieldsUsed.push(field);
  if (norm(batchValue) !== norm(catalogValue)) conflicts.push(`${field} conflicts (${batchValue} vs ${catalogValue})`);
}

function resolveSku(row, selectedRows, capabilities) {
  if (!capabilities.sku_id) return { status: "unavailable", skuId: "", reason: "Catalog has no SKU authority." };
  const skuIds = [...new Set(selectedRows.map((candidate) => candidate.tcgplayer_sku_id).filter(Boolean))];
  if (row.tcgplayer_sku_id) {
    if (skuIds.includes(row.tcgplayer_sku_id)) return { status: "verified", skuId: row.tcgplayer_sku_id, reason: "Supplied SKU verified." };
    return { status: "conflict", skuId: "", reason: `Supplied SKU ID ${row.tcgplayer_sku_id} conflicts with the exact Product-ID candidate.` };
  }
  return skuIds.length === 1
    ? { status: "verified", skuId: skuIds[0], reason: "Unique authoritative SKU verified." }
    : { status: "unavailable", skuId: "", reason: "Exact Product ID has no unique authoritative SKU variant." };
}

function makeResult(row, candidates, auditStatus, reason, details = {}) {
  const selected = details.selected || (auditStatus === "green" ? candidates[0] : null);
  return {
    id: row.internal_row_id,
    row,
    candidates,
    selected,
    audit_status: auditStatus,
    identity_status: auditStatus,
    status: auditStatus === "green" ? "matched" : auditStatus === "yellow" ? "review" : "unmatched",
    match_confidence: auditStatus === "green" ? 100 : 0,
    match_reason: reason,
    reason,
    tcgplayer_product_id: selected?.tcgplayer_product_id || "",
    tcgplayer_sku_id: details.verifiedSkuId || "",
    sku_verification_status: details.skuStatus || (details.capabilities?.sku_id ? "unavailable" : "unavailable"),
    identity_fields_used: details.fieldsUsed || [],
    identity_fields_unverified: details.unverifiedFields || [],
    product_id_candidates: details.productCandidates || [...new Set(candidates.map((candidate) => candidate.tcgplayer_product_id).filter(Boolean))],
    batch_language_assumption: details.languageAssumption || "",
    catalog_capabilities: details.capabilities || {},
    manual_selection: Boolean(details.manualSelection),
  };
}

function updateResult(result, auditStatus, reason) {
  return { ...result, audit_status: auditStatus, status: auditStatus === "green" ? "matched" : auditStatus === "yellow" ? "review" : "unmatched", match_reason: reason, reason };
}

function allocationErrors(row, settings) {
  const errors = [];
  if (!settings.allocation_mode) errors.push("allocation mode is not selected");
  if (!settings.settings_confirmed) errors.push("allocation settings are not confirmed");
  if (!isPositiveInteger(row.quantity)) errors.push("quantity must be a positive integer");
  if (!row.physical_location_sku) errors.push("physical_location_sku is blank after allocation");
  else if (!isValidLocation(row.physical_location_sku)) errors.push(`physical_location_sku is malformed: ${row.physical_location_sku}`);
  if (row.location_allocation_error) errors.push(row.location_allocation_error);
  if (row.location_metadata_error) errors.push(row.location_metadata_error);
  if (row.section_capacity_exceeded) errors.push("section capacity exceeded by row quantity");
  if (row.location_collision) errors.push("physical location capacity collision");
  if (row.allocation_mode && settings.allocation_mode && row.allocation_mode !== settings.allocation_mode) errors.push("row allocation mode does not match current settings");
  return [...new Set(errors)];
}

function allocationMetadata(settings, row) {
  return {
    mode: settings.allocation_mode || row.allocation_mode || "",
    box_id: settings.box_id || row.box_id || "",
    starting_section_number: settings.starting_section_number || "",
    cards_per_section: settings.cards_per_section || "",
    use_import_sequence: Boolean(settings.use_import_sequence),
    confirmed: Boolean(settings.settings_confirmed || row.allocation_settings_confirmed),
  };
}

function annotateDuplicatesInSection(results) {
  const counts = countBy(results.map(duplicateInSectionKey).filter(Boolean));
  const positions = new Map();
  return results.map((result) => {
    const key = duplicateInSectionKey(result);
    const count = key ? counts.get(key) || 1 : 1;
    const index = key ? (positions.get(key) || 0) + 1 : 1;
    if (key) positions.set(key, index);
    return {
      ...result,
      duplicate_in_section_count: count,
      duplicate_in_section_index: index,
      duplicate_in_section: count > 1,
      duplicate_combo_unresolved: false,
    };
  });
}

function fuzzyCandidates(row, indexes) {
  const exactName = indexes.byName.get(norm(row.card_name)) || [];
  if (exactName.length) return exactName.slice(0, 8);
  const prefix = norm(row.card_name).slice(0, 8);
  return (indexes.byPrefix.get(prefix) || []).filter((candidate) => similarName(row.card_name, candidate.card_name)).slice(0, 8);
}

function similarName(a, b) {
  const left = norm(a); const right = norm(b);
  return left.length > 4 && right.length > 4 && (left.includes(right) || right.includes(left));
}

function physicalInventoryRowErrors(row) {
  const errors = [];
  if (!isPositiveInteger(row.quantity)) errors.push("quantity must be a positive integer");
  if (!isValidLocation(row.physical_location_sku)) errors.push("physical_location_sku must match Bnnn-Snnn");
  if (row.location_metadata_error) errors.push(row.location_metadata_error);
  return errors;
}

function validateSequenceValues(rows) {
  const issues = [];
  const seen = new Map();
  for (const row of rows) {
    const raw = cleanCell(row.import_sequence);
    const numeric = Number(raw);
    if (!raw) issues.push({ source_row: row.source_row, message: "is blank" });
    else if (!Number.isFinite(numeric)) issues.push({ source_row: row.source_row, message: `is nonnumeric (${raw})` });
    else if (!Number.isInteger(numeric)) issues.push({ source_row: row.source_row, message: `is fractional (${raw})` });
    else if (numeric <= 0) issues.push({ source_row: row.source_row, message: `must be positive (${raw})` });
    else if (seen.has(numeric)) issues.push({ source_row: row.source_row, message: `duplicates row ${seen.get(numeric)} (${raw})` });
    else seen.set(numeric, row.source_row);
  }
  return issues;
}

function resultToExportRow(result) {
  return {
    internal_row_id: result.row.internal_row_id,
    source_row: result.row.source_row,
    audit_status: result.audit_status,
    match_reason: result.match_reason,
    physical_location_sku: result.row.physical_location_sku,
    tcgplayer_product_id: result.tcgplayer_product_id,
    tcgplayer_sku_id: result.tcgplayer_sku_id,
    sku_verification_status: result.sku_verification_status,
    identity_fields_used: result.identity_fields_used.join("|"),
    identity_fields_unverified: result.identity_fields_unverified.join("|"),
    allocation_mode: result.allocation_mode || result.row.allocation_mode || "",
    batch_language_assumption: result.batch_language_assumption,
    duplicate_in_section_count: result.duplicate_in_section_count || 1,
    duplicate_in_section_index: result.duplicate_in_section_index || 1,
  };
}

function duplicateInSectionKey(result) {
  if (!result.tcgplayer_product_id || !isValidLocation(result.row.physical_location_sku)) return "";
  return [
    result.tcgplayer_product_id,
    result.sku_verification_status,
    result.sku_verification_status === "verified" ? result.tcgplayer_sku_id : "",
    result.row.physical_location_sku,
  ].join("|");
}

function canonicalRows(rows) {
  return [...rows].sort((a, b) => (a.canonical_index ?? a.source_row ?? 0) - (b.canonical_index ?? b.source_row ?? 0) || String(a.internal_row_id || "").localeCompare(String(b.internal_row_id || "")));
}

function canonicalResults(results) {
  return [...results].sort((a, b) => (a.row.canonical_index ?? a.row.source_row ?? 0) - (b.row.canonical_index ?? b.row.source_row ?? 0) || String(a.id || "").localeCompare(String(b.id || "")));
}

function addIndex(index, key, row) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(row);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function issue(level, row, message) {
  return { level, row: row.source_row, internal_row_id: row.internal_row_id, message };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = `${item.level}|${item.internal_row_id}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function readinessState(errors) {
  return { ready: errors.length === 0, errors };
}

function cleanCell(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function normalizeCollectorNumber(value) {
  return cleanCell(value).replace(/^0+(?=\d)/, "").toUpperCase().replace(/\s+/g, "");
}

function parseQuantity(value) {
  if (cleanCell(value) === "") return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function normalizeRarity(value) {
  const key = norm(value);
  return RARITY_MAP.get(key) || cleanCell(value).toUpperCase();
}

function normalizeCondition(value) {
  const key = norm(value);
  if (!key) return "";
  if (key.includes("near mint") || key === "nm") return "Near Mint";
  if (key.includes("lightly played") || key === "lp") return "Lightly Played";
  if (key.includes("moderately played") || key === "mp") return "Moderately Played";
  if (key.includes("heavily played") || key === "hp") return "Heavily Played";
  if (key.includes("damaged")) return "Damaged";
  return cleanCell(value);
}

function parseConditionAndFinish(conditionValue, finishValue, hasFinishColumn) {
  const rawCondition = cleanCell(conditionValue);
  if (hasFinishColumn) return { condition: normalizeCondition(rawCondition), finish: normalizeFinish(finishValue), note: "" };
  const finishMatch = rawCondition.match(/\b(etched\s+foil|non[- ]?foil|foil)\b/i);
  if (finishMatch) {
    const conditionWithoutFinish = rawCondition.replace(finishMatch[0], "").trim().replace(/\s+/g, " ");
    const normalizedFinish = normalizeFinish(finishMatch[0]);
    return { condition: normalizeCondition(conditionWithoutFinish), finish: normalizedFinish, note: `Catalog finish parsed from Condition: ${rawCondition} -> condition ${normalizeCondition(conditionWithoutFinish)}, finish ${normalizedFinish}.` };
  }
  return { condition: normalizeCondition(rawCondition), finish: rawCondition ? "Normal" : "", note: "" };
}

function normalizeFinish(value) {
  const key = norm(value);
  if (!key) return "";
  if (key.includes("etched")) return "Etched Foil";
  if (["normal", "nonfoil", "non foil", "non-foil"].includes(key)) return "Normal";
  if (key === "foil" || key.includes(" foil")) return "Foil";
  return cleanCell(value);
}

function normalizeLanguage(value) {
  const key = norm(value);
  if (!key) return "";
  const aliases = { en: "English", eng: "English", english: "English", ja: "Japanese", jp: "Japanese", japanese: "Japanese" };
  return aliases[key] || cleanCell(value);
}

function normalizeBoxId(boxId) {
  const trimmed = cleanCell(boxId).toUpperCase();
  if (!trimmed) return "";
  const digits = trimmed.startsWith("B") ? trimmed.slice(1) : trimmed;
  return /^\d+$/.test(digits) ? `B${digits.padStart(3, "0")}` : trimmed;
}

function norm(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
