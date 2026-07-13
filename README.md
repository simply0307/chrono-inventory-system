# Chrono CSV Correction Tool

Chrono is a simple local/internal CSV tool for Mythic Strategies. It helps correct a new card batch by matching rows against a TCGplayer inventory/reference export, generating section-level physical locations, auditing risky rows, and exporting a corrected batch CSV.

Chrono is not currently a source-of-truth inventory database. It does not keep a canonical inventory ledger, apply batches, roll back imports, remember manual matches, or store state in IndexedDB/localStorage. The browser session is temporary; exported CSVs are the output.

## Workflow

1. Upload a TCGplayer inventory/reference CSV or spreadsheet.
2. Upload a batch CSV or spreadsheet.
3. Confirm field mappings.
4. Generate section locations in `Bnnn-Snnn` format.
5. Run match/audit.
6. Review yellow/red rows and optionally choose a candidate for the current session.
7. Export a corrected batch CSV.

## Output

Chrono preserves the original batch columns and fills or appends:

- `Bin` or the detected physical location column
- `physical_location_sku`
- `tcgplayer_product_id`
- `tcgplayer_sku_id`
- `matched_set_name`
- `match_status`
- `match_reason`

## Important Field Separation

Keep these identities separate:

- `physical_location_sku`: Mythic Strategies storage location, such as `B001-S001`.
- `tcgplayer_product_id`: TCGplayer product/card identifier.
- `tcgplayer_sku_id`: TCGplayer listing variant identifier when available.

Never treat a physical location SKU as a TCGplayer SKU ID.

## Location Generation

Chrono generates section-level locations:

```text
B001-S001
B001-S002
B001-S003
```

Multiple cards can share the same section location. Duplicate `physical_location_sku` values are allowed because a section can contain more than one card row.

Rules:

- `Qty` consumes section capacity.
- If a row would cross a section boundary, Chrono moves the whole row to the next section.
- If one row has `Qty` greater than `cards_per_section`, Chrono flags it red for manual handling.
- Existing `Bin` values are preserved unless regeneration is selected.
- `Import Sequence` can drive chronological assignment.

## Matching

Chrono normalizes:

- card name
- set name/code when available
- collector number
- rarity
- condition
- finish/printing
- language
- quantity

Primary match fields are card name, collector number, condition, finish, language, rarity, and set name/code when present.

## Foil In Condition

Some TCGplayer exports embed finish in `Condition` instead of providing a separate `Printing` or `Finish` column.

When the reference file has no finish/printing column, Chrono parses:

- `Near Mint Foil` -> condition `Near Mint`, finish `Foil`
- `Lightly Played Foil` -> condition `Lightly Played`, finish `Foil`
- `Near Mint` -> condition `Near Mint`, finish `Normal`
- `Moderately Played` -> condition `Moderately Played`, finish `Normal`

A batch row with `Condition = Near Mint` and `Printing = Foil` can match a reference row with `Condition = Near Mint Foil`.

Audit reasons include this when it matters:

```text
Reference finish parsed from Condition: Near Mint Foil -> condition Near Mint, finish Foil.
```

## Audit Status

- Green: clear match and export-ready.
- Yellow: possible match or review needed.
- Red: blocked because required data is missing, no match was found, quantity is invalid, or section capacity is exceeded.

Yellow manual candidate choices only affect the current browser session and the current export. Chrono does not remember them after reload.

## Readiness Language

Chrono separates readiness into:

- Schema readiness: expected columns exist.
- Data readiness: those columns contain usable values.
- Clean export readiness: there is enough usable data to safely produce the corrected batch.

Examples:

- A file with headers and zero rows is schema-ready but data-not-ready.
- A batch with a `Bin` column where every value is blank has the physical location field present, but physical location data is not ready.
- A populated batch without generated or existing locations is blocked for clean export until locations are filled.

## Current Test Files

For `TCGplayer__Pricing_Custom_Export_20260705_092817.csv`:

- Schema readiness: mostly ready.
- Data readiness: not ready because the file has headers but zero product rows.
- Clean export readiness: blocked because there are no TCGplayer IDs or reference rows to match.

For `Scan & Identify - Matched to Catalog Export - 20260705.csv`:

- Schema readiness: ready.
- Data readiness: partially ready because it has batch rows.
- Clean export readiness: blocked until locations are generated because the physical location field was detected as `Bin`, but all `Bin` values are blank.

## Run Locally

```powershell
pnpm install
pnpm dev
```

## Verify

```powershell
pnpm test
pnpm build
```
