# `export defer` — Phase 1 Implementation Plan (syntax + ModuleRequests plumbing)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement parser, early errors, and ModuleRequest-record plumbing for the `export defer` re-export syntax from the [Deferred Re-exports proposal](https://github.com/tc39/proposal-deferred-reexports), behind a `deferred-reexports` feature flag. Behavior-preserving: deferred sources still load and evaluate eagerly; only the syntax surface and the static-semantics data model change.

**Architecture:** Reuse the existing `ModuleRequestRecord.Phase: 'defer' | 'evaluation'` machinery introduced for import-defer. Add a `Phase` field to the `ExportDeclaration_NamedFrom` ParseNode variant. Recognize a `defer` contextual keyword between `export` and the `*`/`{` re-export forms in `parseExportDeclaration`, gated on a new `deferred-reexports` feature flag. Update `ModuleRequests` to honor `node.Phase` for `ExportDeclaration` nodes. Validate against test262 PRs 5033/5034/5035, applied locally on top of the test262 submodule.

**Tech Stack:** TypeScript (`.mts`), Rollup, Babel, Vitest, test262 conformance suite. Source code in `src/`, build outputs in `lib/`. Tests run via the test262 submodule at `test/test262/test262`.

**Spec reference:** `docs/superpowers/specs/2026-04-27-export-defer-design.md` (commit `c077e8c9`, branch `experimental-export-defer`).

**Out of scope (deferred to Phase 2a/2b/3 plans):** any change to `ExportEntries`, `ExportEntriesForModule`, `ResolveExport`, `LoadRequestedModules`, module-namespace `[[Get]]`, or new abstract operations like `EvaluateModuleSync`. PRs 5034 and 5035 will fail at the end of this plan, as expected.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `src/host-defined/engine.mts` | modify | Register the new `deferred-reexports` feature flag in the `FEATURES` array. |
| `src/parser/ParseNode.mts` | modify | Add `Phase: 'defer' \| 'evaluation'` to the `ExportDeclaration_NamedFrom` interface. |
| `src/static-semantics/ModuleRequests.mts` | modify | Read `node.Phase` from `ExportDeclaration` instead of hard-coding `'evaluation'`. |
| `src/parser/ModuleParser.mts` | modify | Recognize `defer` modifier in `parseExportDeclaration`; enforce early errors for invalid forms. |
| `test/test262/features` | modify | Map test262's `deferred-reexports` feature name to engine262's `deferred-reexports` flag. |
| `test/test262/test262` (submodule) | modify (pointer) | Pin to a local branch with PRs 5033/5034/5035 cherry-picked on upstream `main`. |

---

## Task 1: Set up test262 branch with PRs 5033/5034/5035

The test262 submodule (`test/test262/test262`) needs to point at a branch that includes the three test PRs, since they are not yet merged upstream. We'll create a local branch off `origin/main` with the PRs fetched as refs and merged in.

**Files:**
- Modify: `test/test262/test262` (submodule pointer; tracked in the parent repo's index)

- [ ] **Step 1: Save current state of submodule**

```bash
cd test/test262/test262 && git rev-parse HEAD
```

Record the SHA for rollback purposes.

- [ ] **Step 2: Fetch the three PRs as refs**

```bash
cd test/test262/test262
git fetch origin pull/5033/head:pr-5033
git fetch origin pull/5034/head:pr-5034
git fetch origin pull/5035/head:pr-5035
```

Expected: each command prints "* [new ref] refs/pull/N/head -> pr-N".

- [ ] **Step 3: Create a working branch off upstream main**

```bash
cd test/test262/test262
git checkout -b deferred-reexports-tests origin/main
```

Expected: "Switched to a new branch 'deferred-reexports-tests'".

- [ ] **Step 4: Merge the three PRs in number order**

```bash
cd test/test262/test262
git merge --no-ff pr-5033 -m "Merge PR 5033 (export-defer syntax tests)"
git merge --no-ff pr-5034 -m "Merge PR 5034 (export-defer load-and-evaluation tests)"
git merge --no-ff pr-5035 -m "Merge PR 5035 (export-defer namespace-ops tests)"
```

If a merge produces conflicts: prefer the PR's version for files under `test/language/export/export-defer/` and `src/export-defer/`; for `features.txt`, ensure the `deferred-reexports` line ends up present once. Resolve, `git add`, `git commit`.

- [ ] **Step 5: Verify the export-defer test directory exists**

```bash
ls test/test262/test262/test/language/export/export-defer
```

Expected output (subset): `evaluation-triggers/`, `load-and-evaluation/`, `syntax/`. (Exact directory names may vary if PRs reorganize them; what matters is that an `export-defer/` directory exists with `.js` files in it.)

- [ ] **Step 6: Stage the submodule pointer change in the parent repo**

```bash
cd /Users/caiolima/dev/engine262
git add test/test262/test262
git status
```

Expected: `modified: test/test262/test262 (new commits)` in `Changes to be committed`.

- [ ] **Step 7: Commit the submodule pointer**

```bash
git commit -m "test: pin test262 to deferred-reexports-tests branch (PRs 5033/5034/5035)"
```

---

## Task 2: Wire test262 feature mapping

Tests in PRs 5033/5034/5035 declare `features: [deferred-reexports]` in their YAML frontmatter. The engine262 test262 runner reads `test/test262/features` to map test262 feature names to engine262 flag names. We add the mapping so tests automatically enable our flag.

**Files:**
- Modify: `test/test262/features`

- [ ] **Step 1: Read the current file**

```bash
cat test/test262/features
```

Expected: a header comment plus existing mappings (`decorators = decorators`, `Temporal = temporal`).

- [ ] **Step 2: Add the new mapping**

Add a line after `Temporal = temporal`:

```
deferred-reexports = deferred-reexports
```

Final relevant region of the file should read:

```
decorators = decorators
Temporal = temporal
deferred-reexports = deferred-reexports

# To be implemented
-arraybuffer-transfer
```

- [ ] **Step 3: Commit**

```bash
git add test/test262/features
git commit -m "test262: map deferred-reexports feature to engine262 flag"
```

---

## Task 3: Build engine and confirm syntax tests currently fail

Before any source change, run a slice of the export-defer syntax suite against the unmodified engine to confirm it fails. This establishes the baseline.

**Files:** none

- [ ] **Step 1: Build the engine**

```bash
npm run build
```

Expected: completes without error. (Build outputs land in `lib/engine262.js`, `lib/engine262.mjs`, etc.)

- [ ] **Step 2: Run the export-defer syntax tests**

```bash
bash scripts/test262.sh language/export/export-defer/syntax
```

Expected: every test fails because the parser rejects `export defer ...`. The script prints failures and exits with non-zero status. Note this exit code and the count of failed tests for comparison after Task 8.

- [ ] **Step 3: (No commit — this step is informational only.)**

---

## Task 4: Add the `deferred-reexports` feature flag

Register the feature in the engine's `FEATURES` array. After this change, `surroundingAgent.feature('deferred-reexports')` returns `true` when the flag is enabled.

**Files:**
- Modify: `src/host-defined/engine.mts:46-92`

- [ ] **Step 1: Open `src/host-defined/engine.mts` and locate the `FEATURES` array**

The array starts around line 46. Existing entries look like:

```typescript
export const FEATURES = ([
  // stage 3, but too big
  {
    name: 'Decorators',
    flag: 'decorators',
    url: 'https://github.com/tc39/proposal-decorators',
    enableInPlayground: true,
  },
  // ...
  {
    name: 'RegExp Buffer Boundaries',
    flag: 'regexp-buffer-boundaries',
    url: 'https://github.com/tc39/proposal-regexp-buffer-boundaries',
    enableInPlayground: true,
  },
]) as const satisfies Engine262Feature[];
```

- [ ] **Step 2: Add a new entry for deferred-reexports**

Insert this entry as a new element in the array, immediately after the last existing entry (`'RegExp Buffer Boundaries'`) and before the closing `])`:

```typescript
  {
    name: 'Deferred Re-exports',
    flag: 'deferred-reexports',
    url: 'https://github.com/tc39/proposal-deferred-reexports',
    enableInPlayground: true,
  },
```

- [ ] **Step 3: Build to verify type-correctness**

```bash
npm run build:dts
```

Expected: completes without error. (TypeScript verifies the entry shape against `Engine262Feature`. The `Feature` union type is now widened to include `'deferred-reexports'`.)

- [ ] **Step 4: Commit**

```bash
git add src/host-defined/engine.mts
git commit -m "feat(engine): add deferred-reexports feature flag"
```

---

## Task 5: Add `Phase` field to `ExportDeclaration_NamedFrom` ParseNode interface

Type-only change. The interface `ExportDeclaration_NamedFrom` represents `export ExportFromClause FromClause WithClause? ;`. After this change, parser code can assign `node.Phase = 'defer'` or `node.Phase = 'evaluation'` for re-export forms.

**Files:**
- Modify: `src/parser/ParseNode.mts:2165-2179`

- [ ] **Step 1: Locate the interface**

In `src/parser/ParseNode.mts`, the interface starts around line 2165:

```typescript
  //   `export` ExportFromClause FromClause WithClause?;
  export interface ExportDeclaration_NamedFrom extends BaseParseNode {
    readonly type: 'ExportDeclaration';
    readonly ExportFromClause: ExportFromClauseLike;
    readonly FromClause: FromClause;
    readonly WithClause: undefined | WithClause;

    readonly AssignmentExpression?: undefined;
    readonly ClassDeclaration?: undefined;
    readonly Declaration?: null;
    readonly Decorators?: null;
    readonly default?: boolean;
    readonly HoistableDeclaration?: undefined;
    readonly NamedExports?: undefined;
    readonly VariableStatement?: undefined;
  }
```

- [ ] **Step 2: Add the `Phase` field**

Insert `readonly Phase: 'defer' | 'evaluation';` immediately after `readonly WithClause: undefined | WithClause;`. The interface should now read:

```typescript
  //   `export` ExportFromClause FromClause WithClause?;
  export interface ExportDeclaration_NamedFrom extends BaseParseNode {
    readonly type: 'ExportDeclaration';
    readonly ExportFromClause: ExportFromClauseLike;
    readonly FromClause: FromClause;
    readonly WithClause: undefined | WithClause;
    readonly Phase: 'defer' | 'evaluation';

    readonly AssignmentExpression?: undefined;
    readonly ClassDeclaration?: undefined;
    readonly Declaration?: null;
    readonly Decorators?: null;
    readonly default?: boolean;
    readonly HoistableDeclaration?: undefined;
    readonly NamedExports?: undefined;
    readonly VariableStatement?: undefined;
  }
```

- [ ] **Step 3: Build to verify the change compiles**

```bash
npm run build:dts
```

Expected: completes without error. The build will likely flag missing `Phase` assignments in `ModuleParser.mts` once Task 7 starts modifying it; for now (only this change), no callers reference `Phase` so the build still passes.

- [ ] **Step 4: Commit**

```bash
git add src/parser/ParseNode.mts
git commit -m "parser: add Phase field to ExportDeclaration_NamedFrom"
```

---

## Task 6: Honor `node.Phase` in `ModuleRequests` for `ExportDeclaration`

Today, `ModuleRequests` for `ExportDeclaration` always returns `Phase: 'evaluation'` (line 92). Change it to read `node.Phase` (which is `'defer' | 'evaluation'` once Task 7 lands; for now `node.Phase` will be `undefined` because the parser doesn't yet assign it, so we default to `'evaluation'`).

**Files:**
- Modify: `src/static-semantics/ModuleRequests.mts:88-94`

- [ ] **Step 1: Locate the case**

In `src/static-semantics/ModuleRequests.mts`, lines 88-94 currently read:

```typescript
    case 'ExportDeclaration':
      if (node.FromClause) {
        const specifier = StringValue(node.FromClause);
        const attributes = node.WithClause ? WithClauseToAttributes(node.WithClause) : [];
        return [{ Specifier: specifier, Attributes: attributes, Phase: 'evaluation' }];
      }
      return [];
```

- [ ] **Step 2: Replace `'evaluation'` with `node.Phase ?? 'evaluation'`**

The case should now read:

```typescript
    case 'ExportDeclaration':
      if (node.FromClause) {
        const specifier = StringValue(node.FromClause);
        const attributes = node.WithClause ? WithClauseToAttributes(node.WithClause) : [];
        return [{ Specifier: specifier, Attributes: attributes, Phase: node.Phase ?? 'evaluation' }];
      }
      return [];
```

The `?? 'evaluation'` fallback covers `ExportDeclaration` variants that don't carry a `Phase` field (the type system will narrow `node` to `ExportDeclaration_NamedFrom` once `node.FromClause` is checked, but the `??` is defensive and free).

- [ ] **Step 3: Build to verify**

```bash
npm run build:dts
```

Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
git add src/static-semantics/ModuleRequests.mts
git commit -m "static-semantics: honor node.Phase for ExportDeclaration ModuleRequests"
```

---

## Task 7: Recognize `defer` modifier in `parseExportDeclaration`

The substantive parser change. After `expect(EXPORT)` and `eat(DEFAULT)`, look for the `defer` contextual keyword. If present (and the feature flag is on, and the next token is `*` or `{`), consume it and set a local `isDefer` flag. Inside the LBRACE and MUL branches, set `node.Phase` based on `isDefer`. Enforce the four early-error cases:

1. `export defer * from "m"` (bare star without `as`) → unexpected.
2. `export defer { x }` (no `from`) → unexpected.
3. `export defer` followed by a declaration form (`var`, `let`, `const`, `class`, `function`) → falls through naturally because the `defer` check requires `*` or `{` lookahead.
4. `export default defer ...` and `export defer default ...` → `defer` check requires `!node.default`, so these never match.

**Files:**
- Modify: `src/parser/ModuleParser.mts:1-7` (imports)
- Modify: `src/parser/ModuleParser.mts:143-242` (`parseExportDeclaration`)

- [ ] **Step 1: Add `surroundingAgent` import**

At the top of `src/parser/ModuleParser.mts`, the existing imports are:

```typescript
import { IsStringWellFormedUnicode, StringValue } from '../static-semantics/all.mts';
import type { Mutable } from '../utils/language.mts';
import { Throw } from '../host-defined/error-messages.mts';
import { Token, isKeywordRaw } from './tokens.mts';
import { StatementParser } from './StatementParser.mts';
import { FunctionKind } from './FunctionParser.mts';
import type { ParseNode } from './ParseNode.mts';
```

Add `surroundingAgent` from `../host-defined/engine.mts`:

```typescript
import { IsStringWellFormedUnicode, StringValue } from '../static-semantics/all.mts';
import type { Mutable } from '../utils/language.mts';
import { Throw } from '../host-defined/error-messages.mts';
import { surroundingAgent } from '../host-defined/engine.mts';
import { Token, isKeywordRaw } from './tokens.mts';
import { StatementParser } from './StatementParser.mts';
import { FunctionKind } from './FunctionParser.mts';
import type { ParseNode } from './ParseNode.mts';
```

- [ ] **Step 2: Add the `defer` modifier check after `eat(DEFAULT)`**

In `parseExportDeclaration`, the existing code reads (around line 143):

```typescript
  parseExportDeclaration(decoratorsBeforeExportKeyword: null | readonly ParseNode.Decorator[]): ParseNode.ExportDeclaration {
    const node = this.startNode<ParseNode.ExportDeclaration>();
    node.Decorators = decoratorsBeforeExportKeyword;
    this.expect(Token.EXPORT);
    node.default = this.eat(Token.DEFAULT);
    if (node.default) {
      // ...
    } else {
      switch (this.peek().type) {
        // ...
      }
    }
    return this.finishNode(node, 'ExportDeclaration');
  }
```

After `node.default = this.eat(Token.DEFAULT);` and before `if (node.default) {`, insert:

```typescript
    let isDefer = false;
    if (
      !node.default
      && surroundingAgent.feature('deferred-reexports')
      && this.test('defer')
      && (this.testAhead(Token.MUL) || this.testAhead(Token.LBRACE))
    ) {
      this.next(); // consume `defer`
      isDefer = true;
    }
```

- [ ] **Step 3: Set `node.Phase` in the LBRACE re-export branch**

Inside the `case Token.LBRACE:` branch (~line 194-212), the existing code reads:

```typescript
        case Token.LBRACE: {
          const NamedExports = this.parseNamedExports();
          if (this.test('from')) {
            node.ExportFromClause = NamedExports;
            node.FromClause = this.parseFromClause();
            if (this.test(Token.WITH)) {
              node.WithClause = this.parseWithClause();
            }
          } else {
            NamedExports.ExportsList.forEach((n) => {
              if (n.localName.type === 'StringLiteral') {
                this.addEarlyError(Throw.SyntaxError('Import name cannot be a string'), n.localName);
              }
            });
            node.NamedExports = NamedExports;
            this.scope.checkUndefinedExports(node.NamedExports);
          }
          this.semicolon();
          break;
        }
```

Modify to (1) set `node.Phase` when `from` is present, and (2) reject the no-`from` case when `isDefer`:

```typescript
        case Token.LBRACE: {
          const NamedExports = this.parseNamedExports();
          if (this.test('from')) {
            node.ExportFromClause = NamedExports;
            node.FromClause = this.parseFromClause();
            node.Phase = isDefer ? 'defer' : 'evaluation';
            if (this.test(Token.WITH)) {
              node.WithClause = this.parseWithClause();
            }
          } else {
            if (isDefer) {
              this.unexpected();
            }
            NamedExports.ExportsList.forEach((n) => {
              if (n.localName.type === 'StringLiteral') {
                this.addEarlyError(Throw.SyntaxError('Import name cannot be a string'), n.localName);
              }
            });
            node.NamedExports = NamedExports;
            this.scope.checkUndefinedExports(node.NamedExports);
          }
          this.semicolon();
          break;
        }
```

- [ ] **Step 4: Set `node.Phase` in the MUL re-export branch and reject bare `defer *`**

Inside the `case Token.MUL:` branch (~line 214-228), the existing code reads:

```typescript
        case Token.MUL: {
          const inner = this.startNode<ParseNode.ExportFromClause>();
          this.next();
          if (this.eat('as')) {
            inner.ModuleExportName = this.parseModuleExportName();
            this.scope.declare(inner.ModuleExportName, 'export');
          }
          node.ExportFromClause = this.finishNode(inner, 'ExportFromClause');
          node.FromClause = this.parseFromClause();
          if (this.test(Token.WITH)) {
            node.WithClause = this.parseWithClause();
          }
          this.semicolon();
          break;
        }
```

Modify to (1) reject bare `*` when `isDefer`, and (2) set `node.Phase`:

```typescript
        case Token.MUL: {
          const inner = this.startNode<ParseNode.ExportFromClause>();
          this.next();
          if (this.eat('as')) {
            inner.ModuleExportName = this.parseModuleExportName();
            this.scope.declare(inner.ModuleExportName, 'export');
          } else if (isDefer) {
            this.unexpected();
          }
          node.ExportFromClause = this.finishNode(inner, 'ExportFromClause');
          node.FromClause = this.parseFromClause();
          node.Phase = isDefer ? 'defer' : 'evaluation';
          if (this.test(Token.WITH)) {
            node.WithClause = this.parseWithClause();
          }
          this.semicolon();
          break;
        }
```

- [ ] **Step 5: Build to verify the parser compiles**

```bash
npm run build:dts
```

Expected: completes without error. (TypeScript verifies that `node.Phase = ...` matches the field's type; that `surroundingAgent.feature(...)` accepts `'deferred-reexports'`.)

- [ ] **Step 6: Build the runtime bundle**

```bash
npm run build:engine
```

Expected: completes without warnings or errors.

- [ ] **Step 7: Commit**

```bash
git add src/parser/ModuleParser.mts
git commit -m "parser: recognize export defer re-export forms"
```

---

## Task 8: Run test262 syntax tests and verify they pass

Now that the parser recognizes the new syntax and the static semantics carry the `Phase`, run the export-defer syntax slice and confirm it passes.

**Files:** none

- [ ] **Step 1: Build the engine (full pipeline)**

```bash
npm run build
```

Expected: success.

- [ ] **Step 2: Run the export-defer syntax tests**

```bash
bash scripts/test262.sh language/export/export-defer/syntax
```

Expected: all tests pass; exit code 0.

If any test fails:

- For a `negative.phase: parse` test that expected an error and got none: the parser is too permissive. Inspect the test source, identify which form should error, and add the missing early-error path in `ModuleParser.mts` (Task 7).
- For a positive test that errored: the parser is too strict. Inspect the test, narrow the early-error condition.
- For a runtime failure: it likely depends on Phase 2a behavior; confirm by checking the test's `flags` and `features` fields. If it's not in the syntax/ subdirectory, it's not in scope for this plan.

After fixing, return to Step 2 of this task.

- [ ] **Step 3: (No commit — Task 8 is verification.)**

---

## Task 9: Run full test262 suite and verify no regressions

A small parser change can ripple. Run the full suite to confirm.

**Files:** none

- [ ] **Step 1: Run the full test262 suite**

```bash
npm run test:test262
```

Expected: same number of passing/failing tests as the baseline before Task 1, *plus* the export-defer syntax tests now passing. The runner prints a summary at the end.

If new failures appear (tests that passed before Task 1 but fail now): inspect the failures. Likely culprits:

- The `defer` keyword check in the parser is matching in unintended contexts. The check is gated on `surroundingAgent.feature('deferred-reexports')` being true; if a regression appears in a test that does *not* declare `features: [deferred-reexports]`, the flag should be off and the new code path inactive. If it isn't, audit how the test262 runner decides which features to enable for a given test.
- The new `Phase: 'defer' | 'evaluation'` field on `ExportDeclaration_NamedFrom` is causing type narrowing to behave unexpectedly somewhere downstream. Search for `node.Phase` usages.

Fix and re-run.

- [ ] **Step 2: (No commit — Task 9 is verification.)**

---

## Task 10: Verify everything is committed and the branch is clean

The previous tasks committed each change individually. Confirm the working tree is clean and the branch contains the expected commits.

**Files:** none

- [ ] **Step 1: Check working tree status**

```bash
git status
```

Expected: `nothing to commit, working tree clean`. If anything is uncommitted, stage and commit it with an appropriate message before proceeding.

- [ ] **Step 2: Review the phase-1 commits**

```bash
git log --oneline c077e8c9..HEAD
```

(`c077e8c9` is the spec-doc commit — the tip of `experimental-export-defer` immediately before this plan's work began.)

Expected (6 commits, in order, from oldest to newest reading bottom-to-top in `git log` output):

```
parser: recognize export defer re-export forms
static-semantics: honor node.Phase for ExportDeclaration ModuleRequests
parser: add Phase field to ExportDeclaration_NamedFrom
feat(engine): add deferred-reexports feature flag
test262: map deferred-reexports feature to engine262 flag
test: pin test262 to deferred-reexports-tests branch (PRs 5033/5034/5035)
```

- [ ] **Step 3: (No further action — phase 1 is complete.)**

---

## Self-review notes (for the implementing engineer)

**Spec coverage:**

- Feature flag added (spec §"Feature flag", §"Phase 1 — Files touched"): Task 4.
- Parser recognizes `defer`: Task 7 step 2.
- Early errors (bare `*`, no `from`, declaration forms, default forms): Task 7 steps 3-4 plus the gating `(this.testAhead(MUL) || this.testAhead(LBRACE))` at step 2.
- `Phase` field on `ExportDeclaration_NamedFrom`: Task 5.
- `ModuleRequests` honors `node.Phase`: Task 6.
- test262 features mapping: Task 2.
- Submodule pin: Task 1.
- Validation criterion (`bash scripts/test262.sh language/export/export-defer/syntax` passes): Task 8.
- No-regression criterion (`npm run test:test262`): Task 9.

**No `Evaluate_ExportDeclaration` change.** The runtime semantics for `ExportDeclaration` (in `src/runtime-semantics/ExportDeclaration.mts`) doesn't need to know about `Phase` in phase 1 — it doesn't yet drive the deferral. That work lives in phase 2a's plan (skipping `LoadRequestedModules` for deferred sources).

**Why the parser uses `surroundingAgent.feature(...)` directly instead of `this.feature(...)`.** Both work; the existing parser code uses both styles. `surroundingAgent.feature(...)` matches the `Lexer.mts:546` (`'decorators'`) and `RegExpParser.mts:301` (`'regexp-buffer-boundaries'`) precedents and avoids needing the `feature()` method to be in scope on `ModuleParser`'s `this`.

**Why `node.Phase ?? 'evaluation'` in `ModuleRequests` rather than just `node.Phase`.** TypeScript narrows `node` to `ExportDeclaration_NamedFrom` after the `node.FromClause` check, so `node.Phase` is `'defer' | 'evaluation'` (no `undefined`). The `?? 'evaluation'` is belt-and-braces against future ParseNode variants that might carry a `FromClause` without a `Phase` (none today) and is free at runtime.
