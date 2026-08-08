# Chrono CSV Correction Tool

Chrono is a local/internal tool for reconciling a newly scanned card batch to a TCGplayer catalog export, assigning section-level physical locations, auditing the result, and exporting independently preflighted rows. The browser session is temporary; Chrono is not a persistent inventory ledger.

## Inputs and authority boundaries

Chrono keeps three inputs distinct:

1. **Catalog/reference** — supplies Product IDs and catalog metadata. Catalog quantity and location columns are ignored for physical allocation.
2. **New batch** — supplies the cards being processed. Blank locations are expected before allocation.
3. **Existing physical inventory (optional)** — supplies current locations and quantities only when append mode is selected.

The identifiers are also separate:

- `physical_location_sku`: Mythic Strategies storage location, such as `B001-S001`.
- `tcgplayer_product_id`: TCGplayer product/card identifier.
- `tcgplayer_sku_id`: TCGplayer listing-variant identifier, populated only when verified by authoritative catalog data.

A generic `SKU` column is never guessed to be either identifier.

## Ordered workflow

1. Import files and confirm schema mappings.
2. Reconcile product identity.
3. Explicitly select and confirm an allocation mode and settings.
4. Allocate locations, then run the post-allocation audit.
5. Export rows only after an independent preflight.

Location allocation never starts until the user chooses one of these modes:

- **New/empty** — starts from the confirmed box and section and ignores all catalog quantity/location data.
- **Append to existing** — requires a separate physical-inventory file with valid positive quantities and canonical `Bnnn-Snnn` locations.

The selected mode, box, starting section, and capacity are recorded in audited/exported rows. `Import Sequence` may control allocation only when every value is a unique positive integer; allocation order never changes canonical output order.

## Product matching and SKU verification

Green identity means the mutually available reliable fields have no contradictions and leave exactly one Product ID. Matching begins with normalized card name and collector number, then uses condition, finish, set name/code, language, product line, rarity, and supplied identifiers whenever each field exists on both sides.

Missing batch set or language is not itself a contradiction. A row may still be green when the remaining exact fields identify one Product ID. An optional batch-wide language assumption can be applied and is recorded in every affected result. Blank fields are reported as unverified; they are never counted as agreements.

SKU authority is separate from Product-ID authority:

- `verified`: one authoritative SKU variant is proven.
- `unavailable`: the catalog has no SKU authority or multiple SKU variants remain. The Product ID may still be green and exported with a blank SKU ID.
- `conflict`: a supplied SKU contradicts the catalog; the row is red.

Fuzzy/name-only candidates and manual choices remain yellow review aids. Conflicting mutually available fields, invalid quantity, no candidate, and allocation errors are red.

## Location and audit protections

- Quantity consumes section capacity; a row is never split across sections.
- A row larger than capacity remains unassigned and becomes red after allocation.
- Preserved locations must be canonical, in the confirmed box, and capacity-safe.
- Repeated Product ID / SKU-status / physical-section rows are allowed and remain separate chronological rows by default. `duplicate_in_section_count` and `duplicate_in_section_index` are informational only.
- Original columns and canonical row order are preserved. Chrono columns are appended.
- Verified export reruns identity matching and post-allocation checks independently instead of trusting the displayed color.

## Foil encoded in Condition

When a catalog has no separate finish column, Chrono parses explicit finish text from Condition, for example `Near Mint Foil` into condition `Near Mint` and finish `Foil`. Nonfoil, foil, and etched foil remain distinct.

## Run and verify

```powershell
pnpm install
pnpm dev
pnpm test
pnpm build
```
