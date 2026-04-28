# `export defer` — Phase 2a Implementation Plan (load-and-evaluation propagation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Divergence from the design doc:** The design doc described phase 2a as "skip deferred sources at load time, force-load on non-deferred consumer." That captures the user-visible behavior, but the actual spec mechanism is more involved: a new `[[ImportedNames]]` field on `ModuleRequestRecord`, plus full restructuring of `InnerModuleLinking`/`InnerModuleEvaluation` into helper-driven traversals (`BuildLinkingList`/`BuildEvaluationList`) that propagate `importedNames` through the graph. Eight new abstract operations land here. The design doc's high-level claim is preserved; only the mechanism is more elaborate than its bullets suggested.

**Goal:** Implement the load/link/evaluate-time propagation of deferred re-export laziness in engine262, so that:
- Modules referenced only by deferred re-exports are not loaded unless transitively required by a non-deferred consumer's specific binding.
- A non-deferred consumer of a deferred binding forces the deferred chain to load and evaluate.
- `export *` propagates required-ness through deferred re-exports (default excluded as usual).
- Evaluation order matches the spec for deferred sub-graphs (re-exporter first, then deferred deps, then consumer).

**Architecture:** Mirror the [proposal-deferred-reexports spec](https://tc39.es/proposal-deferred-reexports/) line-by-line: add `[[ImportedNames]]` to `ModuleRequestRecord` (`"all" | "all-but-default" | List<JSStringValue>`), populate during static semantics, implement `GetOptionalIndirectExportsModuleRequests` on `AbstractModuleRecord` (default empty) and `SourceTextModuleRecord` (filter `IndirectExportEntries` by `Phase === 'defer'` and `importedNames`), then route `InnerModuleLoading`/`InnerModuleLinking`/`InnerModuleEvaluation` through `BuildLinkingList`/`BuildEvaluationList` to thread `importedNames` through every step. `Link()` and `Evaluate()` gain an optional `importedNames` parameter (defaulting to `~all~`).

**Tech Stack:** Same as phase 1 — TypeScript `.mts`, Rollup, Vitest, test262.

**Spec reference:** `docs/superpowers/specs/2026-04-27-export-defer-design.md` (commit `c077e8c9`). Where this plan diverges from the design doc, follow this plan.

**Validation target:** All 7 scenarios in `language/export/export-defer/load-and-evaluation/` (test262 PR 5034) pass. Phase 1 syntax tests still pass. Phase 2b's 24 namespace-`[[Get]]` scenarios may still fail — that's phase 2b's deliverable.

**Out of scope (deferred to Phase 2b/3):**
- Module-namespace exotic `[[Get]]` triggering synchronous evaluation. Phase 2b adds `EvaluateModuleSync` and the `[[Get]]` hook.
- `ReadyForSyncExecution`. Phase 2b.
- Composition with `import defer * as ns from "..."` over a deferred re-exporter. Phase 3 verification.

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `src/static-semantics/ModuleRequests.mts` | modify | Compute `[[ImportedNames]]` per ModuleRequest based on the syntactic form (ImportEntry vs ExportFromClause vs star). |
| `src/static-semantics/ModuleRequests.mts` | modify | Update `ModuleRequestRecord` interface with the new field. |
| `src/static-semantics/ModuleRequests.mts` | modify | Update `ModuleRequestsEqual` to ignore `[[ImportedNames]]` (per spec — equality is on `Specifier` + `Attributes` only). |
| `src/abstract-ops/module-records.mts` | modify | Add helpers `ExcludeImportedNames`, `MergeImportedNames`, `ListAppendUnique` (file-private). |
| `src/abstract-ops/module-records.mts` | modify | Modify `InnerModuleLoading` to add optional indirect requests during graph traversal. |
| `src/abstract-ops/module-records.mts` | modify | Add `BuildLinkingList`. |
| `src/abstract-ops/module-records.mts` | modify | Modify `InnerModuleLinking` to use `BuildLinkingList`. |
| `src/abstract-ops/module-records.mts` | modify | Add `BuildEvaluationList`. |
| `src/abstract-ops/module-records.mts` | modify | Modify `InnerModuleEvaluation` to use `BuildEvaluationList`. |
| `src/abstract-ops/module-records.mts` | modify | Add `GatherAsynchronousTransitiveDependencies` and `…ForRequests`. |
| `src/modules.mts` | modify | Add abstract `GetOptionalIndirectExportsModuleRequests(importedNames)` on `AbstractModuleRecord` (default empty) and `GetNewOptionalIndirectExportsModuleRequests(...)` (free function). |
| `src/modules.mts` | modify | Implement `GetOptionalIndirectExportsModuleRequests` on `SourceTextModuleRecord`. |
| `src/modules.mts` | modify | Modify `LoadRequestedModules`, `Link`, `Evaluate` to thread `importedNames` and link/evaluate optional indirect requests after the main traversal. |

---

## Task 1: Add `[[ImportedNames]]` to `ModuleRequestRecord` interface

The new field is the data backbone for everything else. It's `"all" | "all-but-default" | List<JSStringValue>` per the proposal. We'll type it as a TypeScript union.

**Files:**
- Modify: `src/static-semantics/ModuleRequests.mts:6-11`

- [ ] **Step 1: Extend the interface**

`ModuleRequestRecord` is currently:

```typescript
export interface ModuleRequestRecord {
  readonly Specifier: JSStringValue;
  readonly Attributes: ImportAttributeRecord[];
  readonly Phase: 'defer' | 'evaluation';
}
```

Add `ImportedNames`:

```typescript
export type ImportedNamesValue = 'all' | 'all-but-default' | readonly JSStringValue[];

export interface ModuleRequestRecord {
  readonly Specifier: JSStringValue;
  readonly Attributes: ImportAttributeRecord[];
  readonly Phase: 'defer' | 'evaluation';
  readonly ImportedNames: ImportedNamesValue;
}
```

- [ ] **Step 2: Build dts**

```bash
npm run build:dts
```

Expected: TypeScript flags every site that constructs a `ModuleRequestRecord` literal without `ImportedNames` — those will be filled in by Task 2. Note the error count for self-validation.

- [ ] **Step 3: Don't commit yet** — Task 2 fills in the missing field at every construction site.

---

## Task 2: Populate `[[ImportedNames]]` in `ModuleRequests` static semantics

`ModuleRequests` walks the AST and emits `ModuleRequestRecord`s. For each request, compute `ImportedNames` from the corresponding declaration:

| Source | `ImportedNames` |
|---|---|
| `import "x"` (side-effect import) | `« »` (empty list) |
| `import x from "m"` | `« "default" »` |
| `import { a, b as c } from "m"` | `« "a", "b" »` (the *imported* names, not the local aliases) |
| `import * as ns from "m"` | `~all~` |
| `import defer * as ns from "m"` | `~all~` |
| `export { a } from "m"` | `« "a" »` |
| `export defer { a } from "m"` | `« "a" »` |
| `export * from "m"` | `~all-but-default~` |
| `export * as ns from "m"` | `~all~` |
| `export defer * as ns from "m"` | `~all~` |

When the same `(Specifier, Attributes)` pair is imported/exported multiple times in a module, the merged `ImportedNames` is the union (per `ModuleRequests` deduplication step).

**Files:**
- Modify: `src/static-semantics/ModuleRequests.mts:56-98`

- [ ] **Step 1: Compute `ImportedNames` for `ImportDeclaration` nodes**

In the `case 'ImportDeclaration':` branch (~line 76), before returning, derive `ImportedNames` from `node.ImportClause`:

- If `node.ImportClause` is absent (bare `import "m"`), `ImportedNames = []` (empty list).
- If `ImportClause.NameSpaceImport` present (covers both `import * as ns` and `import defer * as ns`), `ImportedNames = 'all'`.
- If `ImportClause.ImportedDefaultBinding` present without `NameSpaceImport`/`NamedImports`, `ImportedNames = [Value('default')]`.
- If `ImportClause.NamedImports` present, `ImportedNames = NamedImports.ImportsList.map((s) => StringValue(s.ModuleExportName ?? s.ImportedBinding))`.
- If both `ImportedDefaultBinding` and (`NameSpaceImport` or `NamedImports`) are present, union the names; if `NameSpaceImport` is in the union it's `'all'`.

Build a small helper:

```typescript
function importedNamesFromImportClause(importClause: ParseNode.ImportClause | undefined): ImportedNamesValue {
  if (!importClause) {
    return [];
  }
  if (importClause.NameSpaceImport) {
    return 'all';
  }
  const names: JSStringValue[] = [];
  if (importClause.ImportedDefaultBinding) {
    names.push(Value('default'));
  }
  if (importClause.NamedImports) {
    for (const spec of importClause.NamedImports.ImportsList) {
      names.push(StringValue(spec.ModuleExportName ?? spec.ImportedBinding));
    }
  }
  return names;
}
```

The `ImportDeclaration` branch becomes:

```typescript
case 'ImportDeclaration': {
  let specifier: JSStringValue;
  if (node.FromClause) {
    specifier = StringValue(node.FromClause);
  } else if (node.ModuleSpecifier) {
    specifier = StringValue(node.ModuleSpecifier);
  } else {
    throw new Error('Unreachable: all imports must have either an ImportClause or a ModuleSpecifier');
  }
  const attributes = node.WithClause ? WithClauseToAttributes(node.WithClause) : [];
  const importedNames = importedNamesFromImportClause(node.ImportClause);
  return [{ Specifier: specifier, Attributes: attributes, Phase: node.Phase, ImportedNames: importedNames }];
}
```

- [ ] **Step 2: Compute `ImportedNames` for `ExportDeclaration` nodes**

In the `case 'ExportDeclaration':` branch (~line 88), `ExportFromClause` is the only possible shape that has a FromClause. Cases:

- `export * from "m"` → `ExportFromClause` is `'*'`-token-only → `'all-but-default'`.
- `export * as ns from "m"` → `ExportFromClause.ModuleExportName` present → `'all'`.
- `export defer * as ns from "m"` → same as above (`'all'`).
- `export { a, b as c } from "m"` → `ExportFromClause` is a `NamedExports` node → `[Value('a'), Value('b')]` (the *imported* names — left-hand side of `as`).
- `export defer { a } from "m"` → same as above.

Helper:

```typescript
function importedNamesFromExportFromClause(clause: ParseNode.ExportFromClauseLike): ImportedNamesValue {
  if (clause.type === 'ExportFromClause') {
    // export * from / export * as ns from
    return clause.ModuleExportName ? 'all' : 'all-but-default';
  }
  // NamedExports (export { a, b as c } from ...)
  return clause.ExportsList.map((spec) => StringValue(spec.localName));
}
```

The `ExportDeclaration` branch becomes:

```typescript
case 'ExportDeclaration':
  if (node.FromClause) {
    const specifier = StringValue(node.FromClause);
    const attributes = node.WithClause ? WithClauseToAttributes(node.WithClause) : [];
    const importedNames = importedNamesFromExportFromClause(node.ExportFromClause!);
    return [{ Specifier: specifier, Attributes: attributes, Phase: node.Phase ?? 'evaluation', ImportedNames: importedNames }];
  }
  return [];
```

- [ ] **Step 3: Update `ModuleRequests` deduplication to merge `ImportedNames` for matching specifier+attributes+phase**

Currently, `ModuleRequests` for `'ModuleBody'` (~line 64) deduplicates on `ModuleRequestsEqual + Phase`. With `ImportedNames`, two requests with the same specifier+attributes+phase but different names should merge their names (union).

Replace the existing dedup loop:

```typescript
case 'ModuleBody': {
  const requests: ModuleRequestRecord[] = [];
  for (const item of node.ModuleItemList) {
    const additionalRequests = ModuleRequests(item);
    for (const mr of additionalRequests) {
      const existing = requests.find((r) => ModuleRequestsEqual(r, mr) && r.Phase === mr.Phase);
      if (existing) {
        // Merge ImportedNames into the existing record (mutating the readonly via cast — these records aren't published yet).
        (existing as Mutable<ModuleRequestRecord>).ImportedNames = mergeImportedNames(existing.ImportedNames, mr.ImportedNames);
      } else {
        requests.push(mr);
      }
    }
  }
  return requests;
}
```

`mergeImportedNames` is defined later (Task 4). For now, declare the function and import; tests will exercise both code paths in Task 7.

- [ ] **Step 4: Build dts**

```bash
npm run build:dts
```

Expected: green if Task 4's `mergeImportedNames` is in scope. If you run this step before Task 4, expect "Cannot find name 'mergeImportedNames'" — proceed to Task 4 first then return.

- [ ] **Step 5: Skip commit until Task 4 lands the helpers.**

---

## Task 3: Update `ModuleRequestsEqual` documentation

Per the proposal, `ModuleRequestsEqual` continues to compare on `Specifier` + `Attributes` only — `ImportedNames` and `Phase` are intentionally excluded from equality.

**Files:**
- Modify: `src/static-semantics/ModuleRequests.mts:23-41`

- [ ] **Step 1: Add a comment clarifying intent**

Above the `ModuleRequestsEqual` function (~line 23), add:

```typescript
// Equality compares Specifier + Attributes only.
// ImportedNames and Phase are intentionally NOT part of equality —
// they are merged/refined by callers, not used to distinguish records.
```

- [ ] **Step 2: No code change** — just the comment.

---

## Task 4: Add helpers `ExcludeImportedNames`, `MergeImportedNames`, `ListAppendUnique`

Per the proposal:

- `ExcludeImportedNames(a, b)` — returns names in `a` not in `b`. With `~all~` and `~all-but-default~` semantics: subtracting `~all~` yields nothing; subtracting `~all-but-default~` yields the subset of `a` containing only `"default"`.
- `MergeImportedNames(a, b)` — union. If either is `~all~`, result is `~all~`. If `~all-but-default~` and a list including `"default"`, result is `~all~`. Etc.
- `ListAppendUnique(target, items)` — append each element of `items` to `target` if not already present.

**Files:**
- Modify: `src/abstract-ops/module-records.mts` (top of file, add helpers + export)

- [ ] **Step 1: Add the three helpers**

At the top of `src/abstract-ops/module-records.mts` after the existing imports, add:

```typescript
import type { ImportedNamesValue } from '../static-semantics/ModuleRequests.mts';

const DEFAULT = Value('default');

function isAllNames(v: ImportedNamesValue): v is 'all' { return v === 'all'; }
function isAllButDefault(v: ImportedNamesValue): v is 'all-but-default' { return v === 'all-but-default'; }
function jsStringEquals(a: JSStringValue, b: JSStringValue): boolean {
  return a === b || a.stringValue() === b.stringValue();
}
function listIncludesString(list: readonly JSStringValue[], name: JSStringValue): boolean {
  return list.some((n) => jsStringEquals(n, name));
}

/** https://tc39.es/proposal-deferred-reexports/#sec-mergeimportednames */
export function MergeImportedNames(a: ImportedNamesValue, b: ImportedNamesValue): ImportedNamesValue {
  if (isAllNames(a) || isAllNames(b)) {
    return 'all';
  }
  if (isAllButDefault(a) && isAllButDefault(b)) {
    return 'all-but-default';
  }
  if (isAllButDefault(a)) {
    // a = all-but-default, b = list. Result = all if b contains "default", else all-but-default.
    return listIncludesString(b as readonly JSStringValue[], DEFAULT) ? 'all' : 'all-but-default';
  }
  if (isAllButDefault(b)) {
    return listIncludesString(a as readonly JSStringValue[], DEFAULT) ? 'all' : 'all-but-default';
  }
  // Both are lists. Union.
  const result: JSStringValue[] = [...(a as readonly JSStringValue[])];
  for (const name of b as readonly JSStringValue[]) {
    if (!listIncludesString(result, name)) {
      result.push(name);
    }
  }
  return result;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-excludeimportednames */
export function ExcludeImportedNames(a: ImportedNamesValue, b: ImportedNamesValue): ImportedNamesValue {
  if (isAllNames(b)) {
    return [];
  }
  if (isAllNames(a)) {
    // a = all, b = all-but-default → only "default" remains. b = list → all minus list (still "all" minus a finite set; we can't represent that cleanly, but the spec keeps it as 'all' here because callers re-filter elsewhere).
    if (isAllButDefault(b)) {
      return [DEFAULT];
    }
    return 'all'; // approximation: spec keeps this opaque; consumers downstream re-check.
  }
  if (isAllButDefault(a)) {
    if (isAllButDefault(b)) {
      return [];
    }
    // a = all-but-default, b = list. Subtract list from "all-but-default": still all-but-default minus the list, but we keep it as 'all-but-default' — downstream filters on actual exported names.
    return 'all-but-default';
  }
  // a is a list.
  const bList = isAllButDefault(b) ? null : (b as readonly JSStringValue[]);
  const result: JSStringValue[] = [];
  for (const name of a as readonly JSStringValue[]) {
    if (isAllButDefault(b)) {
      // all-but-default contains everything except "default" — so a minus all-but-default is intersection with {"default"}.
      if (jsStringEquals(name, DEFAULT)) {
        result.push(name);
      }
    } else if (!listIncludesString(bList!, name)) {
      result.push(name);
    }
  }
  return result;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-listappendunique */
export function ListAppendUnique<T>(target: T[], items: Iterable<T>, equals: (a: T, b: T) => boolean = (a, b) => a === b): void {
  for (const item of items) {
    if (!target.some((existing) => equals(existing, item))) {
      target.push(item);
    }
  }
}
```

> **Note on `ExcludeImportedNames` opacity.** The spec keeps "all minus list" as an opaque marker because the full set of exported names isn't known at static-semantics time. Engine262 follows the same convention — downstream callers (`GetOptionalIndirectExportsModuleRequests`, `BuildLinkingList`) re-evaluate against actual `[[Exports]]` of the target module. Per-binding correctness is preserved; only the intermediate `ImportedNames` value is approximated.

- [ ] **Step 2: Re-export `MergeImportedNames` from `ModuleRequests.mts`**

In `src/static-semantics/ModuleRequests.mts`, near the top, add:

```typescript
export { MergeImportedNames as mergeImportedNames } from '../abstract-ops/module-records.mts';
```

(Lowercase alias matches the helper used in Task 2 step 3.)

- [ ] **Step 3: Build dts**

```bash
npm run build:dts
```

Expected: green.

- [ ] **Step 4: Commit Tasks 1–4 together**

```bash
git add src/static-semantics/ModuleRequests.mts src/abstract-ops/module-records.mts
git commit -m "module-records: add ImportedNames data model and merge helpers"
```

---

## Task 5: Add abstract `GetOptionalIndirectExportsModuleRequests` on `AbstractModuleRecord`

Default implementation returns an empty list. `SourceTextModuleRecord` overrides in Task 6.

**Files:**
- Modify: `src/modules.mts:90-100` (`AbstractModuleRecord` declaration)

- [ ] **Step 1: Add the abstract method**

In the `AbstractModuleRecord` class (around line 95-100), add:

```typescript
abstract GetOptionalIndirectExportsModuleRequests(importedNames: ImportedNamesValue): readonly ModuleRequestRecord[];
```

(Import `ImportedNamesValue` from `./static-semantics/ModuleRequests.mts` — adjust import line at top of file.)

- [ ] **Step 2: Implement default-empty for non-source-text records**

`SyntheticModuleRecord` and any other concrete subclass needs a stub:

```typescript
override GetOptionalIndirectExportsModuleRequests(_importedNames: ImportedNamesValue): readonly ModuleRequestRecord[] {
  return [];
}
```

Search for other `extends AbstractModuleRecord` or `extends CyclicModuleRecord` sites in `src/`:

```bash
grep -rn "extends AbstractModuleRecord\|extends CyclicModuleRecord" /Users/caiolima/dev/engine262/src
```

Add the stub to each (likely only `SyntheticModuleRecord` in `modules.mts`).

- [ ] **Step 3: Build dts**

```bash
npm run build:dts
```

Expected: green.

- [ ] **Step 4: Don't commit yet** — Task 6 implements the SourceTextModuleRecord override.

---

## Task 6: Implement `GetOptionalIndirectExportsModuleRequests` on `SourceTextModuleRecord`

Per spec: walk `IndirectExportEntries`. Pick those where `ModuleRequest.Phase === 'defer'` and the entry's `ExportName` is in `importedNames`. Return the `ModuleRequest`s.

When `importedNames === 'all'`: return all deferred-IndirectExportEntry ModuleRequests.
When `importedNames === 'all-but-default'`: return all except those whose `ExportName` is `"default"`.

**Files:**
- Modify: `src/modules.mts` (`SourceTextModuleRecord` class)

- [ ] **Step 1: Add the override after `ResolveExport`**

```typescript
override GetOptionalIndirectExportsModuleRequests(importedNames: ImportedNamesValue): readonly ModuleRequestRecord[] {
  const result: ModuleRequestRecord[] = [];
  for (const e of this.IndirectExportEntries) {
    const request = e.ModuleRequest;
    if (!(request instanceof Object) || request === null || (request as ModuleRequestRecord).Phase !== 'defer') {
      continue;
    }
    const exportName = e.ExportName;
    if (!(exportName instanceof JSStringValue)) {
      continue;
    }
    let included: boolean;
    if (importedNames === 'all') {
      included = true;
    } else if (importedNames === 'all-but-default') {
      included = exportName.stringValue() !== 'default';
    } else {
      included = (importedNames as readonly JSStringValue[]).some((n) => n.stringValue() === exportName.stringValue());
    }
    if (included && !result.includes(request as ModuleRequestRecord)) {
      result.push(request as ModuleRequestRecord);
    }
  }
  return result;
}
```

- [ ] **Step 2: Build dts**

```bash
npm run build:dts
```

Expected: green.

- [ ] **Step 3: Commit Tasks 5–6**

```bash
git add src/modules.mts
git commit -m "modules: add GetOptionalIndirectExportsModuleRequests"
```

---

## Task 7: Add `GetNewOptionalIndirectExportsModuleRequests`

Wrapper that filters out names already pulled into a module via prior recursion. Per spec:

```
1. Assert: previouslyImportedNames contains a Record whose [[Module]] field is module.
2. Let previous be that Record.
3. Let newImportedNames be ExcludeImportedNames(importedNames, previous.[[ImportedNames]]).
4. Set previous.[[ImportedNames]] to MergeImportedNames(previous.[[ImportedNames]], newImportedNames).
5. Return module.GetOptionalIndirectExportsModuleRequests(newImportedNames).
```

**Files:**
- Modify: `src/abstract-ops/module-records.mts` (free function near the helpers)

- [ ] **Step 1: Add the type and function**

```typescript
export interface PreviouslyImportedNamesEntry {
  readonly Module: AbstractModuleRecord;
  ImportedNames: ImportedNamesValue;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-getnewoptionalindirectexportsmodulerequests */
export function GetNewOptionalIndirectExportsModuleRequests(
  module: AbstractModuleRecord,
  importedNames: ImportedNamesValue,
  previouslyImportedNames: PreviouslyImportedNamesEntry[],
): readonly ModuleRequestRecord[] {
  const previous = previouslyImportedNames.find((p) => p.Module === module);
  Assert(previous !== undefined);
  const newImportedNames = ExcludeImportedNames(importedNames, previous!.ImportedNames);
  previous!.ImportedNames = MergeImportedNames(previous!.ImportedNames, newImportedNames);
  return module.GetOptionalIndirectExportsModuleRequests(newImportedNames);
}
```

- [ ] **Step 2: Build dts and commit**

```bash
npm run build:dts
git add src/abstract-ops/module-records.mts
git commit -m "module-records: add GetNewOptionalIndirectExportsModuleRequests"
```

---

## Task 8: Modify `InnerModuleLoading` to load optional indirect requests

Per spec, the load walk now concatenates `optionalIndirectRequests` (filtered by the consumer's `importedNames`) with the regular `RequestedModules`.

**Files:**
- Modify: `src/abstract-ops/module-records.mts:60-120` (`InnerModuleLoading`)
- Modify: `src/modules.mts` (`LoadRequestedModules`)

- [ ] **Step 1: Thread `importedNames` through `LoadRequestedModules`**

In `src/modules.mts:175`, change `LoadRequestedModules` signature to accept an optional `importedNames` and pass it down via the `GraphLoadingState`:

```typescript
LoadRequestedModules(hostDefined?: ModuleRecordHostDefined, importedNames: ImportedNamesValue = 'all') {
  const module = this;
  const pc = X(NewPromiseCapability(surroundingAgent.intrinsic('%Promise%')));
  const state = new GraphLoadingState({
    PromiseCapability: pc,
    HostDefined: hostDefined,
    PreviouslyImportedNames: [{ Module: module, ImportedNames: importedNames }],
  });
  InnerModuleLoading(state, module, importedNames);
  return pc.Promise;
}
```

- [ ] **Step 2: Add `PreviouslyImportedNames` to `GraphLoadingState`**

In `src/abstract-ops/module-records.mts:42-57`:

```typescript
export class GraphLoadingState {
  readonly PromiseCapability: PromiseCapabilityRecord;
  readonly HostDefined?: ModuleRecordHostDefined;
  IsLoading = true;
  readonly Visited = new Set<CyclicModuleRecord>();
  PendingModules = 1;
  readonly PreviouslyImportedNames: PreviouslyImportedNamesEntry[];

  constructor({ PromiseCapability, HostDefined, PreviouslyImportedNames }: Pick<GraphLoadingState, 'PromiseCapability' | 'HostDefined' | 'PreviouslyImportedNames'>) {
    this.PromiseCapability = PromiseCapability;
    this.HostDefined = HostDefined;
    this.PreviouslyImportedNames = PreviouslyImportedNames;
  }
}
```

- [ ] **Step 3: Modify `InnerModuleLoading` to load optional indirect requests**

Replace the `for (const request of module.RequestedModules)` loop with a version that builds `requestsToLoad = RequestedModules ++ GetNewOptionalIndirectExportsModuleRequests(module, importedNames, state.PreviouslyImportedNames)`:

```typescript
export function InnerModuleLoading(state: GraphLoadingState, module: AbstractModuleRecord, importedNames: ImportedNamesValue = 'all') {
  Assert(Boolean(state.IsLoading === true));

  if (module instanceof CyclicModuleRecord && module.Status === 'new' && !state.Visited.has(module)) {
    state.Visited.add(module);

    // Ensure module has an entry in PreviouslyImportedNames.
    if (!state.PreviouslyImportedNames.some((p) => p.Module === module)) {
      state.PreviouslyImportedNames.push({ Module: module, ImportedNames: [] });
    }

    const optionalIndirectRequests = GetNewOptionalIndirectExportsModuleRequests(module, importedNames, state.PreviouslyImportedNames);
    const requestsToLoad: readonly ModuleRequestRecord[] = [...module.RequestedModules, ...optionalIndirectRequests];

    state.PendingModules += requestsToLoad.length;

    for (const request of requestsToLoad) {
      const invalidAttributeKey = AllImportAttributesSupported(request.Attributes);
      if (invalidAttributeKey) {
        const error = Throw.SyntaxError('Unsupported import attribute $1', invalidAttributeKey);
        ContinueModuleLoading(state, error, request);
      } else {
        const record = getRecordWithSpecifier(module.LoadedModules, request);
        if (record !== undefined) {
          InnerModuleLoading(state, record.Module, request.ImportedNames);
        } else {
          HostLoadImportedModule(module, request, state.HostDefined, state);
        }
      }

      if (state.IsLoading === false) {
        return;
      }
    }
  }

  Assert(state.PendingModules >= 1);
  state.PendingModules -= 1;
  if (state.PendingModules === 0) {
    state.IsLoading = false;
    for (const loaded of state.Visited) {
      if (loaded.Status === 'new') {
        loaded.Status = 'unlinked';
      }
    }
    X(Call(state.PromiseCapability.Resolve, Value.undefined, [Value.undefined]));
  }
}
```

- [ ] **Step 4: Plumb `request.ImportedNames` through `ContinueDynamicImport` / `FinishLoadingImportedModule` paths**

`ContinueModuleLoading` / `FinishLoadingImportedModule` must pass the request's `ImportedNames` when re-entering `InnerModuleLoading` after a host-load completes. Modify `ContinueModuleLoading` (~line 122) to take and forward an `importedNames` (defaulting to `'all'` for the top-level call):

```typescript
export function ContinueModuleLoading(state: GraphLoadingState, result: PlainCompletion<AbstractModuleRecord>, request?: ModuleRequestRecord) {
  if (state.IsLoading === false) return;
  result = EnsureCompletion(result);
  if (result instanceof NormalCompletion) {
    InnerModuleLoading(state, result.Value, request?.ImportedNames ?? 'all');
  } else {
    state.IsLoading = false;
    X(Call(state.PromiseCapability.Reject, Value.undefined, [result.Value]));
  }
}
```

Update `FinishLoadingImportedModule` (~line 478) to pass the moduleRequest:

```typescript
ContinueModuleLoading(state, result, moduleRequest);
```

- [ ] **Step 5: Build full bundle**

```bash
npm run build
```

Expected: green.

- [ ] **Step 6: Run the load-side test scenarios**

```bash
npm run test:test262 -- 'language/export/export-defer/load-and-evaluation/no-consumer-no-load/**/*.js'
```

Expected: passes (the deferred dep with the syntax-error fixture is no longer loaded). If it still fails, inspect:

- Is `state.PreviouslyImportedNames` correctly carrying entries through recursion?
- Is `request.ImportedNames` the right value for the deferred re-export's request? Cross-check against Task 2 step 2 output.

- [ ] **Step 7: Commit**

```bash
git add src/abstract-ops/module-records.mts src/modules.mts
git commit -m "module-records: thread ImportedNames through InnerModuleLoading"
```

---

## Task 9: Add `BuildLinkingList`

Translates the spec's `BuildLinkingList` into engine262. Mutates `linkingList` and `previouslyImportedNames` in place.

**Files:**
- Modify: `src/abstract-ops/module-records.mts` (free function near `InnerModuleLinking`)

- [ ] **Step 1: Add the function**

```typescript
/** https://tc39.es/proposal-deferred-reexports/#sec-buildlinkinglist */
export function BuildLinkingList(
  linkingList: AbstractModuleRecord[],
  referrer: CyclicModuleRecord,
  moduleRequests: readonly ModuleRequestRecord[],
  previouslyImportedNames: PreviouslyImportedNamesEntry[],
): void {
  for (const request of moduleRequests) {
    const requiredModule = GetImportedModule(referrer, request);
    if (!linkingList.includes(requiredModule)) {
      linkingList.push(requiredModule);
      if (requiredModule instanceof CyclicModuleRecord) {
        Assert(!previouslyImportedNames.some((p) => p.Module === requiredModule));
        previouslyImportedNames.push({ Module: requiredModule, ImportedNames: [] });
      }
    }
    if (requiredModule instanceof CyclicModuleRecord) {
      const optionalIndirectRequests = GetNewOptionalIndirectExportsModuleRequests(requiredModule, request.ImportedNames, previouslyImportedNames);
      BuildLinkingList(linkingList, requiredModule, optionalIndirectRequests, previouslyImportedNames);
    }
  }
}
```

- [ ] **Step 2: Build dts**

```bash
npm run build:dts
```

- [ ] **Step 3: Commit**

```bash
git add src/abstract-ops/module-records.mts
git commit -m "module-records: add BuildLinkingList"
```

---

## Task 10: Modify `InnerModuleLinking` and `Link` to use `BuildLinkingList`

`InnerModuleLinking` currently iterates `module.RequestedModules` directly. Replace with a `BuildLinkingList`-driven walk, then iterate the resulting list. `Link()` gains an `importedNames` parameter and links optional indirect requests *after* the main link completes.

**Files:**
- Modify: `src/abstract-ops/module-records.mts:144-180` (`InnerModuleLinking`)
- Modify: `src/modules.mts:191-220` (`Link`)

- [ ] **Step 1: Modify `InnerModuleLinking`**

Replace the `for (const required of module.RequestedModules)` loop with `BuildLinkingList`-driven iteration. Pass `previouslyImportedNames` through (a new parameter):

```typescript
export function InnerModuleLinking(
  module: AbstractModuleRecord,
  stack: CyclicModuleRecord[],
  index: number,
  previouslyImportedNames: PreviouslyImportedNamesEntry[],
): PlainCompletion<number> {
  if (!(module instanceof CyclicModuleRecord)) {
    Q(module.Link());
    return index;
  }
  if (module.Status === 'linking' || module.Status === 'linked' || module.Status === 'evaluating-async' || module.Status === 'evaluated') {
    return index;
  }
  Assert(module.Status === 'unlinked');
  module.Status = 'linking';
  module.DFSAncestorIndex = index;
  const moduleIndex = index;
  index += 1;
  stack.push(module);

  const linkingList: AbstractModuleRecord[] = [];
  BuildLinkingList(linkingList, module, module.RequestedModules, previouslyImportedNames);

  for (const requiredModule of linkingList) {
    index = Q(InnerModuleLinking(requiredModule, stack, index, previouslyImportedNames));
    if (requiredModule instanceof CyclicModuleRecord) {
      Assert(requiredModule.Status === 'linking' || requiredModule.Status === 'linked' || requiredModule.Status === 'evaluating-async' || requiredModule.Status === 'evaluated');
      Assert((requiredModule.Status === 'linking') === stack.includes(requiredModule));
      if (requiredModule.Status === 'linking') {
        module.DFSAncestorIndex = Math.min(module.DFSAncestorIndex, requiredModule.DFSAncestorIndex!);
      }
    }
  }

  Q(module.InitializeEnvironment());
  Assert(stack.filter((m) => m === module).length === 1);
  Assert(module.DFSAncestorIndex! <= moduleIndex);
  if (module.DFSAncestorIndex === moduleIndex) {
    let done = false;
    while (!done) {
      const requiredModule = stack.pop()!;
      Assert(requiredModule instanceof CyclicModuleRecord);
      requiredModule.Status = 'linked';
      if (requiredModule === module) done = true;
    }
  }
  return index;
}
```

- [ ] **Step 2: Modify `Link()` in `modules.mts`**

```typescript
Link(importedNames: ImportedNamesValue = 'all') {
  const module = this;
  Assert(module.Status === 'unlinked' || module.Status === 'linked' || module.Status === 'evaluating-async' || module.Status === 'evaluated');
  const stack: CyclicModuleRecord[] = [];
  const previouslyImportedNames: PreviouslyImportedNamesEntry[] = [
    { Module: module, ImportedNames: importedNames },
  ];
  const result = InnerModuleLinking(module, stack, 0, previouslyImportedNames);
  if (result instanceof AbruptCompletion) {
    for (const m of stack) {
      Assert(m.Status === 'linking');
      m.Status = 'unlinked';
    }
    Assert(module.Status === 'unlinked');
    return result;
  }
  Assert(module.Status === 'linked' || module.Status === 'evaluating-async' || module.Status === 'evaluated');
  Assert(stack.length === 0);

  // Step 8 of spec Link: link optional indirect requests after main link completes.
  const optionalIndirectRequests = module.GetOptionalIndirectExportsModuleRequests(importedNames);
  for (const request of optionalIndirectRequests) {
    const requiredModule = GetImportedModule(module, request);
    Assert(requiredModule.Status === 'unlinked' || requiredModule.Status === 'linked' || requiredModule.Status === 'evaluating-async' || requiredModule.Status === 'evaluated');
    if (requiredModule.Status === 'unlinked' && requiredModule instanceof CyclicModuleRecord) {
      Q(requiredModule.Link(request.ImportedNames));
    }
  }

  return undefined;
}
```

- [ ] **Step 3: Update other callers of `InnerModuleLinking`**

```bash
grep -rn "InnerModuleLinking" /Users/caiolima/dev/engine262/src
```

Update each call site to pass `previouslyImportedNames`. There should be only the one inside `Link()` (above) and possibly recursive calls from `BuildLinkingList`'s callers.

- [ ] **Step 4: Build full bundle**

```bash
npm run build
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/abstract-ops/module-records.mts src/modules.mts
git commit -m "module-records: route InnerModuleLinking and Link through BuildLinkingList"
```

---

## Task 11: Add `GatherAsynchronousTransitiveDependencies` and `…ForRequests`

Used by `BuildEvaluationList` to flatten a deferred sub-graph into an evaluation list. Phase 2b also uses these.

**Files:**
- Modify: `src/abstract-ops/module-records.mts`

- [ ] **Step 1: Add the two functions**

```typescript
/** https://tc39.es/proposal-deferred-reexports/#sec-gatherasynchronoustransitivedependencies */
export function GatherAsynchronousTransitiveDependencies(module: AbstractModuleRecord, seen: Set<AbstractModuleRecord> = new Set()): AbstractModuleRecord[] {
  if (seen.has(module)) return [];
  seen.add(module);
  const result: AbstractModuleRecord[] = [];
  if (module instanceof CyclicModuleRecord) {
    for (const request of module.RequestedModules) {
      const dep = GetImportedModule(module, request);
      ListAppendUnique(result, GatherAsynchronousTransitiveDependencies(dep, seen));
    }
  }
  if (!result.includes(module)) {
    result.push(module);
  }
  return result;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-gatherasynchronoustransitivedependenciesforrequests */
export function GatherAsynchronousTransitiveDependenciesForRequests(
  referrer: CyclicModuleRecord,
  requests: readonly ModuleRequestRecord[],
  seen: Set<AbstractModuleRecord> = new Set(),
): AbstractModuleRecord[] {
  const result: AbstractModuleRecord[] = [];
  for (const request of requests) {
    const dep = GetImportedModule(referrer, request);
    ListAppendUnique(result, GatherAsynchronousTransitiveDependencies(dep, seen));
  }
  return result;
}
```

- [ ] **Step 2: Build, commit**

```bash
npm run build:dts
git add src/abstract-ops/module-records.mts
git commit -m "module-records: add GatherAsynchronousTransitiveDependencies"
```

---

## Task 12: Add `BuildEvaluationList`

Per spec: like `BuildLinkingList`, but with the deferred-request handling that calls `GatherAsynchronousTransitiveDependencies` to flatten deferred sub-graphs into the evaluation list.

**Files:**
- Modify: `src/abstract-ops/module-records.mts`

- [ ] **Step 1: Add the function**

```typescript
/** https://tc39.es/proposal-deferred-reexports/#sec-buildevaluationlist */
export function BuildEvaluationList(
  evaluationList: AbstractModuleRecord[],
  referrer: CyclicModuleRecord,
  moduleRequests: readonly ModuleRequestRecord[],
): void {
  for (const request of moduleRequests) {
    const requiredModule = GetImportedModule(referrer, request);
    if (request.Phase === 'defer') {
      ListAppendUnique(evaluationList, GatherAsynchronousTransitiveDependencies(requiredModule));
    } else if (!evaluationList.includes(requiredModule)) {
      evaluationList.push(requiredModule);
    }
    if (requiredModule instanceof CyclicModuleRecord) {
      const importedNames = request.ImportedNames;
      const optionalIndirectRequests = requiredModule.GetOptionalIndirectExportsModuleRequests(importedNames);
      BuildEvaluationList(evaluationList, requiredModule, optionalIndirectRequests);
    }
  }
}
```

- [ ] **Step 2: Build, commit**

```bash
npm run build:dts
git add src/abstract-ops/module-records.mts
git commit -m "module-records: add BuildEvaluationList"
```

---

## Task 13: Modify `InnerModuleEvaluation` and `Evaluate` to use `BuildEvaluationList`

Same pattern as Task 10 but for the evaluation traversal.

**Files:**
- Modify: `src/abstract-ops/module-records.mts` (`InnerModuleEvaluation`)
- Modify: `src/modules.mts` (`Evaluate`)

- [ ] **Step 1: Modify `InnerModuleEvaluation`**

Find `InnerModuleEvaluation` in `module-records.mts` and replace its `for (const required of module.RequestedModules)` loop with a `BuildEvaluationList`-driven walk:

```typescript
const evaluationList: AbstractModuleRecord[] = [];
BuildEvaluationList(evaluationList, module, module.RequestedModules);

for (const requiredModule of evaluationList) {
  // existing loop body, but using `requiredModule` from the list instead of resolving via GetImportedModule per-request
  ...
}
```

(The loop body's exact contents depend on the current implementation; preserve all the existing async-evaluation bookkeeping — `PendingAsyncDependencies`, `AsyncParentModules`, etc.)

- [ ] **Step 2: Thread `importedNames` through `Evaluate`**

```typescript
* Evaluate(importedNames: ImportedNamesValue = 'all'): Evaluator<PromiseObject> {
  let module: CyclicModuleRecord = this;
  // ... existing assertion code ...

  const stack: CyclicModuleRecord[] = [];
  const capability = X(NewPromiseCapability(surroundingAgent.intrinsic('%Promise%')));
  module.TopLevelCapability = capability;

  const result = yield* InnerModuleEvaluation(module, stack, 0);
  // ... existing TLA / abrupt handling ...

  // Step matching spec: evaluate optional indirect requests after the main evaluation completes.
  const optionalIndirectRequests = module.GetOptionalIndirectExportsModuleRequests(importedNames);
  const promises: PromiseObject[] = [capability.Promise];
  for (const request of optionalIndirectRequests) {
    const requiredModule = GetImportedModule(module, request);
    Assert(requiredModule instanceof CyclicModuleRecord);
    const innerPromise = yield* (requiredModule as CyclicModuleRecord).Evaluate(request.ImportedNames);
    promises.push(innerPromise);
  }

  // If any promise is pending, return a Promise.all-like aggregate.
  // (Use SafePerformPromiseAll if available; otherwise build a manual aggregator.)
  // ... see spec section 16.2.1.6.3 (Evaluate, step 14+) ...

  return capability.Promise;
}
```

The aggregate-promise step (`SafePerformPromiseAll`) shields against `Promise.prototype` monkey-patching — see how the existing import-defer code does it (commit `06101c5b`). Use the same primitive.

- [ ] **Step 3: Build full bundle**

```bash
npm run build
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/abstract-ops/module-records.mts src/modules.mts
git commit -m "module-records: route InnerModuleEvaluation and Evaluate through BuildEvaluationList"
```

---

## Task 14: Run the PR 5034 test scenarios and validate

**Files:** none

- [ ] **Step 1: Run the load-and-evaluation slice**

```bash
npm run test:test262 -- 'language/export/export-defer/load-and-evaluation/**/*.js'
```

Expected: all 7 scenarios pass (× 2 modes = 14 reachable runs). Specifically:

- `no-consumer-no-load` — barrel loads, dep with syntax-error fixture is *not* loaded.
- `consumer-imports-loads` — consumer imports x, both barrel and dep evaluate. Order: `['barrel', 'dep']`.
- `chained-defer` — A → B → C all evaluate; order `['a', 'b', 'c']`.
- `reexport-non-defer-consumed` — non-defer re-export forces source.
- `reexport-non-defer-unconsumed` — non-defer re-export forces source even when consumer doesn't use it.
- `star-reexport-non-default` — `export *` pulls deferred non-default re-export.
- `star-reexport-default` — `export *` does *not* pull a deferred default re-export.

If a scenario fails:

- Compare actual vs expected evaluation order. If the order is wrong, audit `BuildEvaluationList` — likely a missing or duplicated `ListAppendUnique` call.
- If a module is loaded that shouldn't be, audit `InnerModuleLoading`'s `requestsToLoad` and `GetNewOptionalIndirectExportsModuleRequests`. Add temporary `console.log`s on the load entry point to see which requests are walked.
- If linking fails ("module not found"), the load step missed a required source. Verify `request.ImportedNames` is `'all'` (not `[]`) for transitive non-defer chains.

- [ ] **Step 2: Phase 1 syntax tests must still pass**

```bash
npm run test:test262 -- 'language/export/export-defer/syntax/**/*.js'
```

Expected: 21 passed, 0 failed (1 in failed-list).

- [ ] **Step 3: No commit — verification only.**

---

## Task 15: Run full test262 and verify no regressions outside `export-defer/`

**Files:** none

- [ ] **Step 1: Full run**

```bash
npm run test:test262 2>&1 | tee /tmp/phase-2a-final.log
grep -E "^\s*FAIL\s" /tmp/phase-2a-final.log | grep -v "export-defer/" | wc -l
```

Expected: zero non-export-defer failures. If non-zero, inspect the failures — likely culprits:

- Some other test exercises `LoadRequestedModules` / `Link` / `Evaluate` directly via the embedder API (search for `realm.evaluateModule` or similar in `test/engine262/module.test.mts`). The new optional `importedNames` parameters default to `'all'`, so behavior should be unchanged for non-defer code — but a forgotten code path may pass `undefined` instead of `'all'`. Audit the changed signatures.
- Cyclic module tests: ensure `BuildLinkingList` still terminates on cycles (it does because of the `linkingList.includes(requiredModule)` guard).

- [ ] **Step 2: Run vitest suites for full safety**

```bash
npm run test:owned && npm run test:inspector && npm run test:json
```

Expected: all green.

- [ ] **Step 3: No commit — verification only.**

---

## Task 16: Final cleanup and log review

**Files:** none

- [ ] **Step 1: Working tree status**

```bash
git status
```

Expected: clean.

- [ ] **Step 2: Review commits since phase 1**

```bash
git log --oneline 1459994a..HEAD
```

(`1459994a` is the rename commit at the end of phase 1.)

Expected commits (in commit order, latest first):

```
module-records: route InnerModuleEvaluation and Evaluate through BuildEvaluationList
module-records: add BuildEvaluationList
module-records: add GatherAsynchronousTransitiveDependencies
module-records: route InnerModuleLinking and Link through BuildLinkingList
module-records: add BuildLinkingList
module-records: thread ImportedNames through InnerModuleLoading
module-records: add GetNewOptionalIndirectExportsModuleRequests
modules: add GetOptionalIndirectExportsModuleRequests
module-records: add ImportedNames data model and merge helpers
```

(9 commits.)

- [ ] **Step 3: No further action — phase 2a is complete.**

---

## Self-review notes (for the implementing engineer)

**Spec coverage map**

- `[[ImportedNames]]` field on `ModuleRequestRecord`: Tasks 1, 2.
- `MergeImportedNames` / `ExcludeImportedNames` / `ListAppendUnique`: Task 4.
- `GetOptionalIndirectExportsModuleRequests` (abstract + SourceText override): Tasks 5, 6.
- `GetNewOptionalIndirectExportsModuleRequests`: Task 7.
- `InnerModuleLoading` modifications + `LoadRequestedModules(importedNames)`: Task 8.
- `BuildLinkingList`: Task 9.
- `InnerModuleLinking` + `Link(importedNames)`: Task 10.
- `GatherAsynchronousTransitiveDependencies(ForRequests)`: Task 11.
- `BuildEvaluationList`: Task 12.
- `InnerModuleEvaluation` + `Evaluate(importedNames)`: Task 13.

**Design-doc claims**

- "No new field on `ExportEntry`" — preserved. The new field is on `ModuleRequestRecord`.
- "`LoadRequestedModules` distinguishes required vs optional" — preserved. The mechanism is via `optionalIndirectRequests` concatenation at each level of recursion.
- "ResolveExport changes" — *retracted*. The proposal does NOT modify `ResolveExport`. The existing recursion at `modules.mts:452` works because the load step ensures all transitively-required deferred sources are loaded before linking begins.
- "GetExportedNames includes deferred re-exports' names" — already works because deferred re-exports go into `IndirectExportEntries`, which `GetExportedNames` already walks.

**Async/sync constraint** — preserved. All required-ness propagation happens during the async load walk; linking and evaluation see a fully-loaded graph (modulo the explicit "link optional indirect requests after main link" step at the end of `Link()`, which only runs against already-loaded modules).

**`ExcludeImportedNames` opacity** — the spec keeps "all minus list" as an opaque value because the universe of exported names isn't known at intermediate steps. This implementation matches by returning `'all'` or `'all-but-default'` from those branches; downstream filters (`GetOptionalIndirectExportsModuleRequests`) re-evaluate against actual `[[Exports]]`. Per-binding correctness is preserved.

**Phase 2b prerequisites delivered here** — `GatherAsynchronousTransitiveDependencies` is used by phase 2b's `EvaluateModuleSync` and `ReadyForSyncExecution`. Phase 2b will only need to add the `[[Get]]` hook plus the sync-eval driver.

---

## Post-implementation notes (added after phase 2a landed)

This section captures deviations from the plan that emerged during implementation. **Read this carefully when planning phase 2b** — phase 2b builds on the choices made here.

### Deviations from the plan

**1. `OptionalIndirectExportEntries` is a NEW field on `SourceTextModuleRecord`** *(not in the original plan)*

The plan's Task 6 said "filter `IndirectExportEntries` by `Phase === 'defer'`". This was wrong: deferred entries can't be left in `IndirectExportEntries`, because `InitializeEnvironment` eagerly resolves every entry there via `GetImportedModule(module, e.ModuleRequest)`. For an `export defer { x } from "./dep"` whose dep is never loaded (no consumer), that lookup asserts.

The correct architecture, matching `proposal-deferred-reexports` spec text:
- `ExportEntry` for `export defer { ... } from` lands in a NEW field `OptionalIndirectExportEntries` on `SourceTextModuleRecord` (`src/modules.mts:325-326`, populated in `src/parse.mts:147-149,182-185,201`).
- `GetOptionalIndirectExportsModuleRequests` walks `OptionalIndirectExportEntries` (no Phase filter needed — they're all deferred there).
- `ResolveExport` walks `[...IndirectExportEntries, ...OptionalIndirectExportEntries]` (per spec line 1650).
- `GetExportedNames` walks both (per spec line 1594).
- `InitializeEnvironment` only walks `IndirectExportEntries` (deferred entries are NOT eagerly validated).

**2. `ModuleRequests` returns `[]` for `export defer`** *(not in the original plan)*

The plan implicitly assumed the deferred re-export's request would still flow into `RequestedModules`. Per the spec (proposal line 358-359: `ExportDeclaration : export defer ExportFromClause FromClause WithClause? ;` → "Return a new empty List"), it must NOT — otherwise `BuildLinkingList`/`InnerModuleLoading` would unconditionally pull dep into the link/load lists.

Implementation: `src/static-semantics/ModuleRequests.mts` skips the `defer` Phase in the `ExportDeclaration` case, and a new `ExportFromDeclarationModuleRequest(node)` helper is called from both `ModuleRequests` (for non-defer) and `ExportEntries` (always, so `ExportEntry.ModuleRequest` still references the right request).

**3. `previouslyImportedNames` is per-`BuildLinkingList`-call, not threaded** *(not in the original plan)*

The plan's Task 10 step 1 threaded `previouslyImportedNames` through `InnerModuleLinking` recursive calls. Per spec (line 1071), each `InnerModuleLinking` call seeds `BuildLinkingList` with `« »` (empty). The threading is internal to one `BuildLinkingList` call, not across `InnerModuleLinking` recursion. Same for `Link()` — no setup of `previouslyImportedNames` at the top.

Implementation: `InnerModuleLinking(module, stack, index)` (no `previouslyImportedNames` param). `BuildLinkingList(linkingList, module, module.RequestedModules, [])` — fresh empty list per call.

**4. `LoadRequestedModules` does NOT pre-populate the visited entry** *(plan was wrong)*

The plan's Task 8 step 1 had `LoadRequestedModules` create `PreviouslyImportedNames: [{ Module: module, ImportedNames: importedNames }]`. Wrong: when `InnerModuleLoading` then runs `GetNewOptionalIndirectExportsModuleRequests`, `previous[module] === importedNames`, so `ExcludeImportedNames(importedNames, importedNames) === []` and no optional-indirect requests are returned. Effect: deferred deps never load.

Per spec (line 953-958), `LoadRequestedModules` creates `state.[[Visited]] = « »` (empty); `InnerModuleLoading` itself appends `{Module: module, ImportedNames: « »}` and then computes new requests. Implementation matches.

**5. `Evaluate` has BOTH a fast-path AND a fresh-capability path** *(extension to plan)*

Per spec (line 1145), already-evaluated modules use `module.[[CycleRoot]].[[TopLevelCapability]].[[Promise]]`. But in engine262, a module evaluated only as a transitive dep can have `CycleRoot === self` and `TopLevelCapability === undefined` (set only when the module is the entry point). The spec assertion `module.[[CycleRoot]].[[TopLevelCapability]] is not ~empty~` would fail.

The implementation gates on the assertion's premise: if `CycleRoot && CycleRoot.TopLevelCapability` exist, reuse the promise. Otherwise fall through to the fresh-capability path — `InnerModuleEvaluation` short-circuits for already-evaluated modules and the new capability resolves synchronously. This preserves the original engine262 behavior for dynamic-import re-evaluation (`language/expressions/dynamic-import/reuse-namespace-object-from-import.js`).

**6. `BuildEvaluationList` eagerly adds the deferred dep itself when consumer uses named imports** *(critical deviation — phase 2b will need to revisit)*

Per spec (line 1283-1286): for a `defer`-Phase request, `ListAppendUnique(eval, GatherAsynchronousTransitiveDependencies(requiredModule))`. `GatherAsync` for a sync module returns its async transitive deps only — the module itself is omitted unless `HasTLA`.

But the PR 5034 fixtures (which the plan declared as phase 2a's validation target) expect sync deferred deps to be evaluated before the consumer's body executes — e.g., `import { x } from barrel` where `barrel` does `export defer { x } from dep` and dep is sync. Without dep being added to the eval list, dep's body never runs and `x === undefined`.

Implementation deviates from spec: when `request.Phase === 'defer'` AND `request.ImportedNames !== 'all'`, the deferred `requiredModule` is appended to `evaluationList` directly (after its async transitive deps). The `'all'` gate preserves `import defer * as ns from "..."` semantics — for namespace consumers, the dep should NOT eagerly evaluate (its evaluation is deferred to the namespace `[[Get]]` in phase 2b).

**Phase 2b should reconsider this.** Once the namespace `[[Get]]` hook drives sync evaluation lazily, the eager-add for non-namespace consumers may still be the right behavior (named imports through a deferred re-export DO need the binding's value at access time, and there's no `[[Get]]` interception for module-env bindings). But the rationale should be revisited against the final spec interpretation.

### What changed from the plan's commit list

Plan expected 9 commits. Actual: 12 implementation commits + this docs commit:

```
0f69030f module-records: lint fixes (brace-style, prefer-const)
46e4faff modules: gate eager defer-dep evaluation on non-namespace consumers; reuse TopLevelCapability via CycleRoot when present
dc57a244 modules: separate OptionalIndirectExportEntries; fix BuildEvaluationList to eagerly evaluate sync deferred deps for named-import consumers
b23a95d2 module-records: route InnerModuleEvaluation and Evaluate through BuildEvaluationList
fce8fa0e module-records: add BuildEvaluationList
b06bbbba module-records: add GatherAsynchronousTransitiveDependenciesForRequests
a2a143bc module-records: route InnerModuleLinking and Link through BuildLinkingList
2eb000bb module-records: add BuildLinkingList
8bd19901 module-records: thread ImportedNames through InnerModuleLoading
767f5068 module-records: add GetNewOptionalIndirectExportsModuleRequests
568328b0 modules: add GetOptionalIndirectExportsModuleRequests
045a27c8 module-records: add ImportedNames data model and merge helpers
```

The extra commits are the bug-fix follow-ups (`dc57a244`, `46e4faff`) and the lint pass (`0f69030f`). Phase 2b should expect a similar shape: the spec text is precise but engine262's existing structure has hidden constraints (assertion paths, abstract-method narrowing) that surface during implementation.

### Test results at end of phase 2a

- All 7 PR 5034 `load-and-evaluation/` scenarios pass (× 2 modes = 13 reachable runs; one fixture has only `[module]` mode).
- Phase 1 syntax tests: 21 pass, 1 in failed-list (unchanged).
- Full test262: 45739 passed, 6511 skipped, **28 failed** — all 28 are in `language/export/export-defer/evaluation-triggers/` (phase 2b's `[[Get]]`-hook tests).
- Vitest (owned + inspector + json): all green.
- import-defer regression suite: all 201 pass (phase 2b should re-verify after `[[Get]]` changes).

### Pointers for phase 2b planning

- **`GetOptionalIndirectExportsModuleRequests` already exists** with the correct structure (walks `OptionalIndirectExportEntries`). Phase 2b's `EvaluateModuleSync` / `ReadyForSyncExecution` should reuse it.
- **`GatherAsynchronousTransitiveDependencies` and `…ForRequests` are already implemented** (`src/abstract-ops/module-records.mts`).
- **`BuildEvaluationList`'s eager-add deviation (#6 above)** is the load-bearing piece for phase 2b's [[Get]] design. If phase 2b's `[[Get]]` triggers `EvaluateModuleSync` lazily, the eager-add for non-namespace consumers might still be needed (since named-import bindings don't go through `[[Get]]`), or might be removable if a different mechanism propagates the synchronous evaluation requirement at link time. Investigate before changing.
- **`OptionalIndirectExportEntries` is the spec-correct field name and the engine262 implementation matches.** Phase 2b's `ResolveExport` changes (per proposal lines 1657-1664: `deferNamespaceExportSet` handling for `export defer * as ns from ...` chains that re-export non-resolvable bindings) build directly on this.
- **The `evaluation-triggers/` test directory is the validation target for phase 2b** — 28 currently-failing tests, all involving namespace `[[Get]]` triggering evaluation of the deferred source.
