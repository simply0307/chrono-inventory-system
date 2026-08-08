import Papa from "papaparse";
import * as XLSX from "xlsx";

export async function parseTabularFile(file, kind) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv" || extension === "tsv") {
    return parseDelimitedText(await file.text(), extension === "tsv" ? "\t" : "");
  }
  if (extension !== "xlsx" && extension !== "xls") throw new Error(`Unsupported file type: .${extension}`);
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  const sheetName = chooseSheet(workbook, kind);
  if (!sheetName) throw new Error("The workbook has no worksheets.");
  return sheetToRows(workbook.Sheets[sheetName]);
}

export function parseDelimitedText(text, delimiter = "") {
  const parsed = Papa.parse(text, { header: false, skipEmptyLines: "greedy", delimiter });
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  const matrix = parsed.data || [];
  if (!matrix.length) return { headers: [], rows: [] };
  return matrixToRows(matrix);
}

export function sheetToRows(sheet) {
  if (!sheet?.["!ref"]) return { headers: [], rows: [] };
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false });
  return matrixToRows(matrix);
}

export function validateHeaders(rawHeaders) {
  const headers = rawHeaders.map((value) => String(value ?? "").trim());
  const blankIndexes = headers.flatMap((header, index) => (header ? [] : [index + 1]));
  if (blankIndexes.length) throw new Error(`Blank header(s) in column(s): ${blankIndexes.join(", ")}. Headers must be explicit so values cannot shift.`);

  const seen = new Map();
  const duplicates = [];
  headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    if (seen.has(key)) duplicates.push(`${header} (columns ${seen.get(key)} and ${index + 1})`);
    else seen.set(key, index + 1);
  });
  if (duplicates.length) throw new Error(`Duplicate header(s): ${duplicates.join(", ")}. Rename them before importing.`);
  return headers;
}

function matrixToRows(inputMatrix) {
  const matrix = inputMatrix.map((row) => (Array.isArray(row) ? row : []));
  let lastUsedColumn = -1;
  for (const row of matrix) {
    row.forEach((value, index) => {
      if (String(value ?? "").trim() !== "") lastUsedColumn = Math.max(lastUsedColumn, index);
    });
  }
  if (lastUsedColumn < 0) return { headers: [], rows: [] };

  const headers = validateHeaders((matrix[0] || []).slice(0, lastUsedColumn + 1));
  const rows = [];
  for (const values of matrix.slice(1)) {
    const row = {};
    let hasValue = false;
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      if (String(value).trim() !== "") hasValue = true;
      row[header] = value;
    });
    if (hasValue) rows.push(row);
  }
  return { headers, rows };
}

function chooseSheet(workbook, kind) {
  const preferred = kind === "inventory" ? ["tcg", "reference", "inventory", "export", "sheet1"] : ["scan", "batch", "chrono", "sheet1"];
  return workbook.SheetNames.find((name) => preferred.some((prefix) => name.toLowerCase().includes(prefix))) || workbook.SheetNames[0];
}

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
