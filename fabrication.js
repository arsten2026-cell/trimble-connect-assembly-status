// Fabrication dates from the fabricator's Excel (Tekla report AM_Fabrication) -> Trimble Connect property sets.
// Stored per assembly INSTANCE (link frn:entity:{IFC GlobalId}) in the library "STEEL/Монтаж", definition "fabstatus",
// named "AM_Fabrication" with simple property names, because Tekla 2026 reads Connect property sets by those names:
// the report and the model read ASSEMBLY.PSET.AM_Fabrication.FabDate / DelivDate / DelivNote (tested live on 1028,
// 15.11.2026: a value set in Connect was read by Tekla after "Synchronize property sets"; dates come in as Tekla dates).
// Pure: no network, no DOM (tested with node --test test/fabrication.test.js).
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.SteelFab = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEF_ID = "fabstatus";
  const PSET = "AM_Fabrication";
  const NOTE_MAX = 79;   // the report's note column and the old Tekla UDA hold 79 characters
  const LOG_MAX = 1500;   // the pset service's string limit is not documented: keep the history short (round 5, L9)
  const FIELDS = ["FabDate", "DelivDate", "DelivNote"];

  /** Definition in the Connect library-editor format. Names and labels are the bare property names on purpose:
   *  Tekla addresses Connect properties by their names (PSET.<set>.<property>), so no spaces, slashes or Cyrillic. */
  function definition() {
    const S = { type: "string" }, D = { type: "string", format: "date" };
    const fields = [["FabDate", D], ["DelivDate", D], ["DelivNote", S], ["Source", S], ["log", S]];
    const props = {}, labels = {}, order = {};
    fields.forEach(([k, schema], i) => { props[k] = schema; labels[k] = k; order[k] = String(i); });
    return { id: DEF_ID, name: PSET, description: "Arsten / Multiplan fabrication: dates from the fabricator's Excel (Tekla reads PSET.AM_Fabrication.*).",
      schema: { props }, i18n: { "en-US": { name: PSET, props: labels }, "__prop-order__": { name: "__prop-order__", props: order } } };
  }

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function validDate(y, m, d) {
    if (!(y >= 2000 && y <= 2037)) return null;   // a typo ("2062", "1926") is refused instead of stored
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ymd(y, m, d) : null;
  }
  /** Excel day serial -> "YYYY-MM-DD" (1900 system; date1904 workbooks are shifted by 1462 days). */
  function fromSerial(n, date1904) {
    const days = Math.floor(n) + (date1904 ? 1462 : 0);
    const t = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    return validDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  /**
   * A date from a cell {text, num, date}. Returns {date} ("YYYY-MM-DD"), {date, ambiguous: true} for a slash date where
   * day and month are both 12 or less (read as day/month, as in Bulgaria, but the preview asks to check), {error} for
   * text that is not a date, or {} for an empty cell.
   */
  function parseDate(cell, date1904) {
    const c = cell || {};
    if (c.date) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(c.date); const v = m && validDate(+m[1], +m[2], +m[3]); return v ? { date: v } : { error: true }; }
    if (typeof c.num === "number" && isFinite(c.num)) {
      if (c.num > 20000 && c.num < 80000) { const v = fromSerial(c.num, date1904); return v ? { date: v } : { error: true }; }
    }
    let s = clean(c.text).replace(/\s*г\.?$/i, "").replace(/(\d)\.\s+(\d)/g, "$1.$2").replace(/\.$/, "").trim();
    if (!s) return {};
    if (/^\d{5}(\.\d+)?$/.test(s)) { const n = parseFloat(s); if (n > 20000 && n < 80000) { const v = fromSerial(n, date1904); return v ? { date: v } : { error: true }; } }
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/.exec(s);   // ISO, also with a time
    if (m) { const v = validDate(+m[1], +m[2], +m[3]); return v ? { date: v } : { error: true }; }
    m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})(?:\s+\d{1,2}:\d\d(?::\d\d)?)?$/.exec(s);
    if (m) {
      const d = +m[1], mo = +m[3];
      const y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
      const v = validDate(y, mo, d);
      if (!v) return { error: true };
      return m[2] === "/" && d <= 12 && mo <= 12 && d !== mo ? { date: v, ambiguous: true } : { date: v };
    }
    return { error: true };
  }

  const H = { guid: "guid", mark: "марка", fab: ["am_fab_date", "дата изработен"], deliv: ["am_deliv_date", "дата доставен"], note: ["am_deliv_note", "стокова разписка"] };
  const has = (h, keys) => keys.some((k) => h.includes(k));

  /**
   * Rows of one sheet (array of rows, each an array of cells {text, num, date}) -> [{where, guid, mark, fab, deliv, note}].
   * Columns are found by their headings (Bulgarian heading or the Tekla key under it), so moved or added columns work.
   * Returns {rows} or {error} ("no GUID column" / "no date columns").
   */
  function readSheet(table, sheetName, rowWord) {
    const pre = (sheetName ? sheetName + ", " : "") + (rowWord ? rowWord + " " : "");
    let hr = -1, cGuid = -1;
    for (let i = 0; i < table.length && hr < 0; i++) {
      (table[i] || []).forEach((c, j) => { if (hr < 0 && clean(c && c.text).toLowerCase() === H.guid) { hr = i; cGuid = j; } });
    }
    if (hr < 0) return { error: "noGuid" };
    let cMark = -1, cFab = -1, cDeliv = -1, cNote = -1;
    (table[hr] || []).forEach((c, j) => {
      const h = clean(c && c.text).toLowerCase();
      if (h === H.mark) cMark = j;
      else if (has(h, H.fab)) cFab = j;
      else if (has(h, H.deliv)) cDeliv = j;
      else if (has(h, H.note)) cNote = j;
    });
    if (cFab < 0 && cDeliv < 0) return { error: "noDates" };
    const get = (r, j) => (j >= 0 && r[j]) || { text: "" };
    const rows = [];
    for (let i = hr + 1; i < table.length; i++) {
      const r = table[i] || [];
      const guid = clean(get(r, cGuid).text);
      if (!guid || guid.toLowerCase() === H.guid) continue;   // blank, or a repeated heading
      rows.push({ where: `${pre}${i + 1}`, guid, mark: clean(get(r, cMark).text),
        fab: cFab < 0 ? null : get(r, cFab), deliv: cDeliv < 0 ? null : get(r, cDeliv), note: cNote < 0 ? null : get(r, cNote) });
    }
    return { rows };
  }

  /**
   * What an import would change.
   * rows: from readSheet (all sheets); toIfc: Tekla GUID -> IFC GlobalId ("" if not a GUID); known: Map IFC GUID ->
   * {mark} of the assemblies loaded in the viewer; existing: Map IFC GUID -> stored props.
   * Rules (same as the Tekla import macro): an empty cell never clears a stored value; the same GUID twice -> the later
   * non-empty value wins and the conflict is listed; a stored value that would change is an overwrite (shown before
   * anything is written); rows whose GUID is not in the loaded models are not written.
   */
  function plan(rows, opts) {
    const o = opts || {};
    const toIfc = o.toIfc || ((g) => g);
    const known = o.known || new Map(), existing = o.existing || new Map();
    const problems = [], warnings = [], conflicts = [], notLoaded = [], badGuid = [];
    const merged = new Map();   // ifc -> {mark, where, FabDate, DelivDate, DelivNote}
    for (const r of rows) {
      const ifc = /^[0-9A-Za-z_$]{22}$/.test(r.guid) ? r.guid : toIfc(r.guid);
      if (!ifc) { badGuid.push(`${r.where}: ${r.guid}`); continue; }
      const vals = {};
      for (const [f, cell] of [["FabDate", r.fab], ["DelivDate", r.deliv]]) {
        if (!cell) continue;
        const d = parseDate(cell, o.date1904);
        if (d.error) problems.push(`${r.where} (${r.mark || "?"}): "${clean(cell.text)}"`);
        else if (d.date) { vals[f] = d.date; if (d.ambiguous) warnings.push(`${r.where} (${r.mark || "?"}): ${clean(cell.text)} → ${d.date}`); }
      }
      if (r.note) {
        let n = clean(r.note.text);
        // trimmed after the cut, so a cut at a space does not store a trailing space that the next round trip
        // through Tekla drops and reports as a change (round 5, L1)
        if (n.length > NOTE_MAX) { warnings.push(`${r.where} (${r.mark || "?"}): ${n.length} > ${NOTE_MAX}`); n = n.slice(0, NOTE_MAX).trim(); }
        if (n) vals.DelivNote = n;
      }
      if (!Object.keys(vals).length) continue;
      const m = merged.get(ifc) || { mark: r.mark, where: r.where };
      for (const [f, v] of Object.entries(vals)) {
        if (m[f] != null && m[f] !== v) conflicts.push(`${r.mark || ifc} ${f}: ${m[f]} (${m.where}) / ${v} (${r.where})`);
        m[f] = v;
      }
      m.where = r.where;
      merged.set(ifc, m);
    }
    const changes = [];
    let fills = 0, overwrites = 0, unchanged = 0;
    for (const [ifc, m] of merged) {
      if (!known.has(ifc)) { notLoaded.push(m.mark || ifc); continue; }
      const cur = existing.get(ifc) || {};
      const set = {}, over = [];
      for (const f of FIELDS) {
        if (m[f] == null) continue;
        const was = stored(f, cur[f]);
        if (was === m[f]) { unchanged++; continue; }
        set[f] = m[f];
        if (was) { overwrites++; over.push({ field: f, from: was, to: m[f] }); } else fills++;
      }
      // before = the stored record the preview was computed from; Save re-reads and compares (round 5, M2 / L4)
      if (Object.keys(set).length) changes.push({ ifc, mark: (known.get(ifc) || {}).mark || m.mark, set, over, before: cur });
    }
    return { rows: rows.length, guids: merged.size, changes, fills, overwrites, unchanged, problems, warnings, conflicts, notLoaded, badGuid };
  }

  /** A stored value as the import compares it: dates as "YYYY-MM-DD" in local time (a date-time such as
   *  "2026-11-14T22:00:00Z" is 15.11 in Bulgaria, round 5, L2), notes cleaned the same way the file is read. */
  function stored(f, v) {
    if (v == null || v === "") return "";
    if (f === "DelivNote") return clean(v);
    const s = String(v);
    if (/^\d{4}-\d\d-\d\d$/.test(s)) return s;
    const t = new Date(s);
    return isNaN(t) ? s.slice(0, 10) : ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  function addLog(log, line) {
    const s = (log ? log + "\n" : "") + line;
    return s.length > LOG_MAX ? s.slice(s.length - LOG_MAX).replace(/^[^\n]*\n/, "") : s;
  }
  /** What to PATCH: only the changed fields, the source file and the history line built on the record as it is
   *  stored NOW (cur = a fresh read). Fields not in the change are left out, so a value someone else wrote since the
   *  panel loaded is never sent back stale (round 5, M2). */
  function patchFor(cur, change, meta) {
    const m = meta || {};
    const x = m.now || new Date();
    const stamp = `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
    const what = Object.entries(change.set).map(([f, v]) => `${f}=${v}`).join(", ");
    return Object.assign({}, change.set, { Source: m.source || "", log: addLog((cur || {}).log, `${stamp} ${what} (${m.source || "?"}, ${m.by || "?"})`) });
  }
  /** Fields of a change whose stored value is no longer what the preview showed (someone saved in between). */
  function changedSince(change, previewCur, freshCur) {
    return Object.keys(change.set).filter((f) => stored(f, (previewCur || {})[f]) !== stored(f, (freshCur || {})[f]));
  }

  return { DEF_ID, PSET, FIELDS, NOTE_MAX, definition, parseDate, fromSerial, readSheet, plan, stored, patchFor, changedSince };
});
