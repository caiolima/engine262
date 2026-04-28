import type { ParseNode } from '../parser/ParseNode.mts';
import { Value, type JSStringValue } from '../value.mts';
import type { Mutable } from '../utils/language.mts';
import { StringValue } from './all.mts';
import { MergeImportedNames, type LoadedModuleRequestRecord } from '#self';

// https://tc39.es/proposal-deferred-reexports/
export type ImportedNamesValue = 'all' | 'all-but-default' | readonly JSStringValue[];

// https://tc39.es/ecma262/#modulerequest-record
export interface ModuleRequestRecord {
  readonly Specifier: JSStringValue;
  readonly Attributes: ImportAttributeRecord[];
  readonly Phase: 'defer' | 'evaluation';
  readonly ImportedNames: ImportedNamesValue;
}

// https://tc39.es/ecma262/#importattribute-record
export interface ImportAttributeRecord {
  readonly Key: JSStringValue;
  readonly Value: JSStringValue;
}

function stringsEqual(left: JSStringValue, right: JSStringValue) {
  return left === right || left.stringValue() === right.stringValue();
}

// Equality compares Specifier + Attributes only.
// ImportedNames and Phase are intentionally NOT part of equality —
// they are merged/refined by callers, not used to distinguish records.
// https://tc39.es/ecma262/#sec-ModuleRequestsEqual
export function ModuleRequestsEqual(left: ModuleRequestRecord | LoadedModuleRequestRecord, right: ModuleRequestRecord | LoadedModuleRequestRecord) {
  if (!stringsEqual(left.Specifier, right.Specifier)) {
    return false;
  }
  const leftAttrs = left.Attributes;
  const rightAttrs = right.Attributes;
  const leftAttrsCount = leftAttrs.length;
  const rightAttrsCount = rightAttrs.length;
  if (leftAttrsCount !== rightAttrsCount) {
    return false;
  }
  for (const l of leftAttrs) {
    if (!rightAttrs.some((r) => stringsEqual(l.Key, r.Key) && stringsEqual(l.Value, r.Value))) {
      return false;
    }
  }
  return true;
}

// https://tc39.es/ecma262/#sec-withclausetoattributes
function WithClauseToAttributes(node: ParseNode.WithClause): ImportAttributeRecord[] {
  const attributes: ImportAttributeRecord[] = [];
  for (const attribute of node.WithEntries) {
    attributes.push({
      Key: StringValue(attribute.AttributeKey),
      Value: StringValue(attribute.AttributeValue),
    });
  }
  attributes.sort((a, b) => (a.Key.value < b.Key.value ? -1 : 1));
  return attributes;
}

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

function importedNamesFromExportFromClause(clause: ParseNode.ExportFromClauseLike): ImportedNamesValue {
  if (clause.type === 'ExportFromClause') {
    // export * from "m"  → ModuleExportName absent  → 'all-but-default'
    // export * as ns from "m"  → ModuleExportName present  → 'all'
    return clause.ModuleExportName ? 'all' : 'all-but-default';
  }
  // NamedExports (export { a, b as c } from "m")
  return clause.ExportsList.map((spec) => StringValue(spec.localName));
}

export function ModuleRequests(node: ParseNode): ModuleRequestRecord[] {
  switch (node.type) {
    case 'Module':
      if (node.ModuleBody) {
        return ModuleRequests(node.ModuleBody);
      }
      return [];
    case 'ModuleBody': {
      const requests: ModuleRequestRecord[] = [];
      for (const item of node.ModuleItemList) {
        const additionalRequests = ModuleRequests(item);
        for (const mr of additionalRequests) {
          const existing = requests.find((r) => ModuleRequestsEqual(r, mr) && r.Phase === mr.Phase);
          if (existing) {
            (existing as Mutable<ModuleRequestRecord>).ImportedNames = MergeImportedNames(existing.ImportedNames, mr.ImportedNames);
          } else {
            requests.push(mr);
          }
        }
      }
      return requests;
    }
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
      return [{
        Specifier: specifier, Attributes: attributes, Phase: node.Phase, ImportedNames: importedNames,
      }];
    }
    case 'ExportDeclaration':
      if (node.FromClause) {
        const specifier = StringValue(node.FromClause);
        const attributes = node.WithClause ? WithClauseToAttributes(node.WithClause) : [];
        const importedNames = importedNamesFromExportFromClause(node.ExportFromClause!);
        return [{
          Specifier: specifier, Attributes: attributes, Phase: node.Phase ?? 'evaluation', ImportedNames: importedNames,
        }];
      }
      return [];
    default:
      return [];
  }
}
