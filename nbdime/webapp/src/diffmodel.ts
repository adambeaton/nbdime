// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
    INotebookContent, ICell, ICodeCell, INotebookMetadata, IOutput, IStream, 
    IExecuteResult, IRawCell
} from 'jupyter-js-notebook/lib/notebook/nbformat';

import {
    get_diff_key, DiffRangeRaw, DiffRangePos, IDiffEntry, IDiffAddRange, 
    IDiffRemoveRange, IDiffPatch, raw2Pos
} from './diffutil';
    
import {
    patchStringified, stringify, DiffOp, patch
} from './patch';

import * as CodeMirror from 'codemirror';


// DIFF MODELS:

export interface IDiffModel {
    unchanged: boolean; 
    added: boolean;
    deleted: boolean;
    
    collapsible: boolean;
    collapsibleHeader: string;
    startCollapsed: boolean;
}

export interface IStringDiffModel extends IDiffModel {  
    base: string;
    remote: string;

    mimetype: string;
    
    additions: DiffRangePos[];
    deletions: DiffRangePos[];
    
    getChunks(): Chunk[];
}

export class StringDiffModel implements IStringDiffModel {
    constructor(
            public base: string,
            public remote:string,
            additions: DiffRangeRaw[],
            deletions: DiffRangeRaw[],
            collapsible?: boolean,
            header?: string,
            collapsed?: boolean) {
        if (base === null) {
            console.assert(deletions.length === 0);
            this.deletions = [];
        } else {
            this.deletions = raw2Pos(deletions, base);
        }
        if (remote === null) {
            console.assert(additions.length === 0);
            this.additions = [];
        } else {
            this.additions = raw2Pos(additions, remote);
        }
        
        this.collapsible = collapsible === true;
        if (this.collapsible) {
            this.collapsibleHeader = header ? header : "";
            this.startCollapsed = collapsed;
        }
    }
    
    getChunks(): Chunk[] {
        var chunks: Chunk[] = [];
        var startEdit = 0, startOrig = 0, editOffset = 0;
        var edit = CodeMirror.Pos(0, 0), orig = CodeMirror.Pos(0, 0);
        let ia = 0, id = 0;
        
        let current: Chunk = null;
        let isAddition: boolean = null;
        let range: DiffRangePos = null;
        for (;;) {
            // Figure out which element to take next
            if (ia < this.additions.length) {
                if (id < this.deletions.length) {
                    let ra = this.additions[ia], rd = this.deletions[id];
                    if (ra.from.line < rd.from.line - editOffset || (ra.from.line == rd.from.line - editOffset &&
                            ra.from.ch <= rd.from.ch)) { // TODO: Character offsets should also be used
                        isAddition = true;
                    } else {
                        isAddition = false;
                    }
                } else {
                    // No more deletions
                    isAddition = true;
                }
            } else if (id < this.deletions.length) {
                // No more additions
                isAddition = false;
            } else {
                if (current) { chunks.push(current); }
                break;
            }
            
            if (isAddition) {
                range = this.additions[ia++];
            } else {
                range = this.deletions[id++];
            }
            let linediff = range.to.line - range.from.line;
            if (range.endsOnNewline) {
                linediff += 1;
            }
            let firstLineNew = range.from.ch === 0 && linediff > 0;

            let startOffset = range.chunkStartLine ? 0 : 1;
            let endOffset = (
                range.chunkStartLine && range.endsOnNewline && firstLineNew) ?
                0 : 1;

            if (current) {
                if (isAddition) {
                    if (current.inOrig(range.from.line)) {
                        current.origTo = Math.max(current.origTo, range.to.line + 1);
                    } else {
                        // No overlap with chunk, start new one
                        chunks.push(current);
                        current = null;
                    }
                } else {
                    if (current.inEdit(range.from.line)) {
                        current.editTo = Math.max(current.editTo, range.to.line + 1);
                    } else {
                        // No overlap with chunk, start new one
                        chunks.push(current);
                        current = null;
                    }
                }
            }
            if (!current) {
                if (isAddition) {
                    startOrig = range.from.line;
                    startEdit = startOrig + editOffset;
                    current = new Chunk(
                        startEdit + startOffset,
                        startEdit + endOffset,
                        startOrig + startOffset,
                        startOrig + endOffset + linediff
                    );
                } else {
                    startEdit = range.from.line;
                    startOrig = startEdit - editOffset;
                    current = new Chunk(
                        startEdit + startOffset,
                        startEdit + endOffset + linediff,
                        startOrig + startOffset,
                        startOrig + endOffset
                    );
                }
                
            }
            editOffset += isAddition ? -linediff : linediff;
        }
        return chunks;
    }
    
    get unchanged(): boolean {
        return this.base == this.remote;
        //return !this.additions && !this.deletions;
    }
    
    get added(): boolean {
        return this.base === null;
    }
    
    get deleted(): boolean {
        return this.remote === null;
    }
    
    collapsible: boolean;
    collapsibleHeader: string;
    startCollapsed: boolean;

    mimetype: string;
    
    additions: DiffRangePos[];
    deletions: DiffRangePos[];
}

// MODEL/CHUNKING FOR DIFFVIEW

export class Chunk {
    constructor(
          public editFrom: number,
          public editTo: number,
          public origFrom: number,
          public origTo: number) {}
    
    inEdit(line: number) {
        return line >= this.editFrom && line <= this.editTo;
    }
    
    inOrig(line: number) {
        return line >= this.origFrom && line <= this.origTo;
    }
};

export class PatchDiffModel extends StringDiffModel {
    constructor(base: any, diff?: IDiffEntry[]) {
        console.assert(!!diff, "Patch model needs diff.");
        var base_str = (typeof base == "string") ? base as string : stringify(base);
        let out = patchStringified(base, diff);
        super(base_str, out.remote, out.additions, out.deletions);
    }
}

/**
 * DirectDiffModel
 * 
 * Class for making cell diff models for added, removed or unchanged cells.
 */
export class DirectDiffModel extends StringDiffModel {
    constructor(base: any, remote: any) {
        var base_str = (typeof base == "string") ? base as string : stringify(base);
        var remote_str = (typeof remote == "string") ? remote as string : stringify(remote);
        var additions: DiffRangeRaw[] = [];
        var deletions: DiffRangeRaw[] = []
        if (base === null) {
            // Added cell
            base_str = null;
            additions.push(new DiffRangeRaw(0, remote_str.length));
        } else if (remote === null) {
            // Deleted cell
            remote_str = null;
            deletions.push(new DiffRangeRaw(0, base_str.length));
        }
        super(base_str, remote_str, additions, deletions);
    }
}

export interface IOutputDiffModel extends IDiffModel {  
    base: IOutput;
    remote: IOutput;
    
    stringify(key?: string) : IStringDiffModel;
}


export class OutputDiffModel implements IOutputDiffModel {
    constructor(
            public base: IOutput,
            remote: IOutput,
            diff?: IDiffEntry[],
            collapsible?: boolean,
            header?: string,
            collapsed?: boolean) {
        if (!remote && diff) {
            this.remote = patch(base, diff);
        } else {
            this.remote = remote;
        }
        this.diff = !!diff ? diff : null;
        this.collapsible = collapsible === true;
        if (this.collapsible) {
            this.collapsibleHeader = header ? header : "";
            this.startCollapsed = collapsed;
        }
    }
    
    get unchanged() : boolean {
        return this.diff === null;
    }
    
    get added(): boolean {
        return this.base === null;
    }
    
    get deleted(): boolean {
        return this.remote === null;
    }

    hasMimeType(mimetype: string): string {
        let t = this.base ? this.base.output_type : this.remote.output_type;
        if (t === 'stream' && mimetype == "application/vnd.jupyter.console-text") {
            return 'text';
        } else if (t === 'execute_result' || t === 'display_data') {
            let data = this.base ? (this.base as IExecuteResult).data : (this.remote as IExecuteResult).data;
            if (mimetype in data) {
                return 'data.' + mimetype;
            }
        }
        return null;
    }

    innerMimeType(key: string) : string {
        if (key === "text") {
            return "text/plain";
        } else if (key.indexOf("data.") == 0) {
            return key.slice("data.".length);
        }
        throw "Unknown MIME type for key: " + key;
    }
    
    stringify(key?: string) : IStringDiffModel {
        let getKeyed = function(obj: any, key: string, f?: (obj: any, key: string) => any) {
            if (!obj) return obj;
            let i = key.indexOf('.');
            if (i >= 0) {
                console.assert(i < key.length);
                if (f) return getKeyed(f(obj, key.slice(0, i)), key.slice(i+1), f);
                else return getKeyed(obj[key.slice(0, i)], key.slice(i+1), f);
            }
            if (f) return f(obj, key);
            else return obj[key];
        };
        let base = key ? getKeyed(this.base, key) : this.base;
        let remote = key ? getKeyed(this.remote, key) : this.remote;
        let diff = this.diff && key ? getKeyed(this.diff, key, get_diff_key) : this.diff;
        let model: IStringDiffModel = null;
        if (this.unchanged || this.added || this.deleted || !diff) {
            model = new DirectDiffModel(base, remote);
        } else {
            model = new PatchDiffModel(base, diff);
        }
        model.mimetype = key ? this.innerMimeType(key) : "application/json";
        model.collapsible = this.collapsible;
        model.collapsibleHeader = this.collapsibleHeader;
        model.startCollapsed = this.startCollapsed;
        return model;
    }
    
    remote: any;
    diff: IDiffEntry[];
    collapsible: boolean;
    collapsibleHeader: string;
    startCollapsed: boolean;
}



export interface ICellDiffModel {
    source: IDiffModel;
    metadata: IDiffModel;
    outputs: IDiffModel[];
    
    unchanged: boolean;
    added: boolean;
    deleted: boolean;
}



/**
 * CellDiffModel
 */
export class BaseCellDiffModel implements ICellDiffModel {

    get unchanged(): boolean {
        let unchanged = this.source.unchanged;
        unchanged = unchanged && (this.metadata ? this.metadata.unchanged : true);
        if (this.outputs) {
            for (let o of this.outputs) {
                unchanged = unchanged && o.unchanged;
            }
        }
        return unchanged;
    }
    
    get deleted(): boolean {
        return this.source.deleted;
    }
    
    get added(): boolean {
        return this.source.added;
    }

    setMimetypeFromCellType(cell: ICell, model: IStringDiffModel, 
            nbMimetype: string) {
        let cellType = cell.cell_type;
        if (cellType === "code") {
            model.mimetype = nbMimetype;
        } else if (cellType === "markdown") {
            model.mimetype = "text/markdown";
        } else if (cellType === "raw") {
            model.mimetype = (cell as IRawCell).metadata.format;
        }
    }

    setMetadataCollapsible() {
        if (this.metadata) {
            this.metadata.collapsible = true;
            this.metadata.collapsibleHeader = "Metadata changed";
            this.metadata.startCollapsed = true;
        }
    }
    
    source: IDiffModel;
    metadata: IDiffModel;
    outputs: IDiffModel[];
}

export class PatchedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell, diff: IDiffEntry[], nbMimetype: string) {
        super();
        let subDiff = get_diff_key(diff, "source");
        if (subDiff) {
            this.source = new PatchDiffModel(base.source, subDiff);
        } else {
            this.source = new DirectDiffModel(base.source, base.source);
        }
        this.setMimetypeFromCellType(base, this.source as IStringDiffModel, nbMimetype);
        subDiff = get_diff_key(diff, "metadata");
        this.metadata = (base.metadata === undefined ?
            null : subDiff ? 
                new PatchDiffModel(base.metadata, subDiff) : 
                new DirectDiffModel(base.metadata, base.metadata));
        this.setMetadataCollapsible();
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = makeOutputModels((base as ICodeCell).outputs, null,
                get_diff_key(diff, "outputs"));
        } else {
            this.outputs = null;
        }
    }
}

export class UnchangedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell, nbMimetype: string) {
        super();
        this.source = new DirectDiffModel(base.source, base.source);
        this.setMimetypeFromCellType(base, this.source as IStringDiffModel, nbMimetype);
        this.metadata = base.metadata === undefined ? null : new DirectDiffModel(base.metadata, base.metadata);
        this.setMetadataCollapsible();
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = makeOutputModels((base as ICodeCell).outputs,
                (base as ICodeCell).outputs);
        } else {
            this.outputs = null;
        }
    }
}

export class AddedCellDiffModel extends BaseCellDiffModel {
    constructor(remote: ICell, nbMimetype: string) {
        super();
        this.source = new DirectDiffModel(null, remote.source);
        this.setMimetypeFromCellType(remote, this.source as IStringDiffModel, nbMimetype);
        this.metadata = remote.metadata === undefined ? null : new DirectDiffModel(null, remote.metadata);
        this.setMetadataCollapsible();
        if (remote.cell_type === "code" && (remote as ICodeCell).outputs) {
            this.outputs = makeOutputModels(null, (remote as ICodeCell).outputs);
        } else {
            this.outputs = null;
        }
    }
}

export class DeletedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell, nbMimetype: string) {
        super();
        this.source = new DirectDiffModel(base.source, null);
        this.setMimetypeFromCellType(base, this.source as IStringDiffModel, nbMimetype);
        this.metadata = base.metadata === undefined ? null : new DirectDiffModel(base.metadata, null);
        this.setMetadataCollapsible();
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = makeOutputModels((base as ICodeCell).outputs, null);
        } else {
            this.outputs = null;
        }
    }
}

function makeOutputModels(base: IOutput[], remote: IOutput[],
        diff?: IDiffEntry[]) : IDiffModel[] {
    let models: IDiffModel[] = [];
    if (remote === null && !diff) {
        // Cell deleted
        for (let o of base) {
            models.push(new OutputDiffModel(o, null));
        }
    } else if (base === null) {
        // Cell added
        for (let o of remote) {
            models.push(new OutputDiffModel(null, o));
        }
    } else if (remote === base) {
        // Outputs unchanged
        for (let o of base) {
            models.push(new OutputDiffModel(o, o));
        }
    } else if (diff) {
        // Outputs' patched, remote will be null
        let consumed = 0;
        let skip = 0;
        for (let d of diff) {
            let index = d.key as number;
            for (let o of base.slice(consumed, index)) {
                // Add unchanged outputs
                models.push(new OutputDiffModel(o, o));
            }
            if (d.op === DiffOp.SEQINSERT) {
                // Outputs added
                for (let o of (d as IDiffAddRange).valuelist) {
                    models.push(new OutputDiffModel(null, o));
                }
                skip = 0;
            } else if (d.op === DiffOp.SEQDELETE) {
                // Outputs removed
                let len = (d as IDiffRemoveRange).length;
                for (let i = index; i < index + len; i++) {
                    models.push(new OutputDiffModel(base[i], null));
                }
                skip = len;
            } else if (d.op === DiffOp.PATCH) {
                // Output changed
                models.push(new OutputDiffModel(base[index], null, (d as IDiffPatch).diff));
                skip = 1;
            } else {
                throw "Invalid diff operation: " + d;
            }
            consumed = Math.max(consumed, index + skip);
        }
        for (let o of base.slice(consumed)) {
            // Add unchanged outputs
            models.push(new OutputDiffModel(o, o));
        }
    } else {
        throw "Invalid arguments to OutputsDiffModel";
    }
    return models;
}


export interface INotebookDiffModel {
    metadata: IDiffModel;
    mimetype: string;
    cells: ICellDiffModel[];
}

/**
 * NotebookDiffModel
 */
export class NotebookDiffModel implements INotebookDiffModel {
    constructor(base: INotebookContent, diff: IDiffEntry[]) {
        let metaDiff = get_diff_key(diff, "metadata");
        this.metadata = (base.metadata || metaDiff) ? new PatchDiffModel(base.metadata, metaDiff) : null;
        this.metadata.collapsible = true;
        this.metadata.collapsibleHeader = "Notebook metadata changed";
        this.metadata.startCollapsed = true;
        this.mimetype = base.metadata.language_info.mimetype;
        this.cells = [];
        var take = 0;
        var skip = 0;
        for (var e of get_diff_key(diff, "cells")) {
            var op = e.op;
            var index = e.key as number;
            
            for (var i=take; i < index; i++) {
                this.cells.push(new UnchangedCellDiffModel(
                    base.cells[i], this.mimetype));
            }
            
            if (op == DiffOp.SEQINSERT) {
                for (var e_i of (e as IDiffAddRange).valuelist) {
                    this.cells.push(new AddedCellDiffModel(
                        e_i as ICell, this.mimetype));
                }
                skip = 0;
            }
            else if (op == DiffOp.SEQDELETE) {
                skip = (e as IDiffRemoveRange).length;
                for (var i=index; i < index + skip; i++) {
                    this.cells.push(new DeletedCellDiffModel(
                        base.cells[i], this.mimetype));
                }
            }
            else if (op == DiffOp.PATCH) {
                this.cells.push(new PatchedCellDiffModel(
                    base.cells[index], (e as IDiffPatch).diff, this.mimetype));
                skip = 1;
            }

            // Skip the specified number of elements, but never decrement take.
            // Note that take can pass index in diffs with repeated +/- on the
            // same index, i.e. [op_remove(index), op_add(index, value)]
            take = Math.max(take, index + skip);
        }
        // Take unchanged values at end
        for (var i=take; i < base.cells.length; i++) {
            this.cells.push(new UnchangedCellDiffModel(base.cells[i], this.mimetype));
        }
    }
    
    metadata: IDiffModel;
    mimetype: string;
    cells: ICellDiffModel[];
}