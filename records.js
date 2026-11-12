// Assembly status: what is stored in the library "STEEL/Монтаж" and how records change (pure, no network).
// Definitions (Connect library-editor format, as Pour status):
//   asmstatus  per assembly instance (frn:entity:{IFC GlobalId}): erected, wrong (+ date/by/note), mark, log
//   asmhold    per assembly instance: hold (+ date/by/reason), log  -> separate so designers can get Edit on holds only
//   delivery   per delivery note (frn:entity:ARSTENDLV-{projectId}-{id}): date, note_no, lines, by, source, cancelled, log
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
    return { id, name, description: "Arsten Assembly status extension.", schema: { props },
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

  return { LIB_NAMES, DEF, definitions, today, setFlag, deliveryLink, deliveryPrefix, newDelivery, cancelDelivery, parseDeliveryText, linesFromRows };
});
