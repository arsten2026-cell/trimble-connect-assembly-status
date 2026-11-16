// Assembly status: what is stored in the library "STEEL/Монтаж" and how records change (pure; the two write-order
// helpers at the end call a client passed in).
// Definitions (Connect library-editor format, as Pour status):
//   asmstatus  per assembly instance (frn:entity:{IFC GlobalId}): erected, wrong (+ date/by/note), mark, log
//   asmhold    per assembly instance: hold (+ date/by/reason), log  -> separate so designers can get Edit on holds only
//   delivery   per delivery note (frn:entity:ARSTENDLV-{projectId}-{id}): date, note_no, lines, by, source, cancelled, log
// Delivered per mark = max(typed deliveries, instances with an Excel DelivDate) - deliveredByMark / availabilityWithFab
// (review 9: only dated pieces, or typed deliveries beyond them, light up "ready"; erected counts as delivered on the Excel side).
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.SteelRecords = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIB_NAMES = ["STEEL/Монтаж", "STEEL/Montazh"];
  const DEF = { status: "asmstatus", hold: "asmhold", delivery: "delivery" };
  const LOG_MAX = 4000;

  function def(id, name, fields) {
    const props = {}, labels = {}, order = {};
    fields.forEach(([k, schema, label], i) => { props[k] = schema; labels[k] = label; order[k] = String(i); });
    return { id, name, description: "Arsten / Multiplan Assembly status extension.", schema: { props },
      i18n: { "en-US": { name, props: labels }, "__prop-order__": { name: "__prop-order__", props: order } } };
  }
  const S = { type: "string" }, B = { type: "boolean" }, D = { type: "string", format: "date" };
  const definitions = () => [
    def(DEF.status, "Assembly status / Статус сглобка", [
      ["erected", B, "Erected / Монтиран"], ["erected_date", D, "Erected date / Дата монтаж"], ["erected_by", S, "Erected by / Монтирал"], ["erected_note", S, "Erected note / Бележка монтаж"],
      ["wrong", B, "Wrong / Грешно изработен"], ["wrong_date", D, "Wrong date / Дата"], ["wrong_by", S, "Wrong by / От"], ["wrong_note", S, "Wrong note / Бележка"],
      ["mark", S, "Mark / Марка"], ["log", S, "History / История"]]),
    def(DEF.hold, "Assembly hold / Задържане", [
      ["hold", B, "On hold / Задържан"], ["hold_date", D, "Hold date / Дата"], ["hold_by", S, "Hold by / От"], ["hold_reason", S, "Reason / Причина"],
      ["mark", S, "Mark / Марка"], ["log", S, "History / История"]]),
    def(DEF.delivery, "Delivery / Доставка", [
      ["date", D, "Date / Дата"], ["note_no", S, "Delivery note / Стокова разписка"], ["lines", S, "Marks and qty / Марки и бр."],
      ["by", S, "By / От"], ["source", S, "Source / Източник"], ["cancelled", B, "Cancelled / Анулирана"], ["log", S, "History / История"]]),
  ];

  const pad = (n) => String(n).padStart(2, "0");
  const today = (d) => { const x = d || new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const stamp = (d) => { const x = d || new Date(); return `${today(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  function addLog(log, line) {
    const s = (log ? log + "\n" : "") + line;
    return s.length > LOG_MAX ? s.slice(s.length - LOG_MAX).replace(/^[^\n]*\n/, "") : s;
  }

  /** Set (on) or clear (off) a flag with date / by / note on an instance record. kind: "erected" | "wrong" | "hold". */
  function setFlag(rec, kind, on, info) {
    const noteKey = kind === "hold" ? "hold_reason" : `${kind}_note`;
    const r = Object.assign({}, rec || {});
    const i = info || {};
    if (i.mark != null) r.mark = i.mark;
    if (on) {
      const was = !!r[kind];
      r[kind] = true;
      r[`${kind}_date`] = i.date || today(i.now);
      r[`${kind}_by`] = i.by || "";
      r[noteKey] = i.note || "";
      r.log = addLog(r.log, `${stamp(i.now)} ${was ? "corrected" : "set"}: ${kind} ${r[`${kind}_date`]} by ${i.by || "?"}${i.note ? " – " + i.note : ""}`);
    } else {
      if (!r[kind]) return r;
      r[kind] = false;
      r[`${kind}_date`] = null; r[`${kind}_by`] = null; r[noteKey] = null;   // cleared with a replace (PATCH merges)
      r.log = addLog(r.log, `${stamp(i.now)} undone: ${kind} by ${i.by || "?"}`);
    }
    return r;
  }

  const deliveryLink = (projectId, id) => `frn:entity:ARSTENDLV-${projectId}-${id}`;
  const deliveryPrefix = (projectId) => `frn:entity:ARSTENDLV-${projectId}-`;
  /** New delivery record. lines: "RF22=3;CL22=2" (SteelLogic.linesText). */
  function newDelivery(info) {
    const i = info || {};
    return { date: i.date || today(i.now), note_no: i.noteNo || "", lines: i.lines || "", by: i.by || "", source: i.source || "typed",
      cancelled: false, log: addLog("", `${stamp(i.now)} created by ${i.by || "?"} (${i.source || "typed"}): ${i.lines || ""}`) };
  }
  function cancelDelivery(rec, info) {
    const i = info || {};
    if (!rec || rec.cancelled) return rec;
    return Object.assign({}, rec, { cancelled: true, log: addLog(rec.log, `${stamp(i.now)} cancelled by ${i.by || "?"}${i.note ? " – " + i.note : ""}`) });
  }

  /**
   * Delivery list from a typed text or an imported table: rows of [mark, qty] (header rows and blanks skipped,
   * the same mark added up). Accepts "RF22 3", "RF22;3", "RF22,3", "RF22\t3", "RF22 x3", "3 x RF22".
   */
  function parseDeliveryText(text) {
    const rows = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      let m = /^(\d+)\s*[x×*]\s*(\S.*)$/i.exec(l);
      if (m) return [m[2], m[1]];
      m = /^(.+?)[\s;,\t]+[x×*]?\s*(\d+)\s*(?:бр\.?|pcs)?$/i.exec(l);
      return m ? [m[1], m[2]] : [l, ""];
    });
    return linesFromRows(rows);
  }
  function linesFromRows(rows) {
    const sum = new Map(), skipped = [];
    for (const r of rows) {
      const mark = String(r[0] == null ? "" : r[0]).replace(/\s+/g, "").toUpperCase();
      const qty = parseInt(String(r[1] == null ? "" : r[1]).replace(/[^\d-]/g, ""), 10);
      if (!mark || !(qty > 0)) { if (mark && !/^(MARK|МАРКА|POS|ПОЗ)/i.test(mark)) skipped.push(r.join(" ")); continue; }
      sum.set(mark, (sum.get(mark) || 0) + qty);
    }
    return { lines: [...sum].map(([mark, qty]) => ({ mark, qty })), skipped };
  }

  // ---------- delivered per mark: typed deliveries + the fabricator's Excel (owner's rule, 16.11.2026) ----------
  // Same mark matching and "RF01=3;CL03=2" reading as steel.js (normMark / parseLines): case and spaces ignored.
  const normMark = (m) => String(m == null ? "" : m).normalize("NFC").replace(/\s+/g, "").toUpperCase();
  const parseLines = (s) => String(s || "").split(";").map((x) => x.split("=")).filter((p) => p[0] && p[0].trim())
    .map(([m, q]) => ({ mark: normMark(m), qty: Math.max(0, parseInt(q, 10) || 0) })).filter((l) => l.qty > 0);
  const fabGet = (fab, g) => (fab && typeof fab.get === "function" ? fab.get(g) : fab && fab[g]) || {};
  /** True when the instance has a delivery date from the fabricator's Excel (fabstatus.DelivDate). */
  // a delivery date in the future (planned) does not count yet; dates are "YYYY-MM-DD", compared with local today
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const fabDelivered = (fab, guid, today) => {
    const v = String(fabGet(fab, guid).DelivDate == null ? "" : fabGet(fab, guid).DelivDate).trim();
    return !!v && v.slice(0, 10) <= (today || todayStr());
  };

  const dedupe = (instances) => { const seen = new Set(); return (instances || []).filter((a) => a && !seen.has(a.guid) && seen.add(a.guid)); };
  const erectedIn = (status, g) => !!(status && typeof status.get === "function" && (status.get(g) || {}).erected);

  /**
   * Delivered count per mark from both sources. Per mark: typed = sum of qty over non-cancelled typed deliveries;
   * excel = instances of the mark (in `instances`) with a DelivDate in fabstatus; count = max(typed, excel), never the
   * sum (the same pieces are usually in both). source: "typed" | "excel" | "both"; differs: both sources have a
   * figure and they are not equal (one source alone is not a disagreement).
   * With `status` (Map guid -> {erected}): on a mark the Excel covers (at least one dated instance), an erected
   * instance counts as delivered on the Excel side too - a piece cannot be erected without arriving (review 9 M6).
   * A mark with no Excel date at all keeps the typed figure alone, so "erected more than delivered" still warns there.
   * @param deliveries [{lines, cancelled}]; fab Map (or object) IFC GUID -> {DelivDate}; instances [{guid, mark}]
   * @returns Map normalised mark -> {typed, excel, count, source, differs} (marks with count > 0 only)
   */
  function deliveredByMark(deliveries, fab, instances, status) {
    const typed = new Map(), dated = new Map(), known = new Map();
    for (const d of deliveries || []) {
      if (!d || d.cancelled) continue;
      for (const l of parseLines(d.lines)) typed.set(l.mark, (typed.get(l.mark) || 0) + l.qty);
    }
    for (const a of dedupe(instances)) {   // an instance loaded twice is counted once
      const m = normMark(a.mark), del = fabDelivered(fab, a.guid);
      if (del) dated.set(m, (dated.get(m) || 0) + 1);
      if (del || erectedIn(status, a.guid)) known.set(m, (known.get(m) || 0) + 1);
    }
    const out = new Map();
    for (const mark of new Set([...typed.keys(), ...dated.keys()])) {
      const t = typed.get(mark) || 0, e = dated.get(mark) ? known.get(mark) || 0 : 0;
      out.set(mark, { typed: t, excel: e, count: Math.max(t, e), source: t && e ? "both" : t ? "typed" : "excel", differs: !!(t && e && t !== e) });
    }
    return out;
  }

  /**
   * steel.js availability with the rule above (review 9 H3). The mark's delivered figure is max(typed, Excel). With
   * Excel dates we know WHICH pieces arrived:
   *  - an instance with a DelivDate (<= today) is "ready" unless erected, wrong or on hold;
   *  - an instance without a date is "ready" only while the typed deliveries cover more than the pieces already
   *    known to be there: freeTyped = typed − (dated instances, erected ones included) − (erected instances without a
   *    date), floored at 0; when freeTyped > 0 the undated un-erected pieces light up as in steel.js (a typed count does
   *    not say which piece came). The Excel count alone never lights an undated piece.
   * Precedence as steel.js: wrong > hold > erected > ready > notDelivered. ready / notDelivered / hold / wrong per row
   * are counted from the states, so they always equal what is coloured.
   * Rows get {typed, excel, source, differs}; the result gets `differs` (rows whose sources disagree) and `byMark`.
   * @param SL steel.js (SteelLogic), passed in so this file stays free of dependencies
   */
  function availabilityWithFab(SL, instances, status, holds, deliveries, fab) {
    const list = dedupe(instances);   // the same instance loaded twice counts once (review 9 low 10)
    status = status || new Map(); holds = holds || new Map();
    const byMark = deliveredByMark(deliveries, fab, list, status);
    const merged = [{ lines: [...byMark].map(([m, x]) => `${m}=${x.count}`).join(";"), cancelled: false }];
    const av = SL.availability(list, status, holds, merged);
    const rows = new Map(av.marks.map((r) => [r.mark, r]));
    const known = new Map();   // per mark: instances known to be on site (dated or erected)
    for (const a of list) if (fabDelivered(fab, a.guid) || erectedIn(status, a.guid)) { const m = normMark(a.mark); known.set(m, (known.get(m) || 0) + 1); }
    for (const r of av.marks) { r.ready = 0; r.hold = 0; r.wrong = 0; r.notDelivered = 0; }
    for (const a of list) {
      const m = normMark(a.mark), r = rows.get(m);
      const s = status.get(a.guid) || {}, h = holds.get(a.guid) || {};
      const freeTyped = Math.max(0, ((byMark.get(m) || {}).typed || 0) - (known.get(m) || 0));
      const id = s.wrong ? "wrong" : h.hold ? "hold" : s.erected ? "erected" : fabDelivered(fab, a.guid) || freeTyped > 0 ? "ready" : "notDelivered";
      av.state.set(a.guid, id);
      if (r && id !== "erected") r[id]++;
    }
    for (const r of av.marks) {
      const x = byMark.get(r.mark) || { typed: 0, excel: 0, source: "", differs: false };
      Object.assign(r, { typed: x.typed, excel: x.excel, source: x.source, differs: x.differs });
    }
    av.byMark = byMark;
    av.differs = av.marks.filter((r) => r.differs);
    return av;
  }

  // ---------- "$" links and undo files: write order and checks (take a client, so they can be tested with a mock) ----------
  /**
   * Replace (delete + re-create, so fields can be cleared) the record of a GUID that still has a raw-"$" copy
   * (review 9 M1). Order: the full merged record goes to the encoded link first (PATCH), then the raw copy is deleted,
   * and only then is the encoded record replaced. Any failure throws and stops the sequence, so a failed step can never
   * leave the raw copy as the newest record (which the next load would show as current and "Премести" would copy back).
   * client: {write, remove, replace} as PsetClient.
   */
  async function replaceOverRaw(client, libId, def, encLink, rawLink, props) {
    await client.write(libId, def, encLink, props);
    await client.remove(libId, def, rawLink);
    return client.replace(libId, def, encLink, props);
  }

  /**
   * Requested links missing from a batch-get result while another returned key, not itself requested, decodes to the
   * same GUID: the service echoed the other "$" link form, so the undo file would wrongly record "did not exist"
   * (review 9 M4). decode: link -> GUID (the panel's own). Returns the suspicious requested links ([] = all fine).
   */
  function echoMismatch(requested, got, decode) {
    const asked = new Set(requested || []);
    const keys = got instanceof Map ? [...got.keys()] : Object.keys(got || {});
    const has = (l) => (got instanceof Map ? got.has(l) : Object.prototype.hasOwnProperty.call(got || {}, l));
    const other = new Set(keys.filter((k) => !asked.has(k)).map(decode));
    return [...asked].filter((l) => !has(l) && other.has(decode(l)));
  }

  return { LIB_NAMES, DEF, definitions, today, setFlag, deliveryLink, deliveryPrefix, newDelivery, cancelDelivery, parseDeliveryText, linesFromRows,
    deliveredByMark, availabilityWithFab, fabDelivered, replaceOverRaw, echoMismatch };
});
