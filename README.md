# Assembly status: steel erection (Trimble Connect 3D viewer)

Statuses per assembly instance (Монтиран / Грешно изработен / Задържан), deliveries per mark, ready-for-erection
colours and the bolt erection list. Design and data model: [DESIGN.md](DESIGN.md).

| File | What |
|---|---|
| `steel.js` | Pure logic: marks, delivered per mark, availability per instance, Tekla GUID -> IFC GlobalId, both sides of a bolt group, bolt list, TYPE2 codes, report rows. |
| `records.js` | Library "STEEL/Монтаж": three definitions (`asmstatus`, `asmhold`, `delivery`), flags with history, deliveries, delivery text / file parsing. |
| `app.js` / `index.html` | Panel + Workspace API (assemblies, fasteners, `getHierarchyParents` type 4 = ElementAssembly). |
| `psetapi.js`, `arsten-access.js` | Copied at publish from `viewer-pour-status` and `shared/` (app kind `assembly`). |
| `demo.js`, `test/fixtures/1028-montazhen.json` | `index.html?demo` on the 1028 МОНТАЖЕН export (22:14). Not published. |
| `tools/make_fixture.py` | Rebuild the fixture from an IFC and check the bolt rule (`python -I -X utf8 tools/make_fixture.py <ifc> test/fixtures/1028-montazhen.json`). |

Tests: `node --test test/steel.test.js test/records.test.js`

## Bolt rule (checked on the 22:14 export)
- Own side: the IfcElementAssembly the IfcMechanicalFastener is aggregated under.
- Other side: `Main_Part_GUID` (Tekla GUID) -> IfcGuid compression -> that part -> its parent IfcElementAssembly.
  32 of 32 two-assembly bolt groups resolve exactly and match `Connected_Assemblies` (e.g. RF22 -> CL22).
- 31 anchors have no link properties: single-assembly bolts (anchors), not unresolved.
- Old exports without `Main_Part_GUID`: nearest instance of the `Connected_Assemblies` mark, flagged uncertain.
- "To install now": own and every connected instance erected; uncertain -> "check".

## Model export checklist
Tekla numbering -> IFC export with pset "Bolt/Болт" (Site_Workshop, Connected_Assemblies, Main_Part_GUID,
Assembly_Code, Comment) and "Assembly/Сглобка" -> upload as a new version of the same file.
