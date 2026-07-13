export function buildCorrectedBatchRows(batchImport, results, mode = "all") {
  const selected = results.filter((result) => {
    if (mode === "all") return true;
    if (mode === "errors") return result.audit_status !== "green";
    return result.audit_status !== "red";
  });

  return selected.map((result) => {
    const output = { ...(result.row.raw || {}) };
    const binColumn = batchImport.mapping?.physical_location_sku || "Bin";
    output[binColumn] = result.row.physical_location_sku || "";
    output.physical_location_sku = result.row.physical_location_sku || "";
    output.tcgplayer_product_id = result.selected?.tcgplayer_product_id || "";
    output.tcgplayer_sku_id = result.selected?.tcgplayer_sku_id || "";
    output.matched_set_name = result.selected?.set_name || "";
    output.match_status = result.audit_status;
    output.match_reason = result.match_reason;
    return output;
  });
}

export function buildCorrectedColumns(originalHeaders = []) {
  return [
    ...new Set([
      ...originalHeaders,
      "physical_location_sku",
      "tcgplayer_product_id",
      "tcgplayer_sku_id",
      "matched_set_name",
      "match_status",
      "match_reason",
    ]),
  ];
}
