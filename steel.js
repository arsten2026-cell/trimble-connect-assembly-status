// Assembly status: pure logic (no network). Browser: window.SteelLogic; Node: require.
// - availability per assembly instance from deliveries per MARK and erected/hold/wrong per INSTANCE;
// - bolt groups: the other side of a site connection, found by mark (Connected_Assemblies) + geometry;
// - bolt erection list (site bolts whose both assemblies are erected), grouped by standard / diameter / length.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.SteelLogic = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Mark as compared: trimmed, inner spaces removed, upper case ("cl 3 " = "CL3"). */
  const normMark = (m) => String(m == null ? "" : m).normalize("NFC").replace(/\s+/g, "").toUpperCase();
  /** Native Tekla CONNECTED_ASSEMBLIES: one or more marks, separated by spaces, commas, semicolons or "->". */
  const parseMarks = (s) => [...new Set(String(s == null ? "" : s).replace(/->/g, ",").split(/[\s,;]+/).map(normMark).filter(Boolean))];

  /** Nut/washer set from Tekla TYPE2, exactly as the firm report "Multiplan Bolt Location List" decodes it. */
  const TYPE2 = [
    [["00110", "01010", "10010", "00010", "00001"], "[NaW]"],
    [["10110", "01110", "11010"], "[Na2W]"],
    [["11110"], "[Na3W]"],
    [["00111", "01011", "10011"], "[NaW Lock]"],
    [["10111", "01111", "11011"], "[Na2W Lock]"],
    [["11111"], "[Na3W Lock]"],
    [["10000", "01000", "00100"], "[W]"],
  ];
  const type2Code = (code) => { const c = String(code == null ? "" : code).trim(); const hit = TYPE2.find(([cs]) => cs.includes(c)); return hit ? hit[1] : "[Setless]"; };
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };
  const fmt = (v) => { const n = num(v); return n == null ? String(v || "") : String(Math.round(n * 10) / 10).replace(/\.0$/, ""); };
  /** "16 x Bolt M20 4014-8.8 70mm [NaW]" (report "Multiplan Bolt Location List"). */
  const boltLine = (b) => `${fmt(b.count)} x Bolt M${fmt(b.diameter)} ${b.standard || ""} ${fmt(b.length)}mm ${type2Code(b.assemblyCode)}`.replace(/\s+/g, " ").trim();

  // ---------- deliveries and availability ----------
  /** "RF01=3;CL03=2" <-> [{mark, qty}] */
  const parseLines = (s) => String(s || "").split(";").map((x) => x.split("=")).filter((p) => p[0] && p[0].trim())
    .map(([m, q]) => ({ mark: normMark(m), qty: Math.max(0, parseInt(q, 10) || 0) })).filter((l) => l.qty > 0);
  const linesText = (lines) => lines.filter((l) => l.qty > 0).map((l) => `${normMark(l.mark)}=${l.qty}`).join(";");
  /** Delivered quantity per mark (Map), cancelled deliveries left out. */
  function deliveredByMark(deliveries) {
    const out = new Map();
    for (const d of deliveries || []) {
      if (!d || d.cancelled) continue;
      for (const l of parseLines(d.lines)) out.set(l.mark, (out.get(l.mark) || 0) + l.qty);
    }
    return out;
  }

  // Colours in the 3D view (week 3, A7: the owner asked for much more visible colouring, 17.11.2026): saturated
  // colours at full opacity for every status; "Не е доставен" a light blue-grey, see-through but still visible.
  const STATES = [
    { id: "notDelivered", en: "Not delivered", bg: "Не е доставен", colour: "#90A4AE", opacity: 0.45 },
    { id: "ready", en: "Ready for erection", bg: "Готов за монтаж", colour: "#FF6D00", opacity: 1 },
    { id: "erected", en: "Erected", bg: "Монтиран", colour: "#00C853", opacity: 1 },
    { id: "wrong", en: "Wrong (fabrication)", bg: "Грешно изработен", colour: "#D50000", opacity: 1 },
    { id: "hold", en: "On hold", bg: "Задържан", colour: "#AA00FF", opacity: 1 },
  ];

  /**
   * State of every assembly instance and the figures per mark.
   * @param instances [{guid, mark}]; status Map guid -> {erected, wrong}; holds Map guid -> {hold}; deliveries [{lines, cancelled}]
   * @returns {state: Map guid -> state id, marks: [{mark, instances, delivered, erected, ready, hold, wrong, notDelivered, over}]}
   */
  function availability(instances, status, holds, deliveries) {
    const delivered = deliveredByMark(deliveries);
    const byMark = new Map();
    for (const a of instances) {
      const m = normMark(a.mark);
      if (!byMark.has(m)) byMark.set(m, []);
      byMark.get(m).push(a);
    }
    const state = new Map(), marks = [];
    for (const [mark, list] of byMark) {
      const st = (g) => status.get(g) || {};
      const erected = list.filter((a) => st(a.guid).erected).length;
      const del = delivered.get(mark) || 0;
      const free = del - erected;
      const row = { mark, instances: list.length, delivered: del, erected, available: Math.max(0, free), ready: 0, hold: 0, wrong: 0, notDelivered: 0, over: erected > del };   // available = delivered − erected; ready = instances lit
      for (const a of list) {
        const s = st(a.guid), h = holds.get(a.guid) || {};
        const id = s.wrong ? "wrong" : h.hold ? "hold" : s.erected ? "erected" : free > 0 ? "ready" : "notDelivered";
        state.set(a.guid, id);
        if (id === "ready") row.ready++; else if (id === "hold") row.hold++; else if (id === "wrong") row.wrong++; else if (id === "notDelivered") row.notDelivered++;
      }
      marks.push(row);
    }
    const unknown = [...delivered.keys()].filter((m) => !byMark.has(m));
    marks.sort((x, y) => x.mark.localeCompare(y.mark, undefined, { numeric: true }));
    return { state, marks, unknownDeliveredMarks: unknown };
  }

  // ---------- exact links: Tekla GUID -> IFC GlobalId ----------
  const IFC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  /**
   * Tekla GUID ("3a3705a8-a0d0-4ac1-bda9-5bb16406f763", optional "ID" prefix) -> 22-char IFC GlobalId (standard
   * IfcGuid compression, as ifcopenshell.guid.compress). "" for anything that is not a GUID.
   */
  function tcGuidToIfc(g) {
    let h = String(g == null ? "" : g).trim();
    if (/^id/i.test(h)) h = h.slice(2);
    h = h.replace(/[-{}\s]/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(h)) return "";
    const b = []; for (let i = 0; i < 32; i += 2) b.push(parseInt(h.slice(i, i + 2), 16));
    const enc = (v, n) => { let out = ""; for (let i = 0; i < n; i++) { out = IFC_CHARS[v % 64] + out; v = Math.floor(v / 64); } return out; };
    let s = enc(b[0], 2);
    for (let i = 1; i < 16; i += 3) s += enc(b[i] * 65536 + b[i + 1] * 256 + b[i + 2], 4);
    return s;
  }

  // ---------- geometry fallback: the other assembly of a bolt group ----------
  const AX = ["x", "y", "z"];
  /** Gap between two boxes (0 when they touch or overlap). */
  const boxGap = (a, b) => Math.sqrt(AX.reduce((t, k) => { const d = Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k]); return t + d * d; }, 0));

  /** Distance from a point to a box (0 inside). */
  const pointBoxDist = (p, b) => Math.sqrt(AX.reduce((t, k) => { const d = Math.max(0, b.min[k] - p[k], p[k] - b.max[k]); return t + d * d; }, 0));
  const centre = (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });

  /**
   * The other side of a bolt group (connected assemblies need not touch the bolt): among the assemblies with one of
   * the connected marks (not the bolt's own assembly), the instance nearest to the centre of the bolt's box
   * (distance to its parts' boxes). When the two nearest are within max(abs, rel × nearest) of each other the bolt
   * is "uncertain" and both are returned - never guessed silently.
   * @param bolt {ownGuid, bbox, otherMarks}; assemblies [{guid, mark, boxes}]; opts {abs: 0.2 (model units, m), rel: 0.1}
   * @returns {guid, distance} | {uncertain: true, candidates: [{guid, distance}, ...]} | {unresolved: "no-marks"|"no-candidates"}
   */
  function resolveOther(bolt, assemblies, opts) {
    const o = Object.assign({ abs: 0.2, rel: 0.1 }, opts || {});
    const marks = (bolt.otherMarks || []).map(normMark);
    if (!marks.length) return { unresolved: "no-marks" };
    const c = centre(bolt.bbox);
    const scored = assemblies.filter((a) => a.guid !== bolt.ownGuid && marks.includes(normMark(a.mark)))
      .map((a) => ({ guid: a.guid, distance: Math.min(...(a.boxes || []).map((b) => pointBoxDist(c, b)), Infinity) }))
      .filter((x) => isFinite(x.distance)).sort((x, y) => x.distance - y.distance);
    if (!scored.length) return { unresolved: "no-candidates" };
    if (scored.length > 1 && scored[1].distance - scored[0].distance <= Math.max(o.abs, o.rel * scored[0].distance)) {
      const lim = scored[0].distance + Math.max(o.abs, o.rel * scored[0].distance);
      return { uncertain: true, candidates: scored.filter((x) => x.distance <= lim) };
    }
    return { guid: scored[0].guid, distance: scored[0].distance };
  }

  /**
   * Both sides of a bolt group.
   * Exact (native Tekla, preferred): Main_Part_GUID -> IFC GlobalId of the part
   * -> the part's parent assembly (ctx.assemblyOfPart). The bolt's own assembly is always one side.
   * Fallback (old exports, or a GUID not found in the model): nearest instance of the Connected_Assemblies mark(s),
   * always flagged uncertain.
   * @param bolt {ownGuid, mainPart, otherMarks (null = property missing), bbox}
   * @param ctx {assemblyOfPart: Map ifcGuid -> assembly guid, assemblies: [{guid, mark, boxes}], opts}
   * @returns {others: [guid], exact: true} | {others: [guid], uncertain: true, via: "nearest"} | {partial: true} | {unresolved: reason}
   */
  function resolveSides(bolt, ctx) {
    const ids = [bolt.mainPart].map(tcGuidToIfc).filter(Boolean);   // Secondary_1/2_GUID are empty in IFC exports (12.11.2026): not used
    if (ids.length) {
      const asm = ids.map((g) => ctx.assemblyOfPart.get(g));
      if (asm.every(Boolean)) return { others: [...new Set(asm)].filter((g) => g !== bolt.ownGuid), exact: true };
    }
    if (bolt.otherMarks == null) return ids.length ? { unresolved: "guid-not-found" } : { partial: true };
    if (!bolt.otherMarks.length) return { others: [], exact: false };
    const r = resolveOther(bolt, ctx.assemblies || [], ctx.opts);
    if (r.unresolved) return { unresolved: r.unresolved };
    return { others: r.uncertain ? r.candidates.map((c) => c.guid) : [r.guid], uncertain: true, via: "nearest" };
  }

  // ---------- bolt erection list ----------
  const isSite = (v) => /site|монтаж|^s$/i.test(String(v || "").trim());
  /**
   * Bolt groups to install now: site bolts whose own assembly and EVERY connected assembly instance are erected.
   * Exact sides (GUID links): not all erected -> waiting. Uncertain sides (fallback): not all candidates erected ->
   * "check". No other side -> anchors. No connection data at all (old export) -> "partial" (own assembly only).
   * @param bolts [{guid, ownGuid, ownMark, sides: resolveSides(...), otherMarks, kind, standard, diameter, length, count}]
   * @param erected (guid) => bool
   * @returns {now, waiting, check, unresolved, partial, anchors, groups: [{standard, diameter, length, groups, bolts, connections}]}
   */
  function boltList(bolts, erected) {
    const out = { now: [], waiting: [], check: [], unresolved: [], partial: [], anchors: [] };
    for (const b of bolts) {
      if (b.kind != null && b.kind !== "" && !isSite(b.kind)) continue;   // workshop bolts are not erection work
      const sd = b.sides || {};
      if (sd.partial) { if (erected(b.ownGuid)) out.partial.push(b); continue; }
      if (sd.unresolved) { out.unresolved.push(b); continue; }
      if (!(sd.others || []).length) { out.anchors.push(b); continue; }   // single assembly: anchors
      if (!erected(b.ownGuid)) { out.waiting.push(b); continue; }
      if (sd.others.every((g) => erected(g))) out.now.push(b);
      else (sd.uncertain ? out.check : out.waiting).push(b);
    }
    const groups = new Map();
    for (const b of out.now) {
      const k = `${b.standard}|${b.diameter}|${b.length}`;
      if (!groups.has(k)) groups.set(k, { standard: b.standard, diameter: b.diameter, length: b.length, groups: 0, bolts: 0, connections: [] });
      const g = groups.get(k);
      g.groups++; g.bolts += Number(b.count) || 0;
      g.connections.push(`${b.ownMark} / ${(b.otherMarks || []).join(", ")}`);
    }
    out.groups = [...groups.values()].sort((x, y) => String(x.standard).localeCompare(String(y.standard)) || (+x.diameter - +y.diameter) || (+x.length - +y.length));
    return out;
  }

  /**
   * Rows for the bolt list export in the layout of the firm report "Multiplan Bolt Location List":
   * per assembly mark a "Marked" row, then per bolt group: line, connected to, site/workshop, comment.
   * @param bolts [{ownMark, count, diameter, standard, length, assemblyCode, connected, kind, comment}]
   */
  function reportRows(bolts) {
    const byMark = new Map();
    for (const b of bolts) {
      const m = String(b.ownMark || "?").trim();
      if (!byMark.has(m)) byMark.set(m, []);
      byMark.get(m).push(b);
    }
    const rows = [];
    for (const m of [...byMark.keys()].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
      rows.push({ type: "mark", mark: m });
      for (const b of byMark.get(m)) rows.push({ type: "bolt", line: boltLine(b),
        connected: String(b.connected == null ? "" : b.connected).replace(/->/g, ", ").replace(/\s+/g, " ").trim(),
        kind: String(b.kind || "").trim(), comment: String(b.comment || "").trim() });
    }
    return rows;
  }

  // ---------- week 3: view settings, mark search, who sees what ----------
  const TABS = ["marks", "deliveries", "fab", "bolts", "docs"];
  const VIEW_DEFAULTS = Object.freeze({ coloured: true, follow: true, tab: "marks" });
  /** Saved view options (the localStorage text, or an object) -> {coloured, follow, tab}. Anything missing, of the wrong
   *  type or unreadable falls back to the default: colouring ON, follow ON, tab "Марки" (A7). */
  function readView(raw) {
    let o = raw;
    if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
    if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
    return { coloured: typeof o.coloured === "boolean" ? o.coloured : VIEW_DEFAULTS.coloured,
      follow: typeof o.follow === "boolean" ? o.follow : VIEW_DEFAULTS.follow,
      tab: TABS.includes(o.tab) ? o.tab : VIEW_DEFAULTS.tab };
  }

  /** Mark search (A5), as the filter in Етикети тактове: "RF" = starts with, "RF22" = exactly RF22 (not RF220),
   *  a number alone ("22") = marks whose number is 22; several terms (space, comma, semicolon) are OR-ed. */
  function matchMark(mark, query) {
    const terms = String(query == null ? "" : query).split(/[\s,;]+/).map(normMark).filter(Boolean);
    if (!terms.length) return true;
    const m = normMark(mark);
    return terms.some((t) => (/^\d+$/.test(t) ? (/(\d+)$/.exec(m) || [])[1] === t || m === t : /\d$/.test(t) ? m === t : m.startsWith(t)));
  }

  // Who is looking (A8): ArstenAccess.side(access) in shared/arsten-access.js, one rule for every panel (round 11, M5).

  // ---------- week 3: the fabricator's files and the last import (A13, B-Office 1) ----------
  const recordsOf = (fab) => (fab instanceof Map ? [...fab.values()] : Object.values(fab || {}));
  const logLines = (r) => String((r && r.log) || "").split("\n").map((l) => l.trim()).filter(Boolean);
  /** The tag the panel adds after the user's name in a history line when the file came from Connect. */
  const fileTag = (ref) => (ref && ref.id ? `file:${ref.id}${ref.versionId ? " v:" + ref.versionId : ""}` : "");
  /**
   * One history line of a fabstatus record, as fabrication.js patchFor writes it:
   * "2026-11-14 08:00 FabDate=2026-11-14 (file.xlsx, Name)" or, imported from Connect,
   * "… (file.xlsx, Name, file:<id> v:<version>)" -> {when, what, source, by, fileId, versionId}; null if not such a line.
   */
  function parseFabLog(line) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (.*?) \((.*)\)$/.exec(String(line || "").trim());
    if (!m) return null;
    let inner = m[3], fileId = "", versionId = "";
    const f = /,\s*file:(\S+?)(?:\s+v:(\S+))?$/.exec(inner);
    if (f) { fileId = f[1]; versionId = f[2] || ""; inner = inner.slice(0, f.index); }
    const k = inner.lastIndexOf(", ");
    const by = k < 0 ? "" : inner.slice(k + 2), source = k < 0 ? inner : inner.slice(0, k);
    return { when: m[1], what: m[2], source: source === "?" ? "" : source, by: by === "?" ? "" : by, fileId, versionId };
  }
  /** Every file name (Source and the history) and every Connect file id (with its versions) ever imported.
   *  manual = names of imports with no Connect file id at all (a file picked from disk, or from before the file tag):
   *  only these may match a Connect file by name, and then only as "maybe" (review 10, M4). A record's Source counts as
   *  manual only when no history line of that record names it (records from before the history). */
  function importRefs(fab) {
    const names = new Set(), ids = new Map(), manual = new Set();
    for (const r of recordsOf(fab)) {
      const named = new Set();
      for (const l of logLines(r)) {
        const p = parseFabLog(l);
        if (!p) continue;
        const src = p.source.trim();
        if (src) { names.add(src); named.add(src); }
        if (p.fileId) { if (!ids.has(p.fileId)) ids.set(p.fileId, new Set()); ids.get(p.fileId).add(p.versionId); }
        else if (src) manual.add(src);
      }
      const source = r && r.Source ? String(r.Source).trim() : "";
      if (source) { names.add(source); if (!named.has(source)) manual.add(source); }
    }
    return { names, ids, manual };
  }
  /**
   * A file in _ArstenDocs/Fabrication, decided by its Connect file id + version as recorded in the history line
   * ("file:<id> v:<ver>"), never by its name alone (review 10, M4):
   *  - "imported" ("внесен"): this id with this very version was imported;
   *  - "newVersion" ("нова версия"): this id was imported, but only other versions of it;
   *  - "maybe" ("внесен?"): cannot be told - the id was recorded without a version (or the listing has none), or the id
   *    is not recorded but a manual import (no file id at all) used the same name;
   *  - "new" ("нов"): anything else, also a same-name file with a new id (the fabricator uploaded the report again).
   */
  function fileState(file, refs) {
    const f = file || {}, r = refs || {};
    const ids = r.ids || new Map(), manual = r.manual || new Set();
    if (f.id && ids.has(f.id)) {
      const vs = ids.get(f.id);
      if (f.versionId && vs.has(f.versionId)) return "imported";
      if (!f.versionId || vs.has("")) return "maybe";
      return "newVersion";
    }
    return manual.has(String(f.name || "").trim()) ? "maybe" : "new";
  }
  /** The newest import over all fabstatus records: {when, source, by, fileId, versionId, assemblies} or null.
   *  assemblies = records whose newest line names the same file on the same day. */
  function lastImport(fab) {
    let best = null;
    const count = new Map();
    for (const r of recordsOf(fab)) {
      const lines = logLines(r);
      const p = lines.length ? parseFabLog(lines[lines.length - 1]) : null;
      if (!p) continue;
      const source = String((r && r.Source) || "").trim() || p.source;
      const k = p.when.slice(0, 10) + "|" + source;
      count.set(k, (count.get(k) || 0) + 1);
      if (!best || p.when > best.when) best = { when: p.when, source, by: p.by, fileId: p.fileId, versionId: p.versionId };
    }
    if (best) best.assemblies = count.get(best.when.slice(0, 10) + "|" + best.source) || 0;
    return best;
  }
  const FAB_EXT = /\.(xlsx|xls|htm|html)$/i;
  const personName = (p) => (p && typeof p === "object" ? [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || "" : String(p || ""));
  /** Core 2.0 folder items found under _ArstenDocs/Fabrication ([{item, path}], path = subfolder) -> the fabricator's
   *  files, newest first: [{id, versionId, name, path, modified, by, size}]. */
  function fabFiles(entries) {
    return (entries || []).filter((e) => e && e.item && String(e.item.type || "FILE").toUpperCase() === "FILE" && FAB_EXT.test(String(e.item.name || "")))
      .map(({ item: x, path }) => ({ id: x.id, versionId: x.versionId || "", name: String(x.name), path: path || "",
        modified: x.modifiedOn || x.modifiedTime || x.createdOn || "", by: personName(x.modifiedBy || x.createdBy), size: x.size || 0 }))
      .sort((a, b) => String(b.modified).localeCompare(String(a.modified)) || a.name.localeCompare(b.name));
  }

  // ---------- week 3: exports with fabrication dates and weights (A14) ----------
  const colName = (i) => (i < 26 ? "" : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
  const r1 = (n) => Math.round(n * 10) / 10;
  const span = (ds) => { const s = ds.filter(Boolean).map(String).sort(); return s.length ? [s[0], s[s.length - 1]] : ["", ""]; };
  const getter = (m) => (g) => (m instanceof Map ? m.get(g) : (m || {})[g]) || {};
  /** Totals row under `n` data rows (rows 2..n+1): SUBTOTAL, so a filter in Excel still sums what is shown. */
  const subtotal = (fn, i, n, result) => ({ formula: `SUBTOTAL(${fn},${colName(i)}2:${colName(i)}${n + 1})`, result });
  /**
   * "По марки" (A14): the old twelve columns unchanged, then fabricated count, fabrication and delivery (Excel) date
   * ranges, weights (kg, from the model's ASSEMBLY weight) and the share by weight fabricated / delivered / erected.
   * Delivered kg = min(delivered, instances) x the mark's average weight (a typed count does not say which piece came).
   * @param av availabilityWithFab result; instances [{guid, mark, weight}]
   * @param o {fab, status, isDelivered(guid), srcName(source), lang}
   * @returns {header, rows, total, pctCols, noWeight}
   */
  function markExportRows(av, instances, o) {
    o = o || {};
    const L = (b, e) => (o.lang === "en" ? e : b);
    const fabOf = getter(o.fab), stOf = getter(o.status);
    const delivered = o.isDelivered || ((g) => !!fabOf(g).DelivDate);
    const src = o.srcName || ((s) => s || "");
    const byMark = new Map(), seen = new Set();
    for (const a of instances || []) {
      if (!a || seen.has(a.guid)) continue;
      seen.add(a.guid);
      const m = normMark(a.mark);
      if (!byMark.has(m)) byMark.set(m, []);
      byMark.get(m).push(a);
    }
    const header = [L("Марка", "Mark"), L("Бр. в модела", "In model"), L("Доставени", "Delivered"), L("Доставени: въведени", "Delivered: typed"), L("Доставени: Excel", "Delivered: Excel"),
      L("Източник", "Source"), L("Монтирани", "Erected"), L("Налични (дост. − монт.)", "Available (deliv. − erect.)"), L("Светнали за монтаж", "Instances ready"), L("Не доставени", "Not delivered"),
      L("Задържани", "On hold"), L("Грешни", "Wrong"),
      L("Изработени", "Fabricated"), L("Изработен от", "Fabricated from"), L("Изработен до", "Fabricated to"), L("Доставен (Excel) от", "Delivered (Excel) from"), L("Доставен (Excel) до", "Delivered (Excel) to"),
      L("Тегло 1 бр. (kg)", "Unit weight (kg)"), L("Тегло общо (kg)", "Total weight (kg)"), L("Изработено (kg)", "Fabricated (kg)"), L("Доставено (kg)", "Delivered (kg)"), L("Монтирано (kg)", "Erected (kg)"),
      L("% изработено (тегло)", "% fabricated (weight)"), L("% доставено (тегло)", "% delivered (weight)"), L("% монтирано (тегло)", "% erected (weight)")];
    const rows = [];
    let anyWeight = false;
    for (const m of av.marks || []) {
      const list = byMark.get(m.mark) || [];
      const w = (a) => num(a.weight) || 0;
      const hasW = list.some((a) => num(a.weight) != null);
      anyWeight = anyWeight || hasW;
      const wTotal = list.reduce((t, a) => t + w(a), 0);
      const wUnit = list.length ? wTotal / list.length : 0;
      const made = list.filter((a) => fabOf(a.guid).FabDate);
      const wFab = made.reduce((t, a) => t + w(a), 0);
      const wDel = Math.min(m.delivered || 0, list.length) * wUnit;
      const wEr = list.filter((a) => stOf(a.guid).erected).reduce((t, a) => t + w(a), 0);
      const [f0, f1] = span(made.map((a) => fabOf(a.guid).FabDate));
      const [d0, d1] = span(list.filter((a) => delivered(a.guid)).map((a) => fabOf(a.guid).DelivDate));
      const kg = (x) => (hasW ? r1(x) : "");
      const pct = (x) => (hasW && wTotal > 0 ? x / wTotal : "");
      rows.push([m.mark, m.instances, m.delivered, m.typed || 0, m.excel || 0, src(m.source), m.erected, m.available, m.ready, m.notDelivered, m.hold, m.wrong,
        made.length, f0, f1, d0, d1, kg(wUnit), kg(wTotal), kg(wFab), kg(wDel), kg(wEr), pct(wFab), pct(wDel), pct(wEr)]);
    }
    const n = rows.length, sumCols = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21];
    const total = header.map(() => "");
    total[0] = L("Общо", "Total");
    const col = (i) => rows.reduce((t, r) => t + (typeof r[i] === "number" ? r[i] : 0), 0);
    for (const i of sumCols) total[i] = subtotal(9, i, n, i >= 18 ? r1(col(i)) : col(i));
    [[22, 19], [23, 20], [24, 21]].forEach(([i, k]) => {
      const res = col(18) > 0 ? col(k) / col(18) : "";
      total[i] = { formula: `IFERROR(SUBTOTAL(9,${colName(k)}2:${colName(k)}${n + 1})/SUBTOTAL(9,${colName(18)}2:${colName(18)}${n + 1}),"")`, result: res };
    });
    return { header, rows, total, pctCols: [22, 23, 24], noWeight: !anyWeight };
  }
  /**
   * "Статус по сглобки" (A14): one row per assembly instance, sorted by mark, with weight, status, fabrication and
   * delivery dates, erection, hold and wrong notes, layer, the Excel file it came from and the IFC GUID.
   * @param o {state: Map guid -> state id, stateName(id), fab, status, holds, isDelivered(guid), lang}
   * @returns {header, rows, total, noWeight}
   */
  function instanceExportRows(instances, o) {
    o = o || {};
    const L = (b, e) => (o.lang === "en" ? e : b);
    const fabOf = getter(o.fab), stOf = getter(o.status), hOf = getter(o.holds);
    const delivered = o.isDelivered || ((g) => !!fabOf(g).DelivDate);
    const stName = o.stateName || ((s) => s);
    const st = o.state instanceof Map ? o.state : new Map();
    const header = [L("Марка", "Mark"), L("Тегло (kg)", "Weight (kg)"), L("Статус", "Status"), L("Изработен", "Fabricated"), L("Доставен (Excel)", "Delivered (Excel)"),
      L("Стокова разписка", "Delivery note"), L("Монтиран на", "Erected on"), L("Монтирал", "Erected by"), L("Бележка (монтаж)", "Note (erection)"),
      L("Задържан: причина", "On hold: reason"), L("Грешно: бележка", "Wrong: note"), L("Слой", "Layer"), L("Excel файл", "Excel file"), "IFC GUID"];
    const seen = new Set();
    const list = (instances || []).filter((a) => a && !seen.has(a.guid) && seen.add(a.guid))
      .sort((x, y) => String(x.mark).localeCompare(String(y.mark), undefined, { numeric: true }) || String(x.guid).localeCompare(String(y.guid)));
    let anyWeight = false;
    const rows = list.map((a) => {
      const f = fabOf(a.guid), s = stOf(a.guid), h = hOf(a.guid), w = num(a.weight);
      if (w != null) anyWeight = true;
      const dd = f.DelivDate ? (delivered(a.guid) ? String(f.DelivDate) : `${f.DelivDate} (${L("план", "planned")})`) : "";
      return [a.mark, w == null ? "" : r1(w), stName(st.get(a.guid) || ""), f.FabDate || "", dd, f.DelivNote || "",
        s.erected ? s.erected_date || "" : "", s.erected ? s.erected_by || "" : "", s.erected ? s.erected_note || "" : "",
        h.hold ? h.hold_reason || "" : "", s.wrong ? s.wrong_note || "" : "", a.layer || "", f.Source || "", a.guid];
    });
    const n = rows.length, total = header.map(() => "");
    total[0] = L("Общо", "Total");
    total[1] = subtotal(9, 1, n, r1(rows.reduce((t, r) => t + (typeof r[1] === "number" ? r[1] : 0), 0)));
    total[2] = subtotal(3, 2, n, n);
    return { header, rows, total, noWeight: !anyWeight };
  }

  // ---------- speed (speed audit 17.11.2026) ----------
  /** Record reads split into calls of `size` links (pset-api batch-get takes 100): one job per chunk, in read order,
   *  each with the index of its read (`at`) and every other field of the read (def, form, soft ...). Item 1. */
  function chunkReads(reads, size) {
    const n = Math.max(1, Math.floor(size) || 100), out = [];
    (reads || []).forEach((r, at) => {
      const links = (r && r.links) || [];
      for (let i = 0; i < links.length; i += n) out.push(Object.assign({}, r, { at, links: links.slice(i, i + n) }));
    });
    return out;
  }
  /** The chunk results (Map link -> props, null = not read) joined back per read, in chunk order: one Map per read. */
  function joinReads(reads, jobs, results) {
    const out = (reads || []).map(() => new Map());
    (jobs || []).forEach((j, k) => { const r = results && results[k]; if (r) for (const [l, p] of r) out[j.at].set(l, p); });
    return out;
  }
  /** Signature of one loaded model for the session's cache of assembly children (item 2a): the model version and every
   *  assembly as runtime id = GUID. No version known -> null (never cached: a new version can keep ids and GUIDs). */
  function modelSig(version, asms) {
    if (version == null || version === "") return null;
    return String(version) + "|" + (asms || []).map((a) => a.id + "=" + a.guid).sort().join(",");
  }
  /** Key of the loaded model set (audit item 8): every model as "id@versionId", sorted, from getModels("loaded").
   *  null when it cannot be compared safely: nothing loaded, not a list, or any model without an id or a versionId
   *  (null never equals anything, so the caller then reloads as before). */
  function modelSetKey(specs) {
    if (!Array.isArray(specs) || !specs.length) return null;
    const out = new Set();
    for (const m of specs) {
      if (!m || m.id == null || m.id === "" || m.versionId == null || m.versionId === "") return null;
      out.add(String(m.id) + "@" + String(m.versionId));
    }
    return [...out].sort().join("|");
  }
  /** The loaded models are the same as at the last finished load: both keys known and equal. */
  const sameModelSet = (a, b) => a != null && b != null && a === b;
  /** Children of each assembly kept per model for the session. take(modelId, sig) gives the kept Map(id -> child ids)
   *  only when the model's signature is the same as when it was read; keep(next) replaces the whole cache with the
   *  models of the newest finished load (a model unloaded meanwhile is dropped and read again when it comes back). */
  function childCache() {
    let models = new Map();
    return {
      take(modelId, sig) { const e = sig ? models.get(modelId) : null; return e && e.sig === sig ? e.kids : null; },
      keep(next) { models = new Map([...(next || new Map())].filter(([, e]) => e && e.sig).map(([m, e]) => [m, { sig: e.sig, kids: e.kids }])); },
      size() { let n = 0; for (const e of models.values()) n += e.kids.size; return n; },
    };
  }
  /** Viewer selection -> assemblies from the maps built at load, without a call per part (item 9a / 10). byKey and
   *  ofChild are keyed "modelId:runtimeId" (assembly itself; part or bolt -> its assembly). Returns {list, unknown}:
   *  list has one slot per selected id in selection order (assembly or null); unknown = {modelId, id, at} still to ask. */
  function selectionAssemblies(selection, byKey, ofChild) {
    const list = [], unknown = [];
    for (const m of selection || []) for (const id of (m && m.objectRuntimeIds) || []) {
      const k = m.modelId + ":" + id;
      const a = (byKey && byKey.get(k)) || (ofChild && ofChild.get(k)) || null;
      if (!a) unknown.push({ modelId: m.modelId, id, at: list.length });
      list.push(a);
    }
    return { list, unknown };
  }
  /** Distinct assemblies of the slots (by GUID, first seen first), nulls skipped. */
  function uniqueAssemblies(list) {
    const m = new Map();
    for (const a of list || []) if (a && !m.has(a.guid)) m.set(a.guid, a);
    return [...m.values()];
  }

  // ---------- review 10, M3: writes vs. a model reload ----------
  /**
   * Book of the writes that landed while a load was running. A load reads into new Maps; a write that finished after
   * the load's read began may be missing from that read, so it is put back over it before the load assigns.
   *   add(field, key, value)   field = "status" | "holds" | "fab" (Maps by GUID) or "deliveries" (array by link);
   *                            value null = deleted. Kept only while a load is running.
   *   mark()                   at the start of a load's read: the sequence number it saw
   *   replay(target, since)    puts every write after `since` into target ({status, holds, fab, deliveries})
   *   loadStarted() / loadEnded()   the book is emptied when the last running load ends
   */
  function writeBook() {
    let seq = 0, loads = 0;
    const list = [];
    return {
      get loading() { return loads > 0; },
      loadStarted() { loads++; },
      loadEnded() { loads = Math.max(0, loads - 1); if (!loads) list.length = 0; },
      mark() { return seq; },
      add(field, key, value) { seq++; if (loads > 0) list.push({ seq, field, key, value }); },
      replay(target, since) {
        let n = 0;
        for (const w of list) {
          if (w.seq <= since) continue;
          const t = target[w.field];
          if (t instanceof Map) { if (w.value == null) t.delete(w.key); else t.set(w.key, w.value); n++; }
          else if (Array.isArray(t)) {
            const i = t.findIndex((d) => d && d.link === w.key);
            if (w.value == null) { if (i >= 0) t.splice(i, 1); }
            else if (i >= 0) t[i] = w.value; else t.unshift(w.value);
            n++;
          }
        }
        return n;
      },
    };
  }

  return { TYPE2, type2Code, boltLine, reportRows, STATES, normMark, parseMarks, parseLines, linesText, deliveredByMark, availability, boxGap, pointBoxDist, tcGuidToIfc, resolveOther, resolveSides, boltList,
    TABS, VIEW_DEFAULTS, readView, matchMark, fileTag, parseFabLog, importRefs, fileState, lastImport, fabFiles, colName, markExportRows, instanceExportRows,
    chunkReads, joinReads, modelSig, modelSetKey, sameModelSet, childCache, selectionAssemblies, uniqueAssemblies, writeBook };
});
