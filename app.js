// Assembly status: steel erection in the Trimble Connect 3D viewer.
// Statuses per assembly INSTANCE (erected / wrong / on hold) and deliveries per MARK are stored in the project
// library "STEEL/Монтаж" (records.js); availability and the bolt erection list come from steel.js.
// Access (shared/arsten-access.js, app "assembly"): panel for ADMIN, GENERAL CONTRACTOR, DESIGNERS;
// erected / wrong / deliveries for ADMIN + GC; holds for ADMIN + GC + DESIGNERS.
(() => {
  "use strict";
  const L = window.SteelLogic, R = window.SteelRecords, A = window.PsetApi;
  const $ = (id) => document.getElementById(id);
  const BATCH = 200;
  const ELEMENT_ASSEMBLY = 4;   // HierarchyType.ElementAssembly
  const T = {
    title: ["Монтаж · Assembly status", "Assembly status · Монтаж"],
    selection: ["Избрано", "Selection"], follow: ["Следи избора в модела", "Follow model selection"], clear: ["Изчисти", "Clear"],
    nothing: ["Нищо не е избрано. Изберете сглобки в модела или марка от таблицата.", "Nothing selected. Select assemblies in the model or a mark in the table."],
    view: ["Изглед", "View"], colour: ["Оцвети по статус", "Colour by status"],
    marks: ["Марки", "Marks"], deliveries: ["Доставки", "Deliveries"], bolts: ["Болтове", "Bolts"], docs: ["Документи", "Documents"],
    erected: ["Монтиран", "Erected"], wrong: ["Грешно изработен", "Wrong (fabrication)"], hold: ["Задържан", "On hold"],
    set: ["Отбележи", "Set"], undo: ["Отмени", "Undo"], note: ["Бележка", "Note"], reason: ["Причина", "Reason"],
    noRight: ["Нямате права за това.", "You have no rights for this."],
  };
  let lang = (() => { try { return localStorage.getItem("arsten.assemblyStatus.lang") || "bg"; } catch { return "bg"; } })();
  const t = (k) => (T[k] ? T[k][lang === "bg" ? 0 : 1] : k);
  const L2 = (b, e) => (lang === "bg" ? b : e);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? String(Math.round(n * 10) / 10) : String(v == null ? "" : v); };
  const fmtDate = (d) => (d ? (lang === "bg" ? String(d).split("-").reverse().join(".") : d) : "");
  function setStatus(text, bad) { $("status").textContent = text; $("status").className = "status" + (bad ? " bad" : ""); }
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  async function guarded(fn) { try { await fn(); } catch (e) { setStatus("Error: " + errText(e), true); console.error(e); } }
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
  }

  const state = {
    api: null, client: null, project: null, user: "", access: null, lib: null, ready: false,
    asms: [], byKey: new Map(), byGuid: new Map(),   // assembly instances {modelId, id, guid, mark, layer, weight, finish, parts:[runtime ids]}
    bolts: [], status: new Map(), holds: new Map(), deliveries: [],
    sel: [], coloured: false, tab: "marks", boltScope: "all", follow: true,
  };
  const key = (modelId, id) => modelId + ":" + id;
  const can = (what) => {
    const r = state.access && state.access.role;
    if (window.ARSTEN_DEMO) return true;
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
  let allObjects = null;
  async function readAll() {
    if (allObjects) return allObjects;
    const api = state.api;
    allObjects = [];
    for (const m of (await api.viewer.getObjects()) || []) {
      const ids = (m.objects || []).map((o) => o.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        for (const p of (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || []) allObjects.push({ modelId: m.modelId, id: p.id, cls: String(p.class || "") });
        setStatus(L2(`Чета модела… ${Math.min(i + BATCH, ids.length)} от ${ids.length}`, `Reading the model… ${Math.min(i + BATCH, ids.length)} of ${ids.length}`));
      }
    }
    return allObjects;
  }
  async function idsOfClass(cls) {
    const api = state.api;
    let models = [];
    try { models = (await api.viewer.getObjects({ parameter: { class: cls } })) || []; } catch {}
    const found = models.map((m) => ({ modelId: m.modelId, ids: (m.objects || []).map((o) => o.id) })).filter((m) => m.ids.length);
    if (found.length) return found;
    const re = new RegExp(`^${cls}$`, "i");
    const byModel = new Map();
    for (const o of await readAll()) if (re.test(o.cls)) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    if (!byModel.size && /elementassembly/i.test(cls)) {
      // assemblies as parents of the parts (as in Cast unit tags)
      const all = (await readAll()).filter((o) => !/elementassembly/i.test(o.cls));
      const seen = new Set();
      let done = 0;
      await pool(all, 8, async (o) => {
        try {
          const ps = (await api.viewer.getHierarchyParents(o.modelId, [o.id], ELEMENT_ASSEMBLY)) || [];
          for (const p of ps) { const k = key(o.modelId, p.id); if (!seen.has(k)) { seen.add(k); if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(p.id); } }
        } catch {}
        if (++done % 100 === 0) setStatus(L2(`Търся сглобките… ${done} от ${all.length}`, `Finding assemblies… ${done} of ${all.length}`));
      });
    }
    return [...byModel].map(([modelId, ids]) => ({ modelId, ids }));
  }

  async function readClass(cls, psetRe) {
    const api = state.api, out = [];
    for (const m of await idsOfClass(cls)) {
      const ids = m.ids;
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const props = (await api.viewer.getObjectProperties(m.modelId, chunk)) || [];
        const guids = (await api.viewer.convertToObjectIds(m.modelId, chunk)) || [];
        props.forEach((p, k) => { const ps = psetOf(p, psetRe); out.push({ modelId: m.modelId, id: p.id, guid: guids[k] || null, ps: ps || {} }); });
      }
    }
    return out.filter((o) => o.guid);
  }
  async function parentAssembly(modelId, id) {
    const ps = (await state.api.viewer.getHierarchyParents(modelId, [id], ELEMENT_ASSEMBLY)) || [];
    for (const p of ps) { const a = state.byKey.get(key(modelId, p.id)); if (a) return a; }
    return null;
  }

  async function loadModel() {
    allObjects = null;
    setStatus(L2("Чета сглобките…", "Reading assemblies…"));
    const asms = await readClass("IfcElementAssembly", /^Assembly/i);
    state.asms = asms.map((a) => ({ modelId: a.modelId, id: a.id, guid: a.guid, mark: String(val(a.ps, /Assembly_Pos/i) || "").trim(),
      layer: val(a.ps, /^Layer/i) || "", weight: val(a.ps, /Assembly_Weight/i) || "", finish: val(a.ps, /^Finish/i) || "", parts: [] }));
    state.byKey = new Map(state.asms.map((a) => [key(a.modelId, a.id), a]));
    state.byGuid = new Map(state.asms.map((a) => [a.guid, a]));
    // parts of each assembly (for colouring and the old-export fallback)
    await pool(state.asms, 8, async (a) => {
      try { a.parts = ((await state.api.viewer.getHierarchyChildren(a.modelId, [a.id], ELEMENT_ASSEMBLY)) || []).map((c) => c.id); } catch { a.parts = []; }
    });
    setStatus(L2("Чета болтовете…", "Reading bolts…"));
    const fs = await readClass("IfcMechanicalFastener", /^Bolt/i);
    const assemblyOfPart = new Map();
    const bolts = [];
    await pool(fs, 6, async (f) => {
      const own = await parentAssembly(f.modelId, f.id);
      const hasLinks = Object.keys(f.ps).some((k) => /Main_Part_GUID|Connected_Assemblies/i.test(k));
      const mainPart = String(val(f.ps, /Main_Part_GUID/i) || "").trim();
      const ifc = L.tcGuidToIfc(mainPart);
      if (ifc && !assemblyOfPart.has(ifc)) {
        try {
          const rt = ((await state.api.viewer.convertToObjectRuntimeIds(f.modelId, [ifc])) || [])[0];
          const a = rt != null ? await parentAssembly(f.modelId, rt) : null;
          if (a) assemblyOfPart.set(ifc, a.guid);
        } catch {}
      }
      const ca = val(f.ps, /Connected_Assemblies/i);
      bolts.push({ modelId: f.modelId, id: f.id, guid: f.guid, ownGuid: own && own.guid, ownMark: own ? own.mark : "?",
        mainPart, otherMarks: hasLinks ? L.parseMarks(ca) : null, connected: ca || "",
        kind: String(val(f.ps, /Site_Workshop/i) || "").trim(), assemblyCode: val(f.ps, /Assembly_Code/i) || "", comment: val(f.ps, /^Comment/i) || "",
        name: val(f.ps, /Bolt Name/i) || "", standard: val(f.ps, /^Standard/i) || "", length: val(f.ps, /^Length/i), diameter: val(f.ps, /^Diameter/i), count: val(f.ps, /Bolt count/i) });
    });
    // fallback geometry only for bolts without a usable Main_Part_GUID (old exports)
    const needFallback = bolts.some((b) => b.otherMarks && b.otherMarks.length && !assemblyOfPart.get(L.tcGuidToIfc(b.mainPart)));
    const assemblies = needFallback ? await assemblyBoxes() : [];
    if (needFallback) {
      const byModel = new Map();
      for (const b of bolts) { if (!byModel.has(b.modelId)) byModel.set(b.modelId, []); byModel.get(b.modelId).push(b); }
      for (const [m, list] of byModel) {
        const boxes = (await state.api.viewer.getObjectBoundingBoxes(m, list.map((b) => b.id))) || [];
        const bm = new Map(boxes.map((x) => [x.id, x.boundingBox]));
        list.forEach((b) => { b.bbox = bm.get(b.id); });
      }
    }
    // In an export that has the link properties, bolts without them (anchors) are single-assembly bolts.
    const exportHasLinks = bolts.some((b) => b.otherMarks != null);
    if (exportHasLinks) for (const b of bolts) if (b.otherMarks == null) b.otherMarks = [];
    for (const b of bolts) b.sides = b.ownGuid ? L.resolveSides(b, { assemblyOfPart, assemblies, opts: { abs: 0.2, rel: 0.1 } }) : { unresolved: "no-own-assembly" };
    state.bolts = bolts;
    state.hasLinks = exportHasLinks;
  }
  async function assemblyBoxes() {
    const out = [];
    for (const a of state.asms) {
      let boxes = [];
      try { boxes = ((await state.api.viewer.getObjectBoundingBoxes(a.modelId, a.parts.length ? a.parts : [a.id])) || []).map((x) => x.boundingBox).filter(Boolean); } catch {}
      out.push({ guid: a.guid, mark: a.mark, boxes });
    }
    return out;
  }

  // ---------- library ----------
  async function loadRecords() {
    const found = await state.client.findLibrary(state.project.id, R.LIB_NAMES);
    if (!found.lib) {
      state.lib = null;
      $("setupBox").hidden = false;
      $("setupBox").innerHTML = L2(`Библиотеката <b>STEEL/Монтаж</b> още не съществува. Администратор я създава веднъж в Connect: Property Set Libraries → New library → име „STEEL/Монтаж“. Статусите не могат да се записват дотогава.`,
        `The library <b>STEEL/Монтаж</b> does not exist yet. An admin creates it once in Connect: Property Set Libraries → New library → name "STEEL/Монтаж". Statuses cannot be saved until then.`);
      return;
    }
    $("setupBox").hidden = true;
    state.lib = found.lib;
    for (const d of R.definitions()) {
      try { await state.client.ensureDefinition(state.lib.id, d); }
      catch (e) { if (e.status !== 403) throw e; }   // non-admins cannot create definitions; reading still works
    }
    const links = state.asms.map((a) => "frn:entity:" + a.guid);
    const toMap = (m) => new Map([...m].map(([l, p]) => [l.replace(/^frn:entity:/, ""), p]));
    state.status = toMap(await state.client.readMany(state.lib.id, R.DEF.status, links));
    state.holds = toMap(await state.client.readMany(state.lib.id, R.DEF.hold, links));
    const dels = await state.client.listAll(state.lib.id, R.DEF.delivery, R.deliveryPrefix(state.project.id));
    state.deliveries = [...dels].map(([link, p]) => Object.assign({ link }, p)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  // ---------- figures ----------
  const avail = () => L.availability(state.asms, state.status, state.holds, state.deliveries);
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

  // ---------- writing ----------
  const stateName = (id) => { const s = L.STATES.find((x) => x.id === id); return s ? (lang === "bg" ? s.bg : s.en) : id; };
  async function applyFlag(kind, on) {
    if (!state.lib) return setStatus(L2("Няма библиотека STEEL/Монтаж.", "No library STEEL/Монтаж."), true);
    if (!can(kind === "hold" ? "hold" : "status")) return setStatus(t("noRight"), true);
    const targets = state.sel.slice();
    if (!targets.length) return;
    const date = ($("d_" + kind) || {}).value || R.today();
    const note = (($("n_" + kind) || {}).value || "").trim();
    if (on && kind !== "erected" && !note) return setStatus(L2("Въведете бележка / причина.", "Enter a note / reason."), true);
    const def = kind === "hold" ? R.DEF.hold : R.DEF.status, store = kind === "hold" ? state.holds : state.status;
    let done = 0, failed = 0, first = "";
    await pool(targets, 6, async (a) => {
      const cur = store.get(a.guid) || null;
      if (!on && !(cur && cur[kind])) return;
      const next = R.setFlag(cur, kind, on, { date, note, by: state.user, mark: a.mark });
      try {
        await (on ? state.client.write : state.client.replace).call(state.client, state.lib.id, def, "frn:entity:" + a.guid, next);
        store.set(a.guid, next); done++;
      } catch (e) { failed++; if (!first) first = e.status === 403 ? t("noRight") : errText(e); }
    });
    setStatus(`${t(kind)}: ${on ? L2("записано", "saved") : L2("отменено", "undone")} ${done}` + (failed ? ` · ${failed} ${L2("грешки", "failed")} (${first})` : ""), failed > 0);
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
    setStatus(L2(`Доставката е записана (${lines.length} марки)`, `Delivery saved (${lines.length} marks)`) + (unknown.length ? ` · ${L2("няма в модела", "not in the model")}: ${unknown.join(", ")}` : ""), unknown.length > 0);
    $("dlvText").value = ""; $("dlvNo").value = "";
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
    if (r.lines.length && window.confirm(L2(`Да се запише доставка с ${r.lines.length} марки (${r.lines.reduce((t, l) => t + l.qty, 0)} бр.)?`, `Save a delivery of ${r.lines.length} marks (${r.lines.reduce((t, l) => t + l.qty, 0)} pcs)?`))) await addDelivery(r.lines, file.name);
  }

  // ---------- rendering ----------
  function render() {
    $("title").textContent = t("title");
    $("hSel").textContent = t("selection"); $("lblFollow").textContent = t("follow"); $("btnSelClear").textContent = t("clear");
    $("hView").textContent = t("view"); $("lblColour").textContent = t("colour");
    document.querySelectorAll("#tabs button").forEach((b) => { b.textContent = t(b.dataset.tab); b.classList.toggle("on", b.dataset.tab === state.tab); });
    ["marks", "deliveries", "bolts", "docs"].forEach((k) => { $("tab-" + k).hidden = state.tab !== k; });
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
      $("selText").innerHTML = `<b>${sel.length}</b> ${L2("сглобки", "assemblies")} · ${esc([...byMark].map(([m, n]) => (n > 1 ? `${m} (${n})` : m)).join(", "))}<div class="sub">${[...states].map(([s, n]) => `${esc(stateName(s))}: ${n}`).join(" · ")}</div>`;
    }
    // actions
    const has = (store, kind) => sel.filter((a) => (store.get(a.guid) || {})[kind]).length;
    const act = (kind, colour, store, right, needNote, noteLbl) => `<div class="act" style="--c:${colour}">
      <div class="hd"><span class="nm">${esc(t(kind))}</span><span class="st">${sel.length ? `${has(store, kind)}/${sel.length}` : ""}</span></div>
      <div class="row">${kind === "erected" || kind === "hold" ? `<input type="date" id="d_${kind}" value="${R.today()}">` : ""}<input type="text" id="n_${kind}" placeholder="${esc(noteLbl)}${needNote ? " *" : ""}"></div>
      <div class="row"><button class="small" data-act="on" data-kind="${kind}" ${sel.length && right ? "" : "disabled"}>${esc(t("set"))}</button>
        <button class="small secondary" data-act="off" data-kind="${kind}" ${has(store, kind) && right ? "" : "disabled"}>${esc(t("undo"))}</button>
        ${right ? "" : `<span class="sub">${esc(t("noRight"))}</span>`}</div></div>`;
    $("acts").innerHTML = act("erected", "#2E7D32", state.status, can("status"), false, t("note"))
      + act("wrong", "#C62828", state.status, can("status"), true, t("note"))
      + act("hold", "#7B1FA2", state.holds, can("hold"), true, t("reason"));
    renderMarks(av); renderDeliveries(); renderBolts(); renderDocs(av);
  }

  function renderMarks(av) {
    const over = av.marks.filter((m) => m.over);
    $("tab-marks").innerHTML = (over.length ? `<div class="warn">${esc(L2("Монтирани повече от доставените: ", "Erected more than delivered: "))}${esc(over.map((m) => `${m.mark} (${m.erected}/${m.delivered})`).join(", "))}</div>` : "")
      + (av.unknownDeliveredMarks.length ? `<div class="warn">${esc(L2("Доставени марки, които ги няма в модела: ", "Delivered marks not in the model: "))}${esc(av.unknownDeliveredMarks.join(", "))}</div>` : "")
      + `<div class="scroll"><table><thead><tr><th>${L2("Марка", "Mark")}</th><th class="n">${L2("Бр.", "Qty")}</th><th class="n">${L2("Дост.", "Deliv.")}</th><th class="n">${L2("Монт.", "Erect.")}</th><th class="n" title="${esc(L2("доставени − монтирани", "delivered − erected"))}">${L2("Налични", "Available")}</th><th class="n">${L2("Не дост.", "Not del.")}</th></tr></thead><tbody>`
      + av.marks.map((m, i) => `<tr><td class="name"><button class="small secondary" data-act="pickMark" data-mark="${esc(m.mark)}" title="${esc(L2("Избери в модела", "Select in the model"))}">${esc(m.mark || "?")}</button>${m.hold ? ` <span class="sub">${L2("задърж.", "hold")} ${m.hold}</span>` : ""}${m.wrong ? ` <span class="bad sub">${L2("грешни", "wrong")} ${m.wrong}</span>` : ""}</td>
        <td class="n">${m.instances}</td><td class="n">${m.delivered}</td><td class="n${m.over ? " bad" : ""}">${m.erected}</td><td class="n">${m.available}</td><td class="n">${m.notDelivered}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }

  function renderDeliveries() {
    const right = can("status");
    $("tab-deliveries").innerHTML = `<div class="box">
        <div class="bar"><input type="date" id="dlvDate" value="${R.today()}"><input type="text" id="dlvNo" placeholder="${esc(L2("Стокова разписка №", "Delivery note no."))}"></div>
        <textarea id="dlvText" placeholder="${esc(L2("Марка и брой на ред, напр.\nRF22 3\nCL22 2", "Mark and qty per line, e.g.\nRF22 3\nCL22 2"))}"></textarea>
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
      + `</tbody></table></div>`;
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
    rows.push({ values: [] }, { values: ["Generated from Trimble Connect by Multiplan (Arsten Assembly status)"] });
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
      </tbody></table><div class="foot">Generated from Trimble Connect by Multiplan (Arsten Assembly status)</div></body></html>`;
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
    const rows = [{ values: [L2("Марка", "Mark"), L2("Бр. в модела", "In model"), L2("Доставени", "Delivered"), L2("Монтирани", "Erected"), L2("Налични (дост. − монт.)", "Available (deliv. − erect.)"), L2("Светнали за монтаж", "Instances ready"), L2("Не доставени", "Not delivered"), L2("Задържани", "On hold"), L2("Грешни", "Wrong")], bold: true, fill: "FFECE8DF" }];
    for (const m of av.marks) rows.push({ values: [m.mark, m.instances, m.delivered, m.erected, m.available, m.ready, m.notDelivered, m.hold, m.wrong] });
    await saveXlsx("by-mark", [{ name: L2("По марки", "By mark"), rows, widths: [12, 10, 10, 10, 14, 14, 12, 10, 10] }]);
  }
  async function exportDeliveries() {
    const rows = [{ values: [L2("Дата", "Date"), "№", L2("Марка", "Mark"), L2("Бр.", "Qty"), L2("От", "By"), L2("Източник", "Source"), L2("Анулирана", "Cancelled")], bold: true, fill: "FFECE8DF" }];
    for (const d of state.deliveries) for (const l of L.parseLines(d.lines)) rows.push({ values: [d.date, d.note_no || "", l.mark, l.qty, d.by || "", d.source || "", d.cancelled ? L2("да", "yes") : ""] });
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
    state.sel = [...picked.values()];
    render();
  }
  async function selectMark(mark) {
    const list = state.asms.filter((a) => L.normMark(a.mark) === L.normMark(mark));
    state.sel = list;
    const s = sel(list);
    await state.api.viewer.setSelection(s, "set");
    try { await state.api.viewer.setCamera(s, { animationTime: 400 }); } catch {}
    render();
  }

  // ---------- wiring ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act], #tabs button");
    if (!b) return;
    if (b.dataset.tab) { state.tab = b.dataset.tab; render(); return; }
    const act = b.dataset.act;
    guarded(async () => {
      if (act === "on" || act === "off") await applyFlag(b.dataset.kind, act === "on");
      else if (act === "pickMark") await selectMark(b.dataset.mark);
      else if (act === "dlvAdd") await addDelivery(R.parseDeliveryText($("dlvText").value).lines, "typed");
      else if (act === "dlvCancel") await cancelDelivery(+b.dataset.i);
      else if (act === "dlvCancelNo") { state.cancelling = null; render(); }
      else if (act === "boltXlsx") await exportBoltsXlsx();
      else if (act === "boltPdf") exportBoltsPdf();
      else if (act === "docErected") await exportErected();
      else if (act === "docMarks") await exportMarks();
      else if (act === "docDeliveries") await exportDeliveries();
    });
  });
  $("btnSelClear").onclick = () => { state.sel = []; render(); };
  $("chkFollow").onchange = (e) => { state.follow = e.target.checked; };
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; await applyColours(); });
  $("selLang").value = lang;
  $("selLang").onchange = (e) => { lang = e.target.value; try { localStorage.setItem("arsten.assemblyStatus.lang", lang); } catch {} render(); };

  async function load() {
    await loadModel();
    if (!state.asms.length) {
      // say what the viewer returned, so a live problem can be diagnosed from the panel
      const cls = new Map();
      for (const o of allObjects || []) cls.set(o.cls || "?", (cls.get(o.cls || "?") || 0) + 1);
      const seen = [...cls].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join(", ");
      setStatus(L2("В заредените модели няма сглобки (IfcElementAssembly).", "No assemblies (IfcElementAssembly) in the loaded models.") +
        ` [${(allObjects || []).length} obj${seen ? ": " + seen : ""}]`, true); return;
    }
    await loadRecords();
    state.ready = true;
    $("main").hidden = false;
    const site = state.bolts.filter((b) => b.sides && (b.sides.others || []).length).length;
    setStatus(`${state.asms.length} ${L2("сглобки", "assemblies")} · ${new Set(state.asms.map((a) => a.mark)).size} ${L2("марки", "marks")} · ${state.bolts.length} ${L2("болтови групи", "bolt groups")} (${site} ${L2("между две сглобки", "between two assemblies")})`);
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

  let selTimer = null, reloadTimer = null;
  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (state.denied || !state.ready) return;
    if (event === "viewer.onSelectionChanged" && state.follow) { clearTimeout(selTimer); selTimer = setTimeout(() => guarded(fromViewer), 200); }
    if (event === "viewer.onModelStateChanged") { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => guarded(load), 1500); }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
