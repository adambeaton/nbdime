// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import * as CodeMirror from 'codemirror';

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

export class DiffRangeRaw {
    constructor(public from: number, length: number) {
        this.to = from + length;
    }
    
    offset(offset: number) {
        this.from += offset;
        this.to += offset;
    }
    
    to: number;
}

/**
 * Class representing a string (diff) range in the format of CodeMirror.Positions.
 * 
 * The class also has fields to ease chunking of diffs without reparsing the
 * text.
 */
export class DiffRangePos {
    /**
     * Create a diff range. The `ch` field of the `to` position is defined as
     * non-inclusive, i.e., it follows the syntax of String.slice().
     */
    constructor(public from: CodeMirror.Position, public to: CodeMirror.Position,
            chunkStartLine?: boolean, endsOnNewline?: boolean) {
        this.chunkStartLine = chunkStartLine === true;
        this.endsOnNewline = endsOnNewline === true;
    }

    chunkStartLine: boolean;
    endsOnNewline: boolean;
}


/**
 * Utility function to find the line number of a given string index,
 * given the positions of all newlines.
 */
function findLineNumber(nlPos: number[], index: number): number {
    if (nlPos.length === 0) return 0;
    var lineNo: number = null;
    nlPos.some(function(el, i) {
        if (el >= index) {
            lineNo = i;
            return true;
        }
        return false;
    });
    if (lineNo === null) {
        return nlPos.length;
    }
    return lineNo;
}

/**
 * Function to convert an array of DiffRangeRaw to DiffRangePos. The 
 * `text` parameter is the text in which the ranges exist.
 */
export function raw2Pos(raws: DiffRangeRaw[], text: string): DiffRangePos[] {
    // Find all newline's indices in text
    let adIdx: number[] = [];
    let i = -1;
    while (-1 !== (i = text.indexOf("\n", i + 1))) {
        adIdx.push(i);
    }
    let result: DiffRangePos[] = [];
    // Find line numbers from raw index
    for (let r of raws) {
        // First `from` position:
        let line = findLineNumber(adIdx, r.from);
        let lineStartIdx = line > 0 ? adIdx[line-1] + 1 : 0; 
        let from = CodeMirror.Pos(line, r.from - lineStartIdx);

        // Then `to` position:
        line = findLineNumber(adIdx, r.to - 1);  // `to` is non-inclusive
        lineStartIdx = line > 0 ? adIdx[line-1] + 1 : 0;
        let to = CodeMirror.Pos(line, r.to - lineStartIdx);

        // Finally chunking hints:
        let startsOnNewLine = adIdx.indexOf(r.from) !== -1;
        let endsOnNewline = adIdx.indexOf(r.to - 1) !== -1;  // non-inclusive
        let firstLineNew = from.ch === 0 && (
            from.line !== to.line || endsOnNewline || r.to === text.length);
        let chunkFirstLine = (
            firstLineNew ||
            !startsOnNewLine ||
            (
                // Neither preceding nor following character is a newline
                adIdx.indexOf(r.from - 1) === -1 &&
                adIdx.indexOf(r.to) === -1
            )
        )
        let pos = new DiffRangePos(from, to, chunkFirstLine, endsOnNewline);
        result.push(pos);
    }
    return result;
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