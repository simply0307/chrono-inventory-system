import React, { useMemo, useState } from "react";
import Papa from "papaparse";
import { AlertTriangle, Check, Download, FileSpreadsheet, HardDrive, Search, Upload } from "lucide-react";
import {
  FIELD_DEFINITIONS,
  assessReadiness,
  auditPostAllocationResults,
  chooseManualMatch,
  getMappingWarnings,
  inferMapping,
  matchBatchRows,
  normalizeBatchRow,
  normalizeInventoryRow,
  normalizePhysicalInventoryRow,
  summarize,
} from "./matching.js";
import { buildCorrectedBatchRows, buildCorrectedColumns } from "./correctedExport.js";
import { DEFAULT_LOCATION_SETTINGS, assignLocationsToBatch } from "./inventoryState.js";
import { parseTabularFile } from "./tabular.js";

export default function App() {
  const [referenceImport, setReferenceImport] = useState(emptyImport("inventory"));
  const [batchImport, setBatchImport] = useState(emptyImport("batch"));
  const [physicalInventoryImport, setPhysicalInventoryImport] = useState(emptyImport("physical_inventory"));
  const [referenceRows, setReferenceRows] = useState([]);
  const [batchRows, setBatchRows] = useState([]);
  const [physicalInventoryRows, setPhysicalInventoryRows] = useState([]);
  const [locationSettings, setLocationSettings] = useState({
    ...DEFAULT_LOCATION_SETTINGS,
    allocation_mode: "",
    settings_confirmed: false,
  });
  const [identityOptions, setIdentityOptions] = useState({ batch_language_assumption: "" });
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
  const readiness = useMemo(
    () => assessReadiness({ referenceImport, batchImport, physicalInventoryImport, referenceRows, batchRows, physicalInventoryRows, results, locationSettings, identityOptions }),
    [referenceImport, batchImport, physicalInventoryImport, referenceRows, batchRows, physicalInventoryRows, results, locationSettings, identityOptions],
  );

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
      } else if (kind === "batch") {
        setBatchImport(nextImport);
        setBatchRows(normalizeRows("batch", nextImport));
      } else {
        setPhysicalInventoryImport(nextImport);
        setPhysicalInventoryRows(normalizeRows("physical_inventory", nextImport));
      }
      setResults([]);
      setMessage("");
    } catch (error) {
      setMessage(error.message || String(error));
    }
  }

  function updateMapping(kind, fieldKey, column) {
    const setter = kind === "inventory" ? setReferenceImport : kind === "batch" ? setBatchImport : setPhysicalInventoryImport;
    setter((current) => {
      const mapping = { ...current.mapping, [fieldKey]: column };
      const next = { ...current, mapping, warnings: getMappingWarnings(current.headers, mapping, kind) };
      if (kind === "inventory") setReferenceRows(normalizeRows("inventory", next));
      else if (kind === "batch") setBatchRows(normalizeRows("batch", next));
      else setPhysicalInventoryRows(normalizeRows("physical_inventory", next));
      setResults([]);
      return next;
    });
  }

  function generateLocations() {
    const assigned = assignLocationsToBatch(batchRows, physicalInventoryRows, [], locationSettings);
    setBatchRows(assigned.batchRows);
    setResults([]);
    if (assigned.blocked) {
      const reasons = [...(assigned.sequenceIssues || []), ...(assigned.existingInventoryIssues || [])];
      const detail = reasons.length ? reasons.map((item) => `row ${item.source_row} ${item.message}`).join("; ") : assigned.batchRows[0]?.location_allocation_error;
      setMessage(`Location allocation blocked: ${detail || "invalid or unconfirmed allocation settings"}`);
      return;
    }
    const identity = matchBatchRows(assigned.batchRows, referenceRows, identityOptions);
    setResults(auditPostAllocationResults(identity, referenceRows, { allocationSettings: locationSettings, existingInventoryRows: physicalInventoryRows }));
    const capacity = assigned.capacityIssues?.length || 0;
    setMessage(
      capacity
        ? `${capacity} row(s) exceed section capacity and will be red in audit.`
        : `Generated section locations for ${assigned.batchRows.filter((row) => row.location_generation_status === "generated").length} row(s).`,
    );
  }

  function runIdentityReconciliation() {
    if (!readiness.importSchema.ready || !readiness.identityReconciliation.ready) {
      setMessage("Identity reconciliation is blocked until import/schema readiness passes.");
      return;
    }
    const nextResults = matchBatchRows(batchRows, referenceRows, identityOptions);
    setResults(nextResults);
    setActiveFilter(nextResults.some((result) => result.audit_status === "red") ? "red" : "all");
  }

  function runPostAllocationAudit() {
    const identity = matchBatchRows(batchRows, referenceRows, identityOptions);
    const audited = auditPostAllocationResults(identity, referenceRows, { allocationSettings: locationSettings, existingInventoryRows: physicalInventoryRows });
    setResults(audited);
    setActiveFilter(audited.some((result) => result.audit_status === "red") ? "red" : "all");
  }

  function selectMatch(resultId, candidate) {
    setResults((current) => current.map((result) => (result.id === resultId ? chooseManualMatch(result, candidate, identityOptions) : result)));
  }

  function exportCorrected(mode) {
    const rows = buildCorrectedBatchRows(batchImport, results, mode, referenceRows, { identityOptions, allocationSettings: locationSettings, existingInventoryRows: physicalInventoryRows });
    if (mode === "verified" && !rows.length) {
      setMessage("Verified export blocked: independent preflight found zero green rows.");
      return;
    }
    const columns = buildCorrectedColumns(batchImport.headers);
    const name = mode === "verified" ? "verified-tcgtracking-upload" : "review-required";
    downloadCsv(name, rows, columns);
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Mythic Strategies</p>
          <h1>Chrono CSV Correction Tool</h1>
        </div>
      </header>

      <section className="wizard-steps">
        {["1 Upload inputs", "2 Confirm mappings", "3 Reconcile identity", "4 Allocate locations", "5 Audit and export"].map((step) => (
          <span key={step}>{step}</span>
        ))}
      </section>

      {message ? <Notice tone={message.includes("exceed") || message.includes("error") ? "error" : "warn"} text={message} /> : null}

      <section className="section-shell">
        <SectionHeader icon={<FileSpreadsheet size={20} />} title="Step 1: Upload Files" />
        <section className="workspace-grid">
          <ImportPanel
            title="TCGplayer Catalog / Reference"
            description="Catalog metadata and Product IDs only; never physical inventory state."
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
          <ImportPanel
            title="Existing Physical Inventory (optional)"
            description="Used only in Append mode; requires valid locations and quantities."
            fileName={physicalInventoryImport.fileName}
            count={physicalInventoryRows.length}
            onImport={(file) => handleImport("physical_inventory", file)}
          />
        </section>
        <div className="status-grid compact">
          <MetricCard label="Import/schema" value={readiness.importSchema.ready ? "ready" : "blocked"} />
          <MetricCard label="Identity reconciliation" value={readiness.identityReconciliation.ready ? "ready" : "blocked"} />
          <MetricCard label="Allocation mode" value={readiness.allocationMode.ready ? "ready" : "blocked"} />
          <MetricCard label="Post-allocation audit" value={readiness.postAllocationAudit.ready ? "ready" : "blocked"} />
          <MetricCard label="Export" value={readiness.exportReadiness.ready ? `${readiness.verifiedCount} ready` : "blocked"} />
        </div>
        {referenceImport.fileName || batchImport.fileName ? <ReadinessNotices readiness={readiness} /> : null}
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
          {physicalInventoryImport.fileName ? <MappingTable title="Physical Inventory Mapping" kind="physical_inventory" importState={physicalInventoryImport} onChange={(field, column) => updateMapping("physical_inventory", field, column)} /> : null}
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<Check size={20} />} title="Step 3: Reconcile Catalog Product IDs" />
        <label>
          <span>Batch-wide language assumption (optional)</span>
          <select value={identityOptions.batch_language_assumption} onChange={(event) => { setIdentityOptions({ batch_language_assumption: event.target.value }); setResults([]); }}>
            <option value="">No assumption</option>
            <option value="English">English</option>
            <option value="Japanese">Japanese</option>
          </select>
        </label>
        {readiness.capabilityNotices.map((notice) => <Notice key={notice} tone="warn" text={notice} />)}
        <div className="button-grid">
          <button type="button" disabled={!readiness.identityReconciliation.ready} onClick={runIdentityReconciliation}>
            <Check size={18} />
            <span>Run Identity Reconciliation</span>
          </button>
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<HardDrive size={20} />} title="Step 4: Allocate Bnnn-Snnn Locations" />
        <div className="location-form">
          <label>
            <span>Allocation mode</span>
            <select value={locationSettings.allocation_mode} onChange={(event) => setLocationSettings({ ...locationSettings, allocation_mode: event.target.value, settings_confirmed: false })}>
              <option value="">Select mode</option>
              <option value="new_empty">New/empty allocation</option>
              <option value="append_existing">Append to existing inventory</option>
            </select>
          </label>
          <label>
            <span>Box number</span>
            <input value={locationSettings.box_id} onChange={(event) => setLocationSettings({ ...locationSettings, box_id: normalizeBoxInput(event.target.value), settings_confirmed: false })} />
          </label>
          <label>
            <span>Starting section</span>
            <input type="number" min="1" value={locationSettings.starting_section_number} onChange={(event) => setLocationSettings({ ...locationSettings, starting_section_number: Number(event.target.value), settings_confirmed: false })} />
          </label>
          <label>
            <span>Cards per section</span>
            <input type="number" min="1" value={locationSettings.cards_per_section} onChange={(event) => setLocationSettings({ ...locationSettings, cards_per_section: Number(event.target.value), settings_confirmed: false })} />
          </label>
          <label className="check-label">
            <input type="checkbox" checked={locationSettings.use_import_sequence} onChange={(event) => setLocationSettings({ ...locationSettings, use_import_sequence: event.target.checked, settings_confirmed: false })} />
            <span>Use Import Sequence</span>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={!locationSettings.regenerate_locations} onChange={(event) => setLocationSettings({ ...locationSettings, regenerate_locations: !event.target.checked, settings_confirmed: false })} />
            <span>Preserve existing Bin values</span>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={locationSettings.settings_confirmed} onChange={(event) => setLocationSettings({ ...locationSettings, settings_confirmed: event.target.checked })} />
            <span>I confirm the mode, Box, starting Section, and capacity</span>
          </label>
        </div>
        <div className="button-grid">
          <button type="button" disabled={!readiness.allocationMode.ready} onClick={generateLocations}>
            <HardDrive size={18} />
            <span>Generate Locations</span>
          </button>
        </div>
      </section>

      <section className="section-shell">
        <SectionHeader icon={<Check size={20} />} title="Step 5: Post-Allocation Audit and Export" />
        <Notice tone="warn" text="Chrono preserves every chronological source row and repeated Product ID. Confirm TCGtracking upload compatibility against an authentic accepted template before using the verified file." />
        <div className="button-grid">
          <button type="button" disabled={!batchRows.length || !batchRows.every((row) => row.allocation_mode)} onClick={runPostAllocationAudit}>
            <Check size={18} />
            <span>Run Post-Allocation Audit</span>
          </button>
          <button type="button" disabled={!readiness.exportReadiness.ready} onClick={() => exportCorrected("verified")}>
            <Download size={18} />
            <span>Verified TCGtracking Upload</span>
          </button>
          <button type="button" disabled={!readiness.postAllocationAudit.ready} onClick={() => exportCorrected("review")}>
            <Download size={18} />
            <span>Review Required</span>
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
    ["product_line", "card_name", "set_name", "set_code", "collector_number", "condition", "finish", "language", "rarity", "quantity", "listing_price", "import_sequence", "physical_location_sku", "box_id", "section_number", "tcgplayer_product_id", "tcgplayer_sku_id"].includes(field.key),
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
      {importState.warnings.map((warning) => (
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
            <th>tcgplayer_sku_id</th>
            <th>SKU verification</th>
            <th>Allocation mode</th>
            <th>Copies in section</th>
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
              <td>{result.tcgplayer_product_id || result.row.tcgplayer_product_id || ""}</td>
              <td>{result.sku_verification_status === "verified" ? result.tcgplayer_sku_id : ""}</td>
              <td>{result.sku_verification_status}</td>
              <td>{result.allocation_mode || result.row.allocation_mode || ""}</td>
              <td>{result.duplicate_in_section_count || 1}</td>
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
              <td colSpan="16">No audit rows yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function normalizeRows(kind, importState) {
  const normalizer = kind === "inventory" ? normalizeInventoryRow : kind === "physical_inventory" ? normalizePhysicalInventoryRow : normalizeBatchRow;
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
    const finishToken = rawCondition.match(/\b(etched\s+foil|non[- ]?foil|foil)\b/i)?.[0] || "";
    const finish = /etched/i.test(finishToken) ? "Etched Foil" : /non/i.test(finishToken) || !finishToken ? "Normal" : "Foil";
    const condition = rawCondition.replace(finishToken, "").trim().replace(/\s+/g, " ") || rawCondition;
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

function ReadinessNotices({ readiness }) {
  const checks = [
    ["Import/schema", readiness.importSchema],
    ["Identity reconciliation", readiness.identityReconciliation],
    ["Allocation mode", readiness.allocationMode],
    ["Post-allocation audit", readiness.postAllocationAudit],
    ["Export", readiness.exportReadiness],
  ];
  return checks.flatMap(([label, check]) => check.ready ? [] : check.errors.slice(0, 3).map((error, index) => (
    <Notice key={`${label}-${index}-${error}`} tone="error" text={`${label} blocked: ${error}`} />
  )));
}
