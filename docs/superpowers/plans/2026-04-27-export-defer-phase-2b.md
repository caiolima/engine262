# `export defer` — Phase 2b Implementation Plan (namespace `[[Get]]` triggered evaluation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Important context — much of phase 2b's apparatus already exists.** Phase 2a delivered `EvaluateModuleSync`, `ReadyForSyncExecution`, `GatherAsynchronousTransitiveDependencies(ForRequests)`, and a working `Evaluate(importedNames)` (signatures matching the spec). What's missing is (a) the `[[Get]]`-time trigger on module-namespace exotic objects, (b) plumbing `importedNames` through `EvaluateModuleSync` and `ReadyForSyncExecution`, and (c) moving the existing import-defer trigger out of `GetModuleExportsList` (which fires too eagerly per PR 5035).

**Goal:** Make `[[Get]]` on a module-namespace exotic the *only* operation that triggers synchronous evaluation of a deferred sub-graph, matching the proposal's "only insert `EvaluateModuleSync` into `[[Get]]`" guarantee. Specifically:

- Regular (non-deferred) namespaces fire the trigger only when the requested key flows through a deferred re-export (`m.GetOptionalIndirectExportsModuleRequests(« P »)` is non-empty).
- Deferred namespaces (`import defer * as ns`) fire the trigger on `[[Get]]` for any exported key, evaluating the full module (`importedNames = 'all'`).
- `[[GetOwnProperty]]`, `[[HasProperty]]`, `[[OwnPropertyKeys]]`, `[[DefineOwnProperty]]`, `[[Delete]]`, `[[Set]]`, super-property define/set — none trigger.
- TLA in the deferred sub-graph + `[[Get]]` → `TypeError` from `ReadyForSyncExecution`.

**Architecture:** Add the trigger inside `[[Get]]` itself (`src/abstract-ops/module-namespace-exotic-objects.mts:120-162`), gated on whether the binding flows through a deferred re-export (regular namespace) or whether `O.Deferred` is true (deferred namespace). Move the existing `O.Deferred` trigger out of `GetModuleExportsList` so it stops firing on non-`[[Get]]` operations. Extend `EvaluateModuleSync(module, importedNames)` and `ReadyForSyncExecution(module, importedNames)` to accept the per-call name set, walking only the relevant deferred sub-graph.

**Tech Stack:** Same as phases 1 and 2a.

**Spec reference:** `docs/superpowers/specs/2026-04-27-export-defer-design.md` (commit `c077e8c9`) plus the post-implementation notes at the bottom of `docs/superpowers/plans/2026-04-27-export-defer-phase-2a.md`.

**Validation target:** All 27 currently-failing tests in `language/export/export-defer/evaluation-triggers/` pass. Phase 1 syntax tests still pass. Phase 2a load-and-evaluation tests still pass. The 201-test import-defer regression suite still passes.

**Out of scope (deferred to Phase 3 or follow-ups):**
- Composition with `import defer * as ns from "..."` over a deferred-re-exporter where the chain itself is deferred. Phase 3 verifies; if a gap surfaces, add a regression test there.
- The `BuildEvaluationList` eager-add behavior (phase 2a deviation #6) — left in place because it's load-bearing for named-import consumers. Revisit only if a test surfaces a contradiction.
- `ResolveExport`'s `deferNamespaceExportSet` handling for chains that re-export non-resolvable bindings (proposal §16.2.1.6.5 lines 1657-1664). Not exercised by PR 5035; defer until a test demands it.

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `src/abstract-ops/module-records.mts` (`EvaluateModuleSync`, lines 310-334) | modify | Accept `importedNames` parameter; pass through to `module.Evaluate(importedNames)`. |
| `src/abstract-ops/module-namespace-exotic-objects.mts` (`ReadyForSyncExecution`, lines 281-307) | modify | Accept `importedNames` parameter; walk only the relevant sub-graph (the optional indirect requests filtered by `importedNames`, plus the module's own non-deferred deps). |
| `src/abstract-ops/module-namespace-exotic-objects.mts` (`[[Get]]`, lines 119-162) | modify | Insert the trigger: if regular namespace AND `m.GetOptionalIndirectExportsModuleRequests(« P »)` is non-empty, call `EvaluateModuleSync(m, « P »)`. If deferred namespace (`O.Deferred`), call `EvaluateModuleSync(m, 'all')`. |
| `src/abstract-ops/module-namespace-exotic-objects.mts` (`GetModuleExportsList`, lines 269-278) | modify | Remove the `O.Deferred` trigger — move to `[[Get]]` only (above). |

---

## Task 1: Extend `EvaluateModuleSync` to accept `importedNames`

Current signature (`src/abstract-ops/module-records.mts:311`):

```typescript
export function* EvaluateModuleSync(module: ModuleRecord): PlainEvaluator<undefined> {
  Assert(module instanceof CyclicModuleRecord ? ReadyForSyncExecution(module) === Value.true : true);
  if (!(module instanceof CyclicModuleRecord && module.Status === 'evaluated')) {
    Q(surroundingAgent.debugger_cannotPreview);
  }
  const promise = yield* module.Evaluate();
  // ... rest unchanged
}
```

Per spec, callers pass `importedNames` so the underlying `Evaluate` runs only the relevant deferred sub-graph.

**Files:**
- Modify: `src/abstract-ops/module-records.mts:310-334`

- [ ] **Step 1: Update the signature and forward to `Evaluate(importedNames)`**

```typescript
import type { ImportedNamesValue } from '../static-semantics/ModuleRequests.mts';

/** https://tc39.es/proposal-deferred-reexports/#sec-EvaluateModuleSync */
export function* EvaluateModuleSync(module: ModuleRecord, importedNames: ImportedNamesValue = 'all'): PlainEvaluator<undefined> {
  // 1. Assert: If module is a Cyclic Module Record, ReadyForSyncExecution(module, importedNames) is true.
  Assert(module instanceof CyclicModuleRecord ? ReadyForSyncExecution(module, importedNames) === Value.true : true);
  if (!(module instanceof CyclicModuleRecord && module.Status === 'evaluated')) {
    Q(surroundingAgent.debugger_cannotPreview);
  }
  // 2. Let promise be module.Evaluate(importedNames).
  const promise = yield* module.Evaluate(importedNames);
  // 3-5. (unchanged: rejection handling)
  Assert(promise.PromiseState === 'fulfilled' || promise.PromiseState === 'rejected');
  if (promise.PromiseState === 'rejected') {
    if (promise.PromiseIsHandled === Value.false) {
      HostPromiseRejectionTracker(promise, 'handle');
    }
    promise.PromiseIsHandled = Value.true;
    Throw(promise.PromiseResult!);
  }
  return undefined;
}
```

(`ReadyForSyncExecution`'s second parameter is added in Task 2; if you run a build between Task 1 and Task 2, you'll get a "expected 1 argument, got 2" error from this Assert. That's expected — proceed to Task 2.)

- [ ] **Step 2: Build dts**

```bash
npm run build:dts
```

Expected: TypeScript flags the `ReadyForSyncExecution(module, importedNames)` call as a signature mismatch until Task 2 lands. That's fine.

- [ ] **Step 3: No commit yet** — Tasks 1-3 commit together.

---

## Task 2: Extend `ReadyForSyncExecution` to accept `importedNames`

Current implementation walks `module.RequestedModules` (every non-deferred dep). For phase 2b's `[[Get]]`-triggered case, the relevant scope is the deferred sub-graph specified by `importedNames`, plus the module's own non-deferred deps (which must already be evaluated for the binding lookup to be meaningful).

Per spec, `ReadyForSyncExecution(module, importedNames)`:

1. If `module` is not a Cyclic Module Record, return `true`.
2. If `module` is already in `seen`, return `true`.
3. Add `module` to `seen`.
4. If `module.[[Status]]` is `evaluated`, return `true`.
5. If `module.[[Status]]` is `evaluating` or `evaluating-async`, return `false`.
6. Assert: `module.[[Status]]` is `linked`.
7. If `module.[[HasTLA]]` is `true`, return `false`.
8. For each `request` in `module.[[RequestedModules]]`, walk into `requiredModule = GetImportedModule(module, request)` recursively (passing `request.[[ImportedNames]]`).
9. For each `request` in `module.GetOptionalIndirectExportsModuleRequests(importedNames)`, walk into `requiredModule = GetImportedModule(module, request)` recursively (passing `request.[[ImportedNames]]`).
10. If all walks return `true`, return `true`. Otherwise return `false`.

**Files:**
- Modify: `src/abstract-ops/module-namespace-exotic-objects.mts:281-307`

- [ ] **Step 1: Move `ReadyForSyncExecution` from the namespace-exotic file to `module-records.mts`**

The function currently lives in `module-namespace-exotic-objects.mts`. Now that it accepts `importedNames` and walks `GetOptionalIndirectExportsModuleRequests`, it depends on more module-record machinery. Move it to `src/abstract-ops/module-records.mts` (just above `EvaluateModuleSync`, line 310) so all the deferred-re-export plumbing lives in one file.

Cut the existing definition from `module-namespace-exotic-objects.mts:281-307` and paste into `module-records.mts:308` (just above `EvaluateModuleSync`). Update the import at the top of `module-namespace-exotic-objects.mts:33` to include `ReadyForSyncExecution`:

```typescript
import {
  // ... existing imports,
  EvaluateModuleSync,
  ReadyForSyncExecution,
  GetImportedModule,
} from './all.mts';
```

(Replace the inline `import { GetImportedModule } from './all.mts';` if separate.)

Confirm the function is no longer defined in `module-namespace-exotic-objects.mts`:

```bash
grep -n "function ReadyForSyncExecution\|export function ReadyForSyncExecution\|export.*ReadyForSyncExecution" /Users/caiolima/dev/engine262/src/abstract-ops/module-namespace-exotic-objects.mts
```

Expected: empty output (or only an import line).

- [ ] **Step 2: Update the moved function's signature and walk**

```typescript
/** https://tc39.es/proposal-deferred-reexports/#sec-ReadyForSyncExecution */
export function ReadyForSyncExecution(
  module: ModuleRecord,
  importedNames: ImportedNamesValue = 'all',
  seen: Set<CyclicModuleRecord> = new Set(),
): BooleanValue {
  if (!(module instanceof CyclicModuleRecord)) {
    return Value.true;
  }
  if (seen.has(module)) {
    return Value.true;
  }
  seen.add(module);
  if (module.Status === 'evaluated') {
    return Value.true;
  }
  if (module.Status === 'evaluating' || module.Status === 'evaluating-async') {
    return Value.false;
  }
  Assert(module.Status === 'linked');
  if (module.HasTLA === Value.true) {
    return Value.false;
  }
  for (const request of module.RequestedModules) {
    const requiredModule = GetImportedModule(module, request);
    if (ReadyForSyncExecution(requiredModule, request.ImportedNames, seen) === Value.false) {
      return Value.false;
    }
  }
  for (const request of module.GetOptionalIndirectExportsModuleRequests(importedNames)) {
    const requiredModule = GetImportedModule(module, request);
    if (ReadyForSyncExecution(requiredModule, request.ImportedNames, seen) === Value.false) {
      return Value.false;
    }
  }
  return Value.true;
}
```

- [ ] **Step 3: Re-export from `all.mts` if not already**

Check that `module-records.mts` is included in `src/abstract-ops/all.mts`'s re-exports (it should be — `EvaluateModuleSync` was already exported from there). No change needed if the re-export is wildcard-style.

```bash
grep -n "module-records" /Users/caiolima/dev/engine262/src/abstract-ops/all.mts
```

Expected: a wildcard `export * from './module-records.mts';` line. If absent, add `ReadyForSyncExecution` to the explicit export list.

- [ ] **Step 4: Build full bundle**

```bash
npm run build
```

Expected: green. If TypeScript complains about callers passing wrong arg counts, audit `module-namespace-exotic-objects.mts`'s `GetModuleExportsList` (which we'll modify in Task 4 anyway).

- [ ] **Step 5: No commit yet** — Tasks 1-3 commit together.

---

## Task 3: Modify `[[Get]]` on the module-namespace exotic to insert the trigger

Per the spec, `[[Get]]` looks like:

```
1. If P is a Symbol, return OrdinaryGet(O, P, Receiver).
2. Let exports be O.[[Exports]].
3. If exports does not contain P, return undefined.
4. Let m be O.[[Module]].
5. If m is a Cyclic Module Record and m.GetOptionalIndirectExportsModuleRequests(« P ») is not empty, then
   a. Perform ? EvaluateModuleSync(m, « P »).
6. (existing binding-lookup steps)
```

For deferred namespaces (`O.Deferred === true`), the spec evaluates the *full* module on first `[[Get]]` (`importedNames = 'all'`) — that matches existing import-defer behavior, just relocated from `GetModuleExportsList` into `[[Get]]`.

The discriminator is `O.Deferred`:
- If `O.Deferred === true`: the namespace is the deferred view. Trigger `EvaluateModuleSync(m, 'all')` (full eval), gating on `ReadyForSyncExecution(m)` first.
- If `O.Deferred === false`: the namespace is regular. Trigger `EvaluateModuleSync(m, [P])` only when `m.GetOptionalIndirectExportsModuleRequests([P])` is non-empty.

**Files:**
- Modify: `src/abstract-ops/module-namespace-exotic-objects.mts:119-162`

- [ ] **Step 1: Insert the trigger near the top of `[[Get]]`**

Current `Get` (line 119):

```typescript
* Get(P, Receiver) {
  const O = this;
  Assert(IsPropertyKey(P));
  if (IsSymbolLikeNamespaceKey(P, O)) {
    return yield* OrdinaryGet(O, P, Receiver);
  }
  const exports = Q(yield* GetModuleExportsList(O));
  if (!exports.has(P as JSStringValue)) {
    return Value.undefined;
  }
  const m = O.Module;
  // ... existing binding lookup ...
}
```

Replace with:

```typescript
* Get(P, Receiver) {
  const O = this;
  Assert(IsPropertyKey(P));
  if (IsSymbolLikeNamespaceKey(P, O)) {
    return yield* OrdinaryGet(O, P, Receiver);
  }
  // Proposal: only [[Get]] triggers EvaluateModuleSync. The exports lookup itself does not.
  if (!O.Exports.has(P as JSStringValue)) {
    return Value.undefined;
  }
  const m = O.Module;

  // Trigger sync evaluation when the binding flows through a deferred re-export
  // (regular namespace) or when the namespace itself is deferred.
  if (m instanceof CyclicModuleRecord) {
    let importedNames: ImportedNamesValue;
    let triggers: boolean;
    if (O.Deferred) {
      // Deferred namespace: evaluate the full module on first [[Get]].
      importedNames = 'all';
      triggers = m.Status !== 'evaluated' && m.Status !== 'evaluating-async';
    } else {
      // Regular namespace: evaluate only the deferred sub-graph for this name.
      importedNames = [P as JSStringValue];
      const optionalRequests = m.GetOptionalIndirectExportsModuleRequests(importedNames);
      triggers = optionalRequests.length > 0;
    }
    if (triggers) {
      if (ReadyForSyncExecution(m, importedNames) === Value.false) {
        return Throw.TypeError('Module "$1" is not ready for synchronous execution', m.HostDefined?.specifier ?? '<anonymous module>');
      }
      Q(yield* EvaluateModuleSync(m, importedNames));
    }
  }

  // Existing binding-lookup path (unchanged).
  const binding = m.ResolveExport(P as JSStringValue);
  Assert(binding instanceof ResolvedBindingRecord);
  const targetModule = binding.Module;
  Assert(!(targetModule instanceof UndefinedValue));
  if (binding.BindingName === 'namespace') {
    return Q(GetModuleNamespace(targetModule, 'evaluation'));
  }
  if (binding.BindingName === 'deferred-namespace') {
    return Q(GetModuleNamespace(targetModule, 'defer'));
  }
  const targetEnv = targetModule.Environment;
  if (!targetEnv) {
    return Throw.ReferenceError('$1 is not defined', P);
  }
  return Q(yield* targetEnv.GetBindingValue(binding.BindingName, Value.true));
},
```

(Replace the entire `Get` method body with the version above. Note that the `Q(yield* GetModuleExportsList(O))` call is replaced by direct `O.Exports.has(...)` — the trigger formerly inside `GetModuleExportsList` is now explicit at the top of `[[Get]]`.)

- [ ] **Step 2: Add the missing imports**

Top of `module-namespace-exotic-objects.mts`:

```typescript
import {
  // ...existing imports,
  EvaluateModuleSync,
  ReadyForSyncExecution,
  GetImportedModule,
  GetModuleNamespace, R,
  type ExoticObject,
} from './all.mts';
import type { ImportedNamesValue } from '../static-semantics/ModuleRequests.mts';
```

(Adjust the existing import block to include `ReadyForSyncExecution`.)

- [ ] **Step 3: Build full bundle**

```bash
npm run build
```

Expected: green.

- [ ] **Step 4: Commit Tasks 1-3**

```bash
git add src/abstract-ops/module-records.mts src/abstract-ops/module-namespace-exotic-objects.mts
git commit -m "module-namespace: trigger EvaluateModuleSync from [[Get]] only"
```

---

## Task 4: Remove the `O.Deferred` trigger from `GetModuleExportsList`

Now that `[[Get]]` carries the trigger, `GetModuleExportsList` should just return the cached exports list without any side effects. Operations like `[[GetOwnProperty]]`, `[[HasProperty]]`, `[[OwnPropertyKeys]]`, `[[Delete]]` all go through `GetModuleExportsList` and must NOT trigger evaluation per PR 5035.

**Files:**
- Modify: `src/abstract-ops/module-namespace-exotic-objects.mts:269-278`

- [ ] **Step 1: Replace `GetModuleExportsList`**

Current:

```typescript
function* GetModuleExportsList(O: ModuleNamespaceObject): PlainEvaluator<JSStringSet> {
  if (O.Deferred) {
    const m = O.Module;
    if (ReadyForSyncExecution(m) === Value.false) {
      return Throw.TypeError('Module "$1" is not ready for synchronous execution', m.HostDefined?.specifier ?? '<anonymous module>');
    }
    Q(yield* EvaluateModuleSync(m));
  }
  return O.Exports;
}
```

Replace with:

```typescript
function GetModuleExportsList(O: ModuleNamespaceObject): JSStringSet {
  // Per proposal-deferred-reexports: only [[Get]] triggers EvaluateModuleSync.
  // [[GetOwnProperty]], [[HasProperty]], [[OwnPropertyKeys]], [[Delete]] all go
  // through this helper and must observe the cached exports list without side effects.
  return O.Exports;
}
```

The function is no longer a generator, so update its callers (lines ~67, ~113, ~130, ~173, ~183) to remove the `Q(yield* ...)` wrapping:

```typescript
const exports = GetModuleExportsList(O);
```

For the call inside `* Get(P, Receiver)` (which was just removed in Task 3 in favor of `O.Exports.has(...)` directly), nothing else to do.

- [ ] **Step 2: Update other internal-method callers**

Search for all callers and update:

```bash
grep -n "GetModuleExportsList\|Q(yield\* GetModuleExportsList" /Users/caiolima/dev/engine262/src/abstract-ops/module-namespace-exotic-objects.mts
```

Each call should become a plain assignment:

```typescript
// before:
const exports = Q(yield* GetModuleExportsList(O));
// after:
const exports = GetModuleExportsList(O);
```

(Check `GetOwnProperty`, `HasProperty`, `Delete`, `OwnPropertyKeys`.)

- [ ] **Step 3: Build full bundle**

```bash
npm run build
```

Expected: green. If a caller still has `yield*`, TypeScript will complain — fix.

- [ ] **Step 4: Commit**

```bash
git add src/abstract-ops/module-namespace-exotic-objects.mts
git commit -m "module-namespace: GetModuleExportsList becomes side-effect-free"
```

---

## Task 5: Run PR 5035 evaluation-triggers tests and validate

**Files:** none

- [ ] **Step 1: Run the slice**

```bash
npm run test:test262 -- 'language/export/export-defer/evaluation-triggers/**/*.js'
```

Expected: 90 total, 89 passed, 0 failed, 1 pending. (One test in the slice is pending due to upstream flag — confirm this matches phase 2a's baseline by checking `git log -- test/test262/failed`.)

If failures persist, classify:

- **`trigger-exported-string-*` still failing:** `[[Get]]` trigger condition isn't firing for the regular-namespace case. Check the `GetOptionalIndirectExportsModuleRequests([P])` path — is the request actually returning the deferred dep? Cross-reference against phase 2a's `OptionalIndirectExportEntries` population (`src/parse.mts:147-149,182-185,201`).
- **`trigger-exported-then-*` still failing:** namespace `[[Get]]` for the `'then'` key. Check `IsSymbolLikeNamespaceKey` — for regular namespaces (`O.Deferred === false`), `'then'` is *not* symbol-like. The trigger should fire. For deferred namespaces (`O.Deferred === true`), `'then'` *is* symbol-like and falls through to `OrdinaryGet`, which does not trigger eval — and that's correct per PR 5035's classification (`'then'` on a deferred namespace is unobservable).
- **`no-trigger-on-exported/*` regressing:** the trigger is firing on something other than `[[Get]]`. Audit `GetModuleExportsList` — should be side-effect-free now (Task 4).
- **`super-property-*` failing:** super-property access goes through the namespace's prototype chain, not `[[Get]]` directly. Verify by tracing the operation:
  - `super.x` where the proto is a namespace → `[[Get]]` is called on the namespace via the prototype chain → trigger fires. ✓
  - `super.x = ...` (super-property set) → `[[Set]]` is called, which does *not* trigger. The test expects no trigger. ✓

- [ ] **Step 2: No commit — verification only.**

---

## Task 6: Verify import-defer regression suite still passes

The deferred-namespace trigger moved from `GetModuleExportsList` to `[[Get]]`. Pre-existing import-defer tests exercised the old path; verify they still pass on the new path.

**Files:** none

- [ ] **Step 1: Run all import-defer tests**

```bash
npm run test:test262 -- 'language/import/import-defer/**/*.js'
```

Expected: same pass count as before phase 2b (per phase 2a notes: 201 passing). No new failures.

If a test fails: the trigger relocation likely missed a case. Common culprits:
- A test does `Object.keys(deferredNs)` or `'x' in deferredNs` and expects evaluation to have happened. Per PR 5035, those should NOT trigger anymore. If an existing import-defer test relies on this behavior, that test is *also* affected by the proposal — flag for upstream coordination.
- A test does `deferredNs.x` and expects evaluation. This IS a `[[Get]]` and should trigger. Verify the new `[[Get]]` path runs `EvaluateModuleSync(m, 'all')` for `O.Deferred === true`.

- [ ] **Step 2: No commit — verification only.**

---

## Task 7: Run full test262 and verify no other regressions

**Files:** none

- [ ] **Step 1: Full run**

```bash
npm run test:test262 2>&1 | tee /tmp/p2b-final.log
grep -E "^Total" /tmp/p2b-final.log | tail -2
grep -E "^\s*FAIL" /tmp/p2b-final.log | grep -v "export-defer" | wc -l
```

Expected: zero non-`export-defer` failures. (Re-running the full suite catches incidental regressions.)

- [ ] **Step 2: Run vitest suites**

```bash
npm run test:owned && npm run test:inspector && npm run test:json
```

Expected: all green.

- [ ] **Step 3: No commit — verification only.**

---

## Task 8: Final cleanup and log review

**Files:** none

- [ ] **Step 1: Working tree status**

```bash
git status
```

Expected: clean.

- [ ] **Step 2: Review phase 2b commits**

```bash
git log --oneline 473476a3..HEAD
```

(`473476a3` is the post-implementation notes commit at the end of phase 2a.)

Expected (3 commits, oldest at bottom):

```
module-namespace: GetModuleExportsList becomes side-effect-free
module-namespace: trigger EvaluateModuleSync from [[Get]] only
docs: phase-2b implementation plan for export defer
```

(The first line will be `module-namespace: GetModuleExportsList becomes side-effect-free`; the docs commit is from before this plan executed.)

- [ ] **Step 3: No further action — phase 2b is complete.**

---

## Self-review notes (for the implementing engineer)

**Spec coverage map**

- `EvaluateModuleSync(module, importedNames)`: Task 1.
- `ReadyForSyncExecution(module, importedNames)`: Task 2.
- `[[Get]]` trigger for regular namespace: Task 3 (the `O.Deferred === false` branch).
- `[[Get]]` trigger for deferred namespace: Task 3 (the `O.Deferred === true` branch).
- Removal of trigger from non-`[[Get]]` operations: Task 4.
- TLA → `TypeError`: handled by `ReadyForSyncExecution` returning `false` and the trigger throwing — same pattern as the pre-existing import-defer code.
- 27 PR 5035 failures flip green: Task 5.
- Import-defer regression: Task 6.
- Full test262 no-regression: Task 7.

**Why move `ReadyForSyncExecution` from `module-namespace-exotic-objects.mts` to `module-records.mts`** (Task 2 step 1): the function now depends on `GetOptionalIndirectExportsModuleRequests` and `GetImportedModule` and is called from inside `EvaluateModuleSync`. Co-locating it with the other module-record machinery keeps the dependency direction clean (namespace exotic depends on module-record helpers, not vice versa).

**Why the `O.Deferred === true` branch passes `'all'` instead of a specific name set** (Task 3): `import defer * as ns from "m"` semantically requests "evaluate the entire module on first observed access." This matches the existing import-defer test expectations and the proposal's text for deferred namespaces. The `[P]` per-name path is reserved for the regular-namespace case where the consumer pulled in a specific binding via the deferred re-exporter.

**The `'then'` exclusion via `IsSymbolLikeNamespaceKey`** (verifying for Task 5 step 1): in a deferred namespace, accessing `'then'` should NOT trigger evaluation — `IsSymbolLikeNamespaceKey` returns true for `'then'` when `O.Deferred`, so `[[Get]]` short-circuits to `OrdinaryGet` before the trigger. In a regular namespace, accessing `'then'` *should* trigger if `'then'` is exported via a deferred re-export — `IsSymbolLikeNamespaceKey` returns false for `'then'` when not deferred, so the trigger runs normally. PR 5035's `then-exported` template tests exactly this distinction.

**Phase 2a's `BuildEvaluationList` eager-add deviation** (carried forward): named-import consumers (`import { x } from barrel`) eagerly evaluate dep at link time because `BuildEvaluationList` adds the deferred dep when `request.ImportedNames !== 'all'`. With phase 2b's `[[Get]]` trigger in place, *namespace*-import consumers (`import * as ns from barrel`) defer evaluation until the `ns.x` access. Both paths are exercised by PR 5035 fixtures — verify both pass in Task 5.
