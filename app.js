// Assembly status: steel erection in the Trimble Connect 3D viewer.
// Statuses per assembly INSTANCE (erected / wrong / on hold) and deliveries per MARK are stored in the project
// library "STEEL/Монтаж" (records.js); availability and the bolt erection list come from steel.js.
// Access (shared/arsten-access.js, app "assembly"): panel for ADMIN, GENERAL CONTRACTOR, DESIGNERS;
// erected / wrong / deliveries for ADMIN + GC; holds for ADMIN + GC + DESIGNERS.
(() => {
  "use strict";
  const L = window.SteelLogic, R = window.SteelRecords, A = window.PsetApi, F = window.SteelFab;
  const $ = (id) => document.getElementById(id);
  const BATCH = 200;
  const ELEMENT_ASSEMBLY = 4;   // HierarchyType.ElementAssembly
  const T = {
    title: ["Стомана", "Steel"],
    selection: ["Избрано", "Selection"], follow: ["Следи избора в модела", "Follow model selection"], clear: ["Изчисти", "Clear"],
    nothing: ["Нищо не е избрано. Изберете сглобки в модела или марка от таблицата.", "Nothing selected. Select assemblies in the model or a mark in the table."],
    view: ["Изглед", "View"], colour: ["Оцвети по статус", "Colour by status"],
    marks: ["Марки", "Marks"], deliveries: ["Доставки", "Deliveries"], fab: ["Производство", "Fabrication"], bolts: ["Болтове", "Bolts"], docs: ["Документи", "Documents"],
    erected: ["Монтиран", "Erected"], wrong: ["Грешно изработен", "Wrong (fabrication)"], hold: ["Задържан", "On hold"],
    set: ["Отбележи", "Set"], undo: ["Отмени", "Undo"], note: ["Бележка", "Note"], reason: ["Причина", "Reason"],
    noRight: ["Нямате права за това.", "You have no rights for this."],
  };
  let lang = (() => { try { return localStorage.getItem("arsten.assemblyStatus.lang") || "bg"; } catch { return "bg"; } })();
  const t = (k) => (T[k] ? T[k][lang === "bg" ? 0 : 1] : k);
  const L2 = (b, e) => (lang === "bg" ? b : e);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? String(Math.round(n * 10) / 10) : String(v == null ? "" : v); };
  const oldDate = (d) => { if (!d) return false; const t0 = new Date(); t0.setDate(t0.getDate() - 7); return String(d) < `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, "0")}-${String(t0.getDate()).padStart(2, "0")}`; };   // > 7 days back (A6)
  const fmtDate = (d) => (d ? (lang === "bg" ? String(d).split("-").reverse().join(".") : d) : "");
  function setStatus(text, bad) { $("status").textContent = text; $("status").className = "status" + (bad ? " bad" : ""); }
  // the result of a write is also shown at the bottom, next to the user's finger on a tablet (week 1, A2)
  let toastTimer = 0;
  function toast(text, bad) {
    const el = $("toast");
    if (!el) return;
    el.setAttribute("role", bad ? "alert" : "status");
    el.textContent = text; el.className = "show " + (bad ? "bad" : "ok");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ""; }, bad ? 7000 : 4000);
  }
  const flash = (text, bad) => { setStatus(text, bad); toast(text, bad); };
  const BUILD = ((document.currentScript && /[?&]v=(\d+)/.exec(document.currentScript.src)) || [])[1] || "dev";
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  async function guarded(fn) { try { await fn(); } catch (e) { flash(L2("Грешка: ", "Error: ") + errText(e), true); console.error(e); } }
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
  }

  const state = {
    api: null, client: null, project: null, user: "", access: null, lib: null, ready: false,
    asms: [], byKey: new Map(), byGuid: new Map(),   // assembly instances {modelId, id, guid, mark, layer, weight, finish, parts:[runtime ids]}
    bolts: [], status: new Map(), holds: new Map(), deliveries: [],
    fab: new Map(), fabPlan: null,   // fabrication dates per IFC GUID (fabrication.js); the import waiting for "Save"
    sel: [], coloured: false, tab: "marks", boltScope: "all", follow: true,
    drafts: {}, flagArmed: null, dlvPending: null,   // typed date/note per card kept across selection changes (F6); big-write confirm (F1); delivery file waiting for "Запиши" (F7)
    noBackupAsk: null, noBackupOk: null,   // failed undo file before fab-clear / Премести: the inline question, and the action confirmed without one (review 9 M5)
  };
  const key = (modelId, id) => modelId + ":" + id;
  // Pset link of a model object. FRN (Trimble's link notation) wants every segment URL-encoded, and Connect's own
  // panel and Tekla look an IFC GUID up encoded: "$" -> "%24". Links written with a raw "$" (before v16) are never
  // shown there, so they are still read (legacyLink) but every new write goes to the encoded link (15.11.2026).
  const entLink = (guid) => "frn:entity:" + encodeURIComponent(guid);
  const legacyLink = (guid) => "frn:entity:" + guid;
  const hasLegacy = (guid) => entLink(guid) !== legacyLink(guid);
  /** GUID of a pset link, whichever form it is in (raw "$" or "%24"). */
  const guidOfLink = (l) => { const g = String(l).replace(/^frn:entity:/, ""); try { return decodeURIComponent(g); } catch { return g; } };
  // a raw-"$" copy already contained in the encoded record (same record, or its last history line is there): only deleted
  const lastLine = (log) => String(log || "").split("\n").filter(Boolean).pop() || "";
  const isStale = (raw, enc) => { const rl = lastLine(raw.log); return JSON.stringify(raw) === JSON.stringify(enc) || (rl !== "" && String(enc.log || "").includes(rl)); };
  const can = (what) => {
    const r = state.access && state.access.role;
    if (window.ARSTEN_DEMO) return true;
    if (what === "fab") what = "status";   // fabrication import: same people as statuses for now; a fabricator group later (round 5, L10)
    return what === "hold" ? ["admin", "gc", "designer"].includes(r) : ["admin", "gc"].includes(r);
  };

  // ---------- token ----------
  let token = null, waiters = [];
  function onToken(tk) { token = tk; const w = waiters; waiters = []; w.forEach((f) => f(tk)); }
  async function getToken(refresh) {
    if (token && !refresh) return token;
    const p = new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error("No access token from Trimble Connect")), 60000); });
    const r = await state.api.extension.requestPermission("accesstoken");
    if (r === "denied") throw new Error("Access to Trimble Connect data was denied for this extension.");
    if (r && r !== "pending" && r !== "granted") { token = r; return r; }
    return p;
  }

  // ---------- model ----------
  const psetOf = (p, re) => { const s = (p.properties || []).find((x) => re.test(x.name || "")); const o = {}; if (s) for (const q of s.properties || []) o[q.name] = q.value; return s ? o : null; };
  const val = (o, re) => { const k = Object.keys(o || {}).find((x) => re.test(x)); return k ? o[k] : undefined; };

  // Every object of the loaded models with its class (read once; used when the native class filter returns nothing,
  // which happens in Connect for some exports, and for assemblies that only exist as hierarchy nodes).
  // allObjects: the last finished load's list (shown in the "no assemblies" diagnostics). Each load reads into its own
  // ctx.all, so two overlapping loads never share or reset one list (review round 3, M3).
  let allObjects = null;
  async function readAll(ctx) {
    if (ctx.all) return ctx.all;
    const api = state.api, all = [];
    for (const m of (await api.viewer.getObjects()) || []) {
      const ids = (m.objects || []).map((o) => o.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        if (ctx.stale()) return all;
        for (const p of (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || []) all.push({ modelId: m.modelId, id: p.id, cls: String(p.class || "") });
        setStatus(L2(`Чета модела… ${Math.min(i + BATCH, ids.length)} от ${ids.length}`, `Reading the model… ${Math.min(i + BATCH, ids.length)} of ${ids.length}`));
      }
    }
    ctx.all = all;
    return all;
  }
  async function idsOfClass(cls, ctx) {
    const api = state.api;
    let models = [];
    try { models = (await api.viewer.getObjects({ parameter: { class: cls } })) || []; } catch {}
    const found = models.map((m) => ({ modelId: m.modelId, ids: (m.objects || []).map((o) => o.id) })).filter((m) => m.ids.length);
    if (found.length) return found;
    const re = new RegExp(`^${cls}$`, "i");
    const byModel = new Map();
    for (const o of await readAll(ctx)) if (re.test(o.cls)) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    if (!byModel.size && /elementassembly/i.test(cls)) {
      // assemblies as parents of the parts (as in Cast unit tags)
      const all = (await readAll(ctx)).filter((o) => !/elementassembly/i.test(o.cls));
      const seen = new Set();
      let done = 0;
      await pool(all, 8, async (o) => {
        if (ctx.stale()) return;
        try {
          const ps = (await api.viewer.getHierarchyParents(o.modelId, [o.id], ELEMENT_ASSEMBLY)) || [];
          for (const p of ps) { const k = key(o.modelId, p.id); if (!seen.has(k)) { seen.add(k); if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(p.id); } }
        } catch {}
        if (++done % 100 === 0) setStatus(L2(`Търся сглобките… ${done} от ${all.length}`, `Finding assemblies… ${done} of ${all.length}`));
      });
    }
    return [...byModel].map(([modelId, ids]) => ({ modelId, ids }));
  }

  async function readClass(cls, psetRe, ctx) {
    const api = state.api, out = [];
    for (const m of await idsOfClass(cls, ctx)) {
      const ids = m.ids;
      for (let i = 0; i < ids.length; i += BATCH) {
        if (ctx.stale()) return [];
        const chunk = ids.slice(i, i + BATCH);
        const props = (await api.viewer.getObjectProperties(m.modelId, chunk)) || [];
        const guids = (await api.viewer.convertToObjectIds(m.modelId, chunk)) || [];
        props.forEach((p, k) => { const ps = psetOf(p, psetRe); out.push({ modelId: m.modelId, id: p.id, guid: guids[k] || null, ps: ps || {} }); });
      }
    }
    return out.filter((o) => o.guid);
  }
  async function parentAssembly(modelId, id, byKey) {
    const ps = (await state.api.viewer.getHierarchyParents(modelId, [id], ELEMENT_ASSEMBLY)) || [];
    for (const p of ps) { const a = (byKey || state.byKey).get(key(modelId, p.id)); if (a) return a; }
    return null;
  }
  /** GUID -> runtime id for a chunk; a chunk that fails is split in halves and retried, so one bad GUID or a timeout
   *  does not drop 500 main parts (review round 2, #12). Result is index-aligned with the chunk (null = not found).
   *  Bounded (review round 3, M8): stops halving below 32 GUIDs (those count as failed), stops at once when the load
   *  is stale, and ctx.failed counts the GUIDs that could not be asked so the caller can give up on a dead model. */
  async function toRuntimeIds(modelId, chunk, ctx) {
    if (ctx.stale()) return chunk.map(() => null);
    try {
      const r = (await state.api.viewer.convertToObjectRuntimeIds(modelId, chunk)) || [];
      return chunk.map((_, k) => (r[k] != null ? r[k] : null));
    } catch (e) {
      if (chunk.length <= 32) {
        // one by one, once: a single bad GUID must not drop its good neighbours (review round 4, M3)
        const out = [];
        for (const g of chunk) {
          if (ctx.stale()) { out.push(null); continue; }
          try { const r = (await state.api.viewer.convertToObjectRuntimeIds(modelId, [g])) || []; out.push(r[0] != null ? r[0] : null); }
          catch { ctx.failed++; out.push(null); }
        }
        return out;
      }
      const h = chunk.length >> 1;
      const a = await toRuntimeIds(modelId, chunk.slice(0, h), ctx);
      return a.concat(await toRuntimeIds(modelId, chunk.slice(h), ctx));
    }
  }

  /**
   * Reads assemblies and bolts of the loaded models. Builds everything into local variables and assigns to state only
   * at the end; returns false (and changes nothing) when a newer load started meanwhile, e.g. a stage that loads and
   * unloads models fires several model events while a slow load is still running (review round 2, #3).
   */
  async function loadModel(gen) {
    const stale = () => gen !== loadGen;
    const ctx = { stale, all: null, failed: 0 };   // this load's own object cache and lookup failures
    setStatus(L2("Чета сглобките…", "Reading assemblies…"));
    const raw = await readClass("IfcElementAssembly", /^Assembly/i, ctx);
    if (stale()) return false;
    // the same assembly in two loaded models (overlapping exports, two versions): keep the first, warn (#11)
    const seenGuid = new Set();
    let dupAsms = 0;
    const asms = [];
    for (const a of raw) {
      if (seenGuid.has(a.guid)) { dupAsms++; continue; }
      seenGuid.add(a.guid);
      asms.push({ modelId: a.modelId, id: a.id, guid: a.guid, mark: String(val(a.ps, /Assembly_Pos/i) || "").trim(),
        layer: val(a.ps, /^Layer/i) || "", weight: val(a.ps, /Assembly_Weight/i) || "", finish: val(a.ps, /^Finish/i) || "", parts: [] });
    }
    const byKey = new Map(asms.map((a) => [key(a.modelId, a.id), a]));
    const byGuid = new Map(asms.map((a) => [a.guid, a]));
    // children of each assembly (parts and, in Tekla IFC, its bolts): one call per ASSEMBLY, reused below so the bolts
    // need no call each (4000 bolts used to mean ~8000 one-by-one calls; user 15.11.2026)
    const asmOfChild = new Map();   // key(model, child runtime id) -> assembly
    let doneA = 0, childErrors = 0;
    await pool(asms, 8, async (a) => {
      if (stale()) return;
      try { a.parts = ((await state.api.viewer.getHierarchyChildren(a.modelId, [a.id], ELEMENT_ASSEMBLY)) || []).map((c) => c.id); }
      catch { a.parts = []; childErrors++; }
      for (const id of a.parts) asmOfChild.set(key(a.modelId, id), a);
      if (++doneA % 50 === 0 && !stale()) setStatus(L2(`Чета сглобките… ${doneA} от ${asms.length}`, `Reading assemblies… ${doneA} of ${asms.length}`));
    });
    if (stale()) return false;
    setStatus(L2("Чета болтовете…", "Reading bolts…"));
    const rawBolts = await readClass("IfcMechanicalFastener", /^Bolt/i, ctx);
    if (stale()) return false;
    // a bolt group loaded twice (two overlapping models) is counted once (#11)
    const seenBolt = new Set();
    let dupBolts = 0;
    const fs = rawBolts.filter((f) => { if (seenBolt.has(f.guid)) { dupBolts++; return false; } seenBolt.add(f.guid); return true; });
    // bolts are not parts: keep them out of the parts lists (colouring)
    const boltKeys = new Set(rawBolts.map((f) => key(f.modelId, f.id)));
    for (const a of asms) a.parts = a.parts.filter((id) => !boltKeys.has(key(a.modelId, id)));
    const assemblyOfPart = new Map();
    // main parts: Tekla GUID -> IFC GlobalId -> runtime id, in batches of 500 per model, then its assembly from the map
    const mainByModel = new Map();
    for (const f of fs) {
      const ifc = L.tcGuidToIfc(String(val(f.ps, /Main_Part_GUID/i) || "").trim());
      if (!ifc) continue;
      if (!mainByModel.has(f.modelId)) mainByModel.set(f.modelId, new Set());
      mainByModel.get(f.modelId).add(ifc);
    }
    const asmModels = [...new Set(asms.map((a) => a.modelId))];
    let slow = 0;   // lookups that still needed a call each (fallback)
    for (const [m, set] of mainByModel) {
      // the bolt's own model first, then the other loaded models (bolts exported apart from their parts, #11)
      let todo = [...set];
      for (const mm of [m].concat(asmModels.filter((x) => x !== m))) {
        if (!todo.length) break;
        const notFound = [];
        for (let i = 0; i < todo.length; i += 500) {
          const chunk = todo.slice(i, i + 500);
          const failedBefore = ctx.failed;
          const rts = await toRuntimeIds(mm, chunk, ctx);
          if (stale()) return false;
          // the whole chunk could not even be asked (model unloaded, viewer busy): give up on this model (M8)
          if (ctx.failed - failedBefore >= chunk.length) { notFound.push(...todo.slice(i)); break; }
          const missing = [];
          chunk.forEach((g, k) => {
            const a = rts[k] != null ? asmOfChild.get(key(mm, rts[k])) : null;
            if (a) assemblyOfPart.set(g, a.guid); else if (rts[k] != null) missing.push([g, rts[k]]); else notFound.push(g);
          });
          await pool(missing, 6, async ([g, rt]) => { slow++; try { const a = await parentAssembly(mm, rt, byKey); if (a) assemblyOfPart.set(g, a.guid); } catch {} });
          if (stale()) return false;
        }
        todo = notFound;
      }
    }
    const bolts = [];
    let doneB = 0;
    await pool(fs, 6, async (f) => {
      if (stale()) return;
      let own = asmOfChild.get(key(f.modelId, f.id)) || null;
      if (!own) { slow++; try { own = await parentAssembly(f.modelId, f.id, byKey); } catch { own = null; } }
      if (++doneB % 200 === 0 && !stale()) setStatus(L2(`Чета болтовете… ${doneB} от ${fs.length}`, `Reading bolts… ${doneB} of ${fs.length}`));
      const hasLinks = Object.keys(f.ps).some((k) => /Main_Part_GUID|Connected_Assemblies/i.test(k));
      const mainPart = String(val(f.ps, /Main_Part_GUID/i) || "").trim();
      const ca = val(f.ps, /Connected_Assemblies/i);
      bolts.push({ modelId: f.modelId, id: f.id, guid: f.guid, ownGuid: own && own.guid, ownMark: own ? own.mark : "?",
        mainPart, otherMarks: hasLinks ? L.parseMarks(ca) : null, connected: ca || "",
        kind: String(val(f.ps, /Site_Workshop/i) || "").trim(), assemblyCode: val(f.ps, /Assembly_Code/i) || "", comment: val(f.ps, /^Comment/i) || "",
        name: val(f.ps, /Bolt Name/i) || "", standard: val(f.ps, /^Standard/i) || "", length: val(f.ps, /^Length/i), diameter: val(f.ps, /^Diameter/i), count: val(f.ps, /Bolt count/i) });
    });
    if (stale()) return false;
    // fallback geometry only for bolts without a usable Main_Part_GUID (old exports)
    const needFallback = bolts.some((b) => b.otherMarks && b.otherMarks.length && !assemblyOfPart.get(L.tcGuidToIfc(b.mainPart)));
    const assemblies = needFallback ? await assemblyBoxes(asms) : [];
    if (needFallback) {
      const byModel = new Map();
      for (const b of bolts) { if (!byModel.has(b.modelId)) byModel.set(b.modelId, []); byModel.get(b.modelId).push(b); }
      for (const [m, list] of byModel) {
        const boxes = (await state.api.viewer.getObjectBoundingBoxes(m, list.map((b) => b.id))) || [];
        const bm = new Map(boxes.map((x) => [x.id, x.boundingBox]));
        list.forEach((b) => { b.bbox = bm.get(b.id); });
      }
    }
    if (stale()) return false;
    // In an export that has the link properties, bolts without them (anchors) are single-assembly bolts.
    const exportHasLinks = bolts.some((b) => b.otherMarks != null);
    if (exportHasLinks) for (const b of bolts) if (b.otherMarks == null) b.otherMarks = [];
    for (const b of bolts) b.sides = b.ownGuid ? L.resolveSides(b, { assemblyOfPart, assemblies, opts: { abs: 0.2, rel: 0.1 } }) : { unresolved: "no-own-assembly" };
    // everything at once, so the panel never shows half of one load and half of another
    state.asms = asms; state.byKey = byKey; state.byGuid = byGuid;
    state.bolts = bolts;
    state.loadStats = { assemblies: asms.length, bolts: bolts.length, slowLookups: slow, dupAsms, dupBolts, childErrors, lookupFailed: ctx.failed };
    allObjects = ctx.all;
    state.hasLinks = exportHasLinks;
    return true;
  }
  async function assemblyBoxes(asms) {
    const out = [];
    for (const a of asms) {
      let boxes = [];
      try { boxes = ((await state.api.viewer.getObjectBoundingBoxes(a.modelId, a.parts.length ? a.parts : [a.id])) || []).map((x) => x.boundingBox).filter(Boolean); } catch {}
      out.push({ guid: a.guid, mark: a.mark, boxes });
    }
    return out;
  }

  // ---------- library ----------
  /** Statuses, holds and deliveries of the loaded assemblies. Read into locals; assigned only when this is still the
   *  newest load, so a slow older load cannot overwrite the newer load's statuses (review round 3, M1). Without gen
   *  (after a save) it always assigns. */
  async function loadRecords(gen) {
    const current = () => gen === undefined || gen === loadGen;
    const found = await state.client.findLibrary(state.project.id, R.LIB_NAMES);
    if (!current()) return false;
    if (!found.lib) {
      state.lib = null;
      $("setupBox").hidden = false;
      $("setupBox").innerHTML = found.denied ? L2(`Библиотеката <b>STEEL/Монтаж</b> не е видима за вас – може да съществува, но без достъп за вас. Попитайте администратора на проекта, преди някой да създаде нова.`,
        `The library <b>STEEL/Монтаж</b> is not visible to you – it may exist without access for you. Ask the project admin before anyone creates a new one.`) : L2(`Библиотеката <b>STEEL/Монтаж</b> още не съществува. Администратор я създава веднъж в Connect: Property Set Libraries → New library → име „STEEL/Монтаж“. Статусите не могат да се записват дотогава.`,
        `The library <b>STEEL/Монтаж</b> does not exist yet. An admin creates it once in Connect: Property Set Libraries → New library → name "STEEL/Монтаж". Statuses cannot be saved until then.`);
      return;
    }
    $("setupBox").hidden = true;
    state.lib = found.lib;
    for (const d of R.definitions()) {
      try { await state.client.ensureDefinition(state.lib.id, d); }
      catch (e) { if (e.status !== 403) throw e; }   // non-admins cannot create definitions; reading still works
    }
    const links = state.asms.map((a) => entLink(a.guid));
    const legacy = state.asms.filter((a) => hasLegacy(a.guid)).map((a) => legacyLink(a.guid));
    const toMap = (m) => new Map([...m].map(([l, p]) => [guidOfLink(l), p]));
    // Records still under a raw-"$" link (Connect's own panel and Tekla never show them) are listed in
    // state.legacyOnly for "Премести": kind "move" = only the raw record exists; "merge" = both exist and the raw one
    // has history the encoded one lacks (an old cached client wrote it after the move, round 6 M2) - its fields win;
    // "stale" = the raw one is an old copy already contained in the encoded record - only deleted.
    const legacyOnly = [];
    const readBoth = async (def) => {
      const old = legacy.length ? toMap(await state.client.readMany(state.lib.id, def, legacy)) : new Map();
      const cur = toMap(await state.client.readMany(state.lib.id, def, links));
      const out = new Map(cur);
      for (const [g, p] of old) {
        if (!cur.has(g)) { legacyOnly.push({ def, guid: g, kind: "move" }); out.set(g, p); }
        else if (isStale(p, cur.get(g))) legacyOnly.push({ def, guid: g, kind: "stale" });
        else { legacyOnly.push({ def, guid: g, kind: "merge" }); out.set(g, Object.assign({}, cur.get(g), p, { log: [cur.get(g).log, p.log].filter(Boolean).join("\n") })); }
      }
      return out;
    };
    const status = await readBoth(R.DEF.status);
    const holds = await readBoth(R.DEF.hold);
    // fabrication dates: an admin's first visit creates the definition; until then there is nothing to read. Any
    // error here only disables the Производство tab, never the rest of Стомана (round 5, M3)
    let fab = new Map(), fabError = "";
    try {
      try { await state.client.ensureDefinition(state.lib.id, F.definition()); } catch (e) { if (e.status !== 403) throw e; }
      fab = await readBoth(F.DEF_ID);
    } catch (e) {
      if (e.status !== 404) { fabError = errText(e); console.warn("fabrication dates not available", e); }
    }
    const dels = await state.client.listAll(state.lib.id, R.DEF.delivery, R.deliveryPrefix(state.project.id));
    if (!current()) return false;
    state.status = status; state.holds = holds; state.fab = fab; state.fabError = fabError; state.legacyOnly = legacyOnly;
    state.deliveries = [...dels].map(([link, p]) => Object.assign({ link }, p)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return true;
  }

  // ---------- figures ----------
  // delivered per mark = max(typed deliveries, instances with an Excel DelivDate); an instance with a DelivDate counts
  // as delivered for its colour; an undated one only for typed deliveries beyond the dated / erected pieces (owner's rule
  // 16.11.2026, review 9 H3 / M6, records.js availabilityWithFab)
  const avail = () => R.availabilityWithFab(L, state.asms, state.status, state.holds, state.deliveries, state.fab);
  /** Where a mark's delivered figure comes from: "въведени" / "Excel" / both. */
  const srcName = (src) => ({ typed: L2("въведени", "typed"), excel: "Excel", both: L2("въведени + Excel", "typed + Excel") }[src] || "");
  const srcFigures = (m) => `Excel: ${m.excel}, ${L2("въведени", "typed")}: ${m.typed}`;
  const differsWarn = (av) => (av.differs.length ? `<div class="warn">${esc(L2("Доставени: Excel от производителя и въведените доставки се различават (брои се по-голямото): ", "Delivered: the fabricator's Excel and the typed deliveries differ (the larger counts): "))}${esc(av.differs.map((m) => `${m.mark} (${srcFigures(m)})`).join(", "))}</div>` : "");
  const erectedFn = () => (g) => !!(state.status.get(g) || {}).erected;

  // ---------- colours ----------
  const sel = (objs) => {
    const byModel = new Map();
    for (const o of objs) for (const id of (o.parts && o.parts.length ? o.parts : [o.id])) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(id); }
    return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
  };
  async function applyColours() {
    if (!state.asms.length) return;
    if (!state.coloured) return state.api.viewer.setObjectState(sel(state.asms), { color: "reset", opacity: 1 });
    const st = avail().state;
    for (const s of L.STATES) {
      const list = state.asms.filter((a) => st.get(a.guid) === s.id);
      if (list.length) await state.api.viewer.setObjectState(sel(list), { color: s.colour, opacity: s.id === "notDelivered" ? 0.35 : 1 });
    }
  }

  // ---------- undo files before mass actions (shared/arsten-backup.js, owner 16.11.2026) ----------
  const backupCache = new Map();
  let backupCore = null;
  const coreFor = () => window.ARSTEN_PHOTOS_CORE || backupCore || (backupCore = ArstenBackup.coreClient(ArstenAccess.coreBase(state.project.location), getToken));
  /** Snapshot of the records [{def, link}] an action is about to change or delete, read fresh (or taken from `known`,
   *  Map def -> Map link -> props), uploaded to _ArstenDocs/Backups/<day>/ before the action runs. Upload failed: the
   *  JSON is downloaded in the browser and the action goes on. A failed READ stops the action: nothing changes without
   *  its undo file. Returns the text added to the result message.
   *  Review 9: no window.ArstenBackup -> the action stops (low 14); a batch-get that echoed a requested link in the
   *  other "$" form stops it too (M4); nothing saved at all gets its own wording (M5). `destructive` (fab-clear,
   *  Премести): without a successful upload the action stops once and asks "Продължи без архив" inline; returns null
   *  then and the caller must not go on. */
  const NO_BACKUP = () => L2("Архивът не може да се направи – нищо не е променено: ", "The backup could not be made – nothing was changed: ");
  async function backupFirst(action, items, known, destructive) {
    if (!items.length) return "";
    if (!window.ArstenBackup) throw new Error(NO_BACKUP() + L2("модулът за архив (arsten-backup.js) не е зареден. Презаредете панела.", "the backup module (arsten-backup.js) is not loaded. Reload the panel."));
    const maps = new Map(known || []);
    try {
      for (const def of new Set(items.map((x) => x.def))) {
        if (maps.has(def)) continue;
        const asked = [...new Set(items.filter((x) => x.def === def).map((x) => x.link))];
        const got = await state.client.readMany(state.lib.id, def, asked);
        const odd = R.echoMismatch(asked, got, guidOfLink);
        if (odd.length) { console.warn("batch-get returned another link form for", odd, [...got.keys()]); throw new Error(L2(`услугата върна друга форма на връзката за ${odd.length} записа`, `the service returned another link form for ${odd.length} records`)); }
        maps.set(def, got);
      }
    } catch (e) { throw new Error(NO_BACKUP() + errText(e)); }
    const snap = ArstenBackup.snapshot({ tool: "steel", action, project: state.project, by: state.user, library: state.lib, records: ArstenBackup.recordsFrom(items, maps) });
    const res = await ArstenBackup.save({ core: coreFor(), projectId: state.project.id, snapshot: snap, cache: backupCache });
    const allowed = state.noBackupOk === action;
    state.noBackupOk = null;
    if (res.uploaded) return ArstenBackup.note(res, lang);
    console.warn("backup not uploaded to Connect", res.error);
    const text = res.downloaded ? ArstenBackup.failedText(lang)
      : L2("Архивът НЕ е запазен – нито е качен в Connect, нито е изтеглен", "The backup was NOT saved – neither uploaded to Connect nor downloaded");
    if (destructive && !allowed) {
      state.noBackupAsk = { action, text };
      flash(text + L2(". Действието е спряно – нищо не е променено.", ". The action was stopped – nothing was changed."), true);
      render();
      return null;
    }
    toast(text, true);
    return " · " + text;
  }
  /** Inline second confirmation after a failed backup of a destructive action (review 9 M5). */
  function noBackupBox() {
    const q = state.noBackupAsk;
    if (!q) return "";
    return `<div class="warn"><b>${esc(q.text)}.</b> ${esc(L2("Действието е спряно. Опитайте пак по-късно или продължете без архив (без възможност за връщане).", "The action was stopped. Try again later or go on without a backup (no way back)."))}
      <div class="bar"><button class="small" data-act="noBackupGo">${esc(L2("Продължи без архив", "Continue without backup"))}</button><button class="small secondary" data-act="noBackupNo">${esc(L2("Откажи", "Cancel"))}</button></div></div>`;
  }
  /** The links a write to these GUIDs touches: the encoded one, plus the raw-"$" copy dropLegacy deletes. */
  const linksOf = (def, guids) => guids.flatMap((g) => [{ def, link: entLink(g) }]
    .concat((state.legacyOnly || []).some((r) => r.def === def && r.guid === g) ? [{ def, link: legacyLink(g) }] : []));

  // ---------- writing ----------
  const stateName =(id) => { const s = L.STATES.find((x) => x.id === id); return s ? (lang === "bg" ? s.bg : s.en) : id; };
  // Who a "Отбележи" / "Отмени" press writes (week 1, F1): "on" writes only the selected pieces that are not marked
  // yet, so dates, names and notes already recorded are never overwritten. Only when every selected piece is marked
  // does "on" correct them all (the button then says "Поправи"). "off" writes only the marked ones.
  function flagTargets(kind, on) {
    const store = kind === "hold" ? state.holds : state.status;
    const marked = (a) => !!(store.get(a.guid) || {})[kind];
    if (!on) return { list: state.sel.filter(marked), correcting: false };
    const notYet = state.sel.filter((a) => !marked(a));
    return notYet.length ? { list: notYet, correcting: false } : { list: state.sel.slice(), correcting: state.sel.length > 0 };
  }
  const BIG = 10;   // more than this many pieces in one press needs a second tap within 10 s
  const flagArmed = (kind, on, n) => !!state.flagArmed && state.flagArmed.key === `${kind}:${on ? 1 : 0}:${n}` && Date.now() - state.flagArmed.at < 10000;
  async function applyFlag(kind, on) {
    if (!state.lib) return flash(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can(kind === "hold" ? "hold" : "status")) return flash(t("noRight"), true);
    const { list: targets, correcting } = flagTargets(kind, on);
    if (!targets.length) return;
    if (targets.length > BIG && !flagArmed(kind, on, targets.length)) {
      state.flagArmed = { key: `${kind}:${on ? 1 : 0}:${targets.length}`, at: Date.now() }; render(); setTimeout(render, 10500); return;
    }
    state.flagArmed = null;
    const typedDate = ($("d_" + kind) || {}).value || "";
    const date = typedDate || R.today();
    const note = (($("n_" + kind) || {}).value || "").trim();
    const noteKey = kind === "hold" ? "hold_reason" : `${kind}_note`;
    // a correction with an empty box keeps each piece's own value (round 8 M1); a new mark needs the note as before
    if (on && kind !== "erected" && !note && !correcting) return flash(L2("Въведете бележка / причина.", "Enter a note / reason."), true);
    if (on && date > R.today()) return flash(L2("Датата е в бъдещето.", "The date is in the future."), true);
    const def = kind === "hold" ? R.DEF.hold : R.DEF.status, store = kind === "hold" ? state.holds : state.status;
    // more than BIG pieces (the confirmed path): undo file first
    const bak = targets.length > BIG ? await backupFirst(`${kind}-${on ? (correcting ? "correct" : "set") : "undo"}`, linksOf(def, targets.map((a) => a.guid))) : "";
    let done = 0, failed = 0, first = "";
    await pool(targets, 6, async (a) => {
      const cur = store.get(a.guid) || null;
      if (!on && !(cur && cur[kind])) return;
      let info = { date, note, by: state.user, mark: a.mark };
      if (correcting && cur) {
        const ownDate = cur[`${kind}_date`] || date;
        const newDate = typedDate && typedDate !== ownDate ? typedDate : ownDate;
        info = { date: newDate, note: note || cur[noteKey] || "", by: newDate !== ownDate ? state.user : cur[`${kind}_by`] || state.user, mark: a.mark };
      }
      const next = R.setFlag(cur, kind, on, info);
      try {
        if (!on && hasRaw(def, a.guid)) {
          // undo over a raw-"$" copy (review 9 M1): full record to the encoded link, raw copy deleted, then the replace
          await R.replaceOverRaw(state.client, state.lib.id, def, entLink(a.guid), legacyLink(a.guid), next);
          state.legacyOnly = state.legacyOnly.filter((r) => !(r.def === def && r.guid === a.guid));
          store.set(a.guid, next); done++;
        } else {
          await (on ? state.client.write : state.client.replace).call(state.client, state.lib.id, def, entLink(a.guid), next);
          store.set(a.guid, next); done++;
          await dropLegacy(def, a.guid);
        }
      } catch (e) { failed++; if (!first) first = e.status === 403 ? t("noRight") : errText(e); }
    });
    if (done && !failed) delete state.drafts[kind];
    const skipped = on ? state.sel.length - targets.length : 0;
    flash(`${t(kind)}: ${on ? L2("записано", "saved") : L2("отменено", "undone")} ${done}`
      + (skipped ? ` · ${skipped} ${L2("вече отбелязани – не са променени", "already marked – left as they were")}` : "")
      + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "") + bak, failed > 0);
    render();
    if (state.coloured) await applyColours();
  }

  async function addDelivery(lines, source) {
    if (!state.lib) return setStatus(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can("status")) return setStatus(t("noRight"), true);
    if (!lines.length) return setStatus(L2("Няма редове с марка и количество.", "No lines with mark and quantity."), true);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rec = R.newDelivery({ date: $("dlvDate").value || R.today(), noteNo: $("dlvNo").value.trim(), lines: L.linesText(lines), by: state.user, source });
    const link = R.deliveryLink(state.project.id, id);
    await state.client.write(state.lib.id, R.DEF.delivery, link, rec);
    state.deliveries.unshift(Object.assign({ link }, rec));
    const known = new Set(state.asms.map((a) => L.normMark(a.mark)));
    const unknown = lines.filter((l) => !known.has(l.mark)).map((l) => l.mark);
    flash(L2(`Доставката е записана (${lines.length} марки)`, `Delivery saved (${lines.length} marks)`) + (unknown.length ? ` · ${L2("няма в модела", "not in the model")}: ${unknown.join(", ")}` : ""), unknown.length > 0);
    $("dlvText").value = ""; $("dlvNo").value = ""; state.dlvDraft = null;
    render();
    if (state.coloured) await applyColours();
  }
  async function cancelDelivery(i) {
    if (!can("status")) return setStatus(t("noRight"), true);
    const d = state.deliveries[i];
    // inline reason box in the row (window.prompt is unreliable inside the Connect iframe)
    if (state.cancelling !== i) { state.cancelling = i; render(); const r = $("dlvReason"); if (r) r.focus(); return; }
    const reason = (($("dlvReason") || {}).value || "").trim();
    if (!reason) return setStatus(L2("Въведете причина за анулиране.", "Enter a reason for cancelling."), true);
    state.cancelling = null;
    const next = R.cancelDelivery(d, { by: state.user, note: reason });
    const { link, ...props } = next;
    await state.client.write(state.lib.id, R.DEF.delivery, d.link, props);
    state.deliveries[i] = next;
    render();
    if (state.coloured) await applyColours();
  }

  // ---------- import ----------
  let excelLoad = null;
  function loadExcelJs() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return excelLoad || (excelLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
      s.integrity = "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz"; s.crossOrigin = "anonymous";
      s.onload = () => resolve(window.ExcelJS);
      s.onerror = () => { excelLoad = null; reject(new Error("Could not load the Excel library")); };
      document.head.appendChild(s);
    }));
  }
  async function importFile(file) {
    let rows = [];
    if (/\.xlsx$/i.test(file.name)) {
      const ExcelJS = await loadExcelJs();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets[0];
      ws.eachRow((row) => { const v = row.values.slice(1).map((c) => (c && typeof c === "object" ? c.result != null ? c.result : c.text : c)); rows.push([v[0], v[1]]); });
    } else {
      rows = (await file.text()).split(/\r?\n/).map((l) => l.split(/[;,\t]/));
    }
    const r = R.linesFromRows(rows);
    if (r.skipped.length) setStatus(L2("Пропуснати редове: ", "Skipped rows: ") + r.skipped.slice(0, 5).join(" | "), true);
    // inline "Запиши / Откажи" box in the Доставки tab (window.confirm can be blocked inside Connect, week 1 F7)
    if (r.lines.length) { state.dlvPending = { lines: r.lines, source: file.name }; state.tab = "deliveries"; render(); }
    else if (!r.skipped.length) flash(L2("Във файла няма редове с марка и количество.", "No lines with mark and quantity in the file."), true);
  }

  // ---------- fabrication import (fabricator's Excel -> AM_Fabrication) ----------
  const pad2 = (n) => String(n).padStart(2, "0");
  /** An ExcelJS cell value -> {text, num, date}. Date cells come as JS Dates at UTC midnight. */
  function excelCell(v) {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("result" in v) v = v.result;
      else if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join("");
      else if ("text" in v) v = v.text;
      else v = "";   // an error value, or a formula without a cached result (round 5, L6)
    }
    if (v instanceof Date) return { text: "", date: `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}` };
    if (typeof v === "number") return { text: String(v), num: v };
    return { text: v == null ? "" : String(v) };
  }
  /** The fabricator's file -> {sheets: [{name, rows}], date1904}. .xlsx (Excel), or the Tekla export itself (an HTML
   *  table named .xls, Windows-1251). The old binary .xls and Excel's "web page" save are refused with a clear message. */
  async function readWorkbook(file) {
    const buf = await file.arrayBuffer();
    const b = new Uint8Array(buf.slice(0, 8));
    if (b[0] === 0x50 && b[1] === 0x4b) {   // zip = .xlsx
      const ExcelJS = await loadExcelJs();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const sheets = wb.worksheets.map((ws) => {
        const rows = [];
        ws.eachRow({ includeEmpty: true }, (row, n) => { rows[n - 1] = row.values.slice(1).map(excelCell); });
        for (let i = 0; i < rows.length; i++) rows[i] = rows[i] || [];
        return { name: wb.worksheets.length > 1 ? ws.name : "", rows };
      });
      return { sheets, date1904: !!(wb.properties && wb.properties.date1904) };
    }
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)
      throw new Error(L2("Файлът е в стария формат Excel 97-2003. Отворете го в Excel, запишете го като „Excel Workbook (*.xlsx)“ и опитайте пак.",
        "The file is in the old Excel 97-2003 format. Open it in Excel, save it as \"Excel Workbook (*.xlsx)\" and try again."));
    const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
    const cs = /charset=["']?([\w-]+)/i.exec(head);
    const html = new TextDecoder(cs ? cs[1] : "windows-1251").decode(buf);
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector("frameset")) throw new Error(L2("Това е Excel „уеб страница“ – данните са в отделна папка. Запишете файла като „Excel Workbook (*.xlsx)“.",
      "This is an Excel \"web page\" save – the data is in a separate folder. Save the file as \"Excel Workbook (*.xlsx)\"."));
    const rows = [...doc.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td,th")].map((td) => {
      const n = td.getAttribute("x:num");
      const c = { text: td.textContent || "" };
      if (n != null && n !== "" && isFinite(+n)) c.num = +n;
      return c;
    }));
    return { sheets: [{ name: "", rows }], date1904: false };
  }

  async function importFab(file) {
    state.fabClearArmed = 0;
    state.fabPlan = null;
    const wb = await readWorkbook(file);
    const rows = [], skipped = [];
    let noDates = false;
    for (const sh of wb.sheets) {
      const r = F.readSheet(sh.rows, sh.name, L2("ред", "row"));
      if (r.rows) rows.push(...r.rows);
      else { if (r.error === "noDates") noDates = true; if (sh.name) skipped.push(sh.name); }
    }
    if (!rows.length) {
      return setStatus(noDates ? L2("Няма колони „Дата изработен“ / „Дата доставен“.", "No \"Дата изработен\" / \"Дата доставен\" columns.")
        : L2("Няма колона GUID – това не е файл от отчета AM_Fabrication.", "No GUID column – this is not a file from the AM_Fabrication report."), true);
    }
    const known = new Map(state.asms.map((a) => [a.guid, { mark: a.mark }]));
    state.fabPlan = { source: file.name, p: F.plan(rows, { toIfc: L.tcGuidToIfc, known, existing: state.fab, date1904: wb.date1904 }) };
    state.tab = "fab";
    setStatus(L2(`Прочетен ${file.name}: проверете промените и натиснете „Запиши“.`, `Read ${file.name}: check the changes and press "Save".`)
      + (skipped.length ? L2(` Пропуснати листове (без GUID / дати): `, ` Sheets skipped (no GUID / dates): `) + skipped.join(", ") : ""), skipped.length > 0);   // round 5, L5
    render();
  }
  /** A raw-"$" copy of this record was found at load time (any kind: move / merge / stale). */
  function hasRaw(def, guid) { return hasLegacy(guid) && (state.legacyOnly || []).some((r) => r.def === def && r.guid === guid); }
  const rightFor = (def) => can(def === R.DEF.hold ? "hold" : def === R.DEF.status ? "status" : "fab");
  /** After a record is safely under its encoded link, delete the raw-"$" copy, so it can never come back when the
   *  encoded one is deleted later (round 6 M1). Failures are ignored: the raw copy is then listed as "stale". */
  async function dropLegacy(def, guid) {
    if (!hasRaw(def, guid)) return;
    try { await state.client.remove(state.lib.id, def, legacyLink(guid)); } catch (e) { console.warn("raw link not deleted", guid, e); }
  }
  /** "Премести": every record still under a raw-"$" link goes to its URL-encoded link, then the raw one is deleted.
   *  Both are read fresh (round 6 L3); an encoded record is only filled with fields it lacks, unless the raw one is
   *  newer (written by an old cached client after the move, M2) - then the raw fields win and its history is added. */
  async function moveLegacy() {
    const list = state.legacyOnly || [];
    if (!list.length || !state.lib) return;
    const bak = await backupFirst("move", list.filter((r) => rightFor(r.def)).flatMap((r) => [{ def: r.def, link: legacyLink(r.guid) }, { def: r.def, link: entLink(r.guid) }]), null, true);
    if (bak === null) return;   // no undo file: stopped, the inline "Продължи без архив" asks (review 9 M5)
    let done = 0, failed = 0, skipped = 0, first = "";
    await pool(list, 6, async (r) => {
      if (!rightFor(r.def)) { skipped++; return; }
      try {
        const raw = await state.client.readOne(state.lib.id, r.def, legacyLink(r.guid));
        const rp = raw && raw.props;
        if (rp) {
          const enc = await state.client.readOne(state.lib.id, r.def, entLink(r.guid));
          const ep = enc && enc.props;
          // the kind is taken from these two fresh reads, not from the load (review 9 low 7)
          const kind = !ep ? "move" : isStale(rp, ep) ? "stale" : "merge";
          let patch = null;
          if (kind === "move") patch = rp;
          else if (kind === "merge") {
            patch = {};
            for (const [k, v] of Object.entries(rp)) if (k !== "log" && JSON.stringify(v) !== JSON.stringify(ep[k])) patch[k] = v;
            const extra = String(rp.log || "").split("\n").filter((l) => l && !String(ep.log || "").includes(l));
            if (extra.length) patch.log = [ep.log, ...extra].filter(Boolean).join("\n").slice(r.def === F.DEF_ID ? -1500 : -4000);
          } else patch = null;   // stale: the encoded record already has its history; fields it lacks were cleared on purpose (round 7 M1)
          if (patch && Object.keys(patch).length) await state.client.writeIfUnchanged(state.lib.id, r.def, entLink(r.guid), patch, enc ? enc.v : undefined);
          await state.client.remove(state.lib.id, r.def, legacyLink(r.guid));
        }
        done++;
      } catch (e) { failed++; if (!first) first = e.status === 403 ? t("noRight") : errText(e); }
    });
    await loadRecords();
    flash(L2(`Преместени ${done} записа.`, `Moved ${done} records.`) + (skipped ? ` · ${skipped} ${L2("без права", "no right")}` : "")
      + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failed > 0);
    render();
    if (state.coloured) await applyColours();   // DelivDate counts as delivered (owner's rule 16.11.2026)
  }

  // Clearing dates (admin): an empty Excel cell never clears a date, so this is the way to correct one or remove test
  // data. Every link form ever written is deleted: URL-encoded, raw "$" (before v16) and the MS-form test of v14/v15.
  const IFC64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  function ifcToMs(g) {
    let n = 0n;
    for (const ch of String(g)) { const v = IFC64.indexOf(ch); if (v < 0) return ""; n = n * 64n + BigInt(v); }
    const h = n.toString(16).padStart(32, "0");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const isAdmin = () => !!(window.ARSTEN_DEMO || (state.access && state.access.role === "admin"));
  // the confirm click must follow within 10 s (round 6 L5)
  const clearArmed = () => !!state.fabClearArmed && Date.now() - state.fabClearArmed < 10000;
  async function clearFab() {
    if (!state.lib || !isAdmin()) return setStatus(t("noRight"), true);
    if (!clearArmed()) { state.fabClearArmed = Date.now(); render(); setTimeout(render, 10500); return; }   // second click confirms
    state.fabClearArmed = 0;
    const list = state.sel.slice();
    // every link stored for these assemblies, whatever its form (round 6 L6), plus the forms we know of
    const ids = new Map(list.map((a) => [a.guid, new Set([a.guid, ifcToMs(a.guid).toLowerCase()])]));
    const all = await state.client.listAll(state.lib.id, F.DEF_ID, "frn:entity:");
    const found = new Map(list.map((a) => [a.guid, new Set([legacyLink(a.guid), "frn:entity:" + ifcToMs(a.guid)])]));
    for (const link of all.keys()) {
      let id = link.replace(/^frn:entity:/, ""); try { id = decodeURIComponent(id); } catch {}
      for (const [g, set] of ids) if (set.has(id) || set.has(id.toLowerCase())) found.get(g).add(link);
    }
    // undo file: every stored link about to be deleted, with its props as listed just now
    const bak = await backupFirst("fab-clear", list.flatMap((a) => [...found.get(a.guid), entLink(a.guid)].filter((l) => all.has(l)).map((link) => ({ def: F.DEF_ID, link }))), new Map([[F.DEF_ID, all]]), true);
    if (bak === null) return;   // no undo file: stopped, the inline "Продължи без архив" asks (review 9 M5)
    let done = 0, failed = 0, first = "";
    await pool(list, 6, async (a) => {
      // other forms first, the encoded (visible) one last: a failure never leaves an old copy behind it (round 6 L1)
      const links = [...found.get(a.guid)].filter((l) => l !== entLink(a.guid)).concat(entLink(a.guid));
      try { for (const l of links) await state.client.remove(state.lib.id, F.DEF_ID, l); state.fab.delete(a.guid); done++; }
      catch (e) { failed++; if (!first) first = e.status === 403 ? t("noRight") : errText(e); }
    });
    await loadRecords();
    flash(L2(`Изтрити дати: ${done} сглобки.`, `Dates cleared: ${done} assemblies.`) + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failed > 0);
    render();
    if (state.coloured) await applyColours();   // DelivDate counts as delivered (owner's rule 16.11.2026)
  }

  async function applyFab() {
    state.fabClearArmed = 0;
    const fp = state.fabPlan;
    if (!fp) return;
    if (!state.lib) return setStatus(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can("fab")) return setStatus(t("noRight"), true);
    // Each assembly is read fresh and written with its version: only the changed fields go out (never a stale copy of
    // the others), and an assembly someone else changed since the preview is skipped, not overwritten (round 5, M2/L4)
    const bak = await backupFirst("fab-import", linksOf(F.DEF_ID, fp.p.changes.map((c) => c.ifc)));
    let done = 0, first = "";
    const failedList = [], meanwhile = [];
    await pool(fp.p.changes, 6, async (c) => {
      const link = entLink(c.ifc);
      try {
        for (let attempt = 0; ; attempt++) {
          const cur = await state.client.readOne(state.lib.id, F.DEF_ID, link);
          let fresh = (cur && cur.props) || null, moved = false;
          // first write to the encoded link of a "$" GUID: the old raw-"$" record is the base and all its fields move over
          if (!fresh && hasLegacy(c.ifc)) { const old = await state.client.readOne(state.lib.id, F.DEF_ID, legacyLink(c.ifc)); fresh = old && old.props; moved = !!fresh; }
          else if (fresh && (state.legacyOnly || []).some((r) => r.def === F.DEF_ID && r.guid === c.ifc && r.kind === "merge")) {
            // raw record newer than the encoded one: merged exactly as readBoth showed it in the preview (round 7 M2)
            const old = await state.client.readOne(state.lib.id, F.DEF_ID, legacyLink(c.ifc));
            if (old && old.props) { fresh = Object.assign({}, fresh, old.props, { log: [fresh.log, old.props.log].filter(Boolean).join("\n") }); moved = true; }
          }
          fresh = fresh || {};
          if (F.changedSince(c, c.before, fresh).length) { meanwhile.push(c.mark || c.ifc); state.fab.set(c.ifc, fresh); return; }
          const patch = Object.assign(moved ? Object.assign({}, fresh) : {}, F.patchFor(fresh, c, { source: fp.source, by: state.user }));
          try { await state.client.writeIfUnchanged(state.lib.id, F.DEF_ID, link, patch, cur ? cur.v : undefined); }
          catch (e) { if ((e.status === 412 || e.status === 409) && attempt < 3) continue; throw e; }
          state.fab.set(c.ifc, Object.assign({}, fresh, patch));
          if (moved) await dropLegacy(F.DEF_ID, c.ifc);
          done++;
          return;
        }
      } catch (e) { failedList.push(c); if (!first) first = e.status === 403 ? t("noRight") : errText(e); }
      finally { const n = done + failedList.length + meanwhile.length; if (n % 25 === 0) setStatus(L2(`Записвам… ${n} от ${fp.p.changes.length}`, `Saving… ${n} of ${fp.p.changes.length}`)); }
    });
    // only what failed stays in the preview, so "Save" again does not rewrite (and re-log) what is already saved (L3)
    if (failedList.length) {
      fp.p.changes = failedList;
      fp.p.overwrites = failedList.reduce((n, c) => n + c.over.length, 0);
      fp.p.fills = failedList.reduce((n, c) => n + Object.keys(c.set).length, 0) - fp.p.overwrites;
    } else state.fabPlan = null;
    flash(L2(`Записани ${done} сглобки.`, `Saved ${done} assemblies.`)
      + (meanwhile.length ? L2(` · ${meanwhile.length} променени междувременно от друг – не са записани, импортирайте файла пак: `, ` · ${meanwhile.length} changed by someone else meanwhile – not saved, import the file again: `) + meanwhile.slice(0, 10).join(", ") + "." : "")
      + (failedList.length ? ` · ${failedList.length} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failedList.length + meanwhile.length > 0);
    render();
    if (state.coloured) await applyColours();   // DelivDate counts as delivered (owner's rule 16.11.2026)
  }

  // ---------- rendering ----------
  function render() {
    $("title").textContent = t("title");
    $("hSel").textContent = t("selection"); $("lblFollow").textContent = t("follow"); $("btnSelClear").textContent = t("clear");
    $("hView").textContent = t("view"); $("lblColour").textContent = t("colour");
    document.querySelectorAll("#tabs button").forEach((b) => { b.textContent = t(b.dataset.tab); b.classList.toggle("on", b.dataset.tab === state.tab); });
    ["marks", "deliveries", "fab", "bolts", "docs"].forEach((k) => { $("tab-" + k).hidden = state.tab !== k; });
    $("legend").innerHTML = L.STATES.map((s) => `<span><span class="sw" style="background:${s.colour}"></span>${esc(lang === "bg" ? s.bg : s.en)}</span>`).join("");
    if (!state.ready) return;
    const av = avail();
    // selection
    const sel = state.sel;
    if (!sel.length) $("selText").innerHTML = `<span class="sub">${esc(t("nothing"))}</span>`;
    else {
      const byMark = new Map();
      for (const a of sel) byMark.set(a.mark, (byMark.get(a.mark) || 0) + 1);
      const states = new Map();
      for (const a of sel) { const s = av.state.get(a.guid); states.set(s, (states.get(s) || 0) + 1); }
      const fb = sel.map((a) => state.fab.get(a.guid) || {});
      // a future DelivDate is planned, not delivered (R.fabDelivered, review 9 low 11)
      const delivN = sel.filter((a) => R.fabDelivered(state.fab, a.guid)).length;
      const fabLine = sel.length === 1
        ? [fb[0].FabDate && `${L2("изработен", "fabricated")} ${fmtDate(fb[0].FabDate)}`,
          fb[0].DelivDate && (delivN ? `${L2("доставен", "delivered")} ${fmtDate(fb[0].DelivDate)}` : `${L2("доставка (план)", "delivery (planned)")} ${fmtDate(fb[0].DelivDate)}`),
          fb[0].DelivNote && `${L2("СР", "DN")} ${fb[0].DelivNote}`].filter(Boolean).join(" · ")
        : [fb.some((x) => x.FabDate) && `${L2("изработени", "fabricated")} ${fb.filter((x) => x.FabDate).length}`, delivN && `${L2("доставени (Excel)", "delivered (Excel)")} ${delivN}`].filter(Boolean).join(" · ");
      $("selText").innerHTML = `<b>${sel.length}</b> ${L2("сглобки", "assemblies")} · ${esc([...byMark].map(([m, n]) => (n > 1 ? `${m} (${n})` : m)).join(", "))}<div class="sub">${[...states].map(([s, n]) => `${esc(stateName(s))}: ${n}`).join(" · ")}</div>`
        + (fabLine ? `<div class="sub">${esc(L2("Производство", "Fabrication"))}: ${esc(fabLine)}</div>` : "");
    }
    // actions
    const has = (store, kind) => sel.filter((a) => (store.get(a.guid) || {})[kind]).length;
    const act = (kind, colour, store, right, needNote, noteLbl) => {
      const on = flagTargets(kind, true), off = flagTargets(kind, false);
      // prefill with the recorded values when every selected piece is marked and they agree; a typed draft wins
      const noteKey = kind === "hold" ? "hold_reason" : `${kind}_note`;
      const recs = on.correcting ? sel.map((a) => store.get(a.guid) || {}) : [];
      const same = (k) => (recs.length && recs.every((r) => (r[k] || "") === (recs[0][k] || "")) ? recs[0][k] || "" : "");
      const dr = state.drafts[kind] || {};
      const dateVal = dr.date != null ? dr.date : on.correcting ? same(`${kind}_date`) : R.today();
      const noteVal = dr.note != null ? dr.note : same(noteKey);
      const mixed = on.correcting && (!same(`${kind}_date`) || !same(noteKey));
      const onLbl = flagArmed(kind, true, on.list.length) ? L2(`Потвърди: ${on.list.length} сглобки`, `Confirm: ${on.list.length} assemblies`)
        : on.correcting ? L2(`Поправи (${on.list.length})`, `Correct (${on.list.length})`) : `${t("set")}${sel.length ? ` (${on.list.length})` : ""}`;
      const offLbl = flagArmed(kind, false, off.list.length) ? L2(`Потвърди: отмени ${off.list.length}`, `Confirm: undo ${off.list.length}`) : `${t("undo")}${off.list.length ? ` (${off.list.length})` : ""}`;
      return `<div class="act" style="--c:${colour}">
      <div class="hd"><span class="nm">${esc(t(kind))}</span><span class="st">${sel.length ? `${has(store, kind)}/${sel.length}` : ""}</span></div>
      <div class="row">${kind === "erected" || kind === "hold" ? `<input type="date" id="d_${kind}" max="${R.today()}" value="${esc(dateVal)}"><span class="sub" id="h_${kind}" ${dr.date != null && oldDate(dr.date) ? "" : "hidden"}>${esc(L2("проверете датата", "check the date"))}</span>` : ""}<input type="text" id="n_${kind}" value="${esc(noteVal)}" placeholder="${esc(mixed ? L2("различни – празно = без промяна", "differ – empty = unchanged") : noteLbl + (needNote ? " *" : ""))}"></div>
      ${on.correcting && sel.length ? `<div class="sub">${esc(L2("Всички избрани вече са отбелязани. „Поправи“ записва само това, което промените; празно поле = всяка сглобка запазва своето.", "All selected are already marked. \"Correct\" writes only what you change; an empty box = each keeps its own."))}</div>`
        : sel.length && on.list.length < sel.length ? `<div class="sub">${esc(L2(`${sel.length - on.list.length} вече отбелязани остават както са.`, `${sel.length - on.list.length} already marked stay as they are.`))}</div>` : ""}
      <div class="row"><button class="small" data-act="on" data-kind="${kind}" ${on.list.length && right ? "" : "disabled"}>${esc(onLbl)}</button>
        <button class="small secondary undo" data-act="off" data-kind="${kind}" ${off.list.length && right ? "" : "disabled"}>${esc(offLbl)}</button>
        ${right ? "" : `<span class="sub">${esc(t("noRight"))}</span>`}</div></div>`;
    };
    $("acts").innerHTML = act("erected", "#2E7D32", state.status, can("status"), false, t("note"))
      + act("wrong", "#C62828", state.status, can("status"), true, t("note"))
      + act("hold", "#7B1FA2", state.holds, can("hold"), true, t("reason"));
    renderMarks(av); renderDeliveries(av); renderFab(); renderBolts(); renderDocs(av);
    const bl = $("build"); if (bl) bl.textContent = `Стомана v${BUILD}`;
  }

  function renderFab() {
    const right = can("fab") && !state.fabError;
    const total = state.asms.length;
    const fabN = state.asms.filter((a) => (state.fab.get(a.guid) || {}).FabDate).length;
    const delN = state.asms.filter((a) => R.fabDelivered(state.fab, a.guid)).length;   // future dates are planned (review 9 low 11)
    const fp = state.fabPlan;
    const list = (title, items, cls) => (items.length ? `<div class="${cls || "warn"}"><b>${esc(title)}</b> (${items.length}): ${esc(items.slice(0, 12).join(" · "))}${items.length > 12 ? " …" : ""}</div>` : "");
    let preview = "";
    if (fp) {
      const p = fp.p;
      const over = p.changes.filter((c) => c.over.length);
      const fname = (f) => ({ FabDate: L2("изработен", "fabricated"), DelivDate: L2("доставен", "delivered"), DelivNote: L2("СР", "DN") }[f] || f);
      const show = (f, v) => (f === "DelivNote" ? v : fmtDate(v));
      preview = `<div class="box" style="margin-top:6px"><div><b>${esc(fp.source)}</b></div>
        <div class="sub">${p.rows} ${L2("реда", "rows")} · ${p.guids} ${L2("сглобки с данни", "assemblies with data")} · ${L2("нови стойности", "new values")} <b>${p.fills}</b> · ${L2("промени на въведени", "changes to stored")} <b>${p.overwrites}</b> · ${L2("без промяна", "unchanged")} ${p.unchanged}</div>
        ${over.length ? `<div class="warn"><b>${esc(L2("Ще се променят вече въведени стойности", "Stored values that will change"))}</b> (${over.length}):<br>${over.slice(0, 15).map((c) => esc(`${c.mark}: ` + c.over.map((o) => `${fname(o.field)} ${show(o.field, o.from)} → ${show(o.field, o.to)}`).join(", "))).join("<br>")}${over.length > 15 ? "<br>…" : ""}</div>` : ""}
        ${list(L2("Неразпознати дати (пропуснати)", "Dates not understood (skipped)"), p.problems)}
        ${list(L2("Проверете (ДД/ММ или ММ/ДД?)", "Check (DD/MM or MM/DD?)"), p.warnings)}
        ${list(L2("Една сглобка с различни стойности", "One assembly with different values"), p.conflicts)}
        ${list(L2("Не са в заредения модел (не се записват)", "Not in the loaded model (not saved)"), p.notLoaded)}
        ${list(L2("Невалиден GUID", "Invalid GUID"), p.badGuid)}
        <div class="bar"><button class="small" data-act="fabApply" ${p.changes.length && right ? "" : "disabled"}>${esc(L2(`Запиши (${p.changes.length} сглобки)`, `Save (${p.changes.length} assemblies)`))}</button>
          <button class="small secondary" data-act="fabCancel">${esc(L2("Откажи", "Cancel"))}</button>${right ? "" : `<span class="sub">${esc(t("noRight"))}</span>`}</div></div>`;
    }
    $("tab-fab").innerHTML = (state.fabError ? `<div class="warn">${esc(L2("Датите за производство не могат да се прочетат: ", "Fabrication dates cannot be read: ") + state.fabError)}</div>` : "") + `<div class="box">
        <div>${L2("Изработени", "Fabricated")}: <b>${fabN}</b> · ${L2("Доставени", "Delivered")}: <b>${delN}</b> / ${total}</div>
        <div class="bar"><label class="small secondary" style="border:1px solid var(--line);padding:2px 7px;font-size:12px;cursor:pointer;${right ? "" : "opacity:.45;pointer-events:none"}">${L2("Импорт Excel от производителя", "Import the fabricator's Excel")}<input type="file" id="fabFile" accept=".xlsx,.xls,.htm,.html" hidden></label>
          ${right ? "" : `<span class="sub">${esc(t("noRight"))}</span>`}</div>
        ${legacyBanner()}${noBackupBox()}
        ${isAdmin() && state.sel.length ? `<div class="bar"><button class="small secondary" data-act="clearFab">${esc(clearArmed()
          ? L2(`Потвърди: изтрий датите на ${state.sel.length} сглобки`, `Confirm: clear the dates of ${state.sel.length} assemblies`)
          : L2(`Изтрий датите на избраните (${state.sel.length})`, `Clear the dates of the selected (${state.sel.length})`))}</button></div>` : ""}
        <div class="sub">${esc(L2("Файлът от отчета AM_Fabrication с попълнени оранжеви колони. Сглобките се разпознават по GUID. Празна клетка не изтрива дата. Tekla чете датите като ASSEMBLY.PSET.AM_Fabrication.* след „Synchronize property sets“.",
          "The AM_Fabrication report file with the orange columns filled. Assemblies are matched by GUID. An empty cell never clears a date. Tekla reads the dates as ASSEMBLY.PSET.AM_Fabrication.* after \"Synchronize property sets\"."))}</div></div>${preview}`;
    const f = $("fabFile");
    if (f) f.onchange = (e) => guarded(async () => { const file = e.target.files[0]; e.target.value = ""; if (file) await importFab(file); });
  }

  function legacyBanner() {
    const n = (state.legacyOnly || []).length;
    if (!n) return "";
    const any = ["status", "hold", "fab"].some((w) => can(w));
    return `<div class="warn">${esc(L2(`${n} записа (сглобки с „$“ в GUID) са в стар формат и не се виждат в панела на Connect и в Tekla.`, `${n} records (assemblies with "$" in the GUID) are in the old format and are not shown in Connect's panel or Tekla.`))}
      <div class="bar"><button class="small" data-act="moveLegacy" ${any ? "" : "disabled"}>${esc(L2("Премести", "Move"))}</button></div></div>`;
  }
  function renderMarks(av) {
    const over = av.marks.filter((m) => m.over);
    $("tab-marks").innerHTML = legacyBanner() + noBackupBox() + differsWarn(av) + (over.length ? `<div class="warn">${esc(L2("Монтирани повече от доставените: ", "Erected more than delivered: "))}${esc(over.map((m) => `${m.mark} (${m.erected}/${m.delivered})`).join(", "))}</div>` : "")
      + (av.unknownDeliveredMarks.length ? `<div class="warn">${esc(L2("Доставени марки, които ги няма в модела: ", "Delivered marks not in the model: "))}${esc(av.unknownDeliveredMarks.join(", "))}</div>` : "")
      + `<div class="scroll"><table><thead><tr><th>${L2("Марка", "Mark")}</th><th class="n">${L2("Бр.", "Qty")}</th><th class="n">${L2("Дост.", "Deliv.")}</th><th class="n">${L2("Монт.", "Erect.")}</th><th class="n" title="${esc(L2("доставени − монтирани", "delivered − erected"))}">${L2("Налични", "Available")}</th><th class="n">${L2("Не дост.", "Not del.")}</th></tr></thead><tbody>`
      + av.marks.map((m, i) => `<tr><td class="name"><button class="small secondary" data-act="pickMark" data-mark="${esc(m.mark)}" title="${esc(L2("Избери в модела", "Select in the model"))}">${esc(m.mark || "?")}</button>${m.hold ? ` <span class="sub">${L2("задърж.", "hold")} ${m.hold}</span>` : ""}${m.wrong ? ` <span class="bad sub">${L2("грешни", "wrong")} ${m.wrong}</span>` : ""}</td>
        <td class="n">${m.instances}</td><td class="n" title="${esc(m.source ? `${srcName(m.source)} · ${srcFigures(m)}` : "")}">${m.delivered}${m.source ? `<div class="sub${m.differs ? " bad" : ""}">${esc(m.differs ? srcFigures(m) : srcName(m.source))}</div>` : ""}</td><td class="n${m.over ? " bad" : ""}">${m.erected}</td><td class="n">${m.available}</td><td class="n">${m.notDelivered}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }

  function renderDeliveries(av) {
    const right = can("status");
    // delivered per mark from both sources (typed notes below + the fabricator's Excel on "Производство")
    const got = av.marks.filter((m) => m.delivered > 0);
    const byMarkBox = got.length ? `<div class="box" style="margin-top:6px"><div><b>${esc(L2("Доставени по марки", "Delivered by mark"))}</b> <span class="sub">${esc(L2("(по-голямото от въведените и Excel)", "(the larger of typed and Excel)"))}</span></div>
      <div class="scroll"><table><thead><tr><th>${L2("Марка", "Mark")}</th><th class="n">${L2("Въведени", "Typed")}</th><th class="n">Excel</th><th class="n">${L2("Дост.", "Deliv.")}</th><th>${L2("Източник", "Source")}</th></tr></thead><tbody>`
      + got.map((m) => `<tr><td>${esc(m.mark)}</td><td class="n">${m.typed}</td><td class="n">${m.excel}</td><td class="n${m.differs ? " bad" : ""}">${m.delivered}</td><td class="sub">${esc(srcName(m.source))}</td></tr>`).join("")
      + `</tbody></table></div></div>` : "";
    const pend = state.dlvPending, dd = state.dlvDraft || {};
    const pendBox = pend ? `<div class="warn"><b>${esc(pend.source)}</b>: ${esc(L2(`${pend.lines.length} марки, ${pend.lines.reduce((n, l) => n + l.qty, 0)} бр.`, `${pend.lines.length} marks, ${pend.lines.reduce((n, l) => n + l.qty, 0)} pcs`))}
        <div class="sub">${esc(pend.lines.slice(0, 20).map((l) => `${l.mark}×${l.qty}`).join(", "))}${pend.lines.length > 20 ? " …" : ""}</div>
        <div class="sub">${esc(L2("Дата и № на стоковата разписка се вземат от полетата по-долу.", "Date and delivery note no. come from the fields below."))}</div>
        <div class="bar"><button class="small" data-act="dlvPendOk" ${right ? "" : "disabled"}>${esc(L2("Запиши доставката", "Save the delivery"))}</button><button class="small secondary" data-act="dlvPendNo">${esc(L2("Откажи", "Cancel"))}</button></div></div>` : "";
    $("tab-deliveries").innerHTML = pendBox + differsWarn(av) + `<div class="box">
        <div class="bar"><input type="date" id="dlvDate" max="${R.today()}" value="${esc(dd.dlvDate != null ? dd.dlvDate : R.today())}"><input type="text" id="dlvNo" value="${esc(dd.dlvNo || "")}" placeholder="${esc(L2("Стокова разписка №", "Delivery note no."))}"></div>
        <textarea id="dlvText" placeholder="${esc(L2("Марка и брой на ред, напр.\nRF22 3\nCL22 2", "Mark and qty per line, e.g.\nRF22 3\nCL22 2"))}">${esc(dd.dlvText || "")}</textarea>
        <div class="bar"><button class="small" data-act="dlvAdd" ${right ? "" : "disabled"}>${L2("Запиши доставка", "Save delivery")}</button>
          <label class="small secondary" style="border:1px solid var(--line);padding:2px 7px;font-size:12px;cursor:pointer;${right ? "" : "opacity:.45;pointer-events:none"}">${L2("Импорт Excel/CSV", "Import Excel/CSV")}<input type="file" id="dlvFile" accept=".xlsx,.csv,.txt" hidden></label>
          ${right ? "" : `<span class="sub">${esc(t("noRight"))}</span>`}</div>
        <div class="sub">${esc(L2("Файл: колона A марка, колона B брой (редовете със заглавия се пропускат).", "File: column A mark, column B qty (header rows are skipped)."))}</div></div>
      <div class="scroll" style="margin-top:6px"><table><thead><tr><th>${L2("Дата", "Date")}</th><th>№</th><th>${L2("Марки", "Marks")}</th><th></th></tr></thead><tbody>`
      + (state.deliveries.length ? state.deliveries.map((d, i) => `<tr${d.cancelled ? ' style="opacity:.5"' : ""}><td>${esc(fmtDate(d.date))}</td><td>${esc(d.note_no || "")}</td>
          <td>${esc(L.parseLines(d.lines).map((l) => `${l.mark}×${l.qty}`).join(", "))}<div class="sub">${esc(d.by || "")}${d.cancelled ? " · " + L2("анулирана", "cancelled") : ""}</div></td>
          <td>${d.cancelled || !right ? "" : state.cancelling === i
            ? `<input type="text" id="dlvReason" placeholder="${esc(L2("Причина *", "Reason *"))}" style="width:90px"><div class="bar" style="margin:3px 0 0"><button class="small" data-act="dlvCancel" data-i="${i}">${L2("Анулирай", "Cancel it")}</button><button class="small secondary" data-act="dlvCancelNo">${L2("Не", "No")}</button></div>`
            : `<button class="small secondary" data-act="dlvCancel" data-i="${i}">${L2("Анулирай", "Cancel")}</button>`}</td></tr>`).join("")
        : `<tr><td colspan="4" class="sub">${L2("Няма доставки.", "No deliveries.")}</td></tr>`)
      + `</tbody></table></div>` + byMarkBox;
    const f = $("dlvFile");
    if (f) f.onchange = (e) => guarded(async () => { const file = e.target.files[0]; e.target.value = ""; if (file) await importFile(file); });
  }

  function boltScope() {
    if (state.boltScope !== "sel" || !state.sel.length) return state.bolts;
    const g = new Set(state.sel.map((a) => a.guid));
    return state.bolts.filter((b) => g.has(b.ownGuid) || ((b.sides && b.sides.others) || []).some((x) => g.has(x)));
  }
  function renderBolts() {
    const list = L.boltList(boltScope(), erectedFn());
    const cnt = (k, label) => `<span>${esc(label)} <span class="cnt">${list[k].length}</span></span>`;
    $("tab-bolts").innerHTML = (state.hasLinks ? "" : `<div class="warn">${esc(L2("Непълен списък: експортът няма Connected_Assemblies / Main_Part_GUID. Болтовете са само по собствената си сглобка.", "Partial list: the export has no Connected_Assemblies / Main_Part_GUID. Bolts are listed by their own assembly only."))}</div>`)
      + `<div class="bar"><label class="chk"><input type="radio" name="bscope" value="all" ${state.boltScope === "all" ? "checked" : ""}> ${L2("Всички", "All")}</label>
         <label class="chk"><input type="radio" name="bscope" value="sel" ${state.boltScope === "sel" ? "checked" : ""}> ${L2("Избраните", "Selection")}</label>
         <button class="small" data-act="boltXlsx">Excel</button><button class="small secondary" data-act="boltPdf">PDF</button></div>
       <div class="legend">${cnt("now", L2("За монтаж сега", "Install now"))}${cnt("check", L2("За проверка", "Check"))}${cnt("waiting", L2("Чакат", "Waiting"))}${cnt("anchors", L2("Анкери", "Anchors"))}${cnt("unresolved", L2("Неясни", "Unresolved"))}${list.partial.length ? cnt("partial", L2("Непълни", "Partial")) : ""}</div>
       <table><thead><tr><th>${L2("Стандарт", "Standard")}</th><th class="n">M</th><th class="n">L</th><th class="n">${L2("Групи", "Groups")}</th><th class="n">${L2("Болтове", "Bolts")}</th></tr></thead><tbody>`
      + (list.groups.length ? list.groups.map((g) => `<tr><td>${esc(g.standard)}<div class="sub">${esc([...new Set(g.connections)].join(" · "))}</div></td><td class="n">${esc(num(g.diameter))}</td><td class="n">${esc(num(g.length))}</td><td class="n">${g.groups}</td><td class="n">${g.bolts}</td></tr>`).join("")
        : `<tr><td colspan="5" class="sub">${L2("Няма болтове за монтаж сега.", "No bolts to install now.")}</td></tr>`)
      + `</tbody></table>`
      + (list.check.length ? `<h2>${L2("За проверка (несигурна връзка)", "Check (uncertain link)")}</h2><div class="sub">${esc(list.check.map((b) => `${b.ownMark} / ${(b.otherMarks || []).join(", ")}`).join(" · "))}</div>` : "");
    document.querySelectorAll('input[name="bscope"]').forEach((r) => { r.onchange = () => { state.boltScope = r.value; render(); }; });
  }

  function renderDocs(av) {
    const erected = state.asms.filter((a) => (state.status.get(a.guid) || {}).erected).length;
    $("tab-docs").innerHTML = `<div class="box"><div>${L2("Монтирани", "Erected")}: <b>${erected}</b> / ${state.asms.length}</div>
      <div class="bar"><button class="small" data-act="docErected">${L2("Монтирани сглобки (Excel)", "Erected assemblies (Excel)")}</button>
      <button class="small secondary" data-act="docMarks">${L2("По марки (Excel)", "By mark (Excel)")}</button>
      <button class="small secondary" data-act="docDeliveries">${L2("Доставки (Excel)", "Deliveries (Excel)")}</button></div></div>`;
  }

  // ---------- exports ----------
  const projectName = () => (state.project && state.project.name) || "";
  async function saveXlsx(name, sheets) {
    const ExcelJS = await loadExcelJs();
    const wb = new ExcelJS.Workbook();
    for (const sh of sheets) {
      const ws = wb.addWorksheet(sh.name);
      for (const r of sh.rows) { const row = ws.addRow(r.values); if (r.bold) row.font = { bold: true }; if (r.fill) row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r.fill } }; }); }
      (sh.widths || []).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    }
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = `${name}_${String(projectName() || "project").replace(/[\\/:*?"<>|]+/g, "_")}_${R.today()}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(L2("Изтеглен ", "Downloaded ") + a.download);
  }
  /** Bolt Location List rows (layout of the firm report "Multiplan Bolt Location List"). */
  function boltReport() {
    const list = L.boltList(boltScope(), erectedFn());
    const header = [["BOLT LOCATION LIST"], ["CLIENT", ""], ["JOB NO", (state.project && state.project.id) || ""], ["PROJECT", projectName()], ["REVISION", ""],
      ["MODEL NUMBER", ""], ["DATE", R.today()], ["MODEL NAME", ""], [L2("ЗА МОНТАЖ СЕГА (двете сглобки монтирани)", "TO INSTALL NOW (both assemblies erected)")]];
    return { list, header, rows: L.reportRows(list.now.concat(list.check.map((b) => Object.assign({}, b, { comment: [b.comment, L2("ПРОВЕРИ ВРЪЗКАТА", "CHECK LINK")].filter(Boolean).join(" · ") })))) };
  }
  async function exportBoltsXlsx() {
    const r = boltReport();
    const rows = r.header.map((h, i) => ({ values: h, bold: i === 0 || i === r.header.length - 1 }));
    rows.push({ values: ["", "Bolt", "Connected To", "Site/Workshop", "Comment"], bold: true, fill: "FFECE8DF" });
    for (const x of r.rows) rows.push(x.type === "mark" ? { values: [`Marked ${x.mark}`], bold: true } : { values: ["", x.line, x.connected, x.kind, x.comment] });
    rows.push({ values: [] }, { values: ["Generated from Trimble Connect by Arsten / Multiplan (Assembly status)"] });
    await saveXlsx("bolt-location-list", [{ name: "Bolt Location List", rows, widths: [16, 40, 28, 14, 30] }]);
  }
  function exportBoltsPdf() {
    const r = boltReport();
    const h = (s) => esc(s);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Multiplan Bolt Location List</title><style>
      @page { margin: 18mm 14mm; } body { font: 10.5px "Courier New", monospace; color:#000; }
      h1 { font-size:14px; margin:0 0 6px; } table { border-collapse:collapse; width:100%; } td, th { padding:3px 5px; border-bottom:1px solid #bbb; text-align:left; vertical-align:top; }
      .mk td { font-weight:bold; background:#eee; } .hdr td { border:0; padding:1px 5px; } .foot { margin-top:10px; font-size:9px; color:#555; }
      .ph { display:flex; justify-content:space-between; font-size:9px; color:#555; margin-bottom:6px; }</style></head><body>
      <div class="ph"><span></span><span>Multiplan Bolt Location List</span><span>${h(R.today())}</span></div><h1>BOLT LOCATION LIST</h1>
      <table class="hdr">${r.header.slice(1, -1).map((x) => `<tr><td>${h(x[0])}</td><td>${h(x[1])}</td></tr>`).join("")}</table>
      <p><b>${h(r.header[r.header.length - 1][0])}</b></p>
      <table><thead><tr><th></th><th>Bolt</th><th>Connected To</th><th>Site/Workshop</th><th>Comment</th></tr></thead><tbody>
      ${r.rows.map((x) => (x.type === "mark" ? `<tr class="mk"><td colspan="5">Marked ${h(x.mark)}</td></tr>` : `<tr><td></td><td>${h(x.line)}</td><td>${h(x.connected)}</td><td>${h(x.kind)}</td><td>${h(x.comment)}</td></tr>`)).join("")}
      </tbody></table><div class="foot">Generated from Trimble Connect by Arsten / Multiplan (Assembly status)</div></body></html>`;
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    document.body.appendChild(f);
    f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); }, 300);
  }
  async function exportErected() {
    const rows = [{ values: [L2("Марка", "Mark"), L2("Дата", "Date"), L2("От", "By"), L2("Бележка", "Note"), "IFC GUID", L2("Слой", "Layer")], bold: true, fill: "FFECE8DF" }];
    for (const a of state.asms.slice().sort((x, y) => x.mark.localeCompare(y.mark, undefined, { numeric: true }))) {
      const s = state.status.get(a.guid) || {};
      if (s.erected) rows.push({ values: [a.mark, s.erected_date || "", s.erected_by || "", s.erected_note || "", a.guid, a.layer] });
    }
    await saveXlsx("erected", [{ name: L2("Монтирани", "Erected"), rows, widths: [12, 12, 20, 30, 26, 18] }]);
  }
  async function exportMarks() {
    const av = avail();
    const rows = [{ values: [L2("Марка", "Mark"), L2("Бр. в модела", "In model"), L2("Доставени", "Delivered"), L2("Доставени: въведени", "Delivered: typed"), L2("Доставени: Excel", "Delivered: Excel"), L2("Източник", "Source"), L2("Монтирани", "Erected"), L2("Налични (дост. − монт.)", "Available (deliv. − erect.)"), L2("Светнали за монтаж", "Instances ready"), L2("Не доставени", "Not delivered"), L2("Задържани", "On hold"), L2("Грешни", "Wrong")], bold: true, fill: "FFECE8DF" }];
    for (const m of av.marks) rows.push({ values: [m.mark, m.instances, m.delivered, m.typed, m.excel, srcName(m.source), m.erected, m.available, m.ready, m.notDelivered, m.hold, m.wrong] });
    await saveXlsx("by-mark", [{ name: L2("По марки", "By mark"), rows, widths: [12, 10, 10, 12, 12, 16, 10, 14, 14, 12, 10, 10] }]);
  }
  async function exportDeliveries() {
    const rows = [{ values: [L2("Дата", "Date"), "№", L2("Марка", "Mark"), L2("Бр.", "Qty"), L2("От", "By"), L2("Източник", "Source"), L2("Анулирана", "Cancelled")], bold: true, fill: "FFECE8DF" }];
    for (const d of state.deliveries) for (const l of L.parseLines(d.lines)) rows.push({ values: [d.date, d.note_no || "", l.mark, l.qty, d.by || "", d.source || "", d.cancelled ? L2("да", "yes") : ""] });
    // marks the fabricator's Excel counts higher than the typed notes: one row with the difference, so the sum per mark
    // equals "Доставени" on the screen (review 9 low 12)
    const xl = [...avail().byMark].filter(([, x]) => x.excel > x.typed).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    const xlSrc = L2("Excel на производителя (с дата; + монтирани)", "Fabricator's Excel (dated; + erected)");
    for (const [mark, x] of xl) rows.push({ values: ["", "", mark, x.excel - x.typed, "", xlSrc, ""] });
    if (xl.length) rows.push({ values: [] }, { values: [L2(`Редовете „${xlSrc}“ допълват въведените доставки до „Доставени“ (по-голямото от въведените и Excel).`, `Rows "${xlSrc}" add to the typed deliveries up to "Delivered" (the larger of typed and Excel).`)] });
    await saveXlsx("deliveries", [{ name: L2("Доставки", "Deliveries"), rows, widths: [12, 14, 12, 8, 20, 20, 10] }]);
  }

  // ---------- selection ----------
  async function fromViewer() {
    const s = (await state.api.viewer.getSelection()) || [];
    const picked = new Map();
    for (const m of s) for (const id of m.objectRuntimeIds || []) {
      const a = state.byKey.get(key(m.modelId, id));
      if (a) { picked.set(a.guid, a); continue; }
      const p = await parentAssembly(m.modelId, id);   // a part was clicked: take its assembly
      if (p) picked.set(p.guid, p);
    }
    state.sel = [...picked.values()]; selChanged();
    render();
  }
  async function selectMark(mark) {
    const list = state.asms.filter((a) => L.normMark(a.mark) === L.normMark(mark));
    state.sel = list; selChanged();
    const s = sel(list);
    await state.api.viewer.setSelection(s, "set");
    try { await state.api.viewer.setCamera(s, { animationTime: 400 }); } catch {}
    render();
  }

  // ---------- wiring ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act], #tabs button");
    if (!b) return;
    if (b.dataset.tab) { state.tab = b.dataset.tab; state.fabClearArmed = 0; render(); return; }
    const act = b.dataset.act;
    guarded(async () => {
      if (act === "on" || act === "off") await applyFlag(b.dataset.kind, act === "on");
      else if (act === "pickMark") await selectMark(b.dataset.mark);
      else if (act === "dlvAdd") await addDelivery(R.parseDeliveryText($("dlvText").value).lines, "typed");
      else if (act === "dlvCancel") await cancelDelivery(+b.dataset.i);
      else if (act === "dlvCancelNo") { state.cancelling = null; render(); }
      else if (act === "dlvPendOk") { const p = state.dlvPending; state.dlvPending = null; if (p) await addDelivery(p.lines, p.source); }
      else if (act === "dlvPendNo") { state.dlvPending = null; setStatus(L2("Импортът е отказан.", "Import cancelled.")); render(); }
      else if (act === "fabApply") await applyFab();
      else if (act === "moveLegacy") await moveLegacy();
      else if (act === "clearFab") await clearFab();
      else if (act === "noBackupGo") {   // second, explicit confirmation after a failed backup (review 9 M5)
        const q = state.noBackupAsk; state.noBackupAsk = null;
        if (!q) return;
        state.noBackupOk = q.action;
        try {
          if (q.action === "move") await moveLegacy();
          else if (q.action === "fab-clear") { state.fabClearArmed = Date.now(); await clearFab(); }
        } finally { state.noBackupOk = null; }
      }
      else if (act === "noBackupNo") { state.noBackupAsk = null; setStatus(L2("Отказано – нищо не е променено.", "Cancelled – nothing was changed.")); render(); }
      else if (act === "fabCancel") { state.fabPlan = null; setStatus(L2("Импортът е отказан.", "Import cancelled.")); render(); }
      else if (act === "boltXlsx") await exportBoltsXlsx();
      else if (act === "boltPdf") exportBoltsPdf();
      else if (act === "docErected") await exportErected();
      else if (act === "docMarks") await exportMarks();
      else if (act === "docDeliveries") await exportDeliveries();
    });
  });
  $("btnSelClear").onclick = () => { state.sel = []; state.fabClearArmed = 0; state.flagArmed = null; state.noBackupAsk = null; state.drafts = {}; state.draftSel = null; render(); };
  // typed dates and notes survive re-renders until saved or the selection is cleared (week 1, F6). They belong to the
  // selection they were typed for: adding pieces keeps them, any other selection drops them (round 8 M2).
  function selChanged() {
    state.fabClearArmed = 0; state.flagArmed = null; state.noBackupAsk = null;   // a confirm never carries over to another selection (round 8 low 3)
    if (state.draftSel && !state.draftSel.every((g) => state.sel.some((a) => a.guid === g))) { state.drafts = {}; state.draftSel = null; }
  }
  document.addEventListener("input", (e) => {
    const id = e.target.id || "";
    if (/^dlv(Date|No|Text)$/.test(id)) { state.dlvDraft = Object.assign(state.dlvDraft || {}, { [id]: e.target.value }); return; }   // round 8 M5
    const m = /^([dn])_(erected|wrong|hold)$/.exec(id);
    if (!m) return;
    const dr = state.drafts[m[2]] || (state.drafts[m[2]] = {});
    dr[m[1] === "d" ? "date" : "note"] = e.target.value;
    state.draftSel = state.sel.map((a) => a.guid);
    if (m[1] === "d") { const h = $("h_" + m[2]); if (h) h.hidden = !oldDate(e.target.value); }
  });
  $("chkFollow").onchange = (e) => { state.follow = e.target.checked; };
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; await applyColours(); });
  $("selLang").value = lang;
  $("selLang").onchange = (e) => { lang = e.target.value; try { localStorage.setItem("arsten.assemblyStatus.lang", lang); } catch {} render(); };

  let loadGen = 0;
  async function load() {
    const gen = ++loadGen;
    try { if (!(await loadModel(gen))) return; }   // a newer load took over
    catch (e) { if (gen !== loadGen) return; throw e; }   // an error of a superseded load (its model was unloaded) is not shown (L1)
    clearTimeout(waitTimer);
    if (!state.asms.length && !(allObjects || []).length && waitTries < 30) {
      // no objects yet: the panel opened before a model was loaded, or the model is still streaming in
      waitTries++;
      setStatus(L2("Чакам да се зареди модел…", "Waiting for a model to load…"));
      waitTimer = setTimeout(() => guarded(load), 4000);
      return;
    }
    waitTries = 0;
    if (!state.asms.length) {
      // say what the viewer returned, so a live problem can be diagnosed from the panel
      const cls = new Map();
      for (const o of allObjects || []) cls.set(o.cls || "?", (cls.get(o.cls || "?") || 0) + 1);
      const seen = [...cls].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join(", ");
      setStatus(L2("В заредените модели няма сглобки (IfcElementAssembly).", "No assemblies (IfcElementAssembly) in the loaded models.") +
        ` [${(allObjects || []).length} obj${seen ? ": " + seen : ""}]`, true); return;
    }
    try { if (!(await loadRecords(gen)) && gen !== loadGen) return; }
    catch (e) { if (gen !== loadGen) return; throw e; }   // an error of a superseded load is not shown (round 4, L8)
    state.ready = true;
    $("main").hidden = false;
    const site = state.bolts.filter((b) => b.sides && (b.sides.others || []).length).length;
    const st = state.loadStats || {};
    const warn = [];
    if (st.dupAsms || st.dupBolts) warn.push(L2(`заредени два пъти (припокриващи се модели): ${st.dupAsms} сглобки, ${st.dupBolts} болта – броени веднъж`,
      `loaded twice (overlapping models): ${st.dupAsms} assemblies, ${st.dupBolts} bolts – counted once`));
    if (st.childErrors) warn.push(L2(`${st.childErrors} сглобки без прочетени елементи`, `${st.childErrors} assemblies whose parts could not be read`));
    if (st.lookupFailed) warn.push(L2(`${st.lookupFailed} основни елемента не можаха да се потърсят – презаредете`, `${st.lookupFailed} main parts could not be looked up – reload`));
    setStatus(`${state.asms.length} ${L2("сглобки", "assemblies")} · ${new Set(state.asms.map((a) => a.mark)).size} ${L2("марки", "marks")} · ${state.bolts.length} ${L2("болтови групи", "bolt groups")} (${site} ${L2("между две сглобки", "between two assemblies")})`
      + (st.slowLookups ? ` · ${L2("бавно търсене", "slow lookups")}: ${st.slowLookups}` : "")
      + (warn.length ? " · ⚠ " + warn.join("; ") : ""), !!warn.length);
    render();
    if (state.coloured) await applyColours();
  }
  async function start(api, client) {
    state.api = api;
    state.access = window.ARSTEN_DEMO ? { allowed: true, role: "admin" } : await ArstenAccess.check({ api, getToken, app: "assembly" });
    if (!state.access.allowed) { state.denied = true; state.api = null; ArstenAccess.renderDenied(document.body, lang, state.access); return; }
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; } catch {}
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    render();
    await guarded(load);
  }
  window.AssemblyStatusApp = { start, state, onEvent: (e, d) => onEvent(e, d) };

  let selTimer = null, reloadTimer = null, waitTimer = null, waitTries = 0;
  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (state.denied || !state.api) return;
    // models loaded by a stage may still be streaming in while the first load runs: reload on their events too; the
    // load generation makes the older load stand down (review round 3, M2)
    // 3 s: a stage loads its models one after the other; one reload after the last of them (round 4, L9)
    if (event === "viewer.onModelStateChanged") { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => guarded(load), 3000); }
    if (!state.ready) return;
    if (event === "viewer.onSelectionChanged" && state.follow) { clearTimeout(selTimer); selTimer = setTimeout(() => guarded(fromViewer), 200); }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
