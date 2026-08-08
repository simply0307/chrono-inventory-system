import { preflightResults } from "./matching.js";

export const EXPORT_MODES = { verified: "verified", review: "review", all: "all" };

export function preflightCorrectedExport(results, catalogRows, options = {}) {
  return preflightResults(results, catalogRows, options);
}

export function buildCorrectedBatchRows(batchImport, results, mode = EXPORT_MODES.all, catalogRows = [], options = {}) {
  const normalizedMode = mode === "safe" ? EXPORT_MODES.verified : mode === "errors" ? EXPORT_MODES.review : mode;
  const checked = preflightCorrectedExport(results, catalogRows, options).results;
  const filtered = checked.filter((result) => {
    if (normalizedMode === EXPORT_MODES.verified) return result.audit_status === "green";
    if (normalizedMode === EXPORT_MODES.review) return result.audit_status !== "green";
    return true;
  });
  return filtered.map((result) => {
    const output = { ...(result.row.raw || {}) };
    const locationColumn = batchImport.mapping?.physical_location_sku;
    if (locationColumn) output[locationColumn] = result.row.physical_location_sku || "";
    output.internal_row_id = result.row.internal_row_id;
    output.physical_location_sku = result.row.physical_location_sku || "";
    output.tcgplayer_product_id = result.tcgplayer_product_id || "";
    output.tcgplayer_sku_id = result.sku_verification_status === "verified" ? result.tcgplayer_sku_id : "";
    output.suggested_tcgplayer_product_ids = result.audit_status === "green" ? "" : result.product_id_candidates.join("|");
    output.candidate_information = result.audit_status === "green" ? "" : candidateInformation(result.candidates);
    output.sku_verification_status = result.sku_verification_status;
    output.identity_fields_used = result.identity_fields_used.join("|");
    output.identity_fields_unverified = result.identity_fields_unverified.join("|");
    output.matched_set_name = result.selected?.set_name || "";
    output.match_status = result.audit_status;
    output.match_reason = result.match_reason;
    output.allocation_mode = result.allocation_mode || result.row.allocation_mode || "";
    output.allocation_box_id = result.row.allocation_starting_box || "";
    output.allocation_starting_section = result.row.allocation_starting_section || "";
    output.allocation_section_capacity = result.row.allocation_section_capacity || "";
    output.batch_language_assumption = result.batch_language_assumption || "";
    output.duplicate_in_section_count = result.duplicate_in_section_count || 1;
    output.duplicate_in_section_index = result.duplicate_in_section_index || 1;
    output.row_handling_mode = "preserve_chronological";
    output.source_row_lineage = String(result.row.source_row);
    return output;
  });
}

export function buildCorrectedColumns(originalHeaders = []) {
  const chronoColumns = [
    "internal_row_id", "physical_location_sku", "tcgplayer_product_id", "tcgplayer_sku_id", "suggested_tcgplayer_product_ids", "candidate_information",
    "sku_verification_status", "identity_fields_used", "identity_fields_unverified", "matched_set_name", "match_status", "match_reason",
    "allocation_mode", "allocation_box_id", "allocation_starting_section", "allocation_section_capacity", "batch_language_assumption",
    "duplicate_in_section_count", "duplicate_in_section_index", "row_handling_mode", "source_row_lineage",
  ];
  return [...originalHeaders, ...chronoColumns.filter((column) => !originalHeaders.includes(column))];
}

function candidateInformation(candidates = []) {
  return candidates.map((candidate) => [
    candidate.tcgplayer_product_id || "",
    candidate.tcgplayer_sku_id || "",
    candidate.card_name || "",
    candidate.set_name || "",
    candidate.collector_number || "",
    candidate.condition || "",
    candidate.finish || "",
    candidate.language || "",
  ].join("~")).join("|");
}
