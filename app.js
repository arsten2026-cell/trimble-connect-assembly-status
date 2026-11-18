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
  const RECORD_POOL = 5;   // pset-api batch-get calls at once while loading the records (speed audit item 1: cap 4-6)
  const ELEMENT_ASSEMBLY = 4;   // HierarchyType.ElementAssembly
  const T = {
    title: ["Стомана", "Steel"],
    selection: ["Избрано", "Selection"], follow: ["Следи избора в модела", "Follow model selection"], clear: ["Изчисти", "Clear"],
    nothing: ["Нищо не е избрано. Изберете сглобки в модела или марка от таблицата.", "Nothing selected. Select assemblies in the model or a mark in the table."],
    view: ["Изглед", "View"], colour: ["Оцвети по статус", "Colour by status"],
    marks: ["Марки", "Marks"], deliveries: ["Доставки", "Deliveries"], fab: ["Производство", "Fabrication"], bolts: ["Болтове", "Bolts"], docs: ["Документи", "Documents"],
    erected: ["Монтиран", "Erected"], wrong: ["Грешно изработен", "Wrong (fabrication)"], hold: ["Задържан", "On hold"],
    set: ["Отбележи", "Set"], undo: ["Премахни", "Remove"], note: ["Бележка", "Note"], reason: ["Причина", "Reason"],
    noRight: ["Нямате права за това.", "You have no rights for this."],
  };
  // one language for all tools (A10): shared key "arsten.lang" (shared/arsten-i18n.js), the old key read once
  const I18N = window.ArstenI18n, OLD_LANG = ["arsten.assemblyStatus.lang"];
  let lang = I18N ? I18N.getLang(OLD_LANG) : "bg";
  const t = (k) => (T[k] ? T[k][lang === "bg" ? 0 : 1] : k);
  const L2 = (b, e) => (lang === "bg" ? b : e);
  // counted forms (round 19 L6): "1 сглобка" / "2 сглобки", "1 марка" / "2 марки", "1 запис" / "2 записа"
  const nW = (n, one, many, en1, enN) => `${n} ${lang === "bg" ? (Math.abs(Number(n)) === 1 ? one : many) : (Math.abs(Number(n)) === 1 ? en1 : enN)}`;
  const nAsm = (n) => nW(n, "сглобка", "сглобки", "assembly", "assemblies");
  const nMark = (n) => nW(n, "марка", "марки", "mark", "marks");
  const nRec = (n) => nW(n, "запис", "записа", "record", "records");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? String(Math.round(n * 10) / 10) : String(v == null ? "" : v); };
  const oldDate = (d) => { if (!d) return false; const t0 = new Date(); t0.setDate(t0.getDate() - 7); return String(d) < `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, "0")}-${String(t0.getDate()).padStart(2, "0")}`; };   // > 7 days back (A6)
  // one date format in every panel (round 14 M4): BG 17.11.2026, EN 17 Nov 2026
  const fmtDate = (d) => (!d ? "" : I18N ? I18N.fmtDate(d, lang) : lang === "bg" ? String(d).split("-").reverse().join(".") : d);
  // round 19 L4: the load's status line (statusLine) is built again after a language switch; any other status is not
  let statusIsLine = null;
  function setStatus(text, bad) { statusIsLine = null; $("status").textContent = text; $("status").className = "status" + (bad ? " bad" : ""); }
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
  // plain words, not "Грешка: Failed to fetch" / "PATCH …: 412" on a weak site signal (sweep 18.11.2026, as Монолитен
  // бетон, Дейности, Статус). Стомана has no Обнови button, so friendly's default "reopen the panel" applies. A panel's
  // own sentence (no status, not technical) is shown as it is; the raw error goes to the console.
  const plainErr = (e) => (I18N ? I18N.friendly(e, lang) : L2("Грешка: ", "Error: ") + errText(e));
  async function guarded(fn) { try { await fn(); } catch (e) { console.error(e); flash(plainErr(e), true); } }
  // Writes vs. a model reload (review 10 M3, as Монолитен бетон round 8 M4): a reload waits while writes are in flight,
  // the write buttons are refused while a load runs, and a write that still lands during a load is put back over the
  // load's older read (book.replay in loadRecords), so it never disappears from the screen.
  let inflight = 0;
  const book = L.writeBook();
  async function writing(fn) { inflight++; try { return await fn(); } finally { inflight--; } }
  // One write at a time (sweep 18.11.2026): a second tap while a write runs is ignored, the write buttons show
  // "Записване…" disabled (a double tap on „Запиши доставка“ used to save the same note twice). gate.busy = the action.
  const gate = L.singleFlight();
  const SAVING = () => L2("Записване…", "Saving…");
  /** A record just written: into the live map (never one captured before an await) and into the book. */
  function keepRec(field, guid, rec) {
    if (rec == null) state[field].delete(guid); else state[field].set(guid, rec);
    book.add(field, guid, rec);
  }
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
  }

  const state = {
    api: null, client: null, project: null, user: "", access: null, lib: null, ready: false,
    partsReady: false, partsError: "",   // phase B of a load (parts, bolts) done / its error (audit item 2)
    asms: [], byKey: new Map(), byGuid: new Map(), asmOfChild: new Map(),   // assembly instances {modelId, id, guid, mark, layer, weight, finish, parts:[runtime ids]}
    bolts: [], status: new Map(), holds: new Map(), deliveries: [],
    fab: new Map(), fabPlan: null,   // fabrication dates per IFC GUID (fabrication.js); the import waiting for "Save"
    sel: [], coloured: true, tab: "marks", boltScope: "all", follow: true,   // colouring on by default, remembered per user (week 3, A7)
    markFilter: "",   // search above the Марки table (A5)
    fabFiles: { list: [], loading: false, error: "", missing: false, complete: true, at: 0, busy: null },   // _AM_Docs/Fabrication (B-Office 1)
    cancelling: null, cancelReason: "",   // the delivery link whose reason box is open, and the typed reason (sweep 18.11.2026)
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
  // Rights follow every group the user is in (round 11, M4) and the server lock (M3): statuses, deliveries and the
  // fabrication import need a group with Edit (ArstenAccess.canWrite: 00_ADMIN, 02, 02.1); a Connect project ADMIN outside
  // them gets the panel read-only. Holds: those, plus designers (04 / 4.1 have Edit on Assembly hold).
  const can = (what) => {
    if (window.ARSTEN_DEMO) return true;
    const a = state.access;
    if (what === "fab") what = "status";   // fabrication import: same people as statuses for now; a fabricator group later (round 5, L10)
    return what === "hold" ? ArstenAccess.canWrite(a) || ArstenAccess.hasRole(a, "designer") : ArstenAccess.canWrite(a);
  };
  /** Why a write button is off: an admin outside the Edit groups is told how to get write access (M3). */
  const noRight = () => (!window.ARSTEN_DEMO && ArstenAccess.hasRole(state.access, "admin") && !ArstenAccess.canWrite(state.access)
    ? L2("Само преглед: добавете се в 00_ADMIN, за да записвате.", "Read only: add yourself to 00_ADMIN to save.") : t("noRight"));
  // Who is looking (week 3, A8; round 11, M5): the same rule as Монолитен бетон (ArstenAccess.side). Site roles do not
  // see the Производство tab, the "стар формат / Премести" banner, load diagnostics or raw GUIDs. Office = admin, the PM
  // side (the "stages" cap), designers, fabricator.
  const office = () => ArstenAccess.side(state.access) === "office";

  // ---------- view options, remembered per user in this browser (week 3, A7) ----------
  const viewKey = () => "arsten.assemblyStatus.view:" + (state.userId || "anon");
  function loadView() {
    let raw = null;
    try { raw = localStorage.getItem(viewKey()); } catch {}
    const v = L.readView(raw);
    state.coloured = v.coloured; state.follow = v.follow; state.tab = v.tab;
  }
  function saveView() {
    try { localStorage.setItem(viewKey(), JSON.stringify({ coloured: state.coloured, follow: state.follow, tab: state.tab })); } catch {}
  }

  // ---------- token ----------
  let token = null, waiters = [];
  function onToken(tk) { token = tk; const w = waiters; waiters = []; w.forEach((f) => f(tk)); }
  // The waiter is registered before asking (the token event may come while requestPermission runs). When Connect
  // returns the token directly, or refuses, the waiter and its 60 s timer are dropped, so no unobserved promise is
  // rejected a minute later (review round 12, L6).
  async function getToken(refresh) {
    if (token && !refresh) return token;
    let timer = 0, done = null;
    const p = new Promise((resolve, reject) => {
      done = (tk) => { clearTimeout(timer); resolve(tk); };
      waiters.push(done);
      timer = setTimeout(() => { waiters = waiters.filter((f) => f !== done); reject(new Error(L2("Trimble Connect не даде ключ за достъп", "No access token from Trimble Connect"))); }, 60000);
    });
    const drop = () => { clearTimeout(timer); waiters = waiters.filter((f) => f !== done); p.catch(() => {}); };
    let r;
    try { r = await state.api.extension.requestPermission("accesstoken"); } catch (e) { drop(); throw e; }
    if (r === "denied") { drop(); throw new Error(L2("Достъпът до данните в Trimble Connect е отказан за това разширение.", "Access to Trimble Connect data was denied for this extension.")); }
    if (r && r !== "pending" && r !== "granted") { drop(); token = r; return r; }
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
  // VIEWER_POOL viewer calls at once (sweep 18.11.2026): chunks were read one after the other; 4 as viewer-project-status.
  const VIEWER_POOL = 4;
  async function readAll(ctx) {
    if (ctx.all) return ctx.all;
    const api = state.api;
    const models = ((await api.viewer.getObjects()) || []).map((m) => ({ modelId: m.modelId, ids: (m.objects || []).map((o) => o.id) }));
    const jobs = L.classChunks(models, BATCH);
    const total = models.reduce((n, m) => n + m.ids.length, 0);
    let read = 0;
    const got = await A.mapLimit(jobs, VIEWER_POOL, async (j) => {
      if (ctx.stale()) return [];
      const ps = (await api.viewer.getObjectProperties(j.modelId, j.ids)) || [];
      read += j.ids.length;
      setStatus(L2(`Чета модела… ${read} от ${total}`, `Reading the model… ${read} of ${total}`));
      return ps.map((p) => ({ modelId: j.modelId, id: p.id, cls: String(p.class || "") }));
    }, { retries: 0 });
    const all = [].concat(...got);
    if (ctx.stale()) return all;
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
      // assemblies as parents of the parts (as in Cast unit tags). Per model, parents asked for 200 ids at a time
      // (4 at once) and only the ids their children do not cover one by one (sweep 18.11.2026, steel.js findParents;
      // was one getHierarchyParents call per object of every loaded model). The children read here go into ctx.kids,
      // so loadParts does not ask for them again.
      const perModel = new Map();
      for (const o of await readAll(ctx)) {
        if (/elementassembly/i.test(o.cls)) continue;
        if (!perModel.has(o.modelId)) perModel.set(o.modelId, []);
        perModel.get(o.modelId).push(o.id);
      }
      const total = [...perModel.values()].reduce((n, ids) => n + ids.length, 0);
      let found = 0;
      setStatus(L2(`Търся сглобките… ${total} обекта`, `Finding assemblies… ${total} objects`));
      for (const [modelId, ids] of perModel) {
        if (ctx.stale()) break;
        const r = await L.findParents(ids,
          (chunk) => api.viewer.getHierarchyParents(modelId, chunk, ELEMENT_ASSEMBLY),
          async (pid) => ((await api.viewer.getHierarchyChildren(modelId, [pid], ELEMENT_ASSEMBLY)) || []).map((c) => c.id),
          { pool: 4, stale: ctx.stale });
        if (r.parents.length) byModel.set(modelId, r.parents);
        for (const [pid, kids] of r.kids) if (kids.length) ctx.kids.set(key(modelId, pid), kids);
        found += r.parents.length;
        console.info(`[Стомана] assemblies as hierarchy parents: ${r.parents.length} in model ${modelId} with ${r.calls} viewer calls for ${ids.length} objects`);
        setStatus(L2(`Търся сглобките… намерени ${found}`, `Finding assemblies… ${found} found`));
      }
    }
    return [...byModel].map(([modelId, ids]) => ({ modelId, ids }));
  }

  async function readClass(cls, psetRe, ctx) {
    const api = state.api;
    const jobs = L.classChunks(await idsOfClass(cls, ctx), BATCH);
    if (ctx.stale()) return [];
    // properties and GUIDs of a chunk side by side, VIEWER_POOL chunks at once; results in model + chunk order
    // (sweep 18.11.2026: were two serial calls per chunk - 4 000 bolts = 40 calls one after the other)
    const got = await A.mapLimit(jobs, VIEWER_POOL, async (j) => {
      if (ctx.stale()) return [];
      const [props, guids] = await Promise.all([api.viewer.getObjectProperties(j.modelId, j.ids), api.viewer.convertToObjectIds(j.modelId, j.ids)]);
      return (props || []).map((p, k) => ({ modelId: j.modelId, id: p.id, guid: (guids || [])[k] || null, ps: psetOf(p, psetRe) || {} }));
    }, { retries: 0 });
    if (ctx.stale()) return [];
    return [].concat(...got).filter((o) => o.guid);
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

  // Children of each assembly per loaded model, kept for the panel's session (speed audit item 2a; steel.js childCache).
  const childCache = L.childCache();
  /** getModels("loaded"); [] when the call fails (the model set then counts as changed, L.modelSetKey). */
  async function loadedModels() {
    try { return (await state.api.viewer.getModels("loaded")) || []; } catch { return []; }
  }
  /** modelId -> version id of the loaded models (getModels may list a model under its file id or its version id). A
   *  model it does not list gets no version, and its children are then never taken from the cache. */
  function modelVersions(specs) {
    const out = new Map();
    for (const m of specs || []) {
      if (!m || !m.versionId) continue;
      if (m.id != null) out.set(m.id, m.versionId);
      out.set(m.versionId, m.versionId);
    }
    return out;
  }

  /**
   * Phase A of a load (audit item 2, smallest step): the assemblies of the loaded models (marks, GUIDs, weights), which
   * is all the Марки / Доставки / Документи tabs and every write need. Assigns them to state with empty part maps
   * (state.partsReady false) and returns {asms, byKey, dupAsms}; null (and changes nothing) when a newer load started
   * meanwhile, e.g. a stage that loads and unloads models fires several model events (review round 2, #3).
   */
  async function loadAssemblies(gen, ctx) {
    const stale = () => gen !== loadGen;
    setStatus(L2("Чета сглобките…", "Reading assemblies…"));
    const raw = await readClass("IfcElementAssembly", /^Assembly/i, ctx);
    if (stale()) return null;
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
    // everything of the assemblies at once; the part maps and bolts of the last load are dropped together (they point
    // at its assembly objects) and come with phase B
    state.asms = asms; state.byKey = byKey; state.byGuid = new Map(asms.map((a) => [a.guid, a]));
    state.asmOfChild = new Map(); state.bolts = []; state.partsReady = false; state.partsError = "";
    allObjects = ctx.all;
    return { asms, byKey, dupAsms };
  }
  /**
   * Phase B, in the background after phase A: the parts of each assembly (hierarchy children), the bolts and their
   * sides. Builds into local variables and assigns to state only at the end (state.partsReady = true); returns false
   * (and changes nothing) when a newer load started meanwhile. Nothing written depends on it: until it ends the colours
   * wait, the Болтове tab and a box-select of parts show "зареждане на частите…", a mark picked in the table is
   * selected in the model when it ends, and one clicked part is asked from the viewer (getHierarchyParents).
   */
  async function loadParts(gen, ctx, got, versions) {
    const stale = () => gen !== loadGen;
    const { asms, byKey, dupAsms } = got;
    const partsOf = new Map();   // assembly -> child runtime ids of this load (put on the assemblies only at the end)
    // children of each assembly (parts and, in Tekla IFC, its bolts): one call per ASSEMBLY, reused below so the bolts
    // need no call each (4000 bolts used to mean ~8000 one-by-one calls; user 15.11.2026)
    // Kept per model for the session (speed audit item 2a): a reload or stage switch that leaves a model loaded with the
    // same version and the same assemblies (runtime id = GUID) reads no children for it again. What is read is unchanged.
    const nextKids = new Map();   // modelId -> {sig, kids: Map(assembly runtime id -> child ids)} of this load
    const todoA = [];
    for (const a of asms) {
      if (!nextKids.has(a.modelId)) {
        const sig = L.modelSig(versions.get(a.modelId), asms.filter((x) => x.modelId === a.modelId));
        nextKids.set(a.modelId, { sig, kids: new Map(), old: childCache.take(a.modelId, sig) });
      }
      const e = nextKids.get(a.modelId);
      // from the session cache, or from the hierarchy-parent fallback of this load (idsOfClass, sweep 18.11.2026)
      const c = (e.old && e.old.get(a.id)) || (ctx.kids && ctx.kids.get(key(a.modelId, a.id)));
      if (c) { partsOf.set(a, c.slice()); e.kids.set(a.id, c); } else todoA.push(a);
    }
    let doneA = 0, childErrors = 0;
    const t0 = Date.now();
    await A.mapLimit(todoA, 8, async (a) => {
      if (stale()) return;
      try {
        const kids = ((await state.api.viewer.getHierarchyChildren(a.modelId, [a.id], ELEMENT_ASSEMBLY)) || []).map((c) => c.id);
        partsOf.set(a, kids);
        if (kids.length) nextKids.get(a.modelId).kids.set(a.id, kids.slice());   // an empty answer is never kept
      } catch { partsOf.set(a, []); childErrors++; }
      if (++doneA % 50 === 0 && !stale()) partsProgress(doneA, todoA.length);
    });
    const childMs = Date.now() - t0;
    if (todoA.length) console.info(`[Стомана] getHierarchyChildren: ${todoA.length} calls (pool 8) in ${childMs} ms; ${asms.length - todoA.length} assemblies from the session cache`);
    if (stale()) return false;
    const asmOfChild = new Map();   // key(model, child runtime id) -> assembly; kept in state for the selection (item 9a)
    for (const a of asms) for (const id of partsOf.get(a) || []) asmOfChild.set(key(a.modelId, id), a);
    const rawBolts = await readClass("IfcMechanicalFastener", /^Bolt/i, ctx);
    if (stale()) return false;
    // a bolt group loaded twice (two overlapping models) is counted once (#11)
    const seenBolt = new Set();
    let dupBolts = 0;
    const fs = rawBolts.filter((f) => { if (seenBolt.has(f.guid)) { dupBolts++; return false; } seenBolt.add(f.guid); return true; });
    // bolts are not parts: keep them out of the parts lists (colouring)
    const boltKeys = new Set(rawBolts.map((f) => key(f.modelId, f.id)));
    for (const a of asms) partsOf.set(a, (partsOf.get(a) || []).filter((id) => !boltKeys.has(key(a.modelId, id))));
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
      if (++doneB % 200 === 0 && !stale()) partsProgress(doneB, fs.length, true);
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
    const assemblies = needFallback ? await assemblyBoxes(asms, partsOf) : [];
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
    for (const a of asms) a.parts = partsOf.get(a) || [];
    state.asmOfChild = asmOfChild;
    state.bolts = bolts;
    childCache.keep(nextKids);
    state.loadStats = { assemblies: asms.length, bolts: bolts.length, slowLookups: slow, dupAsms, dupBolts, childErrors, lookupFailed: ctx.failed,
      childCalls: todoA.length, childCached: asms.length - todoA.length, childMs: Math.round(childMs) };
    allObjects = ctx.all;
    state.hasLinks = exportHasLinks;
    state.partsReady = true;
    return true;
  }
  // VIEWER_POOL assemblies at once, results in assembly order (sweep 18.11.2026: were one call after the other)
  async function assemblyBoxes(asms, partsOf) {
    return A.mapLimit(asms, VIEWER_POOL, async (a) => {
      const parts = partsOf.get(a) || [];
      let boxes = [];
      try { boxes = ((await state.api.viewer.getObjectBoundingBoxes(a.modelId, parts.length ? parts : [a.id])) || []).map((x) => x.boundingBox).filter(Boolean); } catch {}
      return { guid: a.guid, mark: a.mark, boxes };
    }, { retries: 0 });
  }

  // ---------- library ----------
  /** Statuses, holds and deliveries of the loaded assemblies. Read into locals; assigned only when this is still the
   *  newest load, so a slow older load cannot overwrite the newer load's statuses (review round 3, M1). Without gen
   *  (after a save) it always assigns. */
  /** The GUID-free part of the record read (library, definitions, deliveries list), see L.prepRecords. With its write
   *  mark taken BEFORE the deliveries list starts, so a write landing meanwhile is replayed (M3). */
  function startRecords() {
    const since = book.mark();
    return { since, p: L.prepRecords(state.client, { projectId: state.project.id, names: R.LIB_NAMES, defs: R.definitions(),
      fabDef: F.definition(), delDef: R.DEF.delivery, delPrefix: R.deliveryPrefix(state.project.id) }) };
  }
  /** pre: a startRecords() begun earlier (loadPhaseA starts it beside the viewer scan, sweep 18.11.2026); without it
   *  (after a save) it is started here. */
  async function loadRecords(gen, pre) {
    const current = () => gen === undefined || gen === loadGen;
    const { since, p } = pre || startRecords();   // writes landing after `since` may be missing from the reads below (M3)
    const prep = await p;
    const found = prep.found;
    if (!current()) return false;
    if (!found.lib) {
      state.lib = null;
      if (found.denied) console.warn("library not readable", "STEEL/Монтаж", JSON.stringify({ denied: found.denied }));   // round 19 M1: into the diagnostics
      $("setupBox").hidden = false;
      $("setupBox").innerHTML = found.denied ? L2(`Библиотеката <b>STEEL/Монтаж</b> не е видима за вас – може да съществува, но без достъп за вас. Попитайте администратора на проекта, преди някой да създаде нова.`,
        `The library <b>STEEL/Монтаж</b> is not visible to you – it may exist without access for you. Ask the project admin before anyone creates a new one.`) : L2(`Библиотеката <b>STEEL/Монтаж</b> още не съществува. Администратор я създава веднъж в Connect: Property Set Libraries → New library → име „STEEL/Монтаж“. Статусите не могат да се записват дотогава.`,
        `The library <b>STEEL/Монтаж</b> does not exist yet. An admin creates it once in Connect: Property Set Libraries → New library → name "STEEL/Монтаж". Statuses cannot be saved until then.`);
      return;
    }
    $("setupBox").hidden = true;
    state.lib = found.lib;
    // all definitions side by side (sweep 18.11.2026; were 4 serial calls). Non-admins cannot create definitions (403,
    // ignored; reading still works). Fabrication dates: an admin's first visit creates the definition; until then there
    // is nothing to read. Any error of it only disables the Производство tab, never the rest of Стомана (round 5, M3)
    let fabFail = prep.fabFail;   // definitions already ensured in startRecords
    const links = state.asms.map((a) => entLink(a.guid));
    const legacy = state.asms.filter((a) => hasLegacy(a.guid)).map((a) => legacyLink(a.guid));
    const toMap = (m) => new Map([...m].map(([l, p]) => [guidOfLink(l), p]));
    // Records still under a raw-"$" link (Connect's own panel and Tekla never show them) are listed in
    // state.legacyOnly for "Премести": kind "move" = only the raw record exists; "merge" = both exist and the raw one
    // has history the encoded one lacks (an old cached client wrote it after the move, round 6 M2) - its fields win;
    // "stale" = the raw one is an old copy already contained in the encoded record - only deleted.
    const legacyOnly = [];
    const merge = (def, old, cur) => {
      const out = new Map(cur);
      for (const [g, p] of old) {
        if (!cur.has(g)) { legacyOnly.push({ def, guid: g, kind: "move" }); out.set(g, p); }
        else if (isStale(p, cur.get(g))) legacyOnly.push({ def, guid: g, kind: "stale" });
        else { legacyOnly.push({ def, guid: g, kind: "merge" }); out.set(g, Object.assign({}, cur.get(g), p, { log: [cur.get(g).log, p.log].filter(Boolean).join("\n") })); }
      }
      return out;
    };
    // status, hold and fabrication, each under the encoded and (for "$" GUIDs) the raw legacy link: every 100-link call
    // of all of them at most RECORD_POOL at once, with retry on 429/503 (speed audit item 1; were one after the other).
    // The deliveries are listed at the same time. A status / hold error fails the load as before; a fabrication error
    // only empties the Производство tab.
    const both = (def, soft) => [{ def, form: "old", links: legacy, soft }, { def, form: "cur", links, soft }];
    const reads = both(R.DEF.status, false).concat(both(R.DEF.hold, false), fabFail ? [] : both(F.DEF_ID, true));
    const jobs = L.chunkReads(reads, 100);
    const readJob = (j) => A.mapLimit([j], 1, (x) => state.client.readMany(state.lib.id, x.def, x.links)).then((r) => r[0]);   // 429/503 retried
    const t0 = Date.now();
    const [got, dels] = await Promise.all([
      A.mapLimit(jobs, RECORD_POOL, async (j) => {
        if (!current() || (j.soft && fabFail)) return null;   // a newer load took over / the fabrication read already failed
        if (!j.soft) return readJob(j);
        try { return await readJob(j); } catch (e) { if (!fabFail) fabFail = e; return null; }
      }, { retries: 0 }),
      prep.dels,   // started in startRecords, right after the definitions
    ]);
    console.info(`[Стомана] records: ${jobs.length} batch-get calls (pool ${RECORD_POOL}) + deliveries in ${Date.now() - t0} ms`);
    const res = L.joinReads(reads, jobs, got).map(toMap);
    const status = merge(R.DEF.status, res[0], res[1]);
    const holds = merge(R.DEF.hold, res[2], res[3]);
    let fab = new Map(), fabError = "";
    if (fabFail) {
      if (fabFail.status !== 404) { fabError = errText(fabFail); console.warn("fabrication dates not available", fabFail); }
    } else fab = merge(F.DEF_ID, res[4], res[5]);
    if (!current()) return false;
    state.status = status; state.holds = holds; state.fab = fab; state.fabError = fabError; state.legacyOnly = legacyOnly;
    state.deliveries = [...dels].map(([link, p]) => Object.assign({ link }, p)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    book.replay(state, since);   // a write that finished during this load stays on screen (M3)
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
  // Colours need the parts (phase B): asked earlier, they are painted when the parts are in (settle).
  let colourDeferred = false;
  async function applyColours() {
    if (!state.asms.length) return;
    if (!state.partsReady) { colourDeferred = true; return; }
    colourDeferred = false;
    if (!state.coloured) return state.api.viewer.setObjectState(sel(state.asms), { color: "reset", opacity: 1 });
    // one setObjectState call per colour group (week 3, A7); colours and opacity from steel.js STATES
    const st = avail().state;
    for (const s of L.STATES) {
      const list = state.asms.filter((a) => st.get(a.guid) === s.id);
      if (list.length) await state.api.viewer.setObjectState(sel(list), { color: s.colour, opacity: s.opacity == null ? 1 : s.opacity });
    }
  }

  // ---------- undo files before mass actions (shared/arsten-backup.js, owner 16.11.2026) ----------
  const backupCache = new Map();
  let backupCore = null;
  const coreFor = () => window.ARSTEN_PHOTOS_CORE || backupCore || (backupCore = ArstenBackup.coreClient(ArstenAccess.coreBase(state.project.location), getToken));
  /** Snapshot of the records [{def, link}] an action is about to change or delete, read fresh (or taken from `known`,
   *  Map def -> Map link -> props), uploaded to _AM_Docs/Backups/<day>/ before the action runs. Upload failed: the
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
    // the path only for the office side; site roles see "Архивът е запазен" (A11)
    if (res.uploaded) return office() || !I18N ? ArstenBackup.note(res, lang) : " · " + I18N.word("backupSaved", lang);
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
    if (!can(kind === "hold" ? "hold" : "status")) return flash(noRight(), true);
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
    const def = kind === "hold" ? R.DEF.hold : R.DEF.status, field = kind === "hold" ? "holds" : "status";
    // more than BIG pieces (the confirmed path): undo file first
    const bak = targets.length > BIG ? await backupFirst(`${kind}-${on ? (correcting ? "correct" : "set") : "undo"}`, linksOf(def, targets.map((a) => a.guid))) : "";
    let done = 0, failed = 0, first = "";
    const meanwhile = [];
    // Each piece is read fresh and written with its version (R.writeFlag, sweep 18.11.2026): another device's erected /
    // hold mark made after this panel loaded is never overwritten by our older copy, and an undo never re-creates it.
    await pool(targets, 6, async (a) => {
      const shown = state[field].get(a.guid) || null;
      if (!on && !(shown && shown[kind])) return;
      const raw = hasRaw(def, a.guid);
      const rawRow = raw ? (state.legacyOnly || []).find((r) => r.def === def && r.guid === a.guid) : null;
      const info = (fresh) => {
        if (!(correcting && fresh)) return { date, note, by: state.user, mark: a.mark };
        const ownDate = fresh[`${kind}_date`] ? String(fresh[`${kind}_date`]).slice(0, 10) : date;
        const newDate = typedDate && typedDate !== ownDate ? typedDate : ownDate;
        return { date: newDate, note: note || fresh[noteKey] || "", by: newDate !== ownDate ? state.user : fresh[`${kind}_by`] || state.user, mark: a.mark };
      };
      try {
        const r = await R.writeFlag(state.client, state.lib.id, def, { enc: entLink(a.guid), raw: raw ? legacyLink(a.guid) : null, rawKind: rawRow && rawRow.kind, shown, kind, on, info });
        keepRec(field, a.guid, r.rec);   // what is stored now: ours, or the other person's newer copy
        if (r.status !== "done") { meanwhile.push(a.mark || a.guid); return; }
        done++;
        if (raw && !on) state.legacyOnly = state.legacyOnly.filter((x) => !(x.def === def && x.guid === a.guid));
        else await dropLegacy(def, a.guid);
      } catch (e) { failed++; if (!first) first = e.status === 403 ? noRight() : errText(e); }
    });
    if (done && !failed) delete state.drafts[kind];
    const skipped = on ? state.sel.length - targets.length : 0;
    flash(`${t(kind)}: ${on ? L2("записано", "saved") : L2("премахнато", "removed")} ${done}`
      + (skipped ? ` · ${skipped} ${L2("вече отбелязани – не са променени", "already marked – left as they were")}` : "")
      + (meanwhile.length ? ` · ${meanwhile.length} ${L2("променени междувременно от друг – не са пипани, вижте ги пак", "changed by someone else meanwhile – left as they are, check them again")}: ${meanwhile.slice(0, 10).join(", ")}` : "")
      + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "") + bak, failed > 0 || meanwhile.length > 0);
    render();
    if (state.coloured) await applyColours();
  }

  async function addDelivery(lines, source) {
    if (!state.lib) return setStatus(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can("status")) return setStatus(noRight(), true);
    if (!lines.length) return setStatus(L2("Няма редове с марка и количество.", "No lines with mark and quantity."), true);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const rec = R.newDelivery({ date: $("dlvDate").value || R.today(), noteNo: $("dlvNo").value.trim(), lines: L.linesText(lines), by: state.user, source });
    const link = R.deliveryLink(state.project.id, id);
    await state.client.write(state.lib.id, R.DEF.delivery, link, rec);
    const shown = Object.assign({ link }, rec);
    state.deliveries.unshift(shown); book.add("deliveries", link, shown);
    const known = new Set(state.asms.map((a) => L.normMark(a.mark)));
    const unknown = lines.filter((l) => !known.has(l.mark)).map((l) => l.mark);
    flash(L2(`Доставката е записана (${nMark(lines.length)})`, `Delivery saved (${nMark(lines.length)})`) + (unknown.length ? ` · ${L2("няма в модела", "not in the model")}: ${unknown.join(", ")}` : ""), unknown.length > 0);
    // the saved text is cleared (the gate stops a second tap meanwhile, so the same note can not be posted twice)
    if ($("dlvText")) $("dlvText").value = ""; if ($("dlvNo")) $("dlvNo").value = ""; state.dlvDraft = null;
    render();
    if (state.coloured) await applyColours();
  }
  // Cancelling is keyed by the record's link, not its row (sweep 18.11.2026): a reload re-sorts state.deliveries, and
  // a colleague's new note sorting in above used to move the open reason box onto a different delivery, which
  // „Анулирай“ then cancelled. The typed reason lives in state.cancelReason, so a re-render keeps it.
  function openCancel(link) {
    if (!can("status")) return setStatus(noRight(), true);
    // inline reason box in the row (window.prompt is unreliable inside the Connect iframe)
    state.cancelling = link; state.cancelReason = "";
    render();
    const r = $("dlvReason"); if (r) r.focus();
  }
  async function cancelDelivery(link) {
    if (!can("status")) return setStatus(noRight(), true);
    if (!link || state.cancelling !== link) return openCancel(link);
    const reason = (state.cancelReason || "").trim();
    if (!reason) return setStatus(L2("Въведете причина за анулиране.", "Enter a reason for cancelling."), true);
    // read fresh and write with the version (R.writeCancel): a cancel or log line added meanwhile is never overwritten
    const r = await R.writeCancel(state.client, state.lib.id, R.DEF.delivery, link, { by: state.user, note: reason });
    state.cancelling = null; state.cancelReason = "";
    const next = r.rec ? Object.assign({ link }, r.rec) : null;
    const j = state.deliveries.findIndex((x) => x.link === link);   // the live list (a load may have replaced it)
    if (!next) { if (j >= 0) state.deliveries.splice(j, 1); }
    else if (j >= 0) state.deliveries[j] = next; else state.deliveries.unshift(next);
    book.add("deliveries", link, next);
    if (r.status === "meanwhile") flash(L2("Доставката вече е анулирана от друг – нищо не е променено.", "The delivery was already cancelled by someone else – nothing was changed."), true);
    else if (r.status === "gone") flash(L2("Доставката вече я няма – нищо не е променено.", "The delivery no longer exists – nothing was changed."), true);
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
      s.onerror = () => { excelLoad = null; reject(new Error(L2("Библиотеката за Excel не се зареди", "Could not load the Excel library"))); };
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

  /** file: a picked File, or {name, arrayBuffer()} downloaded from Connect; ref: {id, versionId, path} of a Connect
   *  file (B-Office 1), recorded in each history line so the file list can mark it "внесен". */
  async function importFab(file, ref) {
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
    state.fabPlan = { source: file.name, ref: ref || null, p: F.plan(rows, { toIfc: L.tcGuidToIfc, known, existing: state.fab, date1904: wb.date1904 }) };
    state.tab = "fab";
    const outside = state.fabPlan.p.notLoaded.length;   // A16: assemblies not in the loaded stage / models
    setStatus(L2(`Прочетен ${file.name}: проверете промените и натиснете „Запиши“.`, `Read ${file.name}: check the changes and press "Save".`)
      + (outside ? L2(` Пропуснати ${nAsm(outside)} извън заредения етап.`, ` ${nAsm(outside)} outside the loaded stage skipped.`) : "")
      + (skipped.length ? L2(` Пропуснати листове (без GUID / дати): `, ` Sheets skipped (no GUID / dates): `) + skipped.join(", ") : ""), skipped.length > 0 || outside > 0);   // round 5, L5
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
      } catch (e) { failed++; if (!first) first = e.status === 403 ? noRight() : errText(e); }
    });
    await loadRecords();
    flash(L2(`Преместени ${nRec(done)}.`, `Moved ${nRec(done)}.`) + (skipped ? ` · ${skipped} ${L2("без права", "no right")}` : "")
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
  // "Изчисти" the fabrication dates: admins with write access only (M3)
  const isAdmin = () => !!(window.ARSTEN_DEMO || (ArstenAccess.hasRole(state.access, "admin") && ArstenAccess.canWrite(state.access)));
  // the confirm click must follow within 10 s (round 6 L5)
  const clearArmed = () => !!state.fabClearArmed && Date.now() - state.fabClearArmed < 10000;
  async function clearFab() {
    if (!state.lib || !isAdmin()) return setStatus(noRight(), true);
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
      try { for (const l of links) await state.client.remove(state.lib.id, F.DEF_ID, l); keepRec("fab", a.guid, null); done++; }
      catch (e) { failed++; if (!first) first = e.status === 403 ? noRight() : errText(e); }
    });
    await loadRecords();
    flash(L2(`Изтрити дати: ${nAsm(done)}.`, `Dates cleared: ${nAsm(done)}.`) + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failed > 0);
    render();
    if (state.coloured) await applyColours();   // DelivDate counts as delivered (owner's rule 16.11.2026)
  }

  async function applyFab() {
    state.fabClearArmed = 0;
    const fp = state.fabPlan;
    if (!fp) return;
    if (!state.lib) return setStatus(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can("fab")) return setStatus(noRight(), true);
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
          if (F.changedSince(c, c.before, fresh).length) { meanwhile.push(c.mark || c.ifc); keepRec("fab", c.ifc, fresh); return; }
          // from Connect: "(file, Name, file:<id> v:<version>)" in the history line (steel.js parseFabLog)
          const patch = Object.assign(moved ? Object.assign({}, fresh) : {}, F.patchFor(fresh, c, { source: fp.source, by: [state.user, L.fileTag(fp.ref)].filter(Boolean).join(", ") }));
          try { await state.client.writeIfUnchanged(state.lib.id, F.DEF_ID, link, patch, cur ? cur.v : undefined); }
          catch (e) { if ((e.status === 412 || e.status === 409) && attempt < 3) continue; throw e; }
          keepRec("fab", c.ifc, Object.assign({}, fresh, patch));
          if (moved) await dropLegacy(F.DEF_ID, c.ifc);
          done++;
          return;
        }
      } catch (e) { failedList.push(c); if (!first) first = e.status === 403 ? noRight() : errText(e); }
      finally { const n = done + failedList.length + meanwhile.length; if (n % 25 === 0) setStatus(L2(`Записвам… ${n} от ${fp.p.changes.length}`, `Saving… ${n} of ${fp.p.changes.length}`)); }
    });
    // only what failed stays in the preview, so "Save" again does not rewrite (and re-log) what is already saved (L3)
    if (failedList.length) {
      fp.p.changes = failedList;
      fp.p.overwrites = failedList.reduce((n, c) => n + c.over.length, 0);
      fp.p.fills = failedList.reduce((n, c) => n + Object.keys(c.set).length, 0) - fp.p.overwrites;
    } else state.fabPlan = null;
    flash(L2(`Записани ${nAsm(done)}.`, `Saved ${nAsm(done)}.`)
      + (meanwhile.length ? L2(` · ${meanwhile.length} променени междувременно от друг – не са записани, импортирайте файла пак: `, ` · ${meanwhile.length} changed by someone else meanwhile – not saved, import the file again: `) + meanwhile.slice(0, 10).join(", ") + "." : "")
      + (failedList.length ? ` · ${failedList.length} ${L2("грешки", "failed")} (${first})` : "")
      + L2(" В Tekla: Trimble Connect → Property sets → синхронизиране.", " In Tekla: Trimble Connect → Property sets → synchronize.") + bak, failedList.length + meanwhile.length > 0);
    render();
    if (state.coloured) await applyColours();   // DelivDate counts as delivered (owner's rule 16.11.2026)
  }

  // ---------- the fabricator's files in Connect (week 3, B-Office 1) ----------
  // Read only: lists _AM_Docs/Fabrication and its subfolders (Core 2.0, the same client as the undo files), never
  // creates a folder. "Внеси" downloads the file (files/fs/{id}/downloadurl) and runs the same preview as a picked file;
  // the import keeps its preview, "Запиши" and undo file.
  // The project's tool folder is _AM_Docs (renamed from _ArstenDocs on 17.11.2026, one name for Arsten and Multiplan);
  // ArstenBackup.findFolder takes _AM_Docs first and falls back to an old _ArstenDocs. Nothing is ever created here.
  // Sweep 18.11.2026: the walk is SteelLogic.listFabEntries (every page of every listing, by_path for a folder Connect
  // leaves out of a parent closed to the user); before, only page 1 was read and long listings said "folder missing".
  async function listFabFiles() {
    if (!window.ArstenBackup) throw new Error(L2("модулът arsten-backup.js не е зареден. Презаредете панела.", "the module arsten-backup.js is not loaded. Reload the panel."));
    const r = await L.listFabEntries(ArstenBackup, coreFor(), state.project.id);
    return { missing: r.missing, complete: r.complete, files: L.fabFiles(r.entries) };
  }
  async function refreshFabFiles() {
    const ff = state.fabFiles;
    if (ff.loading) return;
    ff.loading = true; ff.error = "";
    try { const r = await listFabFiles(); ff.list = r.files; ff.missing = r.missing; ff.complete = r.complete !== false; }
    catch (e) { ff.list = []; ff.complete = true; ff.error = e.status === 403 ? L2("нямате достъп до папката", "no access to the folder") : errText(e); console.warn("fabricator files", e); }
    finally { ff.loading = false; ff.at = Date.now(); }
    if (state.tab === "fab") render();
  }
  async function importFromConnect(fileId) {
    const ff = state.fabFiles, f = ff.list.find((x) => x.id === fileId);
    if (!f || ff.busy) return;
    if (!can("fab")) return flash(noRight(), true);
    ff.busy = f.id; render();
    try {
      setStatus(L2(`Изтеглям ${f.name}…`, `Downloading ${f.name}…`));
      // exactly the version shown in the list, which is also the version recorded in the history (review 10 L4)
      const d = await coreFor().req(`files/fs/${encodeURIComponent(f.id)}/downloadurl${f.versionId ? `?versionId=${encodeURIComponent(f.versionId)}` : ""}`);
      const url = d && (d.url || d.downloadUrl || d.href);
      if (!url) throw new Error(L2("Connect не върна адрес за изтегляне", "Connect returned no download address"));
      let buf;
      try { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 120000); try { const res = await fetch(url, { signal: ctl.signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`); buf = await res.arrayBuffer(); } finally { clearTimeout(t); } }   // 2 min limit (round 12 M1)
      catch (e) { throw new Error(L2(`файлът не може да се изтегли в панела (${errText(e)}). Изтеглете го от Connect и го изберете с „Импорт Excel от производителя“.`,
        `the file cannot be downloaded into the panel (${errText(e)}). Download it from Connect and pick it with "Import the fabricator's Excel".`)); }
      await importFab({ name: f.name, arrayBuffer: async () => buf }, { id: f.id, versionId: f.versionId, path: f.path });
    } finally { ff.busy = null; render(); }
  }
  const fmtStamp = (s) => { if (!s) return ""; const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)/.exec(String(s)); if (!m) return fmtDate(String(s).slice(0, 10));
    const d = new Date(s); if (/T/.test(s) && !isNaN(d)) return `${fmtDate(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${fmtDate(m[1])} ${m[2]}`; };
  /** A13: stays after a fabrication import, read from the newest fabstatus record (its Source and history line). */
  function lastImportBox() {
    const li = L.lastImport(state.fab);
    if (!li) return "";
    return `<div class="keep">${esc(L2("Последен импорт", "Last import"))}: <b>${esc(li.source || "?")}</b>${li.by ? `, ${esc(li.by)}` : ""}, ${esc(fmtStamp(li.when))}${li.assemblies ? ` <span class="sub">(${li.assemblies} ${esc(L2("сглобки", "assemblies"))})</span>` : ""}
      – <b>${esc(L2("синхронизирайте Tekla преди нов отчет", "synchronize Tekla before a new report"))}</b> <span class="sub">(Trimble Connect → Property sets → Synchronize)</span></div>`;
  }
  function fabFilesBox(right) {
    const ff = state.fabFiles;
    if (!ff.at && !ff.loading && state.tab === "fab") setTimeout(() => guarded(refreshFabFiles), 0);   // first time the tab is shown
    const refs = L.importRefs(state.fab);
    const badge = (s) => (s === "imported" ? `<span class="badge done">${esc(L2("внесен", "imported"))}</span>`
      : s === "maybe" ? `<span class="badge maybe" title="${esc(L2("Внесен е файл със същото име, но без запис коя версия – проверете", "A file with this name was imported, but which version is not recorded – check"))}">${esc(L2("внесен?", "imported?"))}</span>`
      : s === "newVersion" ? `<span class="badge new">${esc(L2("нова версия", "new version"))}</span>` : `<span class="badge new">${esc(L2("нов", "new"))}</span>`);
    const rows = ff.list.map((f) => {
      const s = L.fileState(f, refs);
      return `<tr><td><b>${esc(f.name)}</b>${f.path ? `<div class="sub">${esc(f.path)}</div>` : ""}</td><td class="sub">${esc(fmtStamp(f.modified))}${f.by ? `<div>${esc(f.by)}</div>` : ""}</td><td>${badge(s)}</td>
        <td class="n"><button class="small${s === "imported" ? " secondary" : ""}" data-act="fabFromConnect" data-id="${esc(f.id)}" ${right && !ff.busy && !state.fabPlan ? "" : "disabled"}>${esc(ff.busy === f.id ? L2("Чета…", "Reading…") : s === "imported" ? L2("Внеси пак", "Import again") : L2("Внеси", "Import"))}</button></td></tr>`;
    }).join("");
    const body = ff.loading || !ff.at ? `<div class="sub">${esc(L2("Чета папката…", "Reading the folder…"))}</div>`
      : ff.error ? `<div class="warn">${esc(L2("Папката не може да се прочете: ", "The folder cannot be read: ") + ff.error)}</div>`
      : ff.missing && !ff.complete ? `<div class="warn">${esc(L2("Папката _AM_Docs/Fabrication не е намерена – списъкът на Connect е непълен. Натиснете „Обнови“.", "The folder _AM_Docs/Fabrication was not found – the Connect list is incomplete. Press \"Refresh\"."))}</div>`
      : ff.missing ? `<div class="sub">${esc(L2("Папката _AM_Docs/Fabrication още не съществува в проекта.", "The folder _AM_Docs/Fabrication does not exist in the project yet."))}</div>`
      : !ff.list.length ? `<div class="sub">${esc(L2("Няма файлове .xlsx / .xls в папката.", "No .xlsx / .xls files in the folder."))}</div>`
      : `<div class="scroll"><table><thead><tr><th>${esc(L2("Файл", "File"))}</th><th>${esc(L2("Качен", "Uploaded"))}</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return `<div class="box" style="margin-top:6px"><div class="bar" style="margin-top:0"><b>${esc(L2("Файлове от производителя", "Files from the fabricator"))}</b>
      <span class="sub">_AM_Docs/Fabrication</span><button class="small secondary" data-act="fabFilesRefresh" style="margin-left:auto" ${ff.loading ? "disabled" : ""}>${esc(L2("Обнови", "Refresh"))}</button></div>${body}
      ${ff.at && !ff.loading && !ff.error && !ff.missing && !ff.complete ? `<div class="warn">${esc(L2("Списъкът е непълен – Connect не върна всички файлове. Натиснете „Обнови“.", "The list is incomplete – Connect did not return every file. Press \"Refresh\"."))}</div>` : ""}
      ${state.fabPlan && ff.list.length ? `<div class="sub">${esc(L2("Първо запишете или откажете прегледания импорт.", "First save or cancel the import being previewed."))}</div>` : ""}</div>`;
  }

  // ---------- rendering ----------
  let lastAv = null, filterTimer = 0;   // figures of the last render, for the mark search (L3)
  function render() {
    $("title").textContent = t("title");
    $("hSel").textContent = t("selection"); $("lblFollow").textContent = t("follow"); $("btnSelClear").textContent = t("clear");
    $("hView").textContent = t("view"); $("lblColour").textContent = t("colour");
    $("chkColour").checked = state.coloured; $("chkFollow").checked = state.follow;
    // Производство: office side and admin only (week 3, A8)
    const off = office();
    if (state.tab === "fab" && !off) state.tab = "marks";
    document.querySelectorAll("#tabs button").forEach((b) => { b.textContent = t(b.dataset.tab); b.classList.toggle("on", b.dataset.tab === state.tab); b.hidden = b.dataset.tab === "fab" && !off; });
    ["marks", "deliveries", "fab", "bolts", "docs"].forEach((k) => { $("tab-" + k).hidden = state.tab !== k; });
    const av = state.ready ? avail() : null;
    lastAv = av;
    const counts = new Map();
    if (av) for (const s of av.state.values()) counts.set(s, (counts.get(s) || 0) + 1);
    $("legend").innerHTML = L.STATES.map((s) => `<span class="li"><span class="sw" style="background:${s.colour};opacity:${s.opacity == null ? 1 : Math.max(s.opacity, 0.6)}"></span>${esc(lang === "bg" ? s.bg : s.en)}${av ? ` <span class="cnt">${counts.get(s.id) || 0}</span>` : ""}</span>`).join("");
    $("legend").classList.toggle("off", !state.coloured);
    if (!state.ready) return;
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
      const onLbl = flagArmed(kind, true, on.list.length) ? L2(`Потвърди: ${nAsm(on.list.length)}`, `Confirm: ${nAsm(on.list.length)}`)
        : on.correcting ? L2(`Поправи (${on.list.length})`, `Correct (${on.list.length})`) : `${t("set")}${sel.length ? ` (${on.list.length})` : ""}`;
      const offLbl = flagArmed(kind, false, off.list.length) ? L2(`Потвърди: премахни ${off.list.length}`, `Confirm: remove ${off.list.length}`) : `${t("undo")}${off.list.length ? ` (${off.list.length})` : ""}`;
      return `<div class="act" style="--c:${colour}">
      <div class="hd"><span class="nm">${esc(t(kind))}</span><span class="st">${sel.length ? `${has(store, kind)}/${sel.length}` : ""}</span></div>
      <div class="row">${kind === "erected" || kind === "hold" ? `<input type="date" id="d_${kind}" max="${R.today()}" value="${esc(dateVal)}"><span class="sub" id="h_${kind}" ${dr.date != null && oldDate(dr.date) ? "" : "hidden"}>${esc(L2("проверете датата", "check the date"))}</span>` : ""}<input type="text" id="n_${kind}" value="${esc(noteVal)}" placeholder="${esc(mixed ? L2("различни – празно = без промяна", "differ – empty = unchanged") : noteLbl + (needNote ? " *" : ""))}"></div>
      ${on.correcting && sel.length ? `<div class="sub">${esc(L2("Всички избрани вече са отбелязани. „Поправи“ записва само това, което промените; празно поле = всяка сглобка запазва своето.", "All selected are already marked. \"Correct\" writes only what you change; an empty box = each keeps its own."))}</div>`
        : sel.length && on.list.length < sel.length ? `<div class="sub">${esc(L2(`${sel.length - on.list.length} вече отбелязани остават както са.`, `${sel.length - on.list.length} already marked stay as they are.`))}</div>` : ""}
      <div class="row"><button class="small" data-act="on" data-kind="${kind}" ${on.list.length && right && !gate.busy ? "" : "disabled"}>${esc(gate.busy === "on:" + kind ? SAVING() : onLbl)}</button>
        <button class="small secondary undo" data-act="off" data-kind="${kind}" ${off.list.length && right && !gate.busy ? "" : "disabled"}>${esc(gate.busy === "off:" + kind ? SAVING() : offLbl)}</button>
        ${right ? "" : `<span class="sub">${esc(noRight())}</span>`}</div></div>`;
    };
    const colourOf = (id) => (L.STATES.find((s) => s.id === id) || {}).colour;
    $("acts").innerHTML = act("erected", colourOf("erected"), state.status, can("status"), false, t("note"))
      + act("wrong", colourOf("wrong"), state.status, can("status"), true, t("note"))
      + act("hold", colourOf("hold"), state.holds, can("hold"), true, t("reason"));
    // only the tab that is shown (speed audit item 15): every tab switch calls render(), so a hidden tab is drawn when
    // it is opened; until then it keeps its last content, hidden
    if (!off) $("tab-fab").innerHTML = "";
    if (state.tab === "marks") renderMarks(av);
    else if (state.tab === "deliveries") renderDeliveries(av);
    else if (state.tab === "fab") renderFab();
    else if (state.tab === "bolts") renderBolts();
    else if (state.tab === "docs") renderDocs(av);
    const bl = $("build"); if (bl) bl.textContent = `Стомана v${BUILD}`;
  }

  /** A16 (week 4): the rows an import leaves out because their assemblies are not in the loaded stage / models – count,
   *  the full list by mark, and what to do. Shown at the top of the preview, so nobody thinks they were saved. */
  function skippedBox(p) {
    const s = F.skippedByMark(p.notLoaded);
    if (!s.total) return "";
    const marks = s.list.map((x) => (x.n > 1 ? `${x.mark} ×${x.n}` : x.mark));
    return `<div class="warn" id="fabSkipped"><b>${esc(L2(`Пропуснати: ${nAsm(s.total)} – няма да се запишат`, `Skipped: ${nAsm(s.total)} – will not be saved`))}</b><br>
      ${esc(L2("Не са в заредения етап – заредете етапа, за да ги внесете.", "Not in the loaded stage – load the stage to import them."))}
      <details${s.list.length <= 20 ? " open" : ""}><summary>${esc(L2(`Списък (${nMark(s.list.length)})`, `List (${nMark(s.list.length)})`))}</summary><div class="sub" style="user-select:text">${esc(marks.join(" · "))}</div></details></div>`;
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
        ${skippedBox(p)}
        <div class="sub">${p.rows} ${L2("реда", "rows")} · ${p.guids} ${L2("сглобки с данни", "assemblies with data")} · ${L2("нови стойности", "new values")} <b>${p.fills}</b> · ${L2("промени на въведени", "changes to stored")} <b>${p.overwrites}</b> · ${L2("без промяна", "unchanged")} ${p.unchanged}${p.notLoaded.length ? ` · <b class="bad">${L2("пропуснати", "skipped")} ${p.notLoaded.length}</b>` : ""}</div>
        ${over.length ? `<div class="warn"><b>${esc(L2("Ще се променят вече въведени стойности", "Stored values that will change"))}</b> (${over.length}):<br>${over.slice(0, 15).map((c) => esc(`${c.mark}: ` + c.over.map((o) => `${fname(o.field)} ${show(o.field, o.from)} → ${show(o.field, o.to)}`).join(", "))).join("<br>")}${over.length > 15 ? "<br>…" : ""}</div>` : ""}
        ${list(L2("Неразпознати дати (пропуснати)", "Dates not understood (skipped)"), p.problems)}
        ${list(L2("Проверете (ДД/ММ или ММ/ДД?)", "Check (DD/MM or MM/DD?)"), p.warnings)}
        ${list(L2("Една сглобка с различни стойности", "One assembly with different values"), p.conflicts)}
        ${list(L2("Невалиден GUID", "Invalid GUID"), p.badGuid)}
        <div class="bar"><button class="small" data-act="fabApply" ${p.changes.length && right ? "" : "disabled"}>${esc(L2(`Запиши (${nAsm(p.changes.length)})`, `Save (${nAsm(p.changes.length)})`))}</button>
          <button class="small secondary" data-act="fabCancel">${esc(L2("Откажи", "Cancel"))}</button>${right ? "" : `<span class="sub">${esc(noRight())}</span>`}</div></div>`;
    }
    $("tab-fab").innerHTML = (state.fabError ? `<div class="warn">${esc(L2("Датите за производство не могат да се прочетат: ", "Fabrication dates cannot be read: ") + state.fabError)}</div>` : "") + `<div class="box">
        <div>${L2("Изработени", "Fabricated")}: <b>${fabN}</b> · ${L2("Доставени", "Delivered")}: <b>${delN}</b> / ${total}</div>
        <div class="bar"><label class="small secondary filebtn" style="${right ? "" : "opacity:.45;pointer-events:none"}">${L2("Импорт Excel от производителя", "Import the fabricator's Excel")}<input type="file" id="fabFile" accept=".xlsx,.xls,.htm,.html" hidden></label>
          ${right ? "" : `<span class="sub">${esc(noRight())}</span>`}</div>
        ${legacyBanner()}${noBackupBox()}${lastImportBox()}
        ${isAdmin() && state.sel.length ? `<div class="bar"><button class="small secondary" data-act="clearFab">${esc(clearArmed()
          ? L2(`Потвърди: изтрий датите на ${nAsm(state.sel.length)}`, `Confirm: clear the dates of ${nAsm(state.sel.length)}`)
          : L2(`Изтрий датите на избраните (${state.sel.length})`, `Clear the dates of the selected (${state.sel.length})`))}</button></div>` : ""}
        <div class="sub">${esc(L2("Файлът от отчета AM_Fabrication с попълнени оранжеви колони. Сглобките се разпознават по GUID. Празна клетка не изтрива дата. Tekla чете датите като ASSEMBLY.PSET.AM_Fabrication.* след „Synchronize property sets“.",
          "The AM_Fabrication report file with the orange columns filled. Assemblies are matched by GUID. An empty cell never clears a date. Tekla reads the dates as ASSEMBLY.PSET.AM_Fabrication.* after \"Synchronize property sets\"."))}</div></div>${preview}${fabFilesBox(right)}`;
    const f = $("fabFile");
    if (f) f.onchange = (e) => guarded(async () => { const file = e.target.files[0]; e.target.value = ""; if (file) await importFab(file); });
  }

  function legacyBanner() {
    const n = (state.legacyOnly || []).length;
    if (!n || !office()) return "";   // an admin migration task: not shown to site roles (week 3, A8)
    const any = ["status", "hold", "fab"].some((w) => can(w));
    return `<div class="warn">${esc(L2(`${nRec(n)} (сглобки с „$“ в GUID) са в стар формат и не се виждат в панела на Connect и в Tekla.`, `${n} records (assemblies with "$" in the GUID) are in the old format and are not shown in Connect's panel or Tekla.`))}
      <div class="bar"><button class="small" data-act="moveLegacy" ${any ? "" : "disabled"}>${esc(L2("Премести", "Move"))}</button></div></div>`;
  }
  function renderMarks(av) {
    const over = av.marks.filter((m) => m.over);
    const ae = document.activeElement, focused = !!ae && ae.id === "markFilter", pos = focused ? ae.selectionStart : null;
    const html = legacyBanner() + noBackupBox() + differsWarn(av) + (over.length ? `<div class="warn">${esc(L2("Монтирани повече от доставените: ", "Erected more than delivered: "))}${esc(over.map((m) => `${m.mark} (${m.erected}/${m.delivered})`).join(", "))}</div>` : "")
      + (av.unknownDeliveredMarks.length ? `<div class="warn">${esc(L2("Доставени марки, които ги няма в модела: ", "Delivered marks not in the model: "))}${esc(av.unknownDeliveredMarks.join(", "))}</div>` : "")
      // search box (week 3, A5): filters the rows below without re-rendering itself, so typing keeps the focus
      + `<div class="search"><input type="search" id="markFilter" value="${esc(state.markFilter)}" placeholder="${esc(L2("Търси марка: RF, RF22, 22…", "Find a mark: RF, RF22, 22…"))}" autocomplete="off" enterkeyhint="search"><span id="markCount" class="sub"></span></div>`
      + `<div class="scroll"><table><thead><tr><th>${L2("Марка", "Mark")}</th><th class="n">${L2("Бр.", "Qty")}</th><th class="n">${L2("Дост.", "Deliv.")}</th><th class="n">${L2("Монт.", "Erect.")}</th><th class="n" title="${esc(L2("Готови за монтаж = доставени, още не монтирани", "Ready to erect = delivered, not erected yet"))}">${L2("Готови", "Ready")}</th><th class="n">${L2("Не дост.", "Not del.")}</th></tr></thead><tbody id="markRows"></tbody></table></div>`
      // one term for "delivered, not erected yet" (sweep 18.11.2026): the column, the colour legend and the Excel all
      // say "Готови за монтаж"; a visible line because phones can not show the header's hover title
      + `<div class="sub">${esc(L2("Готови = доставени, още не монтирани (готови за монтаж).", "Ready = delivered, not erected yet (ready to erect)."))}</div>`;
    // a selection click changes nothing in this tab: the same HTML is not parsed again, so the table, its scroll
    // position and the search box (focus, caret; A5) stay as they are (speed audit item 15)
    const box = $("tab-marks");
    if (box._html !== html || !$("markRows")) { box.innerHTML = html; box._html = html; }
    fillMarkRows(av);
    if (focused && document.activeElement !== $("markFilter")) { const el = $("markFilter"); el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
  }
  const shownMarks = (av) => av.marks.filter((m) => L.matchMark(m.mark, state.markFilter));
  function fillMarkRows(av) {
    const shown = shownMarks(av);
    $("markCount").textContent = state.markFilter.trim() ? `${shown.length} / ${av.marks.length}` : "";
    const rows = $("markRows"), html = (shown.length ? "" : `<tr><td colspan="6" class="sub">${esc(L2("Няма такава марка.", "No such mark."))}</td></tr>`)
      + shown.map((m) => `<tr><td class="name"><button class="small secondary" data-act="pickMark" data-mark="${esc(m.mark)}" title="${esc(L2("Избери в модела", "Select in the model"))}">${esc(m.mark || "?")}</button>${m.hold ? ` <span class="sub">${L2("задърж.", "hold")} ${m.hold}</span>` : ""}${m.wrong ? ` <span class="bad sub">${L2("грешни", "wrong")} ${m.wrong}</span>` : ""}</td>
        <td class="n">${m.instances}</td><td class="n" title="${esc(m.source ? `${srcName(m.source)} · ${srcFigures(m)}` : "")}">${m.delivered}${m.source ? `<div class="sub${m.differs ? " bad" : ""}">${esc(m.differs ? srcFigures(m) : srcName(m.source))}</div>` : ""}</td><td class="n${m.over ? " bad" : ""}">${m.erected}</td><td class="n">${m.available}</td><td class="n">${m.notDelivered}</td></tr>`).join("");
    if (rows._html !== html) { rows.innerHTML = html; rows._html = html; }
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
    const pendBox = pend ? `<div class="warn"><b>${esc(pend.source)}</b>: ${esc(L2(`${nMark(pend.lines.length)}, ${pend.lines.reduce((n, l) => n + l.qty, 0)} бр.`, `${nMark(pend.lines.length)}, ${pend.lines.reduce((n, l) => n + l.qty, 0)} pcs`))}
        <div class="sub">${esc(pend.lines.slice(0, 20).map((l) => `${l.mark}×${l.qty}`).join(", "))}${pend.lines.length > 20 ? " …" : ""}</div>
        <div class="sub">${esc(L2("Дата и № на стоковата разписка се вземат от полетата по-долу.", "Date and delivery note no. come from the fields below."))}</div>
        <div class="bar"><button class="small" data-act="dlvPendOk" ${right && !gate.busy ? "" : "disabled"}>${esc(gate.busy === "dlvPendOk" ? SAVING() : L2("Запиши доставката", "Save the delivery"))}</button><button class="small secondary" data-act="dlvPendNo">${esc(L2("Откажи", "Cancel"))}</button></div></div>` : "";
    $("tab-deliveries").innerHTML = pendBox + differsWarn(av) + `<div class="box">
        <div class="bar"><input type="date" id="dlvDate" max="${R.today()}" value="${esc(dd.dlvDate != null ? dd.dlvDate : R.today())}"><input type="text" id="dlvNo" value="${esc(dd.dlvNo || "")}" placeholder="${esc(L2("Стокова разписка №", "Delivery note no."))}"></div>
        <textarea id="dlvText" placeholder="${esc(L2("Марка и брой на ред, напр.\nRF22 3\nCL22 2", "Mark and qty per line, e.g.\nRF22 3\nCL22 2"))}">${esc(dd.dlvText || "")}</textarea>
        <div class="bar"><button class="small" data-act="dlvAdd" ${right && !gate.busy ? "" : "disabled"}>${esc(gate.busy === "dlvAdd" ? SAVING() : L2("Запиши доставка", "Save delivery"))}</button>
          <label class="small secondary filebtn" style="${right ? "" : "opacity:.45;pointer-events:none"}">${L2("Импорт Excel/CSV", "Import Excel/CSV")}<input type="file" id="dlvFile" accept=".xlsx,.csv,.txt" hidden></label>
          ${right ? "" : `<span class="sub">${esc(noRight())}</span>`}</div>
        <div class="sub">${esc(L2("Файл: колона A марка, колона B брой (редовете със заглавия се пропускат).", "File: column A mark, column B qty (header rows are skipped)."))}</div></div>
      <div class="scroll" style="margin-top:6px"><table><thead><tr><th>${L2("Дата", "Date")}</th><th>№</th><th>${L2("Марки", "Marks")}</th><th></th></tr></thead><tbody>`
      + (state.deliveries.length ? state.deliveries.map((d) => `<tr${d.cancelled ? ' style="opacity:.5"' : ""}><td>${esc(fmtDate(d.date))}</td><td>${esc(d.note_no || "")}</td>
          <td>${esc(L.parseLines(d.lines).map((l) => `${l.mark}×${l.qty}`).join(", "))}<div class="sub">${esc(d.by || "")}${d.cancelled ? " · " + L2("анулирана", "cancelled") : ""}</div></td>
          <td>${d.cancelled || !right ? "" : state.cancelling === d.link
            ? `<input type="text" id="dlvReason" value="${esc(state.cancelReason || "")}" placeholder="${esc(L2("Причина *", "Reason *"))}" style="width:90px"><div class="bar" style="margin:3px 0 0"><button class="small" data-act="dlvCancel" data-link="${esc(d.link)}" ${gate.busy ? "disabled" : ""}>${esc(gate.busy === "dlvCancel" ? SAVING() : L2("Анулирай", "Void it"))}</button><button class="small secondary" data-act="dlvCancelNo">${L2("Не", "No")}</button></div>`
            : `<button class="small secondary" data-act="dlvCancel" data-link="${esc(d.link)}" ${gate.busy ? "disabled" : ""}>${L2("Анулирай", "Void")}</button>`}</td></tr>`).join("")
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
    if (!state.partsReady) { $("tab-bolts").innerHTML = `<div class="sub">${esc(state.partsError ? L2("Частите не са прочетени: ", "The parts could not be read: ") + state.partsError : partsText())}</div>`; return; }
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
      <button class="small secondary" data-act="docInstances">${L2("Статус по сглобки (Excel)", "Status per assembly (Excel)")}</button>
      <button class="small secondary" data-act="docDeliveries">${L2("Доставки (Excel)", "Deliveries (Excel)")}</button></div>
      <div class="sub">${esc(L2("„По марки“ и „Статус по сглобки“ съдържат датите за производство, теглата и % по тегло.", "\"By mark\" and \"Status per assembly\" include the fabrication dates, the weights and the % by weight."))}</div></div>
      ${office() ? lastImportBox() : ""}`;
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
      for (const [i, f] of Object.entries(sh.numFmts || {})) ws.getColumn(+i + 1).numFmt = f;
      if (sh.freeze) ws.views = [{ state: "frozen", ySplit: sh.freeze }];
      if (sh.filter) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: sh.filter.rows + 1, column: sh.filter.cols } };
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
  // "По марки" and "Статус по сглобки" with fabrication dates, weights and % by weight (week 3, A14; steel.js).
  // Weight: the model's ASSEMBLY weight (pset "Assembly", property Assembly_Weight), as read at load.
  const isDeliveredFab = (g) => R.fabDelivered(state.fab, g);
  const HDR = "FFECE8DF";
  const noWeightNote = () => ({ values: [L2("Теглото липсва в заредения модел (Assembly_Weight) – колоните за тегло са празни.", "The weight is missing in the loaded model (Assembly_Weight) – the weight columns are empty.")] });
  async function exportMarks() {
    const x = L.markExportRows(avail(), state.asms, { fab: state.fab, status: state.status, isDelivered: isDeliveredFab, srcName, lang });
    const rows = [{ values: x.header, bold: true, fill: HDR }, ...x.rows.map((v) => ({ values: v })), { values: x.total, bold: true }, { values: [] },
      { values: [L2("Тегло: ASSEMBLY тегло от модела, kg. Доставено (kg) = доставени бр. × средното тегло на марката. „Общо“ сумира само видимите редове при филтър.",
        "Weight: the model's ASSEMBLY weight, kg. Delivered (kg) = delivered qty × the mark's average weight. \"Total\" sums only the rows shown by a filter.")] }];
    if (x.noWeight) rows.push(noWeightNote());
    await saveXlsx("by-mark", [{ name: L2("По марки", "By mark"), rows, widths: [12, 10, 10, 12, 12, 16, 10, 14, 14, 12, 10, 10, 11, 12, 12, 13, 13, 12, 13, 13, 13, 13, 12, 12, 12],
      numFmts: Object.fromEntries(x.pctCols.map((i) => [i, "0.0%"])), freeze: 1, filter: { rows: x.rows.length, cols: x.header.length } }]);
  }
  async function exportInstances() {
    const x = L.instanceExportRows(state.asms, { state: avail().state, stateName, fab: state.fab, status: state.status, holds: state.holds, isDelivered: isDeliveredFab, lang });
    const rows = [{ values: x.header, bold: true, fill: HDR }, ...x.rows.map((v) => ({ values: v })), { values: x.total, bold: true }];
    if (x.noWeight) rows.push({ values: [] }, noWeightNote());
    await saveXlsx("by-assembly", [{ name: L2("По сглобки", "By assembly"), rows, widths: [12, 11, 18, 12, 16, 16, 12, 18, 24, 24, 24, 18, 22, 26],
      freeze: 1, filter: { rows: x.rows.length, cols: x.header.length } }]);
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
  // a part or bolt is looked up in the map built at load (speed audit item 9a: a box-select of 500 parts was 500 calls
  // in a row); only ids the map does not know are asked from the viewer, 6 at a time. A newer selection wins.
  // While the parts are still loading (phase B) a few unknown ids (a clicked part) are asked as before; a box-select of
  // more waits for the parts instead of thousands of calls, with "зареждане на частите…" in the status line.
  let selGen = 0;
  const FEW_UNKNOWN = 8;
  async function fromViewer() {
    const my = ++selGen;
    const s = (await state.api.viewer.getSelection()) || [];
    let r = L.selectionAssemblies(s, state.byKey, state.asmOfChild);
    if (r.unknown.length > FEW_UNKNOWN && !state.partsReady) {
      setStatus(partsText());
      await waitParts();
      if (my !== selGen) return;
      r = L.selectionAssemblies(s, state.byKey, state.asmOfChild);
      if (!state.partsReady) { if (state.ready) statusLine(false); return; }   // parts not read: no thousands of calls
      statusLine(true);
    }
    if (r.unknown.length) await pool(r.unknown, 6, async (u) => { r.list[u.at] = await parentAssembly(u.modelId, u.id); });
    if (my !== selGen) return;
    state.sel = L.uniqueAssemblies(r.list); selChanged();
    render();
  }
  async function selectMark(mark) {
    let list = state.asms.filter((a) => L.normMark(a.mark) === L.normMark(mark));
    state.sel = list; selChanged();
    if (!state.partsReady) {
      // the status buttons work at once; the pieces are shown in the model when the parts are in (phase B)
      render();
      setStatus(partsText() + L2(" Марката ще се избере в модела след малко.", " The mark will be selected in the model in a moment."));
      await waitParts();
      if (state.sel !== list || !state.partsReady) return;   // another selection meanwhile / parts not read
      list = list.map((a) => state.byGuid.get(a.guid)).filter(Boolean);   // a newer load's objects
      state.sel = list;
      statusLine(true);
    }
    const s = sel(list);
    await state.api.viewer.setSelection(s, "set");
    try { await state.api.viewer.setCamera(s, { animationTime: 400 }); } catch {}
    render();
  }

  // ---------- wiring ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act], #tabs button");
    if (!b) return;
    if (b.dataset.tab) { state.tab = b.dataset.tab; state.fabClearArmed = 0; saveView(); render(); return; }
    const act = b.dataset.act;
    // write buttons: refused while the model is being (re)loaded, counted while they run (review 10 M3)
    const WRITES = ["on", "off", "dlvAdd", "dlvCancel", "dlvPendOk", "fabApply", "moveLegacy", "clearFab", "noBackupGo"];
    // the first "Анулирай" only opens the reason box: no write, so no gate and no "Записване…"
    if (act === "dlvCancel" && state.cancelling !== b.dataset.link) { if (!gate.busy) openCancel(b.dataset.link); return; }
    const isWrite = WRITES.includes(act);
    if (isWrite && gate.busy) return;   // a write is running: the second tap is ignored (sweep 18.11.2026)
    if (isWrite && book.loading) return flash(L2("Моделът се презарежда – опитайте след малко.", "The model is reloading – try again in a moment."), true);
    // the typed text is read BEFORE the gate's render (which redraws the boxes) and before any await
    const dlvText = act === "dlvAdd" ? (($("dlvText") || {}).value || "") : "";
    const run = (fn) => (isWrite
      ? gate.run(act === "on" || act === "off" ? `${act}:${b.dataset.kind}` : act, () => { render(); return writing(fn); }).finally(() => render())
      : fn());
    guarded(() => run(async () => {
      if (act === "on" || act === "off") await applyFlag(b.dataset.kind, act === "on");
      else if (act === "pickMark") await selectMark(b.dataset.mark);
      else if (act === "dlvAdd") await addDelivery(R.parseDeliveryText(dlvText).lines, "typed");
      else if (act === "dlvCancel") await cancelDelivery(b.dataset.link);
      else if (act === "dlvCancelNo") { state.cancelling = null; state.cancelReason = ""; render(); }
      else if (act === "dlvPendOk") {
        const p = state.dlvPending; state.dlvPending = null;
        // a failed save puts the import back, so "Запиши доставката" can be tapped again (it is not lost)
        if (p) { try { await addDelivery(p.lines, p.source); } catch (e) { if (!state.dlvPending) state.dlvPending = p; throw e; } }
      }
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
      else if ((act === "boltXlsx" || act === "boltPdf") && !state.partsReady) flash(partsText(), true);
      else if (act === "boltXlsx") await exportBoltsXlsx();
      else if (act === "boltPdf") exportBoltsPdf();
      else if (act === "docErected") await exportErected();
      else if (act === "docMarks") await exportMarks();
      else if (act === "docDeliveries") await exportDeliveries();
      else if (act === "docInstances") await exportInstances();
      else if (act === "fabFilesRefresh") await refreshFabFiles();
      else if (act === "fabFromConnect") await importFromConnect(b.dataset.id);
    }));
  });
  // Enter in the mark search with exactly one match selects that mark in the model (A5)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target || e.target.id !== "markFilter" || !state.ready) return;
    e.preventDefault();
    const shown = shownMarks(avail());
    if (shown.length === 1) guarded(() => selectMark(shown[0].mark));
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
    // search (round 12, L3): the figures of the last render (they change with the data, not with typing), 80 ms debounce
    if (id === "markFilter") {
      state.markFilter = e.target.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { if (state.ready && $("markRows")) fillMarkRows(lastAv || avail()); }, 80);
      return;
    }
    if (id === "dlvReason") { state.cancelReason = e.target.value; return; }   // kept across re-renders (sweep 18.11.2026)
    if (/^dlv(Date|No|Text)$/.test(id)) { state.dlvDraft = Object.assign(state.dlvDraft || {}, { [id]: e.target.value }); return; }   // round 8 M5
    const m = /^([dn])_(erected|wrong|hold)$/.exec(id);
    if (!m) return;
    const dr = state.drafts[m[2]] || (state.drafts[m[2]] = {});
    dr[m[1] === "d" ? "date" : "note"] = e.target.value;
    state.draftSel = state.sel.map((a) => a.guid);
    if (m[1] === "d") { const h = $("h_" + m[2]); if (h) h.hidden = !oldDate(e.target.value); }
  });
  $("chkFollow").onchange = (e) => { state.follow = e.target.checked; saveView(); };
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; saveView(); $("legend").classList.toggle("off", !state.coloured); await applyColours(); });
  $("selLang").value = lang;
  $("selLang").onchange = (e) => { lang = I18N ? I18N.setLang(e.target.value) : e.target.value; render(); if (statusIsLine != null) statusLine(statusIsLine); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };

  let loadGen = 0;
  // Audit item 8 (smallest step): the loaded model set {id@versionId} of the last load that finished (records and
  // parts). A model event that leaves it unchanged (Connect fires them for streaming and visibility too) re-reads
  // nothing: only the colours are painted again. A missing versionId never compares equal (L.modelSetKey).
  let lastModelsKey = null;
  const activeLoads = new Set();   // generations whose phase A or B still runs
  /** Every model (re)load goes through here: it waits while writes are in flight (M3), and while phase A (assemblies
   *  + records) runs the write buttons are refused (book.loading). Phase B (parts, bolts) runs on in the background. */
  async function load() {
    if (inflight > 0) { reloadSoon(1000); return; }
    if (await modelsUnchanged()) return;
    book.loadStarted();
    try { await loadNow(); } finally { book.loadEnded(); }
  }
  async function modelsUnchanged() {
    if (!state.ready || !state.partsReady || activeLoads.size || lastModelsKey == null) return false;
    const gen = loadGen, k = L.modelSetKey(await loadedModels());
    if (gen !== loadGen || activeLoads.size || !L.sameModelSet(lastModelsKey, k)) return false;
    console.info("[Стомана] model event: the loaded models did not change – no reload");
    if (state.coloured) await applyColours();
    return true;
  }
  function reloadSoon(ms) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => guarded(load), ms); }

  // ---------- waiting for the parts (phase B) ----------
  const partsText = () => L2("Зареждане на частите…", "Loading the parts…");
  let partsWait = null;
  /** Resolves when the newest load's parts are in, or that load ended without them (error / no assemblies). */
  function waitParts() {
    if (state.partsReady || state.partsError || !activeLoads.size) return Promise.resolve();
    if (!partsWait) { let resolve; const promise = new Promise((r) => { resolve = r; }); partsWait = { promise, resolve }; }
    return partsWait.promise;
  }
  function partsSettled() { const w = partsWait; partsWait = null; if (w) w.resolve(); }
  const headText = () => `${state.asms.length} ${L2("сглобки", "assemblies")} · ${new Set(state.asms.map((a) => a.mark)).size} ${L2("марки", "marks")}`;
  function partsProgress(n, of, bolts) {
    const what = bolts ? L2(`болтове ${n} от ${of}`, `bolts ${n} of ${of}`) : `${n} ${L2("от", "of")} ${of}`;
    setStatus((state.ready ? headText() + " · " : "") + partsText() + " " + what);
  }
  /** The status line after a load: phase A done (parts still loading, or failed) or both phases done. */
  function statusLine(partsDone) {
    if (!partsDone) {
      setStatus(headText() + " · " + (state.partsError ? L2("⚠ частите не са прочетени – презаредете панела", "⚠ the parts could not be read – reload the panel") : partsText()), !!state.partsError);
      statusIsLine = false;
      return;
    }
    const site = state.bolts.filter((b) => b.sides && (b.sides.others || []).length).length;
    const st = state.loadStats || {};
    const warn = [];
    if (st.dupAsms || st.dupBolts) warn.push(L2(`заредени два пъти (припокриващи се модели): ${nAsm(st.dupAsms)}, ${nW(st.dupBolts, "болт", "болта", "bolt", "bolts")} – броени веднъж`,
      `loaded twice (overlapping models): ${st.dupAsms} assemblies, ${st.dupBolts} bolts – counted once`));
    if (st.childErrors) warn.push(L2(`${nAsm(st.childErrors)} без прочетени елементи`, `${nAsm(st.childErrors)} whose parts could not be read`));
    if (st.lookupFailed) warn.push(L2(`${st.lookupFailed} основни елемента не можаха да се потърсят – презаредете`, `${st.lookupFailed} main parts could not be looked up – reload`));
    const head = headText();
    if (office()) setStatus(`${head} · ${state.bolts.length} ${L2("болтови групи", "bolt groups")} (${site} ${L2("между две сглобки", "between two assemblies")})`
      + (st.slowLookups ? ` · ${L2("бавно търсене", "slow lookups")}: ${st.slowLookups}` : "")
      + (warn.length ? " · ⚠ " + warn.join("; ") : ""), !!warn.length);
    else {   // site roles: one plain sentence, no load diagnostics (week 3, A8)
      const broken = st.childErrors || st.lookupFailed;
      setStatus(head + (broken ? L2(" · ⚠ част от модела не е прочетена – презаредете панела", " · ⚠ part of the model could not be read – reload the panel") : ""), !!broken);
    }
    statusIsLine = true;
  }
  /** A load's two phases meet here: records in -> the panel is shown; records and parts in -> colours, and the model
   *  set counts as loaded (item 8). Only the newest load settles. */
  async function settle(run) {
    if (run.gen !== loadGen || !run.records) return;
    statusLine(run.parts);
    render();
    if (!run.parts) return;
    lastModelsKey = run.modelsKey;
    if (state.coloured || colourDeferred) await applyColours();
  }

  async function loadNow() {
    const gen = ++loadGen;
    activeLoads.add(gen);
    lastModelsKey = null;   // until this load settles: a load that fails never leaves an older set "unchanged"
    let background = false;   // phase B started: it ends the load
    try { background = await loadPhaseA(gen); }
    finally { if (!background) { activeLoads.delete(gen); if (gen === loadGen) partsSettled(); } }
  }
  /** Phase A (assemblies, then records), with phase B started in the background as soon as the assemblies are in.
   *  Returns true when phase B was started. */
  async function loadPhaseA(gen) {
    const specs = await loadedModels();   // read once: the model set (item 8) and the versions of the child cache (2a)
    const run = { gen, modelsKey: L.modelSetKey(specs), records: false, parts: false };
    const ctx = { stale: () => gen !== loadGen, all: null, failed: 0, kids: new Map() };   // this load's own object cache and lookup failures
    // The library, definitions and deliveries list need no GUID: started now, beside the viewer scan (sweep 18.11.2026;
    // on a phone's first open they were ~3 serial pset round trips after the scan). Not during a "waiting for a model"
    // retry (every 4 s), so an empty viewer does not repeat them. Their errors and the setup box still come only after
    // the "no assemblies" check, in loadRecords (as Монолитен бетон).
    const pre = waitTries ? null : startRecords();
    let got;
    try { got = await loadAssemblies(gen, ctx); if (!got) return false; }   // a newer load took over
    catch (e) { if (gen !== loadGen) return false; throw e; }   // an error of a superseded load (its model was unloaded) is not shown (L1)
    clearTimeout(waitTimer);
    if (!state.asms.length && !(allObjects || []).length && waitTries < 30) {
      // no objects yet: the panel opened before a model was loaded, or the model is still streaming in
      waitTries++;
      setStatus(L2("Чакам да се зареди модел…", "Waiting for a model to load…"));
      waitTimer = setTimeout(() => guarded(load), 4000);
      return false;
    }
    waitTries = 0;
    if (!state.asms.length) {
      // say what the viewer returned, so a live problem can be diagnosed from the panel
      const cls = new Map();
      for (const o of allObjects || []) cls.set(o.cls || "?", (cls.get(o.cls || "?") || 0) + 1);
      const seen = [...cls].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join(", ");
      setStatus(L2("В заредените модели няма сглобки (IfcElementAssembly).", "No assemblies (IfcElementAssembly) in the loaded models.") +
        (office() ? ` [${(allObjects || []).length} obj${seen ? ": " + seen : ""}]` : ""), true); return false;   // diagnostics: office / admin only (A8)
    }
    // phase B: the parts and bolts, at the same time as the records (viewer calls vs. pset-api calls)
    loadParts(gen, ctx, got, modelVersions(specs)).then(
      (ok) => { if (!ok || gen !== loadGen) return; run.parts = true; partsSettled(); return guarded(() => settle(run)); },
      (e) => {
        if (gen !== loadGen) return;   // an error of a superseded load is not shown
        state.partsError = errText(e); console.error(e);
        partsSettled();
        if (state.ready) { statusLine(false); render(); }
        toast(L2("Частите не са прочетени: ", "The parts could not be read: ") + state.partsError, true);
      }).finally(() => activeLoads.delete(gen));
    try { if (!(await loadRecords(gen, pre)) && gen !== loadGen) return true; }
    catch (e) { if (gen !== loadGen) return true; throw e; }   // an error of a superseded load is not shown (round 4, L8)
    run.records = true;
    state.ready = true;
    $("main").hidden = false;
    await settle(run);
    return true;
  }
  async function start(api, client) {
    state.api = api;
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Стомана (assembly-status)", version: BUILD, lang: () => lang });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    state.access = window.ARSTEN_DEMO ? (window.ARSTEN_DEMO_ACCESS || { allowed: true, role: "admin" }) : await ArstenAccess.check({ api, getToken, app: "assembly" });
    if (I18N) { lang = await I18N.pickLang(api, state.access, OLD_LANG); $("selLang").value = lang; }   // stored choice, else the Connect user's language
    if (!state.access.allowed) { state.denied = true; state.api = null; ArstenAccess.renderDenied(document.body, lang, state.access); return; }
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; state.userId = u.id || u.email || ""; } catch {}
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Стомана (assembly-status)", projectId: state.project.id, version: BUILD, redact: [state.user], lang: () => lang });   // A23
    loadView();   // colouring (default on), follow and tab, per user (week 3, A7)
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
    if (event === "viewer.onModelStateChanged") reloadSoon(3000);
    if (!state.ready) return;
    if (event === "viewer.onModelReset") {
      // Connect's "Reset" cleared the colours: the box says so, for this session only - the remembered per-user
      // setting (saveView) stays, so the next opening colours again, as pour-status (sweep 18.11.2026)
      state.coloured = false; render();
    }
    if (event === "viewer.onSelectionChanged" && state.follow) { clearTimeout(selTimer); selTimer = setTimeout(() => guarded(fromViewer), 200); }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus(I18N ? I18N.word("notInside", lang) : "Not inside Trimble Connect.", true);
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", lang));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", lang) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
