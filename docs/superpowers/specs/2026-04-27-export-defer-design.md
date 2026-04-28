# Deferred Re-exports (`export defer`) — Design

**Status:** approved, ready for implementation planning
**Proposal:** https://github.com/tc39/proposal-deferred-reexports
**Tracking test262 PRs:** [#5033 syntax](https://github.com/tc39/test262/pull/5033), [#5034 load-and-evaluation](https://github.com/tc39/test262/pull/5034), [#5035 namespace-ops](https://github.com/tc39/test262/pull/5035)
**Date:** 2026-04-27

## Goal

Implement the deferred re-exports proposal in engine262. The proposal extends `ExportDeclaration` with a `defer` modifier on re-export forms, allowing a module to re-export bindings whose source modules are loaded and evaluated lazily — only when an exported binding is actually observed via the namespace's `[[Get]]`.

This is **export-only**. The proposal does not add new `import defer { ... }` named-import syntax. The existing `import defer * as ns from "..."` (from the import-defer proposal, already shipped in #295/#342) is unchanged.

## Non-goals

- Performance optimization. engine262's stated non-goal is speed; correctness and spec faithfulness come first.
- Public API additions to `src/index.mts`.
- Inspector/devtools changes beyond what falls out of namespace `[[Get]]` semantics.
- Caching of derived state (e.g. per-module sets of deferred-re-exported names) until profiling shows it matters.

## Background — what already exists

Import-defer (`import defer * as ns from "..."`) is already implemented. The relevant infrastructure:

- `ModuleRequestRecord.Phase: 'defer' | 'evaluation'` (`src/static-semantics/ModuleRequests.mts:10`).
- `BindingName: 'namespace' | 'deferred-namespace' | JSStringValue` on `ResolvedBindingRecord` (`src/abstract-ops/module-records.mts:64`).
- `DeferredNamespace` field on `CyclicModuleRecord` (`src/abstract-ops/module-records.mts:111`).
- `GetModuleNamespace(module, phase)` returns the deferred or eager namespace exotic (`src/abstract-ops/module-records.mts:521`).
- The parser recognizes `import defer *` (`src/parser/ModuleParser.mts:24`).

The proposal builds on this: `ModuleRequestRecord.Phase` is reused unchanged. New work centers on (a) extending the parser/static-semantics for `export defer`, (b) per-binding-required propagation in `LoadRequestedModules`, and (c) a `[[Get]]`-driven synchronous evaluation operation.

## Three-phase delivery

### Phase 1 — Syntax + ModuleRequest plumbing

Behavior-preserving. Deferred sources still load and evaluate eagerly. Only the parser, static semantics, and feature flag move.

**Files touched**

| File | Change |
|---|---|
| `src/host-defined/engine.mts` (FEATURES array) | Add `{ name: 'Deferred Re-exports', flag: 'export-defer', url: 'https://github.com/tc39/proposal-deferred-reexports', enableInPlayground: true }`. |
| `src/parser/ModuleParser.mts` (`parseExportDeclaration`, ~line 143) | After `expect(EXPORT)` and `eat(DEFAULT)`, recognize the `defer` contextual keyword. Gate on the feature flag. Set `node.Phase = 'defer'`. Constrain the following form to `*` `as` `ModuleExportName` `from ...` or `{ ... }` `from ...`. Default else-branch: `node.Phase = 'evaluation'`. |
| `src/parser/ParseNode.mts` (`ExportDeclaration_NamedFrom`, ~line 2165) | Add `readonly Phase: 'defer' \| 'evaluation';`. |
| `src/static-semantics/ModuleRequests.mts` (line 92) | Replace hard-coded `Phase: 'evaluation'` with `node.Phase ?? 'evaluation'`. |
| `test/test262/features` | Add `export-defer = export-defer`. |
| `.gitmodules` / submodule pin | Point `test/test262/test262` at a local fork branch that merges PRs 5033/5034/5035 onto upstream `main`. |

**Early errors enforced**

- `export defer * from "m"` — bare star without `as` → SyntaxError.
- `export defer { x }` without `from` — SyntaxError.
- `export defer const x = …` / `var` / `function` / `class` — SyntaxError.
- `export default defer …` / `export defer default …` — SyntaxError.

**Validation criteria**

`bash scripts/test262.sh language/export/export-defer/syntax` passes all 12 cases (6 valid, 5 invalid in module context, 1 in script context). No regression in `npm run test:test262`.

**Out of scope (deferred to phase 2)**

`ExportEntry`, `ExportEntries`, `ExportEntriesForModule`, `ResolveExport`, `LoadRequestedModules`, `module-namespace-exotic-objects.mts`, `Evaluate_ExportDeclaration`. Tests in PR 5034 and 5035 will fail at end of phase 1, as expected.

### Phase 2a — Load-and-evaluation

The deferral takes effect: modules referenced only by deferred re-exports are not loaded unless a non-deferred consumer transitively requires a binding that flows through them.

**Data-model observation.** After phase 1, `ExportEntry.ModuleRequest.Phase` already carries `'defer' | 'evaluation'` correctly, because `ExportEntriesForModule` reuses the `ModuleRequestRecord` returned by `ModuleRequests`. No new field on `ExportEntry`.

**Algorithmic shift.** `LoadRequestedModules` / `InnerModuleLoading` switches from "load every requested module" to "load every required module." Required is defined recursively:

- An `ImportEntry` with `ModuleRequest.Phase === 'evaluation'` is required.
- A non-deferred `ExportEntry` (`export { x } from "m"` without `defer`, `export * from "m"`, `export * as ns from "m"`) is required.
- A deferred `ExportEntry` (`export defer { x } from "m"`, `export defer * as ns from "m"`) is *optional* in isolation, but becomes required if a non-deferred consumer transitively requires the binding it provides. `export *` is non-deferred and propagates required-ness through any deferred re-exports it crosses (per PR 5034 case 6); `default` is excluded from `export *` (case 7).

**New abstract operation**

- `GetOptionalIndirectExportsModuleRequests(module)` — returns the list of `ModuleRequestRecord`s reachable only via deferred re-exports from `module` and not already required.

**Modified abstract operations** (in `src/abstract-ops/module-records.mts`)

- `LoadRequestedModules` / `InnerModuleLoading` — distinguish required vs optional during the recursive load walk; only required requests trigger `HostLoadImportedModule`.
- `ResolveExport` (on `SourceTextModuleRecord`) — when walking a deferred re-export entry under a non-deferred consumer, recurse into the deferred source as if required. The source is already loaded by this point because the load walk saw the same chain.
- `GetExportedNames` — include names of deferred re-exports. They are exported; only their sources' loading/evaluation is conditional.

**Per-module bookkeeping.** `CyclicModuleRecord` gains a way to identify which loaded sources are deferred-only (e.g. a `Set<ModuleRecord>` populated during `InnerModuleLoading`). Phase 2b uses this to find the targets of `EvaluateModuleSync`.

**Async/sync constraint.** engine262's `LoadRequestedModules` is async (it calls `HostLoadImportedModule`), but `ResolveExport` and the namespace `[[Get]]` are synchronous. The required-ness propagation through a non-deferred consumer must therefore complete during the async load walk, not lazily at link time. After loading completes, deferred-only sources are loaded but un-evaluated; whether they are also `linked` at the end of phase 2a or only linked lazily inside `EvaluateModuleSync` is determined by the proposal's spec text and is a phase-2 implementation question (the design accommodates either choice; see phase 2b's `EvaluateModuleSync` description).

**Validation criteria**

All 7 scenarios in PR 5034 (`language/export/export-defer/load-and-evaluation/`) pass. Phase 1 syntax tests still pass. PR 5035 likely still fails — that is phase 2b.

**Out of scope (deferred to phase 2b)**

Evaluating deferred-only sources. They remain un-evaluated until phase 2b's `EvaluateModuleSync` is invoked from `[[Get]]`. Linking of those sources may happen here or in phase 2b — see the async/sync constraint note above.

### Phase 2b — Namespace `[[Get]]` triggered evaluation

The `[[Get]]` trigger is the only hook. Per PR 5035's classification:

- **trigger-on-exported:** key is a string AND in `[[Exports]]` AND its source is a not-yet-evaluated deferred-reexport → run sync eval, then return value.
- **no-trigger-on-exported:** key is exported but the operation isn't `[[Get]]` (`[[HasProperty]]`, `[[GetOwnProperty]]`, `[[OwnPropertyKeys]]`, `[[DefineOwnProperty]]`, `[[Delete]]`, `[[Set]]`, super-property define/set, super-property get on the namespace's prototype) → no trigger.
- **no-trigger:** key is not exported (including `'then'` when not exported, which already returns `undefined` before reaching the trigger).

**New abstract operations** (in `src/abstract-ops/module-records.mts`)

| Op | Purpose |
|---|---|
| `GatherAsynchronousTransitiveDependencies(module, seen)` | Walks the deferred sub-graph reachable from `module` and collects modules to evaluate. |
| `GatherAsynchronousTransitiveDependenciesForRequests(requests, seen)` | Same but starting from a list of `ModuleRequestRecord`s. |
| `ReadyForSyncExecution(modules)` | Returns true iff none of the gathered modules has TLA (`HasTLA === true`). |
| `EvaluateModuleSync(module)` | Top-level entry: gather → validate → if not ready, throw a `SyntaxError`; otherwise link any not-yet-linked deferred sources, then run each module's `ExecuteModule` in dependency order synchronously. |

**`[[Get]]` change.** In `src/abstract-ops/module-namespace-exotic-objects.mts`, after the existing exported-name lookup and before reading the binding: if the resolved binding originates from a deferred re-export entry whose source has not yet been evaluated, call `EvaluateModuleSync(source)`, then proceed. The "originates from a deferred re-export entry" check is computed on demand from the module's `[[ExportEntries]]`; the binding's `ModuleRequest.Phase === 'defer'` is the discriminator.

**TLA interaction.** A deferred sub-graph that contains a module with top-level await cannot be evaluated from `[[Get]]` because `[[Get]]` is synchronous. `ReadyForSyncExecution` returns false → `EvaluateModuleSync` throws a `SyntaxError`. (Exact error type to be confirmed against final spec text during plan execution.)

**Per-module deferred-name lookup.** Computed on demand from `[[ExportEntries]]` on each `[[Get]]` access — `[[Get]]` already walks `[[Exports]]`, so adding a Phase check is constant overhead per access. Cache only if profiling demands it later.

**Validation criteria**

All 24 trigger/no-trigger scenarios in PR 5035 (`language/export/export-defer/evaluation-triggers/`) pass; PRs 5034 and 5033 remain green.

### Phase 3 — Dynamic import sanity check

No new code expected. `import(specifier, { phase: "defer" })` already routes through `GetModuleNamespace(module, 'defer')`, which yields a namespace exotic whose `[[Get]]` was extended in phase 2b. A dynamic-defer import of a re-exporter with `export defer { x } from "C"` should therefore trigger sync eval on `ns.x` automatically.

**Deliverables**

- Run `npm run test:test262 -- --features=export-defer,import-defer`. Expect green.
- One composition test: `import defer * as ns from "reexporter"` where `reexporter` contains `export defer { x } from "C"`. Reading `ns.x` evaluates C exactly once. If covered upstream, no in-repo test; otherwise a one-off in `test/engine262/module.test.mts`.

If a gap surfaces, fix in place and add a regression test. Otherwise phase 3 is a no-op PR.

## Testing strategy

- Submodule `test/test262/test262` is pinned to a local fork branch: upstream `tc39/test262 main` plus cherry-picked PRs 5033, 5034, 5035.
- `test/test262/features` carries `export-defer = export-defer`.
- Inner loop per phase: `bash scripts/test262.sh language/export/export-defer/<area>`.
- Full loop: `npm run test:test262 -- --features=export-defer`.
- When upstream merges any of the three PRs, bump the submodule pin; no migration work.
- Hand-ported in-repo tests (`test/engine262/*.test.mts`) are *not* added speculatively. The repo's precedent for module-defer features (set by import-defer #295, #342) is to lean entirely on test262. One-off in-repo tests are added only when a gap appears.

## Error handling summary

| Scenario | Outcome | Where |
|---|---|---|
| Bare `export defer * from "m"` | SyntaxError at parse | Phase 1 parser |
| `export defer` not followed by re-export form | SyntaxError at parse | Phase 1 parser |
| `export defer` with feature flag off | `defer` treated as identifier (existing path) | Phase 1 parser gate |
| TLA in deferred sub-graph triggered via `[[Get]]` | SyntaxError thrown by `EvaluateModuleSync` | Phase 2b |
| Cycle through a deferred re-export | Handled by existing `ResolveExport`/`Link` cycle detection | Phase 2a/2b |

## Risks

- **Spec instability.** Proposal is pre-Stage-3; spec text and tests can change. *Mitigation:* feature flag, submodule pin, small phases.
- **test262 PR rebases.** *Mitigation:* fork branch is automated to re-cherry-pick on upstream `main` updates.
- **Composition with existing import-defer.** `import defer * as ns from "reexporter"` over a deferred re-exporter is a new combination not exercised by existing import-defer tests. *Mitigation:* explicit verification in phase 3.
- **Async/sync split in load propagation.** Required-ness must propagate during the async load walk, not lazily at link time. *Mitigation:* called out as a phase 2a constraint; verified by PR 5034 cases 4 and 5.

## Implementation order summary

1. Phase 1 — syntax + feature flag + ModuleRequests plumbing. PR 5033 green.
2. Phase 2a — load-and-evaluation propagation + `GetOptionalIndirectExportsModuleRequests`. PR 5034 green.
3. Phase 2b — namespace `[[Get]]` trigger + `EvaluateModuleSync` and friends. PR 5035 green.
4. Phase 3 — dynamic import composition check. Verification only; no-op PR if nothing surfaces.
