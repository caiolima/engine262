import { Q, X } from '../completion.mts';
import { AbstractModuleRecord, CyclicModuleRecord, ResolvedBindingRecord } from '../modules.mts';
import type { ImportedNamesValue } from '../static-semantics/ModuleRequests.mts';
import {
  SymbolValue,
  Value,
  Descriptor,
  wellKnownSymbols,
  JSStringValue,
  type ObjectInternalMethods,
  UndefinedValue,
  type PropertyKeyValue,
  ObjectValue,
} from '../value.mts';
import { type Mutable } from '../utils/language.mts';
import { JSStringSet } from '../utils/container.mts';
import {
  Assert,
  CompareArrayElements,
  SameValue,
  MakeBasicObject,
  IsPropertyKey,
  IsAccessorDescriptor,
  SetImmutablePrototype,
  OrdinaryGetOwnProperty,
  OrdinaryDefineOwnProperty,
  OrdinaryHasProperty,
  OrdinaryGet,
  OrdinaryDelete,
  OrdinaryOwnPropertyKeys,
  GetModuleNamespace, R,
  type ExoticObject,
  EvaluateModuleSync,
  ReadyForSyncExecution,
} from './all.mts';
import { Throw } from '#self';

export interface ModuleNamespaceObject extends ExoticObject {
  readonly Module: AbstractModuleRecord;
  readonly Exports: JSStringSet;
  readonly Deferred: boolean;
}

export function isModuleNamespaceObject(V: Value): V is ModuleNamespaceObject {
  return V instanceof ObjectValue && 'Module' in V;
}

const InternalMethods = {
  * GetPrototypeOf() {
    return Value.null;
  },
  * SetPrototypeOf(V) {
    return Q(yield* SetImmutablePrototype(this, V));
  },
  * IsExtensible() {
    return Value.false;
  },
  * PreventExtensions() {
    return Value.true;
  },
  * GetOwnProperty(P) {
    const O = this;

    if (IsSymbolLikeNamespaceKey(P, O)) {
      return OrdinaryGetOwnProperty(O, P);
    }
    const exports = GetModuleExportsList(O);
    if (!exports.has(P as JSStringValue)) {
      return Value.undefined;
    }
    const value = Q(yield* O.Get(P, O));
    return Descriptor({
      Value: value,
      Writable: Value.true,
      Enumerable: Value.true,
      Configurable: Value.false,
    });
  },
  * DefineOwnProperty(P, Desc) {
    const O = this;

    if (IsSymbolLikeNamespaceKey(P, O)) {
      return yield* OrdinaryDefineOwnProperty(O, P, Desc);
    }

    const current = Q(yield* O.GetOwnProperty(P));
    if (current instanceof UndefinedValue) {
      return Value.false;
    }
    if (IsAccessorDescriptor(Desc)) {
      return Value.false;
    }
    if (Desc.Writable !== undefined && Desc.Writable === Value.false) {
      return Value.false;
    }
    if (Desc.Enumerable !== undefined && Desc.Enumerable === Value.false) {
      return Value.false;
    }
    if (Desc.Configurable !== undefined && Desc.Configurable === Value.true) {
      return Value.false;
    }
    if (Desc.Value !== undefined) {
      return SameValue(Desc.Value, current.Value!);
    }
    return Value.true;
  },
  * HasProperty(P) {
    const O = this;

    if (IsSymbolLikeNamespaceKey(P, O)) {
      return yield* OrdinaryHasProperty(O, P);
    }
    const exports = GetModuleExportsList(O);
    if (exports.has(P as JSStringValue)) {
      return Value.true;
    }
    return Value.false;
  },
  /** https://tc39.es/proposal-deferred-reexports/#sec-module-namespace-exotic-objects-get-p-receiver */
  * Get(P, Receiver) {
    const O = this;

    // 1. Assert: IsPropertyKey(P) is true.
    Assert(IsPropertyKey(P));
    if (IsSymbolLikeNamespaceKey(P, O)) {
      return yield* OrdinaryGet(O, P, Receiver);
    }
    const m = O.Module;
    // For deferred namespaces, [[Get]] of any non-symbol-like key forces full
    // evaluation of the module (matching the existing import-defer semantics,
    // relocated from GetModuleExportsList per proposal-deferred-reexports).
    // EvaluateModuleSync re-throws cached evaluation errors for
    // already-evaluated modules — calling it unconditionally preserves that.
    if (m instanceof CyclicModuleRecord && O.Deferred) {
      if (ReadyForSyncExecution(m, 'all') === Value.false) {
        return Throw.TypeError('Module "$1" is not ready for synchronous execution', m.HostDefined?.specifier ?? '<anonymous module>');
      }
      Q(yield* EvaluateModuleSync(m, 'all'));
    }
    // After a deferred-namespace eval the exports list is unchanged; the spec
    // checks exports membership next. For regular namespaces this is the
    // first observation of the cached exports list (no side effects).
    if (!O.Exports.has(P as JSStringValue)) {
      return Value.undefined;
    }
    // For regular namespaces, trigger only when the requested binding flows
    // through a deferred re-export (m.GetOptionalIndirectExportsModuleRequests
    // returns the deferred sub-graph for « P »).
    if (m instanceof CyclicModuleRecord && !O.Deferred) {
      const importedNames: ImportedNamesValue = [P as JSStringValue];
      const optionalRequests = m.GetOptionalIndirectExportsModuleRequests(importedNames);
      if (optionalRequests.length > 0) {
        if (ReadyForSyncExecution(m, importedNames) === Value.false) {
          return Throw.TypeError('Module "$1" is not ready for synchronous execution', m.HostDefined?.specifier ?? '<anonymous module>');
        }
        Q(yield* EvaluateModuleSync(m, importedNames));
      }
    }
    // 6. Let binding be ! m.ResolveExport(P).
    const binding = m.ResolveExport(P as JSStringValue);
    // 7. Assert: binding is a ResolvedBinding Record.
    Assert(binding instanceof ResolvedBindingRecord);
    // 8. Let targetModule be binding.[[Module]].
    const targetModule = binding.Module;
    // 9. Assert: targetModule is not undefined.
    Assert(!(targetModule instanceof UndefinedValue));
    // 10. If binding.[[BindingName]] is ~namespace~, then
    if (binding.BindingName === 'namespace') {
      // a. Return ? GetModuleNamespace(targetModule).
      return Q(GetModuleNamespace(targetModule, 'evaluation'));
    }
    // https://tc39.es/proposal-defer-import-eval/#sec-module-namespace-exotic-objects-get-p-receiver
    if (binding.BindingName === 'deferred-namespace') {
      return Q(GetModuleNamespace(targetModule, 'defer'));
    }
    // 11. Let targetEnv be targetModule.[[Environment]].
    const targetEnv = targetModule.Environment;
    // 12. If targetEnv is undefined, throw a ReferenceError exception.
    if (!targetEnv) {
      return Throw.ReferenceError('$1 is not defined', P);
    }
    // 13. Return ? targetEnv.GetBindingValue(binding.[[BindingName]], true).
    return Q(yield* targetEnv.GetBindingValue(binding.BindingName, Value.true));
  },
  * Set() {
    return Value.false;
  },
  * Delete(P) {
    const O = this;

    Assert(IsPropertyKey(P));
    if (IsSymbolLikeNamespaceKey(P, O)) {
      return Q(yield* OrdinaryDelete(O, P));
    }
    const exports = GetModuleExportsList(O);
    if (exports.has(P as JSStringValue)) {
      return Value.false;
    }
    return Value.true;
  },
  * OwnPropertyKeys() {
    const O = this;

    let exports;
    exports = GetModuleExportsList(O);
    if (O.Deferred && exports.has('then')) {
      exports = [...exports].filter((x) => x.stringValue() !== 'then');
    }

    const symbolKeys = X(OrdinaryOwnPropertyKeys(O));
    return [...exports, ...symbolKeys];
  },
} satisfies Partial<ObjectInternalMethods<ModuleNamespaceObject>>;

/** https://tc39.es/ecma262/#sec-modulenamespacecreate */
export function ModuleNamespaceCreate(
  module: AbstractModuleRecord,
  exports: readonly JSStringValue[],
  phase: 'defer' | 'evaluation',
): ModuleNamespaceObject {
  // 2. Let internalSlotsList be the internal slots listed in Table 31.
  const internalSlotsList = ['Module', 'Exports'];
  // 3. Let M be MakeBasicObject(internalSlotsList).
  const M = MakeBasicObject(internalSlotsList) as Mutable<ModuleNamespaceObject>;
  // 4. Set M's essential internal methods to the definitions specified in 10.4.6.
  /** https://tc39.es/ecma262/#sec-module-namespace-exotic-objects */
  M.GetPrototypeOf = InternalMethods.GetPrototypeOf;
  M.SetPrototypeOf = InternalMethods.SetPrototypeOf;
  M.IsExtensible = InternalMethods.IsExtensible;
  M.PreventExtensions = InternalMethods.PreventExtensions;
  M.GetOwnProperty = InternalMethods.GetOwnProperty;
  M.DefineOwnProperty = InternalMethods.DefineOwnProperty;
  M.HasProperty = InternalMethods.HasProperty;
  M.Get = InternalMethods.Get;
  M.Set = InternalMethods.Set;
  M.Delete = InternalMethods.Delete;
  M.OwnPropertyKeys = InternalMethods.OwnPropertyKeys;
  // 5. Set M.[[Module]] to module.
  M.Module = module;
  // 6. Let sortedExports be a List whose elements are the elements of exports, sorted according to lexicographic code unit order.
  const sortedExports = [...exports].sort((x, y) => {
    const result = X(CompareArrayElements(x, y, Value.undefined));
    return R(result);
  });
  // 7. Set M.[[Exports]] to sortedExports.
  M.Exports = new JSStringSet(sortedExports);
  let toStringTag: JSStringValue;
  // 9. If phase is defer, then
  if (phase === 'defer') {
    // a. Assert: module.[[DeferredNamespace]] is empty.
    Assert(module.DeferredNamespace === undefined);
    // b. Set module.[[DeferredNamespace]] to M.
    (module as Mutable<AbstractModuleRecord>).DeferredNamespace = M;
    // c. Set M.[[Deferred]] to true.
    M.Deferred = true;
    // d. Let toStringTag be "Deferred Module".
    toStringTag = Value('Deferred Module');
  } else { // 10. Else,
    // a. Assert: module.[[Namespace]] is empty.
    Assert(module.Namespace === undefined);
    // b. Set module.[[Namespace]] to M.
    (module as Mutable<AbstractModuleRecord>).Namespace = M;
    // c. Set M.[[Deferred]] to false.
    M.Deferred = false;
    // d. Let toStringTag be "Module".
    toStringTag = Value('Module');
  }
  // 11. Create an own data property of M named %Symbol.toStringTag% whose [[Value]] is toStringTag whose [[Writable]], [[Enumerable]], and [[Configurable]] attributes are false.
  M.properties.set(wellKnownSymbols.toStringTag, Descriptor({
    Writable: Value.false,
    Enumerable: Value.false,
    Configurable: Value.false,
    Value: toStringTag,
  }));
  // 10. Return M.
  return M;
}

/** https://tc39.es/proposal-defer-import-eval/#sec-IsSymbolLikeNamespaceKey */
function IsSymbolLikeNamespaceKey(P: PropertyKeyValue, ns: ModuleNamespaceObject): P is SymbolValue {
  if (P instanceof SymbolValue) {
    return true;
  }
  if (ns.Deferred && P.stringValue() === 'then') {
    return true;
  }
  return false;
}

/** https://tc39.es/proposal-deferred-reexports/#sec-GetModuleExportsList */
function GetModuleExportsList(O: ModuleNamespaceObject): JSStringSet {
  // Per proposal-deferred-reexports: only [[Get]] triggers EvaluateModuleSync.
  // [[GetOwnProperty]], [[HasProperty]], [[OwnPropertyKeys]], [[Delete]] all go
  // through this helper and must observe the cached exports list without side effects.
  return O.Exports;
}
