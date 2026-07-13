import React, { useMemo, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { AlertTriangle, Check, Download, FileSpreadsheet, HardDrive, Search, Upload } from "lucide-react";
import {
  FIELD_DEFINITIONS,
  chooseManualMatch,
  getMappingWarnings,
  inferMapping,
  matchBatchRows,
  normalizeBatchRow,
  normalizeInventoryRow,
  summarize,
} from "./matching.js";
import { buildCorrectedBatchRows, buildCorrectedColumns } from "./correctedExport.js";
import { DEFAULT_LOCATION_SETTINGS, assignLocationsToBatch } from "./inventoryState.js";

export default function App() {
  const [referenceImport, setReferenceImport] = useState(emptyImport("inventory"));
  const [batchImport, setBatchImport] = useState(emptyImport("batch"));
  const [referenceRows, setReferenceRows] = useState([]);
  const [batchRows, setBatchRows] = useState([]);
  const [locationSettings, setLocationSettings] = useState({
    ...DEFAULT_LOCATION_SETTINGS,
    box_id: "B001",
    starting_section_number: 1,
    cards_per_section: 100,
    use_import_sequence: true,
    regenerate_locations: false,
  });
  const [results, setResults] = useState([]);
  const [activeFilter, setActiveFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");

  const stats = useMemo(() => summarize(results, referenceRows), [results, referenceRows]);
  const filteredResults = useMemo(() => {
    const term = query.trim().toLowerCase();
    return results.filter((result) => {
      const statusMatch = activeFilter === "all" || result.audit_status === activeFilter;
      const textMatch =
        !term ||
        [result.row.card_name, result.row.collector_number, result.row.physical_location_sku, result.match_reason]
          .join(" ")
          .toLowerCase()
          .includes(term);
      return statusMatch && textMatch;
    });
  }, [activeFilter, query, results]);

  async function handleImport(kind, file) {
    if (!file) return;
    try {
      const parsed = await parseTabularFile(file, kind);
      const mapping = inferMapping(parsed.headers);
      const nextImport = {
        kind,
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows,
        mapping,
        warnings: getMappingWarnings(parsed.headers, mapping, kind),
      };
      if (kind === "inventory") {
        setReferenceImport(nextImport);
        setReferenceRows(normalizeRows("inventory", nextImport));
      } else {
        setBatchImport(nextImport);
        setBatchRows(normalizeRows("batch", nextImport));
      }
      setResults([]);
      setMessage("");
    } catch (error) {
      setMessage(error.message || String(error));
    }
  }

  function updateMapping(kind, fieldKey, column) {
    const setter = kind === "inventory" ? setReferenceImport : setBatchImport;
    setter((current) => {
      const mapping = { ...current.mapping, [fieldKey]: column };
      const next = { ...current, mapping, warnings: getMappingWarnings(current.headers, mapping, kind) };
      if (kind === "inventory") setReferenceRows(normalizeRows("inventory", next));
      else setBatchRows(normalizeRows("batch", next));
      setResults([]);
      return next;
    });
  }

  function generateLocations() {
    const assigned = assignLocationsToBatch(batchRows, [], [], locationSettings);
    setBatchRows(assigned.batchRows);
    setResults([]);
    const capacity = assigned.capacityIssues?.length || 0;
    setMessage(
      capacity
        ? `${capacity} row(s) exceed section capacity and will be red in audit.`
        : `Generated section locations for ${assigned.batchRows.filter((row) => row.location_generation_status === "generated").length} row(s).`,
    );
  }

  function runMatchAudit() {
    const nextResults = matchBatchRows(batchRows, referenceRows, {});
    setResults(nextResults);
    setActiveFilter(nextResults.some((result) => result.audit_status === "red") ? "red" : "all");
  }

  function selectMatch(resultId, candidate) {
    setResults((current) => current.map((result) => (result.id === resultId ? chooseManualMatch(result, candidate) : result)));
  }

  function exportCorrected(mode) {
    const rows = buildCorrectedBatchRows(batchImport, results, mode);
    const columns = buildCorrectedColumns(batchImport.headers);
    downloadCsv(`chrono-corrected-batch-${mode}`, rows, columns);
  }

  const readiness = {
    referenceHasIds: referenceRows.some((row) => row.tcgplayer_product_id),
    batchHasRows: batchRows.length > 0,
    batchHasNames: batchRows.some((row) => row.card_name),
    batchHasQty: batchRows.some((row) => Number(row.quantity) > 0),
  };

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Mythic Strategies</p>
          <h1>Chrono CSV Correction Tool</h1>
        </div>
      </header>

      <section className="wizard-steps">
        {["1 Upload files", "2 Confirm mappings", "3 Generate locations", "4 Match, audit, export"].map((step) => (
          <span key={step}>{step}</span>
        ))}
      </section>

      {message ? <Notice tone={message.includes("exceed") || message.includes("error") ? "error" : "warn"} text={message} /> : null}

      <section className="section-shell">
        <SectionHeader icon={<FileSpreadsheet size={20} />} title="Step 1: Upload Files" />
        <section className="workspace-grid">
          <ImportPanel
            title="TCGplayer Inventory / Reference CSV"
            description="Lookup file with TCGplayer Product IDs."
            fileName={referenceImport.fileName}
            count={referenceRows.length}
            onImport={(file) => handleImport("inventory", file)}
          />
          <ImportPanel
            title="Batch CSV"
            description="Chronological truth for the inventory being added."
            fileName={batchImport.fileName}
            count={batchRows.length}
            onImport={(file) => handleImport("batch", file)}
          />
        </section>
        <div className="status-grid compact">
          <MetricCard label="Reference has TCGplayer IDs" value={readiness.referenceHasIds ? "yes" : "no"} />
          <MetricCard label="Batch has rows" value={readiness.batchHasRows ? "yes" : "no"} />
          <MetricCard label="Batch has card names" value={readiness.batchHasNames ? "yes" : "no"} />
          <MetricCard label="Batch has quantities" value={readiness.batchHasQty ? "yes" : "no"} />
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<FileSpreadsheet size={20} />} title="Step 2: Confirm Field Mapping" />
        <div className="mapping-grid">
          <MappingTable
            title="Reference Mapping"
            kind="inventory"
            importState={referenceImport}
            onChange={(field, column) => updateMapping("inventory", field, column)}
          />
          <MappingTable title="Batch Mapping" kind="batch" importState={batchImport} onChange={(field, column) => updateMapping("batch", field, column)} />
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<HardDrive size={20} />} title="Step 3: Generate Bnnn-Snnn Locations" />
        <div className="location-form">
          <label>
            <span>Box number</span>
            <input value={locationSettings.box_id} onChange={(event) => setLocationSettings({ ...locationSettings, box_id: normalizeBoxInput(event.target.value) })} />
          </label>
          <label>
            <span>Starting section</span>
            <input type="number" min="1" value={locationSettings.starting_section_number} onChange={(event) => setLocationSettings({ ...locationSettings, starting_section_number: Number(event.target.value) })} />
          </label>
          <label>
            <span>Cards per section</span>
            <input type="number" min="1" value={locationSettings.cards_per_section} onChange={(event) => setLocationSettings({ ...locationSettings, cards_per_section: Number(event.target.value) })} />
          </label>
          <label className="check-label">
            <input type="checkbox" checked={locationSettings.use_import_sequence} onChange={(event) => setLocationSettings({ ...locationSettings, use_import_sequence: event.target.checked })} />
            <span>Use Import Sequence</span>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={!locationSettings.regenerate_locations} onChange={(event) => setLocationSettings({ ...locationSettings, regenerate_locations: !event.target.checked })} />
            <span>Preserve existing Bin values</span>
          </label>
        </div>
        <div className="button-grid">
          <button type="button" disabled={!batchRows.length} onClick={generateLocations}>
            <HardDrive size={18} />
            <span>Generate Locations</span>
          </button>
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<Check size={20} />} title="Step 4: Match, Audit, Export" />
        <div className="button-grid">
          <button type="button" disabled={!referenceRows.length || !batchRows.length} onClick={runMatchAudit}>
            <Check size={18} />
            <span>Run Match & Audit</span>
          </button>
          <button type="button" disabled={!results.length} onClick={() => exportCorrected("safe")}>
            <Download size={18} />
            <span>Export Green/Yellow Rows</span>
          </button>
          <button type="button" disabled={!results.length} onClick={() => exportCorrected("all")}>
            <Download size={18} />
            <span>Export All Rows</span>
          </button>
          <button type="button" disabled={!results.length} onClick={() => exportCorrected("errors")}>
            <Download size={18} />
            <span>Export Error/Review Rows</span>
          </button>
        </div>
        <div className="status-grid">
          <StatusButton label="Green" value={stats.green} active={activeFilter === "green"} onClick={() => setActiveFilter("green")} />
          <StatusButton label="Yellow" value={stats.yellow} active={activeFilter === "yellow"} onClick={() => setActiveFilter("yellow")} />
          <StatusButton label="Red" value={stats.red} active={activeFilter === "red"} onClick={() => setActiveFilter("red")} />
          <StatusButton label="All" value={stats.total} active={activeFilter === "all"} onClick={() => setActiveFilter("all")} />
        </div>
        <div className="review-toolbar">
          <div className="search-box">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search card, number, location, reason..." />
          </div>
        </div>
        <ReviewTable results={filteredResults} onSelect={selectMatch} />
      </section>
    </main>
  );
}

function ImportPanel({ title, description, fileName, count, onImport }) {
  return (
    <article className="import-panel">
      <div className="panel-title">
        <FileSpreadsheet size={20} />
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <label className="drop-zone">
        <Upload size={20} />
        <span>{fileName || "Choose CSV/XLSX"}</span>
        <input type="file" accept=".csv,.tsv,.xlsx,.xls" onChange={(event) => onImport(event.target.files?.[0])} />
      </label>
      <div className="import-meta">
        <strong>{count}</strong>
        <span>rows loaded</span>
      </div>
    </article>
  );
}

function MappingTable({ title, kind, importState, onChange }) {
  const fields = FIELD_DEFINITIONS.filter((field) =>
    ["card_name", "collector_number", "condition", "finish", "language", "rarity", "quantity", "listing_price", "import_sequence", "physical_location_sku", "tcgplayer_product_id", "tcgplayer_sku_id", "set_name"].includes(field.key),
  );
  const referenceFinishFromCondition = kind === "inventory" && importState.mapping.condition && !importState.mapping.finish;
  return (
    <article className="mapping-panel">
      <h3>{title}</h3>
      {referenceFinishFromCondition ? (
        <Notice
          tone="warn"
          text={`No separate finish/printing column is mapped. Chrono will parse Foil from ${importState.mapping.condition} and default non-foil rows to Normal.`}
        />
      ) : null}
      {importState.warnings.slice(0, 4).map((warning) => (
        <Notice key={`${warning.field}-${warning.message}`} tone={warning.level === "red" ? "error" : "warn"} text={warning.message} />
      ))}
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Column</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.key}>
                <td>{field.label}</td>
                <td>
                  <select value={importState.mapping[field.key] || ""} onChange={(event) => onChange(field.key, event.target.value)}>
                    <option value="">Unmapped</option>
                    {importState.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                  {field.key === "finish" && referenceFinishFromCondition ? <small className="mapping-hint">Derived from Condition: Foil becomes Foil, otherwise Normal</small> : null}
                </td>
                <td>
                  {field.key === "finish" && referenceFinishFromCondition
                    ? sampleDerivedFinishValues(importState.rows, importState.mapping.condition)
                    : sampleValues(importState.rows, importState.mapping[field.key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function ReviewTable({ results, onSelect }) {
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Row</th>
            <th>Import Seq</th>
            <th>Card</th>
            <th>#</th>
            <th>Condition</th>
            <th>Printing</th>
            <th>Qty</th>
            <th>physical_location_sku</th>
            <th>tcgplayer_product_id</th>
            <th>Matched Set</th>
            <th>Status</th>
            <th>Reason / Candidates</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.id} className={`audit-${result.audit_status}`}>
              <td>{result.row.source_row}</td>
              <td>{result.row.import_sequence}</td>
              <td>{result.row.card_name}</td>
              <td>{result.row.collector_number}</td>
              <td>{result.row.condition}</td>
              <td>{result.row.finish}</td>
              <td>{result.row.quantity}</td>
              <td>{result.row.physical_location_sku}</td>
              <td>{result.selected?.tcgplayer_product_id || ""}</td>
              <td>{result.selected?.set_name || ""}</td>
              <td>{result.audit_status}</td>
              <td>
                <div>{result.match_reason}</div>
                {!result.selected && result.candidates.length ? (
                  <div className="candidate-actions">
                    {result.candidates.slice(0, 3).map((candidate) => (
                      <button type="button" key={`${candidate.tcgplayer_product_id}-${candidate.source_row}`} onClick={() => onSelect(result.id, candidate)}>
                        {candidate.card_name} {candidate.set_name ? `(${candidate.set_name})` : ""} #{candidate.collector_number}
                      </button>
                    ))}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {!results.length ? (
            <tr>
              <td colSpan="12">No audit rows yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

async function parseTabularFile(file, kind) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv" || extension === "tsv") {
    const text = await file.text();
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      delimiter: extension === "tsv" ? "\t" : "",
    });
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    return { headers: parsed.meta.fields || [], rows: parsed.data };
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheet = workbook.Sheets[chooseSheet(workbook, kind)];
  return sheetToRows(sheet);
}

function chooseSheet(workbook, kind) {
  const preferred = kind === "inventory" ? ["tcg", "reference", "inventory", "export", "Sheet1"] : ["scan", "batch", "chrono", "Sheet1"];
  return workbook.SheetNames.find((name) => preferred.some((prefix) => name.toLowerCase().includes(prefix.toLowerCase()))) || workbook.SheetNames[0];
}

function sheetToRows(sheet) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
  const rawHeaders = [];
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    rawHeaders.push(cell?.v == null ? "" : String(cell.v).trim());
  }
  let lastHeaderIndex = rawHeaders.length - 1;
  while (lastHeaderIndex >= 0 && !rawHeaders[lastHeaderIndex]) lastHeaderIndex -= 1;
  const headers = rawHeaders.slice(0, lastHeaderIndex + 1).filter(Boolean);
  const rows = [];
  for (let rowIndex = range.s.r + 1; rowIndex <= range.e.r; rowIndex += 1) {
    const row = {};
    let hasValue = false;
    headers.forEach((header, offset) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: range.s.c + offset })];
      const value = cell?.v == null ? "" : cell.v;
      if (value !== "") hasValue = true;
      row[header] = value;
    });
    if (hasValue) rows.push(row);
  }
  return { headers, rows };
}

function normalizeRows(kind, importState) {
  const normalizer = kind === "inventory" ? normalizeInventoryRow : normalizeBatchRow;
  return importState.rows.map((row, index) => normalizer(row, importState.mapping, index, { source_file: importState.fileName }));
}

function sampleValues(rows, column) {
  if (!column) return "";
  const values = [];
  const seen = new Set();
  for (const row of rows) {
    const value = String(row[column] ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= 3) break;
  }
  return values.join(", ");
}

function sampleDerivedFinishValues(rows, conditionColumn) {
  if (!conditionColumn) return "";
  const samples = [];
  const seen = new Set();
  for (const row of rows) {
    const rawCondition = String(row[conditionColumn] ?? "").trim();
    if (!rawCondition) continue;
    const finish = /\bfoil\b/i.test(rawCondition) ? "Foil" : "Normal";
    const condition = rawCondition.replace(/\bfoil\b/gi, "").trim().replace(/\s+/g, " ") || rawCondition;
    const sample = `${rawCondition} -> ${condition} / ${finish}`;
    if (seen.has(sample)) continue;
    seen.add(sample);
    samples.push(sample);
    if (samples.length >= 3) break;
  }
  return samples.join(", ");
}

function downloadCsv(label, rows, columns) {
  const csv = Papa.unparse(rows, { columns });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${label}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function normalizeBoxInput(value) {
  const trimmed = String(value).trim().toUpperCase();
  if (!trimmed) return "B001";
  if (trimmed.startsWith("B")) return trimmed;
  return `B${trimmed.padStart(3, "0")}`;
}

function emptyImport(kind) {
  return { kind, fileName: "", headers: [], rows: [], mapping: {}, warnings: [] };
}

function StatusButton({ label, value, active, onClick }) {
  return (
    <button type="button" className={`status-button ${active ? "active" : ""}`} onClick={onClick}>
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="status-button metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SectionHeader({ icon, title }) {
  return (
    <div className="section-header">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function Notice({ tone, text }) {
  return (
    <div className={`notice ${tone}`}>
      <AlertTriangle size={18} />
      <span>{text}</span>
    </div>
  );
}
