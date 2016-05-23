// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

export const JSON_INDENT = "    ";

export function repeat_string(str: string, count: number): string {
    if (count < 1) return '';
    var result = '', pattern = str.valueOf();
    while (count > 1) {
        if (count & 1) result += pattern;
        count >>= 1, pattern += pattern;
    }
    return result + pattern;
};

export function get_diff_key(diff: IDiffEntry[], key:string) : IDiffEntry[] {
    for (var i=0; i<diff.length; ++i) {
        if (diff[i].key == key) {
            return (diff[i] as IDiffPatch).diff;
        }
    }
    return null;
}

export class DiffRange {
    constructor(public from: number, length: number) {
        this.to = from + length;
    }
    
    offset(offset: number) {
        this.from += offset;
        this.to += offset;
    }
    
    to: number;
}

export interface IDiffEntryBase {
    key: string | number;
    op: string;   
}

export interface IDiffAddRange extends IDiffEntryBase {
    valuelist: string | Array<any>;
}

export interface IDiffAdd extends IDiffEntryBase {
    value: any;
}

export interface IDiffRemove extends IDiffEntryBase {
}

export interface IDiffReplace extends IDiffEntryBase {
    value: any;
}

export interface IDiffRemoveRange extends IDiffEntryBase {
    length: number;
}

export interface IDiffPatch extends IDiffEntryBase {
    diff: IDiffEntry[];
}

export type IDiffEntry = (IDiffAddRange | IDiffRemoveRange | IDiffPatch | IDiffAdd | IDiffRemove | IDiffReplace);