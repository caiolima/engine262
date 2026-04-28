import {
  surroundingAgent, HostLoadImportedModule, HostPromiseRejectionTracker,
} from '../host-defined/engine.mts';
import { IncrementModuleAsyncEvaluationCount } from '../execution-context/Agent.mts';
import {
  CyclicModuleRecord,
  SyntheticModuleRecord,
  ResolvedBindingRecord,
  AbstractModuleRecord,
  type ModuleRecordHostDefined,
  ModuleRecord,
} from '../modules.mts';
import {
  ObjectValue, Value,
} from '../value.mts';
import {
  Q, X, NormalCompletion, ThrowCompletion, AbruptCompletion,
  type PlainCompletion,
  EnsureCompletion,
} from '../completion.mjs';
import {
  Assert,
  ModuleNamespaceCreate,
  NewPromiseCapability,
  PerformPromiseThen,
  CreateBuiltinFunction,
  Call,
  ContinueDynamicImport,
  PromiseCapabilityRecord,
} from './all.mts';
import {
  Realm,
  HostGetSupportedImportAttributes,
  ModuleRequestsEqual,
  ReadyForSyncExecution,
  type Arguments, type ImportAttributeRecord, type ImportedNamesValue, type ModuleRequestRecord, type PlainEvaluator, type ScriptRecord, type SourceTextModuleRecord,
  Throw,
  JSStringValue,
} from '#self';

const DEFAULT_NAME = Value('default');

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
    return listIncludesString(b as readonly JSStringValue[], DEFAULT_NAME) ? 'all' : 'all-but-default';
  }
  if (isAllButDefault(b)) {
    return listIncludesString(a as readonly JSStringValue[], DEFAULT_NAME) ? 'all' : 'all-but-default';
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
    if (isAllButDefault(b)) {
      return [DEFAULT_NAME];
    }
    // a = all, b = list. The result is "all minus a finite set"; the spec keeps
    // this opaque. We return 'all' — downstream filters re-evaluate against
    // actual [[Exports]].
    return 'all';
  }
  if (isAllButDefault(a)) {
    if (isAllButDefault(b)) {
      return [];
    }
    // a = all-but-default, b = list. Subtract list; keep as 'all-but-default'.
    // Downstream filters re-evaluate against actual [[Exports]].
    return 'all-but-default';
  }
  const aList = a as readonly JSStringValue[];
  const result: JSStringValue[] = [];
  for (const name of aList) {
    if (isAllButDefault(b)) {
      // 'all-but-default' contains every name except "default"; the difference
      // is the intersection of `a` with {"default"}.
      if (jsStringEquals(name, DEFAULT_NAME)) {
        result.push(name);
      }
    } else if (!listIncludesString(b as readonly JSStringValue[], name)) {
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

/** https://tc39.es/ecma262/#graphloadingstate-record */
export class GraphLoadingState {
  readonly PromiseCapability: PromiseCapabilityRecord;

  readonly HostDefined?: ModuleRecordHostDefined;

  IsLoading = true;

  readonly Visited = new Set<CyclicModuleRecord>();

  PendingModules = 1;

  readonly PreviouslyImportedNames: PreviouslyImportedNamesEntry[];

  constructor({ PromiseCapability, HostDefined, PreviouslyImportedNames = [] }: Pick<GraphLoadingState, 'PromiseCapability' | 'HostDefined'> & { PreviouslyImportedNames?: PreviouslyImportedNamesEntry[] }) {
    this.PromiseCapability = PromiseCapability;
    this.HostDefined = HostDefined;
    this.PreviouslyImportedNames = PreviouslyImportedNames;
  }
}

/** https://tc39.es/proposal-deferred-reexports/#sec-InnerModuleLoading */
export function InnerModuleLoading(state: GraphLoadingState, module: AbstractModuleRecord, importedNames: ImportedNamesValue = 'all') {
  // 1. Assert: state.[[IsLoading]] is true.
  Assert(Boolean(state.IsLoading === true));

  // 2. If module is a Cyclic Module Record, module.[[Status]] is new, and state.[[Visited]] does not contain module, then
  if (module instanceof CyclicModuleRecord && module.Status === 'new' && !state.Visited.has(module)) {
    // a. Append module to state.[[Visited]].
    state.Visited.add(module);

    // Ensure module has an entry in PreviouslyImportedNames.
    if (!state.PreviouslyImportedNames.some((p) => p.Module === module)) {
      state.PreviouslyImportedNames.push({ Module: module, ImportedNames: [] });
    }

    // Compute optional indirect requests for the deferred re-exports the
    // current consumer's importedNames touches.
    const optionalIndirectRequests = GetNewOptionalIndirectExportsModuleRequests(module, importedNames, state.PreviouslyImportedNames);
    const requestsToLoad: readonly ModuleRequestRecord[] = [...module.RequestedModules, ...optionalIndirectRequests];

    state.PendingModules += requestsToLoad.length;

    for (const request of requestsToLoad) {
      const invalidAttributeKey = AllImportAttributesSupported(request.Attributes);
      if (invalidAttributeKey) {
        const error = Throw.SyntaxError('Unsupported import attribute $1', invalidAttributeKey);
        ContinueModuleLoading(state, error);
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

/** https://tc39.es/ecma262/#sec-ContinueModuleLoading */
export function ContinueModuleLoading(state: GraphLoadingState, result: PlainCompletion<AbstractModuleRecord>, request?: ModuleRequestRecord) {
  if (state.IsLoading === false) {
    return;
  }
  result = EnsureCompletion(result);
  if (result instanceof NormalCompletion) {
    InnerModuleLoading(state, result.Value, request?.ImportedNames ?? 'all');
  } else {
    state.IsLoading = false;
    X(Call(state.PromiseCapability.Reject, Value.undefined, [result.Value]));
  }
}

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

/** https://tc39.es/proposal-deferred-reexports/#sec-InnerModuleLinking */
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
  const moduleIndex = index;
  module.DFSAncestorIndex = index;
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
  Q((module as SourceTextModuleRecord).InitializeEnvironment());
  Assert(stack.indexOf(module) === stack.lastIndexOf(module));
  Assert(module.DFSAncestorIndex <= moduleIndex);
  if (module.DFSAncestorIndex === moduleIndex) {
    let done = false;
    while (done === false) {
      const requiredModule = stack.pop();
      Assert(requiredModule instanceof CyclicModuleRecord);
      requiredModule.Status = 'linked';
      if (requiredModule === module) {
        done = true;
      }
    }
  }
  return index;
}

/** https://tc39.es/ecma262/#sec-EvaluateModuleSync */
export function* EvaluateModuleSync(module: ModuleRecord): PlainEvaluator<undefined> {
  // 1. Assert: If module is a Cyclic Module Record, ReadyForSyncExecution(module) is true.
  Assert(module instanceof CyclicModuleRecord ? ReadyForSyncExecution(module) === Value.true : true);
  if (!(module instanceof CyclicModuleRecord && module.Status === 'evaluated')) {
    Q(surroundingAgent.debugger_cannotPreview);
  }
  // 2. Let promise be module.Evaluate()./
  const promise = yield* module.Evaluate();
  // 3. Assert: promise.[[PromiseState]] is either fulfilled or rejected.
  Assert(promise.PromiseState === 'fulfilled' || promise.PromiseState === 'rejected');
  // 4. If promise.[[PromiseState]] is rejected, then
  if (promise.PromiseState === 'rejected') {
    // a. If promise.[[PromiseIsHandled]] is false, perform HostPromiseRejectionTracker(promise, "handle").
    if (promise.PromiseIsHandled === Value.false) {
      HostPromiseRejectionTracker(promise, 'handle');
    }
    // b. Set promise.[[PromiseIsHandled]] to true.
    promise.PromiseIsHandled = Value.true;
    // c. Throw promise.[[PromiseResult]].
    Throw(promise.PromiseResult!);
  }
  // 5. Return unused.
  return undefined;
}

/** https://tc39.es/ecma262/#sec-innermoduleevaluation */
export function* InnerModuleEvaluation(module: AbstractModuleRecord, stack: CyclicModuleRecord[], index: number): PlainEvaluator<number> {
  if (!(module instanceof CyclicModuleRecord)) {
    Q(yield* EvaluateModuleSync(module));
    return NormalCompletion(index);
  }
  if (module.Status === 'evaluating-async' || module.Status === 'evaluated') {
    if (module.EvaluationError === undefined) {
      return NormalCompletion(index);
    } else {
      return module.EvaluationError;
    }
  }
  if (module.Status === 'evaluating') {
    return NormalCompletion(index);
  }
  Assert(module.Status === 'linked');
  module.Status = 'evaluating';
  const moduleIndex = index;
  module.DFSAncestorIndex = index;
  module.PendingAsyncDependencies = 0;
  module.AsyncParentModules = [];
  index += 1;
  const evaluationList: ModuleRecord[] = [];
  for (const request of module.RequestedModules) {
    const requiredModule = GetImportedModule(module, request);
    if (request.Phase === 'defer') {
      const additionalModules = GatherAsynchronousTransitiveDependencies(requiredModule);
      for (const additionalModule of additionalModules) {
        if (!evaluationList.includes(additionalModule)) {
          evaluationList.push(additionalModule);
        }
      }
    } else if (!evaluationList.includes(requiredModule)) {
      evaluationList.push(requiredModule);
    }
  }
  stack.push(module);
  for (const required of evaluationList!) {
    let requiredModule: ModuleRecord | CyclicModuleRecord = required as ModuleRecord;
    index = Q(yield* InnerModuleEvaluation(requiredModule, stack, index));
    if (requiredModule instanceof CyclicModuleRecord) {
      Assert(requiredModule.Status === 'evaluating' || requiredModule.Status === 'evaluating-async' || requiredModule.Status === 'evaluated');
      Assert((requiredModule.Status === 'evaluating') === stack.includes(requiredModule));
      if (requiredModule.Status === 'evaluating') {
        module.DFSAncestorIndex = Math.min(module.DFSAncestorIndex, requiredModule.DFSAncestorIndex!);
      } else {
        requiredModule = requiredModule.CycleRoot!;
        Assert((requiredModule as CyclicModuleRecord).Status === 'evaluating-async' || (requiredModule as CyclicModuleRecord).Status === 'evaluated');
        if ((requiredModule as CyclicModuleRecord).EvaluationError !== undefined) {
          return EnsureCompletion((requiredModule as CyclicModuleRecord).EvaluationError);
        }
      }
      if (typeof (requiredModule as CyclicModuleRecord).AsyncEvaluationOrder === 'number') {
        module.PendingAsyncDependencies += 1;
        (requiredModule as CyclicModuleRecord).AsyncParentModules.push(module);
      }
    }
  }
  if (module.PendingAsyncDependencies > 0 || module.HasTLA === Value.true) {
    Assert(module.AsyncEvaluationOrder === 'unset');
    module.AsyncEvaluationOrder = IncrementModuleAsyncEvaluationCount();
    if (module.PendingAsyncDependencies === 0) {
      X(yield* ExecuteAsyncModule(module));
    }
  } else {
    Q(yield* module.ExecuteModule());
  }
  Assert(stack.indexOf(module) === stack.lastIndexOf(module));
  Assert(module.DFSAncestorIndex <= moduleIndex);
  if (module.DFSAncestorIndex === moduleIndex) {
    let done = false;
    while (done === false) {
      const requiredModule = stack.pop();
      Assert(requiredModule instanceof CyclicModuleRecord);
      Assert(typeof requiredModule.AsyncEvaluationOrder === 'number' || requiredModule.AsyncEvaluationOrder === 'unset');
      if (requiredModule.AsyncEvaluationOrder === 'unset') {
        requiredModule.Status = 'evaluated';
      } else {
        requiredModule.Status = 'evaluating-async';
      }
      if (requiredModule === module) {
        done = true;
      }
      requiredModule.CycleRoot = module;
    }
  }
  return index;
}

/** https://tc39.es/proposal-defer-import-eval/#sec-GatherAsynchronousTransitiveDependencies  */
export function GatherAsynchronousTransitiveDependencies(module: ModuleRecord, seen?: Set<ModuleRecord>): ModuleRecord[] {
  // 1. If seen is not present, set seen to a new empty List.
  seen ??= new Set();
  // 2. Let result be a new empty List.
  const result: ModuleRecord[] = [];
  // 3. If seen contains module, return result.
  if (seen.has(module)) {
    return result;
  }
  // 4. Append module to seen.
  seen.add(module);
  // 5. If module is not a Cyclic Module Record, return result.
  if (!(module instanceof CyclicModuleRecord)) {
    return result;
  }
  // 6. If module.[[Status]] is either evaluating or evaluated, return result.
  if (module.Status === 'evaluating' || module.Status === 'evaluated') {
    return result;
  }
  // 7. If module.[[HasTLA]] is true, then
  if (module.HasTLA === Value.true) {
    // a. Append module to result.
    result.push(module);
    // b. Return result.
    return result;
  }
  // 8. For each ModuleRequest Record request of module.[[RequestedModules]], do
  for (const request of module.RequestedModules) {
    // a. Let requiredModule be GetImportedModule(module, request).
    const requiredModule = GetImportedModule(module, request);
    // b. Let additionalModules be GatherAsynchronousTransitiveDependencies(requiredModule, seen).
    const additionalModules = GatherAsynchronousTransitiveDependencies(requiredModule, seen);
    // c. For each Module Record m of additionalModules, do
    for (const m of additionalModules) {
      // i. If result does not contain m, append m to result.
      if (!result.includes(m)) {
        result.push(m);
      }
    }
  }
  // 9. Return result.
  return result;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-buildevaluationlist */
export function BuildEvaluationList(
  evaluationList: ModuleRecord[],
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
      if (importedNames === 'all') {
        // import * over a deferred re-exporter: only asynchronous transitive
        // deps of `export defer` sources evaluate here. Synchronous deps are
        // deferred to module-namespace [[Get]] (phase 2b).
        const allOptionalIndirectRequests = requiredModule.GetOptionalIndirectExportsModuleRequests(importedNames);
        ListAppendUnique(evaluationList, GatherAsynchronousTransitiveDependenciesForRequests(requiredModule, allOptionalIndirectRequests, new Set()));
      } else {
        const optionalIndirectRequests = requiredModule.GetOptionalIndirectExportsModuleRequests(importedNames);
        BuildEvaluationList(evaluationList, requiredModule, optionalIndirectRequests);
      }
    }
  }
}

/** https://tc39.es/proposal-deferred-reexports/#sec-gatherasynchronoustransitivedependenciesforrequests */
export function GatherAsynchronousTransitiveDependenciesForRequests(
  referrer: CyclicModuleRecord,
  requests: readonly ModuleRequestRecord[],
  seen: Set<ModuleRecord> = new Set(),
): ModuleRecord[] {
  const result: ModuleRecord[] = [];
  for (const request of requests) {
    const dep = GetImportedModule(referrer, request);
    ListAppendUnique(result, GatherAsynchronousTransitiveDependencies(dep, seen));
  }
  return result;
}

/** https://tc39.es/ecma262/#sec-execute-async-module */
function* ExecuteAsyncModule(module: CyclicModuleRecord) {
  // 1. Assert: module.[[Status]] is evaluating or evaluating-async.
  Assert(module.Status === 'evaluating' || module.Status === 'evaluating-async');
  // 2. Assert: module.[[HasTLA]] is true.
  Assert(module.HasTLA === Value.true);
  // 3. Let capability be ! NewPromiseCapability(%Promise%).
  const capability = X(NewPromiseCapability(surroundingAgent.intrinsic('%Promise%')));
  // 4. Let fulfilledClosure be a new Abstract Closure with no parameters that captures module and performs the following steps when called:
  function* fulfilledClosure() {
    // a. Perform ! AsyncModuleExecutionFulfilled(module).
    X(yield* AsyncModuleExecutionFulfilled(module));
    // b. Return undefined.
    return Value.undefined;
  }
  // 5. Let onFulfilled be ! CreateBuiltinFunction(fulfilledClosure, 0, "", « »).
  const onFulfilled = CreateBuiltinFunction(fulfilledClosure, 0, Value(''), ['Module']);
  // 6. Let rejectedClosure be a new Abstract Closure with parameters (error) that captures module and performs the following steps when called:
  const rejectedClosure = ([error = Value.undefined]: Arguments) => {
    // a. Perform ! AsyncModuleExecutionRejected(module, error).
    X(AsyncModuleExecutionRejected(module, error));
    // b. Return undefined.
    return Value.undefined;
  };
  // 7. Let onRejected be ! CreateBuiltinFunction(rejectedClosure, 0, "", « »).
  const onRejected = CreateBuiltinFunction(rejectedClosure, 0, Value(''), ['Module']);
  // 8. Perform ! PerformPromiseThen(capability.[[Promise]], onFulfilled, onRejected).
  X(PerformPromiseThen(capability.Promise, onFulfilled, onRejected));
  // 9. Perform ! module.ExecuteModule(capability).
  X(yield* module.ExecuteModule(capability));
  // 10. Return.
  return Value.undefined;
}

/** https://tc39.es/ecma262/#sec-gather-available-ancestors */
function GatherAvailableAncestors(module: CyclicModuleRecord, execList: CyclicModuleRecord[]) {
  for (const m of module.AsyncParentModules) {
    if (!execList.includes(m) && m.CycleRoot!.EvaluationError === undefined) {
      Assert(m.Status === 'evaluating-async');
      Assert(m.EvaluationError === undefined);
      Assert(typeof m.AsyncEvaluationOrder === 'number');
      Assert(m.PendingAsyncDependencies! > 0);
      m.PendingAsyncDependencies! -= 1;
      if (m.PendingAsyncDependencies === 0) {
        execList.push(m);
        if (m.HasTLA === Value.false) {
          GatherAvailableAncestors(m, execList);
        }
      }
    }
  }
}

/** https://tc39.es/ecma262/#sec-asyncmodulexecutionfulfilled */
function* AsyncModuleExecutionFulfilled(module: CyclicModuleRecord): PlainEvaluator {
  if (module.Status === 'evaluated') {
    Assert(module.EvaluationError !== undefined);
    return;
  }
  Assert(module.Status === 'evaluating-async');
  Assert(typeof module.AsyncEvaluationOrder === 'number');
  Assert(module.EvaluationError === undefined);
  module.AsyncEvaluationOrder = 'done';
  module.Status = 'evaluated';
  if (module.TopLevelCapability !== undefined) {
    Assert(module.CycleRoot === module);
    X(Call(module.TopLevelCapability.Resolve, Value.undefined, [Value.undefined]));
  }

  const execList: CyclicModuleRecord[] = [];
  GatherAvailableAncestors(module, execList);
  Assert(execList.every((m) => typeof m.AsyncEvaluationOrder === 'number' && m.PendingAsyncDependencies === 0 && m.EvaluationError === undefined));
  const sortedExecList = execList.toSorted((m1, m2) => (m1.AsyncEvaluationOrder as number) - (m2.AsyncEvaluationOrder as number));

  for (const m of sortedExecList) {
    if (m.Status === 'evaluated') {
      Assert(m.EvaluationError !== undefined);
    } else if (m.HasTLA === Value.true) {
      X(yield* ExecuteAsyncModule(m));
    } else {
      const result = yield* m.ExecuteModule();
      if (result instanceof AbruptCompletion) {
        X(AsyncModuleExecutionRejected(m, result.Value));
      } else {
        m.AsyncEvaluationOrder = 'done';
        m.Status = 'evaluated';
        if (m.TopLevelCapability !== undefined) {
          Assert(m.CycleRoot === m);
          X(Call(m.TopLevelCapability.Resolve, Value.undefined, [Value.undefined]));
        }
      }
    }
  }
}

/** https://tc39.es/ecma262/#sec-AsyncModuleExecutionRejected */
function AsyncModuleExecutionRejected(module: CyclicModuleRecord, error: Value) {
  if (module.Status === 'evaluated') {
    Assert(module.EvaluationError !== undefined);
    return;
  }
  Assert(module.Status === 'evaluating-async');
  Assert(typeof module.AsyncEvaluationOrder === 'number');
  Assert(module.EvaluationError === undefined);
  module.EvaluationError = ThrowCompletion(error);
  module.Status = 'evaluated';
  module.AsyncEvaluationOrder = 'done';
  if (module.TopLevelCapability !== undefined) {
    Assert(module.CycleRoot === module);
    X(Call(module.TopLevelCapability.Reject, Value.undefined, [error]));
  }
  for (const m of module.AsyncParentModules) {
    AsyncModuleExecutionRejected(m, error);
  }
}

function getRecordWithSpecifier(loadedModules: CyclicModuleRecord['LoadedModules'], request: ModuleRequestRecord) {
  const records = loadedModules.filter((r) => ModuleRequestsEqual(r, request));
  Assert(records.length <= 1);
  return records.length === 1 ? records[0] : undefined;
}

/** https://tc39.es/ecma262/#sec-GetImportedModule */
export function GetImportedModule(referrer: CyclicModuleRecord, request: ModuleRequestRecord) {
  const record = getRecordWithSpecifier(referrer.LoadedModules, request);
  Assert(record !== undefined);
  return record.Module;
}

/** https://tc39.es/ecma262/#sec-FinishLoadingImportedModule */
export function FinishLoadingImportedModule(referrer: ScriptRecord | CyclicModuleRecord | Realm, moduleRequest: ModuleRequestRecord, result: PlainCompletion<AbstractModuleRecord>, state: GraphLoadingState | PromiseCapabilityRecord) {
  result = EnsureCompletion(result);
  // 1. If result is a normal completion, then
  if (result.Type === 'normal') {
    // a. If referrer.[[LoadedModules]] contains a LoadedModuleRequest Record record such that ModuleRequestsEqual(record, moduleRequest) is true, then
    const record = getRecordWithSpecifier(referrer.LoadedModules, moduleRequest);
    if (record !== undefined) {
      // i. Assert: That Record's [[Module]] is result.[[Value]].
      Assert(record.Module === result.Value);
    } else { // b. Else,
      //  i. Append the LoadedModuleRequest Record { [[Specifier]]: moduleRequest.[[Specifier]], [[Attributes]]: moduleRequest.[[Attributes]], [[Module]]: result.[[Value]] } to referrer.[[LoadedModules]].
      referrer.LoadedModules.push({ Specifier: moduleRequest.Specifier, Attributes: moduleRequest.Attributes, Module: result.Value });
    }
  }

  // 2. If payload is a GraphLoadingState Record, then
  if (state instanceof GraphLoadingState) {
    // a. Perform ContinueModuleLoading(payload, result).
    ContinueModuleLoading(state, result, moduleRequest);
    // 3. Else,
  } else {
    // a. Perform ContinueDynamicImport(payload, result).
    ContinueDynamicImport(state, result, moduleRequest.Phase);
  }

  // 4. Return unused.
}

/** https://tc39.es/ecma262/#sec-AllImportAttributesSupported */
export function AllImportAttributesSupported(attributes: readonly ImportAttributeRecord[]) {
  // Note: This function is meant to return a boolean. Instead, we return:
  // - instead of *false*, the key of the unsupported attribute
  // - instead of *true*, undefined

  const supported: readonly string[] = HostGetSupportedImportAttributes();
  for (const attribute of attributes) {
    if (!supported.includes(attribute.Key.stringValue())) {
      return attribute.Key;
    }
  }
  return undefined;
}

/** https://tc39.es/ecma262/#sec-getmodulenamespace */
export function GetModuleNamespace(
  module: AbstractModuleRecord,
  phase: 'defer' | 'evaluation',
): ObjectValue {
  // 1. Assert: If module is a Cyclic Module Record, then module.[[Status]] is not new or unlinked.
  if (module instanceof CyclicModuleRecord) {
    Assert(module.Status !== 'new' && module.Status !== 'unlinked');
  }
  // 2. Let namespace be module.[[Namespace]].
  let namespace = phase === 'defer' ? module.DeferredNamespace : module.Namespace;
  // 3. If namespace is empty, then
  if (namespace === undefined) {
    // a. Let exportedNames be module.GetExportedNames().
    const exportedNames = module.GetExportedNames();
    // b. Let unambiguousNames be a new empty List.
    const unambiguousNames = [];
    // c. For each element name of exportedNames, do
    for (const name of exportedNames) {
      if (phase !== 'defer' || name.stringValue() !== 'then') {
        // i. Let resolution be module.ResolveExport(name).
        const resolution = module.ResolveExport(name);
        // ii. If resolution is a ResolvedBinding Record, append name to unambiguousNames.
        if (resolution instanceof ResolvedBindingRecord) {
          unambiguousNames.push(name);
        }
      }
    }
    // d. Set namespace to ModuleNamespaceCreate(module, unambiguousNames).
    namespace = ModuleNamespaceCreate(module, unambiguousNames, phase);
  }
  // 4. Return namespace.
  return namespace;
}

/** https://tc39.es/ecma262/#sec-create-default-export-synthetic-module */
export function CreateDefaultExportSyntheticModule(defaultExport: Value) {
  // 1. Let closure be the a Abstract Closure with parameters (module) that captures defaultExport and performs the following steps when called:
  const closure = function* closure(module: SyntheticModuleRecord): PlainEvaluator {
    // a. Return module.SetSyntheticExport("default", defaultExport).
    Q(yield* module.SetSyntheticExport(Value('default'), defaultExport));
    return NormalCompletion(undefined);
  };
  return new SyntheticModuleRecord({
    Realm: surroundingAgent.currentRealmRecord,
    Environment: undefined,
    Namespace: undefined,
    HostDefined: undefined,
    ExportNames: [Value('default')],
    EvaluationSteps: closure,
  });
}

/** https://tc39.es/proposal-import-text/#sec-create-text-module */
export function CreateTextModule(source: JSStringValue) {
  return CreateDefaultExportSyntheticModule(source);
}
