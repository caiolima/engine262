# engine262 — repository guidance

## Spec fidelity is the contract

engine262 is a reference implementation of ECMAScript. Its value is that it
mirrors the spec exactly, so people can read the code as a faithful executable
form of the standard.

**Never change algorithm steps from the spec.** When you implement an abstract
operation, concrete method, or anything documented by an `https://tc39.es/...`
URL in a doc comment:

- Implement every numbered/lettered step verbatim, in the same order.
- Annotate each step in code with a comment that quotes the spec wording (e.g.
  `// 3. Let newImportedNames be ExcludeImportedNames(importedNames, previous.[[ImportedNames]]).`).
- Do not skip steps, reorder them, fold them together, or substitute a
  shortcut, even if the result would be observably equivalent in current
  tests.
- Do not invent extra steps (eager appends, defensive checks, "convenience"
  early-returns) on top of the spec algorithm.

If a deviation seems desirable for performance, ergonomics, or because the
spec text is unclear, the right path is:

1. Open an issue or PR upstream against the relevant proposal/spec.
2. Until that lands, leave the spec-faithful version in place.

The only acceptable local-only adaptations are:

- Translating `« »`/List notation into TypeScript arrays/iterables.
- Translating `[[Field]]` into TS property access.
- Using language-level constructs (`for…of`, `Set`, `Map`) when they are a
  direct, semantically-identical substitution for a spec primitive (e.g.
  using a `Set` as the backing store for "if list contains X" membership
  checks). These adaptations must not change which steps run or in what
  order.

When you find existing code that deviates from the spec, the default action
is to make it spec-faithful and run the test suite. If tests regress, that
is information about the spec, not a license to keep the deviation.
