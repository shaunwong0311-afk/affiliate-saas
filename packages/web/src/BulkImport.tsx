import { useDeferredValue, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { api, errorMessage, errorStatus, num } from "./api";
import { Badge, Card, ErrorBanner, Field, Notice, humanize } from "./ui";
import { parseCsv } from "./csv";
import { saveText } from "./download";
import {
  emptyUploadSummary,
  fieldsFor,
  guessMapping,
  looksLikeHeader,
  positionalMapping,
  prepareProspectRows,
  prepareRosterRows,
  templateHeader,
  uploadRows,
  type ImportKind,
  type PreparedRow,
  type ProspectRow,
  type ReadyRow,
  type RosterRow,
  type UploadSummary,
} from "./importRows";

/**
 * Bulk import from a pasted or uploaded CSV — prospects (Recruitment) or the existing
 * affiliate roster (Affiliates). Three steps on one panel: load the data, check the
 * preview (every row says whether it will be sent and, if not, why), import.
 *
 * The API validates a whole request at once and reports aggregate counts, so this panel
 * does the per-row work: rows that would fail are held back with the reason, the rest
 * go up in batches, and anything the server still refuses is listed by line number.
 */

type Row = ProspectRow | RosterRow;
type Ready = ReadyRow<Row>;
type Summary = UploadSummary;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
/** Above this, a loaded file is summarised instead of echoed into the textarea. */
const INLINE_TEXT_LIMIT = 200_000;
const PREVIEW_ROWS = 100;

type Run =
  | { phase: "idle" }
  | { phase: "sending"; done: number; total: number }
  | { phase: "finished"; summary: Summary; excluded: number }
  | { phase: "stopped"; summary: Summary; excluded: number; error: string; remaining: Ready[] };

interface Copy {
  title: string;
  sub: string;
  endpoint: string;
  columns: ReactNode;
  required: string;
  after: string;
  counts: Record<string, { label: string; kind: string; hint: string }>;
}

const COPY: Record<ImportKind, Copy> = {
  prospects: {
    title: "Import prospects",
    sub: "a list of creators you already want to reach — they join the queue as real prospects",
    endpoint: "/recruitment/prospects/import",
    columns: (
      <>
        <span className="mono acc">name</span> plus at least one of <span className="mono acc">email</span>,{" "}
        <span className="mono acc">siteUrl</span> or <span className="mono acc">channelUrl</span>; <span className="mono acc">notes</span> is optional.
      </>
    ),
    required: "Choose the Name column and at least one of Email, Website or Channel.",
    after: "Someone already in your queue is matched, not duplicated — so importing the same file twice is safe.",
    counts: {
      imported: { label: "New prospects", kind: "pos", hint: "added to your queue" },
      merged: { label: "Already known", kind: "info", hint: "matched an existing prospect" },
      skipped: { label: "Skipped by the server", kind: "warn", hint: "no usable identifier" },
    },
  },
  roster: {
    title: "Import your affiliate roster",
    sub: "the affiliates you already work with, e.g. an export from your previous platform",
    endpoint: "/recruitment/affiliates/import",
    columns: (
      <>
        <span className="mono acc">name</span> and <span className="mono acc">email</span>; <span className="mono acc">siteUrl</span> and{" "}
        <span className="mono acc">revenue</span> (what they have produced so far, e.g. 1250.00) are optional.
      </>
    ),
    required: "Choose the Name and Email columns.",
    after:
      "Each person becomes an active affiliate on your program, and the recruitment engine will not cold-email that address. No welcome email is sent. Importing the same file twice is safe.",
    counts: {
      created: { label: "Affiliates added", kind: "pos", hint: "new on your roster" },
      existing: { label: "Already on your roster", kind: "info", hint: "left as they were" },
      skipped: { label: "Skipped by the server", kind: "warn", hint: "could not be added" },
    },
  },
};

function cleanSource(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function BulkImport({
  kind,
  onClose,
  onImported,
  onEnriched,
  blocked,
}: {
  kind: ImportKind;
  onClose: () => void;
  /** Rows reached the API (fully or in part) — refresh whatever list is on screen. The
   *  totals so far say whether anything new was added. */
  onImported: (summary: UploadSummary) => void;
  /** Prospects only: the "enrich & score now" action finished, so the new rows are scored. */
  onEnriched?: () => void;
  /** When set, importing cannot work yet (e.g. no program to attach a roster to). */
  blocked?: ReactNode;
}) {
  const copy = COPY[kind];
  const fields = fieldsFor(kind);

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  // The user's own header/mapping choice, valid only for the data it was made on.
  const [override, setOverride] = useState<{ signature: string; hasHeader: boolean; mapping: string[] } | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [backlog, setBacklog] = useState<{ busy: boolean; note: string | null; error: string | null }>({ busy: false, note: null, error: null });
  const fileInput = useRef<HTMLInputElement>(null);

  // Parsing is the expensive part; keep typing in the textarea responsive.
  const deferredText = useDeferredValue(text);
  const table = useMemo(() => parseCsv(deferredText), [deferredText]);
  const columnCount = useMemo(() => table.reduce((max, row) => Math.max(max, row.length), 0), [table]);
  const signature = `${columnCount}:${(table[0] ?? []).join("\u0001")}`;

  // Recomputed only when the header line or the column count changes (that is what
  // `signature` captures) — not on every edit further down the data.
  const auto = useMemo(() => {
    const first = table[0] ?? [];
    const hasHeader = looksLikeHeader(first, fields);
    const mapping = hasHeader ? guessMapping(padTo(first, columnCount), fields) : positionalMapping(columnCount, kind);
    return { hasHeader, mapping };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, kind]);

  const active = override && override.signature === signature ? override : auto;
  const { hasHeader, mapping } = active;
  const dataRows = useMemo(() => (hasHeader ? table.slice(1) : table), [table, hasHeader]);
  const firstLine = hasHeader ? 2 : 1;

  const prepared = useMemo<PreparedRow<Row>[]>(
    () => (kind === "prospects" ? prepareProspectRows(dataRows, mapping, firstLine) : prepareRosterRows(dataRows, mapping, firstLine)),
    [kind, dataRows, mapping, firstLine],
  );

  const ready = useMemo<Ready[]>(() => prepared.filter((r) => r.value !== null).map((r) => ({ line: r.line, value: r.value as Row })), [prepared]);
  const excludedCount = prepared.length - ready.length;
  const warnedCount = prepared.filter((r) => r.value !== null && r.issues.length > 0).length;
  const tooMany = dataRows.length > MAX_ROWS;

  const mapped = (key: string) => mapping.includes(key);
  const mappingComplete = kind === "prospects" ? mapped("name") && (mapped("email") || mapped("siteUrl") || mapped("channelUrl")) : mapped("name") && mapped("email");

  const busy = run.phase === "sending";
  const hasData = table.length > 0;

  // ---- loading data ---------------------------------------------------------

  function reset() {
    setText("");
    setFileName(null);
    setLoadError(null);
    setOverride(null);
    setOnlyProblems(false);
    setRun({ phase: "idle" });
    setBacklog({ busy: false, note: null, error: null });
    if (fileInput.current) fileInput.current.value = "";
  }

  async function loadFile(file: File | undefined | null) {
    if (!file) return;
    setLoadError(null);
    if (/\.(xlsx?|numbers|ods)$/i.test(file.name)) {
      setLoadError(`"${file.name}" is a spreadsheet file. Export it as CSV first (File → Download / Save as → CSV), then choose that file.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setLoadError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. Import files of up to 5 MB — split it into parts.`);
      return;
    }
    try {
      const content = await file.text();
      if (content.includes("\u0000")) {
        setLoadError(`"${file.name}" does not look like a text file. Export your list as CSV and try again.`);
        return;
      }
      setRun({ phase: "idle" });
      setOverride(null);
      setFileName(file.name);
      setText(content);
    } catch {
      setLoadError(`Could not read "${file.name}".`);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the control so choosing the SAME file again (after fixing it) fires a change.
    e.target.value = "";
    void loadFile(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    void loadFile(e.dataTransfer.files?.[0]);
  }

  // ---- mapping --------------------------------------------------------------

  function setHasHeader(next: boolean) {
    const first = table[0] ?? [];
    setOverride({ signature, hasHeader: next, mapping: next ? guessMapping(padTo(first, columnCount), fields) : positionalMapping(columnCount, kind) });
  }

  function setColumn(index: number, key: string) {
    // A field belongs to one column: choosing it here releases it anywhere else.
    const next = mapping.map((current, i) => (i === index ? key : key !== "" && current === key ? "" : current));
    setOverride({ signature, hasHeader, mapping: next });
  }

  // ---- upload ---------------------------------------------------------------

  async function send(rows: Ready[], base: Summary, excluded: number) {
    setRun({ phase: "sending", done: 0, total: rows.length });
    setBacklog({ busy: false, note: null, error: null });
    const label = kind === "prospects" ? cleanSource(source) : "";
    // Batching, the per-row 400 handling and the "what was not sent" bookkeeping live in
    // uploadRows (importRows.ts); this only maps its outcome onto the panel.
    const outcome = await uploadRows<Row>({
      rows,
      base,
      send: (batch) => api.post<unknown>(copy.endpoint, { rows: batch, ...(label ? { source: label } : {}) }),
      onProgress: (done, total) => setRun({ phase: "sending", done, total }),
    });
    if (outcome.status === "stopped") {
      setRun({ phase: "stopped", summary: outcome.summary, excluded, error: describeFailure(outcome.error), remaining: outcome.remaining });
    } else {
      setRun({ phase: "finished", summary: outcome.summary, excluded });
    }
    // Refresh the page's list as soon as anything went in — also after a partial upload.
    if (outcome.summary.accepted > base.accepted) onImported(outcome.summary);
  }

  async function processBacklog() {
    setBacklog({ busy: true, note: null, error: null });
    try {
      const r = await api.post<{ enriched?: number; scored?: number } | null>("/recruitment/process-backlog", {});
      setBacklog({ busy: false, note: `Enriched ${num(r?.enriched ?? 0)} and scored ${num(r?.scored ?? 0)} prospects.`, error: null });
      onEnriched?.();
    } catch (e) {
      setBacklog({ busy: false, note: null, error: errorMessage(e, "Could not run enrichment.") });
    }
  }

  // ---- render ---------------------------------------------------------------

  const summary = run.phase === "finished" || run.phase === "stopped" ? run.summary : null;
  const showFileChip = fileName !== null && text.length > INLINE_TEXT_LIMIT;

  return (
    <div className="import-panel">
      <Card
        title={copy.title}
        sub={copy.sub}
        actions={
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
            ✕ Close
          </button>
        }
      >
        {blocked ? (
          <Notice kind="warn">{blocked}</Notice>
        ) : summary && run.phase === "finished" ? (
          <ResultView
            kind={kind}
            copy={copy}
            summary={summary}
            excluded={run.excluded}
            backlog={backlog}
            onProcessBacklog={processBacklog}
            onAnother={reset}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="import-steps mono">
              <span className={hasData ? "done" : "on"}>1 · LOAD</span>
              <span className={hasData && run.phase === "idle" ? "on" : ""}>2 · CHECK</span>
              <span className={busy || run.phase === "stopped" ? "on" : ""}>3 · IMPORT</span>
            </div>

            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
              Columns: {copy.columns} A header row is detected automatically and you can re-assign any column below.{" "}
              <a
                href="#"
                className="acc"
                style={{ textDecoration: "underline" }}
                onClick={(e) => {
                  e.preventDefault();
                  saveText(`${templateHeader(kind)}\n`, kind === "prospects" ? "vantage-prospects-template.csv" : "vantage-affiliate-roster-template.csv");
                }}
              >
                Download a blank template
              </a>
            </p>

            {loadError && <ErrorBanner message={loadError} />}

            <div
              className={`dropzone${dragging ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={onPick} hidden />
              <button type="button" className="btn sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                ⇪ Choose a CSV file
              </button>
              <span className="faint" style={{ fontSize: 12 }}>
                or drop it here · or paste rows below · up to 5 MB / {num(MAX_ROWS)} rows
              </span>
            </div>

            {showFileChip ? (
              <div className="row gap-8 mt-8" style={{ fontSize: 13 }}>
                <Badge kind="info">{fileName}</Badge>
                <span className="muted">{num(table.length)} lines loaded</span>
              </div>
            ) : (
              <textarea
                className="input mono mt-8"
                rows={hasData ? 4 : 6}
                spellCheck={false}
                disabled={busy}
                value={text}
                placeholder={`${templateHeader(kind)}\n…paste your rows here (comma, semicolon or tab separated)`}
                onChange={(e) => {
                  setText(e.target.value);
                  setFileName(null);
                  if (run.phase !== "idle") setRun({ phase: "idle" });
                }}
                style={{ fontSize: 12, resize: "vertical" }}
              />
            )}

            {hasData && (
              <>
                <div className="row wrap gap-8 mt-16" style={{ alignItems: "center" }}>
                  <Badge kind={ready.length > 0 ? "pos" : ""}>{num(ready.length)} ready to import</Badge>
                  {excludedCount > 0 && <Badge kind="neg">{num(excludedCount)} left out</Badge>}
                  {warnedCount > 0 && <Badge kind="warn">{num(warnedCount)} with a value dropped</Badge>}
                  <span className="spacer" />
                  <label className="row gap-8 muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
                    <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} disabled={busy} />
                    first line is a header
                  </label>
                  {excludedCount + warnedCount > 0 && (
                    <label className="row gap-8 muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
                      <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                      only rows with a problem
                    </label>
                  )}
                </div>

                {!mappingComplete && <Notice kind="warn" style={{ marginTop: 12 }}>{copy.required}</Notice>}
                {tooMany && (
                  <Notice kind="warn" style={{ marginTop: 12 }}>
                    This data has {num(dataRows.length)} rows. Import up to {num(MAX_ROWS)} at a time — split the file and import the parts one after another.
                  </Notice>
                )}

                <PreviewTable
                  header={hasHeader ? table[0] ?? [] : null}
                  columnCount={columnCount}
                  mapping={mapping}
                  fields={fields}
                  dataRows={dataRows}
                  prepared={prepared}
                  onlyProblems={onlyProblems}
                  disabled={busy}
                  onMap={setColumn}
                />

                {excludedCount > 0 && (
                  <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>
                    Rows marked "left out" are not sent. Fix them in your file and import it again — rows that already went in are matched, not duplicated.
                  </p>
                )}
              </>
            )}

            {kind === "prospects" && hasData && (
              <div className="mt-16" style={{ maxWidth: 320 }}>
                <Field label="Source label (optional — how these prospects appear under Source)">
                  <input className="input" value={source} placeholder="import" disabled={busy} onChange={(e) => setSource(e.target.value)} />
                </Field>
              </div>
            )}

            {run.phase === "stopped" && (
              <div className="mt-16">
                <ErrorBanner message={`The import stopped: ${run.error}`} />
                <ResultCounts copy={copy} summary={run.summary} excluded={run.excluded} />
                <p className="muted" style={{ fontSize: 13 }}>
                  {num(run.remaining.length)} row{run.remaining.length === 1 ? " was" : "s were"} not sent. Resuming continues from where it stopped.
                </p>
              </div>
            )}

            {busy && run.phase === "sending" && (
              <div className="mt-16">
                <div className="progress">
                  <span style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} />
                </div>
                <div className="faint mono" style={{ fontSize: 12, marginTop: 6 }}>
                  sending {num(run.done)} of {num(run.total)} rows…
                </div>
              </div>
            )}

            <div className="row gap-8 mt-16 wrap">
              {run.phase === "stopped" ? (
                <button type="button" className="btn primary" onClick={() => send(run.remaining, run.summary, run.excluded)}>
                  ↻ Resume · {num(run.remaining.length)} rows
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || ready.length === 0 || tooMany || deferredText !== text}
                  onClick={() => send(ready, emptyUploadSummary(), excludedCount)}
                >
                  {busy ? "importing…" : ready.length > 0 ? `Import ${num(ready.length)} row${ready.length === 1 ? "" : "s"}` : "Import"}
                </button>
              )}
              {hasData && (
                <button type="button" className="btn ghost" onClick={reset} disabled={busy}>
                  Clear
                </button>
              )}
              <span className="faint" style={{ fontSize: 12, flex: "1 1 260px" }}>{copy.after}</span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function padTo(row: string[], length: number): string[] {
  return row.length >= length ? row : [...row, ...Array.from({ length: length - row.length }, () => "")];
}

function describeFailure(e: unknown): string {
  const status = errorStatus(e);
  if (status === 403) return "your role cannot import (managers, admins and owners can).";
  if (status === 413) return "the server refused a batch as too large. Shorten very long notes and try again.";
  return errorMessage(e, "the server did not accept the rows.");
}

// ---- preview ----------------------------------------------------------------

function PreviewTable({
  header,
  columnCount,
  mapping,
  fields,
  dataRows,
  prepared,
  onlyProblems,
  disabled,
  onMap,
}: {
  header: string[] | null;
  columnCount: number;
  mapping: string[];
  fields: { key: string; label: string }[];
  dataRows: string[][];
  prepared: PreparedRow<Row>[];
  onlyProblems: boolean;
  disabled: boolean;
  onMap: (index: number, key: string) => void;
}) {
  const indexes = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < prepared.length && out.length < PREVIEW_ROWS; i++) {
      if (!onlyProblems || prepared[i]!.issues.length > 0) out.push(i);
    }
    return out;
  }, [prepared, onlyProblems]);
  const matching = onlyProblems ? prepared.filter((r) => r.issues.length > 0).length : prepared.length;
  const columns = Array.from({ length: columnCount }, (_, i) => i);

  return (
    <div className="mt-16">
      <div className="import-preview">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 54 }}>Line</th>
              <th style={{ width: 96 }}>Status</th>
              {columns.map((c) => (
                <th key={c} style={{ minWidth: 150 }}>
                  <select className="select" value={mapping[c] ?? ""} disabled={disabled} onChange={(e) => onMap(c, e.target.value)} aria-label={`Column ${c + 1} contains`}>
                    <option value="">— ignore —</option>
                    {fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <div className="import-colname" title={header?.[c] ?? ""}>
                    {header ? header[c] || "(no heading)" : `column ${c + 1}`}
                  </div>
                </th>
              ))}
              <th style={{ minWidth: 200 }}>Problem</th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((i) => {
              const row = prepared[i]!;
              const cells = dataRows[i] ?? [];
              const out = row.value === null;
              return (
                <tr key={row.line} className={out ? "left-out" : undefined}>
                  <td className="mono faint" style={{ fontSize: 11.5 }}>{row.line}</td>
                  <td>{out ? <Badge kind="neg">left out</Badge> : row.issues.length > 0 ? <Badge kind="warn">partial</Badge> : <Badge kind="pos">ready</Badge>}</td>
                  {columns.map((c) => (
                    <td key={c} className={mapping[c] ? undefined : "ignored"} title={cells[c] ?? ""}>
                      <span className="import-cell">{cells[c] ?? ""}</span>
                    </td>
                  ))}
                  <td className={out ? "neg" : "warn"} style={{ fontSize: 12 }}>
                    {row.issues.map((x) => x.message).join(" · ")}
                  </td>
                </tr>
              );
            })}
            {indexes.length === 0 && (
              <tr>
                <td colSpan={columnCount + 3} className="faint" style={{ textAlign: "center", padding: 18 }}>
                  {onlyProblems ? "No rows with a problem." : "No data rows — only a header line was found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {matching > indexes.length && (
        <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
          Showing the first {num(indexes.length)} of {num(matching)} {onlyProblems ? "rows with a problem" : "rows"}. The counts above cover the whole file.
        </div>
      )}
    </div>
  );
}

// ---- result -----------------------------------------------------------------

function ResultCounts({ copy, summary, excluded }: { copy: Copy; summary: Summary; excluded: number }) {
  // Known counters first, in a fixed order; then anything else the API chose to report.
  const known = Object.keys(copy.counts).filter((k) => k in summary.counts || summary.accepted > 0);
  const extra = Object.keys(summary.counts).filter((k) => !(k in copy.counts));
  return (
    <div className="result-tiles">
      {known.map((key) => {
        const meta = copy.counts[key]!;
        const value = summary.counts[key] ?? 0;
        return (
          <div key={key} className={`result-tile ${value > 0 ? meta.kind : ""}`}>
            <div className="result-n mono">{num(value)}</div>
            <div className="result-label">{meta.label}</div>
            <div className="faint" style={{ fontSize: 11.5 }}>{meta.hint}</div>
          </div>
        );
      })}
      {extra.map((key) => (
        <div key={key} className="result-tile">
          <div className="result-n mono">{num(summary.counts[key])}</div>
          <div className="result-label">{humanize(key)}</div>
          <div className="faint" style={{ fontSize: 11.5 }}>reported by the server</div>
        </div>
      ))}
      {excluded + summary.refused.length > 0 && (
        <div className="result-tile neg">
          <div className="result-n mono">{num(excluded + summary.refused.length)}</div>
          <div className="result-label">Not sent</div>
          <div className="faint" style={{ fontSize: 11.5 }}>
            {num(excluded)} left out in the preview{summary.refused.length > 0 ? ` · ${num(summary.refused.length)} refused by the server` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultView({
  kind,
  copy,
  summary,
  excluded,
  backlog,
  onProcessBacklog,
  onAnother,
  onClose,
}: {
  kind: ImportKind;
  copy: Copy;
  summary: Summary;
  excluded: number;
  backlog: { busy: boolean; note: string | null; error: string | null };
  onProcessBacklog: () => void;
  onAnother: () => void;
  onClose: () => void;
}) {
  const counted = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const added = kind === "prospects" ? summary.counts.imported ?? 0 : summary.counts.created ?? 0;
  const nothingAdded = summary.accepted > 0 && added === 0;
  // The roster route skips every row when the workspace has no program to attach them to.
  const noProgram = kind === "roster" && summary.accepted > 0 && (summary.counts.skipped ?? 0) === summary.accepted;

  return (
    <div>
      {summary.accepted === 0 ? (
        <Notice kind="warn">Nothing was imported — every row was refused. The reasons are listed below.</Notice>
      ) : noProgram ? (
        <Notice kind="warn">
          Nothing was added. The server skips every row when the workspace has no program to attach affiliates to — create one under{" "}
          <a href="#/programs" style={{ textDecoration: "underline" }}>Programs &amp; Offers</a>, then import again.
        </Notice>
      ) : (
        <Notice kind="ok">
          Import finished — {num(summary.accepted)} row{summary.accepted === 1 ? "" : "s"} sent.
          {nothingAdded ? " Nothing new was added: everyone in the file was already there." : ""}
        </Notice>
      )}

      <ResultCounts copy={copy} summary={summary} excluded={excluded} />

      {summary.accepted > 0 && counted === 0 && (
        <p className="faint" style={{ fontSize: 12 }}>The server accepted the rows but did not report a breakdown.</p>
      )}

      {summary.refused.length > 0 && (
        <div className="mt-16">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6 }}>Refused by the server</div>
          <div className="import-refused">
            {summary.refused.slice(0, 50).map((r, i) => (
              <div key={i} className="row gap-8" style={{ fontSize: 12.5, alignItems: "baseline" }}>
                <span className="mono faint" style={{ minWidth: 64 }}>line {r.line}</span>
                <span className="neg">{r.reason}</span>
              </div>
            ))}
            {summary.refused.length > 50 && <div className="faint" style={{ fontSize: 12 }}>…and {num(summary.refused.length - 50)} more.</div>}
          </div>
        </div>
      )}

      {kind === "prospects" && added > 0 && (
        <div className="mt-16">
          <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
            New prospects are unscored until they are enriched, so they sort below the scored ones in the queue. That happens on the next automation
            cycle{added <= 250 ? " — or you can run it now (it can take a minute)." : "."}
          </p>
          {backlog.error && <ErrorBanner message={backlog.error} />}
          {backlog.note && <Notice kind="ok">{backlog.note}</Notice>}
          {added <= 250 && !backlog.note && (
            <button type="button" className="btn sm" onClick={onProcessBacklog} disabled={backlog.busy}>
              {backlog.busy ? "enriching…" : "Enrich & score now"}
            </button>
          )}
        </div>
      )}

      <div className="row gap-8 mt-16">
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
        <button type="button" className="btn ghost" onClick={onAnother}>
          Import another file
        </button>
      </div>
    </div>
  );
}
