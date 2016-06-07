"use strict";

import {
    DiffRangeRaw, JSON_INDENT, repeat_string, IDiffEntry, IDiffAdd, IDiffPatch, IDiffAddRange, IDiffRemoveRange
} from './diffutil';


import stableStringify = require('json-stable-stringify');


export type PatchResult = {remote: string, additions: DiffRangeRaw[], deletions: DiffRangeRaw[]};

export
namespace DiffOp {
    export const ADD = "add";
    export const REMOVE = "remove";
    export const REPLACE = "replace";
    export const PATCH = "patch";
    export const SEQINSERT = "addrange";
    export const SEQDELETE = "removerange";
}

export function patch(base: (string | Array<any> | any), diff: IDiffEntry[]) : (string | Array<any> | any) {
    if (typeof base == "string") {
        return patchSequence(base, diff);
    } else if (base instanceof Array) {
        return patchSequence(base, diff)
    } else {
        return patchObject(base, diff);
    }
}

function patchSequence(base: Array<any>, diff: IDiffEntry[]): Array<any> {
    // The patched sequence to build and return
    let patched: string | any = typeof base == "string" ? "" : [];
    // Index into obj, the next item to take unless diff says otherwise
    let take = 0;
    let skip = 0;
    for (let e of diff) {
        let op = e.op;
        let index = e.key as number;

        // Take values from base not mentioned in diff, up to not including index
        for (let value of base.slice(take, index)) {
            patched.push(deepCopy(value));
        }

        if (op === DiffOp.SEQINSERT) {
            // Extend with new values directly
            patched += (e as IDiffAddRange).valuelist;
            skip = 0;
        } else if (op === DiffOp.SEQDELETE) {
            // Delete a number of values by skipping
            skip = (e as IDiffRemoveRange).length;
        } else if (op === DiffOp.PATCH) {
            patched.push(patch(base[index], (e as IDiffPatch).diff));
            skip = 1;
        } else {
            throw "Invalid op: " + op;
        }

        // Skip the specified number of elements, but never decrement take.
        // Note that take can pass index in diffs with repeated +/- on the
        // same index, i.e. [op_remove(index), op_add(index, value)]
        take = Math.max(take, index + skip);
    }

    // Take values at end not mentioned in diff
    for (let value of base.slice(take)) {
        patched.push(deepCopy(value));
    }
    return patched;
}

function patchObject(base: Object, diff: IDiffEntry[]) : Object {
    let patched: any = {};
    let keysToCopy = Object.keys(base);

    for (let e of diff) {
        let op = e.op, key = e.key as string;

        if (op == DiffOp.ADD) {
            console.assert(!(key in keysToCopy));
            patched[key] = (e as IDiffAdd).value
        } else if (op == DiffOp.REMOVE) {
            keysToCopy.splice(keysToCopy.indexOf(key), 1);   // Remove key
        } else if (op == DiffOp.REPLACE) {
            keysToCopy.splice(keysToCopy.indexOf(key), 1);   // Remove key
            patched[key] = (e as IDiffAdd).value;
        } else if (op == DiffOp.PATCH) {
            keysToCopy.splice(keysToCopy.indexOf(key), 1);   // Remove key
            patched[key] = patch(base[key], (e as IDiffPatch).diff)
        } else {
            throw "Invalid op " + op;
        }
    }

    // Take items not mentioned in diff
    for (let key of keysToCopy) {
        patched[key] = deepCopy(base[key]);
    }
    return patched
}

export function patchStringified(base: (string | Array<any> | any), diff: IDiffEntry[], level?: number) : PatchResult {
    if (level === undefined) {
        level = 0;
    }
    if (typeof base == "string") {
        return patchString(base, diff, level);
    } else if (base instanceof Array) {
        return patchStringifiedList(base, diff, level)
    } else {
        return patchStringifiedObject(base, diff, level);
    }
}

function patchStringifiedObject(base: Object, diff: IDiffEntry[], level: number) : PatchResult {
    if (level === undefined) {
        var level = 0;
    }
    let map: { [key: string]: any; } = base;
    var remote = "";
    var additions: DiffRangeRaw[] = [];
    var deletions: DiffRangeRaw[] = [];
    let postfix = ",\n";
    
    var baseIndex = 0;
    
    // Short-circuit if diff is empty
    if (diff === null) {
        return {remote: stringify(base, level, true), additions: additions, deletions: deletions};
    }
    
    // Object is dict. As diff keys should be unique, create map for easy processing
    var ops: { [key: string]: IDiffEntry} = {};
    var op_keys : string[] = [];
    for (var d of diff) {
        op_keys.push(d.key as string);
        ops[d.key as string] = d;
    }
    var all_keys = getAllKeys(base, op_keys);
    
    for (var key of all_keys) {
        let keyString = makeKeyString(key, level + 1);
        if (valueIn(key, op_keys)) {
            // Entry has a change
            let e = ops[key];
            let op = e.op;
            
            if (valueIn(op, [DiffOp.ADD, DiffOp.REPLACE, DiffOp.REMOVE])) {
                if (valueIn(op, [DiffOp.ADD, DiffOp.REPLACE])) {
                    let valr = stringify((e as IDiffAdd).value, level + 1, false) + postfix;
                    additions.push(new DiffRangeRaw(remote.length, keyString.length + valr.length));
                    remote += keyString + valr;
                }
                if (valueIn(op, [DiffOp.REMOVE, DiffOp.REPLACE])) {
                    let valb = stringify(map[key], level + 1, false) + postfix;
                    deletions.push(new DiffRangeRaw(baseIndex, keyString.length + valb.length));
                    baseIndex += valb.length;
                }
            } else if (op == DiffOp.PATCH) {
                let pd = patchStringified(map[key], (e as IDiffPatch).diff, level + 1);
                let valr = pd.remote;
                // Insert key string:
                valr = keyString + valr.slice((level + 1) * JSON_INDENT.length) + postfix;
                let offset = remote.length + keyString.length - (level + 1) * JSON_INDENT.length;
                offsetRanges(offset, pd.additions, pd.deletions);
                remote += valr;
                additions = additions.concat(pd.additions);
                deletions = deletions.concat(pd.deletions);
                
                baseIndex += stringify(map[key], level + 1, false).length + keyString.length + postfix.length;
            } else {
                throw "Invalid op " + op;
            }
        } else {
            // Entry unchanged
            let val = keyString + stringify(map[key], level + 1, false) + postfix;
            remote += val;
            baseIndex += val.length;
        }
    }
    
    // Stringify correctly
    if (remote.slice(remote.length - postfix.length) == postfix) {
        remote = remote.slice(0, remote.length - postfix.length)
    }
    let indent = repeat_string(JSON_INDENT, level);
    remote = indent + "{\n" + remote + "\n" + indent + "}";
    offsetRanges(indent.length + 2, additions, deletions);
    return {remote: remote, additions: additions, deletions: deletions};
}

function patchStringifiedList(base: Array<any>, diff: IDiffEntry[], level: number) : PatchResult {
    var remote = "";
    var additions: DiffRangeRaw[] = [];
    var deletions: DiffRangeRaw[] = [];
    var baseIndex = 0;  // Position in base string
    let postfix = ",\n";
    
    // Short-circuit if diff is empty
    if (diff === null) {
        return {remote: stringify(base, level), additions: additions, deletions: deletions};
    }
    // Index into obj, the next item to take unless diff says otherwise
    var take = 0;
    var skip = 0;
    for (var e of diff) {
        var op = e.op;
        var index = e.key as number;

        // Take values from obj not mentioned in diff, up to not including index
        if (index > take) {
            let unchanged = stringify(base.slice(take, index), level + 1) + postfix;;
            remote = remote.concat(unchanged);
            baseIndex += unchanged.length;
        }

        if (op == DiffOp.SEQINSERT) {
            // Extend with new values directly
            let val = stringify((e as IDiffAddRange).valuelist, level + 1) + postfix;
            additions.push(new DiffRangeRaw(remote.length, val.length));
            remote += val;
            skip = 0;
        }
        else if (op == DiffOp.SEQDELETE) {
            // Delete a number of values by skipping
            let val = stringify(base[index], level + 1) + postfix;
            deletions.push(new DiffRangeRaw(baseIndex, val.length));
            baseIndex += val.length;
            skip = (e as IDiffRemoveRange).length;
        }
        else if (op == DiffOp.PATCH) {
            let pd = patchStringified(base[index], (e as IDiffPatch).diff, level + 1);
            skip = 1;
            
            let val = pd.remote + postfix;
            offsetRanges(remote.length, pd.additions, pd.deletions);
            additions = additions.concat(pd.additions);
            deletions = deletions.concat(pd.deletions);
            baseIndex += stringify(base[index], level + 1).length;
            remote += val;
        }

        // Skip the specified number of elements, but never decrement take.
        // Note that take can pass index in diffs with repeated +/- on the
        // same index, i.e. [op_remove(index), op_add(index, value)]
        take = Math.max(take, index + skip);
    }

    // Take unchanged values at end
    if (base.length > take) {
        remote += stringify(base.slice(take, base.length), level + 1) + postfix;
    }
    
    // Stringify correctly
    if (remote.slice(remote.length - postfix.length) == postfix) {
        remote = remote.slice(0, remote.length - postfix.length)
    }
    let indent = repeat_string(JSON_INDENT, level);
    remote = indent + "[\n" + remote + "\n" + indent + "]";
    offsetRanges(indent.length + 2, additions, deletions);
    return {remote: remote, additions: additions, deletions: deletions};
}

function patchString(base: string, diff: IDiffEntry[], level: number) : PatchResult {
    var additions: DiffRangeRaw[] = [];
    var deletions: DiffRangeRaw[] = [];
    var baseIndex= 0;
    // Index into obj, the next item to take unless diff says otherwise
    var take = 0;
    var skip = 0;
    var remote = "";
    for (var e of diff) {
        var op = e.op;
        var index = e.key as number;
        
        // Take values from obj not mentioned in diff, up to not including index
        let unchanged = base.slice(take, index);
        remote += unchanged;
        baseIndex += unchanged.length;
        
        if (op == DiffOp.SEQINSERT) {
            let added = (e as IDiffAddRange).valuelist;
            additions.push(new DiffRangeRaw(remote.length, added.length));
            remote += added;
            skip = 0;
        } else if (op == DiffOp.SEQDELETE) {
            // Delete a number of values by skipping
            skip = (e as IDiffRemoveRange).length;
            deletions.push(new DiffRangeRaw(baseIndex, skip));
            baseIndex += skip;
        } else {
            throw "Invalid diff op on string: " + op;
        }
        take = Math.max(take, index + skip);
    }
    remote += base.slice(take, base.length);
    if (level > 0) {
        // This string is part of a hierachical structure: output data in JSON format
        remote = stringify(remote, level);
        // Shift all indices by indentation + one to account for opening quote
        offsetRanges(level * JSON_INDENT.length + 1, additions, deletions);
        // Offset ranges by JSON escaping
        adjustRangesByJSONEscapes(remote, additions);
        adjustRangesByJSONEscapes(base, deletions);
    }
    return {remote: remote, additions: additions, deletions: deletions};
}

/**
 * Ordered stringify. Wraps stableStringify(), but handles indentation, and
 * turns null input into empty string.
 */
export function stringify(values: string | any[] | { [key: string] : any},
                          level?: number, indentFirst?: boolean) : string {
    var ret = (values === null) ? "" : stableStringify(values, {space: JSON_INDENT});
    if (level) {
        ret = _indent(ret, level, indentFirst);
    }
    return ret;
}


// Utility functions and variables:

function _indent(str: string, levels: number, indentFirst?: boolean) : string {
    if (indentFirst === undefined) {
        indentFirst = true;
    }
    let lines = str.split('\n');
    var ret: string[] = new Array(lines.length);
    if (!indentFirst) {
        ret[0] = lines[0];
    }
    for (var i = indentFirst ? 0 : 1; i < lines.length; i++) {
        ret[i] = repeat_string(JSON_INDENT, levels) + lines[i];
    }
    return ret.join('\n');
}


var isArray = Array.isArray || function (x) {
    return {}.toString.call(x) === '[object Array]';
};

var objectKeys = Object.keys || function (obj) {
    var has = Object.prototype.hasOwnProperty || function () { return true };
    var keys: any[] = [];
    for (var key in obj) {
        if (has.call(obj, key)) keys.push(key);
    }
    return keys;
};

function onlyUnique(value: any, index: any, self: any) { 
    return self.indexOf(value) === index;
}

function getAllKeys(obj: Object, diffKeys: string[]){
    return objectKeys(obj).concat(diffKeys).filter(onlyUnique).sort();
}

function valueIn(value: any, array: Array<any>) {
    return array.indexOf(value) >= 0;
}

function makeKeyString(key: string, level: number) {
    return repeat_string(JSON_INDENT, level) + "\"" + key + "\": ";
}

function offsetRanges(offset: number, additions: DiffRangeRaw[], deletions: DiffRangeRaw[]) {
    for (var a of additions) {
        a.offset(offset);
    }
    for (var d of deletions) {
        d.offset(offset);
    }
}

function adjustRangesByJSONEscapes(jsonString: string, ranges: DiffRangeRaw[]) {
    // First find all escaped characters, and expansion coefficients
    var escapes = ["\\\"", "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t"];
    var unicodes = /\\u\d{4}/g;
    
    var indices: number[] = [];
    var expansions: number[] = [];
    
    for (var e of escapes) {
        var len = JSON.parse("\"" + e + "\"").length as number;
        while (1) {
            i = jsonString.indexOf(e, i);
            if (i < 0) {
                break;
            }
            indices.push(i);
            expansions.push(2 - len);
            i++;
        }
    }
    let match: RegExpExecArray;
    while ((match = unicodes.exec(jsonString)) != null) {
        indices.push(match.index);
        expansions.push(6 - JSON.parse("\"" + match[0] + "\"").length);
    }
    
    // Now adjust differences
    // TODO: Optimize this algorithm?
    for (var i = 0; i < indices.length; i++) {
        for (let r of ranges) {
            var idx = indices[i], exp = expansions[i] - 1;
            if (r.from > idx) {
                r.from += exp;
            }
            if (r.to > idx) {
                r.to += exp;
            }
        }
    }
}

function deepCopy(obj) {
  if (typeof obj == 'object') {
    if (obj instanceof Array) {
      var l = obj.length;
      var o = new Array(l);
      for (var i = 0; i < l; i++) {
        o[i] = deepCopy(obj[i]);
      }
      return o;
    } else {
      var r: any = {};
      r.prototype = obj.prototype;
      for (var k in obj) {
        r[k] = deepCopy(obj[k]);
      }
      return r;
    }
  }
  return obj;
}
