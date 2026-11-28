import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain browser module
import { workbook, display, shiftFormula, toCSV, fromCSV, colName, colIndex } from "../public/drive/formula.js";

const show = (cells: Record<string, string>, ref: string, more: { name: string; cells: Record<string, string> }[] = []) => {
  const wb = workbook([{ name: "Sheet1", cells }, ...more]);
  return display(wb.value(0, ref));
};

describe("Cumulus://Spreads formulas", () => {
  it("arithmetic, precedence and text", () => {
    assert.equal(show({ A1: "=1+2*3" }, "A1"), "7");
    assert.equal(show({ A1: "=(1+2)*3" }, "A1"), "9");
    assert.equal(show({ A1: "=2^3^2" }, "A1"), "512");
    assert.equal(show({ A1: "=-2^2" }, "A1"), "-4");
    assert.equal(show({ A1: "=10/4" }, "A1"), "2.5");
    assert.equal(show({ A1: "=0.1+0.2" }, "A1"), "0.3");
    assert.equal(show({ A1: '="a"&"b"&1' }, "A1"), "ab1");
    assert.equal(show({ A1: "=50%*10" }, "A1"), "5");
    assert.equal(show({ A1: "=1/0" }, "A1"), "#DIV/0!");
    assert.equal(show({ A1: "=NOPE(1)" }, "A1"), "#NAME?");
    assert.equal(show({ A1: "=1+" }, "A1"), "#VALUE!");
  });

  it("references, ranges, sheets and cycles", () => {
    const cells = { A1: "10", A2: "20", A3: "30", B1: "=SUM(A1:A3)", B2: "=AVERAGE(A1:A3)", B3: "=A1*2+A2", C1: "=C2", C2: "=C1", D1: "hello", D2: "=COUNTA(A1:A3,D1)" };
    assert.equal(show(cells, "B1"), "60");
    assert.equal(show(cells, "B2"), "20");
    assert.equal(show(cells, "B3"), "40");
    assert.equal(show(cells, "C1"), "#CIRC!");
    assert.equal(show(cells, "D2"), "4");
    assert.equal(show({ A1: "=Data!B2*2" }, "A1", [{ name: "Data", cells: { B2: "21" } }]), "42");
    assert.equal(show({ A1: "=Missing!B2" }, "A1"), "#REF!");
    assert.equal(show({ A1: "1,234.5", A2: "=A1*2" }, "A2"), "2469");
  });

  it("functions", () => {
    const cells = { A1: "apple", B1: "3", A2: "pear", B2: "5", A3: "apple", B3: "7" };
    const f = (formula: string) => show({ ...cells, Z1: formula }, "Z1");
    assert.equal(f("=SUMIF(A1:A3,\"apple\",B1:B3)"), "10");
    assert.equal(f("=COUNTIF(B1:B3,\">4\")"), "2");
    assert.equal(f("=VLOOKUP(\"pear\",A1:B3,2,FALSE)"), "5");
    assert.equal(f("=VLOOKUP(\"kiwi\",A1:B3,2,FALSE)"), "#N/A");
    assert.equal(f("=IFERROR(VLOOKUP(\"kiwi\",A1:B3,2,FALSE),\"none\")"), "none");
    assert.equal(f("=IF(B2>4,\"big\",\"small\")"), "big");
    assert.equal(f("=IF(TRUE,1,1/0)"), "1");
    assert.equal(f("=MATCH(\"pear\",A1:A3)"), "2");
    assert.equal(f("=INDEX(B1:B3,3)"), "7");
    assert.equal(f("=ROUND(2.345,2)"), "2.35");
    assert.equal(f("=MAX(B1:B3)-MIN(B1:B3)"), "4");
    assert.equal(f("=UPPER(LEFT(A2,2))"), "PE");
    assert.equal(f("=TEXTJOIN(\", \",TRUE,A1:A3)"), "apple, pear, apple");
    assert.equal(f("=AND(B1>1,B2>1)"), "TRUE");
    assert.equal(f("=MEDIAN(B1:B3)"), "5");
  });

  it("formats, fill and CSV", () => {
    const wb = workbook([{ name: "S", cells: { A1: "0.256", A2: "1234.5" } }]);
    assert.equal(display(wb.value(0, "A1"), "pct"), "25.6%");
    assert.equal(display(wb.value(0, "A2"), "money"), "$1,234.50");
    assert.equal(shiftFormula("=A1+$B$1+B$2+\"C3\"", 1, 2), "=B3+$B$1+C$2+\"C3\"");
    assert.equal(shiftFormula("=A1", -1, 0), "=#REF!");
    assert.deepEqual(fromCSV(toCSV([["a", "b,c"], ['q"t', "x\ny"]])), [["a", "b,c"], ['q"t', "x\ny"]]);
    assert.equal(colName(0), "A");
    assert.equal(colName(27), "AB");
    assert.equal(colIndex("AB"), 27);
  });
});
