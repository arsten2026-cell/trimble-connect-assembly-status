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

  const STATES = [
    { id: "notDelivered", en: "Not delivered", bg: "Не е доставен", colour: "#9E9E9E" },
    { id: "ready", en: "Ready for erection", bg: "Готов за монтаж", colour: "#E37424" },
    { id: "erected", en: "Erected", bg: "Монтиран", colour: "#2E7D32" },
    { id: "wrong", en: "Wrong (fabrication)", bg: "Грешно изработен", colour: "#C62828" },
    { id: "hold", en: "On hold", bg: "Задържан", colour: "#7B1FA2" },
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

  return { TYPE2, type2Code, boltLine, reportRows, STATES, normMark, parseMarks, parseLines, linesText, deliveredByMark, availability, boxGap, pointBoxDist, tcGuidToIfc, resolveOther, resolveSides, boltList };
});
