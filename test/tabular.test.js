import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseDelimitedText, sheetToRows } from "../src/tabular.js";

test("CSV parsing preserves quoted fields and embedded commas by column position", () => {
  const parsed = parseDelimitedText('Name,Note,Qty\r\n"Fire, Ice","quoted, value",2\r\n');
  assert.deepEqual(parsed.headers, ["Name", "Note", "Qty"]);
  assert.deepEqual(parsed.rows[0], { Name: "Fire, Ice", Note: "quoted, value", Qty: "2" });
});

test("XLSX blank intermediate headers are rejected instead of shifting values", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Card Name", "", "Qty"],
    ["Armored Transport", "must not shift", 1],
  ]);
  assert.throws(() => sheetToRows(sheet), /Blank header.*column.*2/i);
});

test("XLSX duplicate headers are rejected case-insensitively", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Card Name", "card_name", "Qty"],
    ["A", "B", 1],
  ]);
  assert.throws(() => sheetToRows(sheet), /Duplicate header/i);
});

test("XLSX blank intermediate values stay in their original columns", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Card Name", "Set Name", "Qty"],
    ["A", "", 2],
  ]);
  assert.deepEqual(sheetToRows(sheet).rows[0], { "Card Name": "A", "Set Name": "", Qty: 2 });
});
