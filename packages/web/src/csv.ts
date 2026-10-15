/**
 * A small RFC 4180 CSV reader (no dependency). Pure — no DOM — so it can be exercised in
 * isolation. Handles what real exports contain: quoted fields with embedded delimiters,
 * newlines and doubled quotes; CRLF / LF / CR line endings; a UTF-8 BOM; and semicolon-,
 * tab- or pipe-separated files (spreadsheets in many locales export `;`).
 */

export type Delimiter = "," | ";" | "\t" | "|";

const CANDIDATES: Delimiter[] = [",", ";", "\t", "|"];

/** Pick the delimiter from the first non-empty record: the candidate that splits it most. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a boundary.
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      sawContent = true;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\n" || ch === "\r") {
      if (sawContent) break; // end of the first record
      continue;
    }
    if (ch !== " ") sawContent = true;
    if (ch === "," || ch === ";" || ch === "\t" || ch === "|") counts[ch]++;
  }
  let best: Delimiter = ",";
  for (const d of CANDIDATES) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * Parse delimited text into rows of trimmed cells. Blank lines are dropped. Lenient where
 * strictness would only lose data: a quote in the middle of an unquoted field is kept
 * literally, and an unterminated quote runs to the end of the input.
 */
export function parseCsv(input: string, delimiter: Delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once the current field has left its quoted section (`"a" trailing`).
  let closedQuote = false;

  const endField = () => {
    row.push(field.trim());
    field = "";
    closedQuote = false;
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !closedQuote && field.trim() === "") {
      // Opening quote (leading whitespace before it is not part of the value).
      field = "";
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  // Final record (no trailing newline).
  if (field !== "" || row.length > 0 || inQuotes) endRow();
  return rows;
}

/** Quote a cell for CSV output when it needs it. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
