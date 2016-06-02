// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
    IEditorModel, EditorModel
} from 'jupyter-js-notebook/lib/editor';

import {
    InputAreaModel, IInputAreaModel
} from 'jupyter-js-notebook/lib/input-area';

import {
    IOutputAreaModel, OutputAreaModel
} from 'jupyter-js-notebook/lib/output-area';

import {
    INotebookContent, ICell, ICodeCell, INotebookMetadata
} from 'jupyter-js-notebook/lib/notebook/nbformat';

import {
    get_diff_key, DiffRangeRaw, DiffRangePos, IDiffEntry, IDiffAddRange, IDiffRemoveRange, IDiffPatch
} from './diffutil';
    
import {
    diffOutput, PatchResult, stringify, DiffOp
} from './patch';

import * as CodeMirror from 'codemirror';


// DIFF MODELS:

export interface IDiffModel {
    base: string;
    remote: string;
    
    additions: DiffRangeRaw[];
    deletions: DiffRangeRaw[];
    
    unchanged: boolean;
}

export class DiffModel implements IDiffModel {
    constructor(
        public base: string,
        public remote:string,
        public additions: DiffRangeRaw[],
        public deletions: DiffRangeRaw[]) {
        }
    
    get unchanged(): boolean {
        return this.base == this.remote;
        //return !this.additions && !this.deletions;
    }
}

/**
 * PatchDiffModel
 */
export class PatchDiffModel extends DiffModel {
    constructor(base: any, diff?: IDiffEntry[]) {
        var base_str = (typeof base == "string") ? base as string : stringify(base);
        let out = diffOutput(base, diff);
        super(base_str, out.remote, out.additions, out.deletions);
    }
}

/**
 * DirectDiffModel
 * 
 * Class for making cell diff models for added, removed or unchanged cells.
 */
export class DirectDiffModel extends DiffModel {
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

export interface IDiffViewModel {
    base: IEditorModel;
    our: IEditorModel;
    
    additions: DiffRangePos[];
    deletions: DiffRangePos[];
    
    getChunks(): Chunk[];
    
    unchanged(): boolean;
    added(): boolean;
    deleted(): boolean;
}


/*
function moveOver(pos: CodeMirror.Position, range: DiffRangePos, copy?: boolean, other?: CodeMirror.Position) {
    var out = copy ? CodeMirror.Pos(pos.line, pos.ch) : pos;
    let linediff = range.to.line - range.from.line;
    out.line += linediff;
    if (other) other.line += linediff;
    if (linediff > 0) {
        // New line added, so just take new position
        out.ch = range.to.ch;
        if (other) other.ch = range.to.ch;
    } else {
        // No newline, so simply increase ch
        var chdiff = range.to.ch - range.from.ch;
        out.ch += chdiff;
        if (other) other.ch += chdiff;
    }
    return out;
}

class DiffIterator {
    constructor(public ranges: DiffRangePos[][]) {
        for (var r of ranges) {
            this.indices.push(0);
        }
    }
    
    next(): {value: [DiffRangePos, number], done: boolean} {
        let ret = {value: null, done: true};
        // Check if any index is within bounds:
        for (var i = 0; i < this.indices.length; i++) {
            var idx = this.indices[i];
            if (idx < this.ranges[i].length) 
            {
                ret.done = false;
                break;
            }
        }
        if (ret.done) return ret;
        
        let minRangeIdx, minRange: DiffRangePos;
        for (var i = 0; i < this.ranges.length; i++) {
            if (this.indices[i] < this.ranges.length) {
                let el = this.ranges[i][this.indices[i]];
                if (minRange === undefined ||
                        el.from.line < minRange.from.line ||
                        el.from.ch < minRange.from.ch) {
                    minRange = el;
                    minRangeIdx = i;
                }
            }
        }
        console.assert(minRangeIdx !== undefined);
        ret.value = [minRange, minRangeIdx];
        this.indices[minRangeIdx]++;
        return ret;
    }
    
    indices: number[];
}
*/

function findLineNumber(nlPos: number[], index: number): number {
    if (nlPos.length === 0) return 0;
    var lineNo: number = null;
    nlPos.some(function(el, i) {
        if (el > index) {
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

function raw2Pos(raws: DiffRangeRaw[], text: string): DiffRangePos[] {
    // Find all newline's indices in text
    let adIdx: number[] = [];
    let i = -1;
    while (-1 !== (i = text.indexOf("\n", i + 1))) {
        adIdx.push(i);
    }
    let result: DiffRangePos[] = [];
    // Find line numbers from raw index
    for (let r of raws) {
        let line = findLineNumber(adIdx, r.from);
        let lineStartIdx = line > 0 ? adIdx[line-1] + 1 : 0; 
        let from = CodeMirror.Pos(line, r.from - lineStartIdx);
        line = findLineNumber(adIdx, r.to);
        lineStartIdx = line > 0 ? adIdx[line-1] + 1 : 0; 
        let to = CodeMirror.Pos(line, r.to - lineStartIdx);
        result.push(new DiffRangePos(from, to));
    }
    return result;
}


export class DiffViewModel implements IDiffViewModel {
    constructor(public base: IEditorModel, public our: IEditorModel,
                additions: DiffRangeRaw[], deletions: DiffRangeRaw[]) {
        if (base === null) {
            console.assert(deletions.length === 0);
            this.deletions = [];
        } else {
            this.deletions = raw2Pos(deletions, base.text);
        }
        if (our === null) {
            console.assert(additions.length === 0);
            this.additions = [];
        } else {
            this.additions = raw2Pos(additions, our.text);
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
            if (!current) {
                if (isAddition) {
                    startOrig = range.from.line;
                    startEdit = startOrig + editOffset;
                    current = new Chunk(startEdit, startEdit + linediff + 1, startOrig, startOrig + 1);
                } else {
                    startEdit = range.from.line;
                    startOrig = startEdit - editOffset;
                    current = new Chunk(startEdit, startEdit + 1, startOrig, startOrig + linediff + 1);
                }
            }
            if (isAddition) {
                if (current.inOrig(range.from.line)) {
                    current.origTo += linediff;
                } else {
                    // No overlap with chunk, start new one
                    chunks.push(current);
                    current = null;
                }
            } else {
                if (current.inEdit(range.from.line)) {
                    current.editTo += linediff;
                } else {
                    // No overlap with chunk, start new one
                    chunks.push(current);
                    current = null;
                }
            }
            editOffset += isAddition ? -linediff : linediff;
        }
        return chunks;
    }

    unchanged(): boolean {
        return this.additions.length == 0 && this.deletions.length == 0;
    }

    added(): boolean {
        return (this.base === null);
    }

    deleted(): boolean {
        return (this.our === null);
    }
    
    additions: DiffRangePos[];
    deletions: DiffRangePos[];
}

export interface ICellDiffModel {
    source: IDiffModel;
    metadata: IDiffModel;
    outputs: IDiffModel;
    
    unchanged: boolean;
    added: boolean;
    deleted: boolean;
    
    // All of these will have one local, and one remote model, although one entry may be null
    sourceView: IDiffViewModel;
    metadataView: IDiffViewModel;
    outputsView: IDiffViewModel;
    outputAreas: IOutputAreaModel[];
}



/**
 * CellDiffModel
 */
export class BaseCellDiffModel implements ICellDiffModel {
    initViews() {
        let constructor = this.constructor as typeof BaseCellDiffModel;
        let base = this.source.base !== null;
        let remote = !this.unchanged && this.source.remote !== null;
        this.sourceView  = constructor.createView(this.source, base, remote);
        if (this.metadata) {
            this.metadataView = constructor.createView(this.metadata, base, remote);
        }
        if (this.outputs) {
            this.outputsView = constructor.createView(this.outputs, base, remote);
            if (base) {
                this.outputAreas.push(new OutputAreaModel());
            }
            if (remote) {
                this.outputAreas.push(new OutputAreaModel());
            }
        }
    }
    
    static createView(model: IDiffModel, base: boolean, remote: boolean): IDiffViewModel {
        if (base && remote) {
            let bEdit = new EditorModel({readOnly: true});
            let rEdit = new EditorModel({readOnly: true});
            bEdit.text = model.base;
            rEdit.text = model.remote;
            return new DiffViewModel(bEdit, rEdit, model.additions, model.deletions);
        } else if (base || remote) {
            let edit = new EditorModel({readOnly: true});
            edit.text = base ? model.base : model.remote;
            return new DiffViewModel(base ? edit : null, base? null : edit, [], []);
        }
        return null;
    }
    
    get unchanged(): boolean {
        return this.source.unchanged && 
            (this.metadata ? this.metadata.unchanged : true) &&
            (this.outputs ? this.outputs.unchanged : true);
    }
    
    get deleted(): boolean {
        return !this.source.remote && 
            this.metadata ? !this.metadata.remote : true &&
            this.outputs ? !this.outputs.remote : true;
    }
    
    get added(): boolean {
        return !this.source.base &&
            this.metadata ? !this.metadata.base : true &&
            this.outputs ? !this.outputs.base : true;
    }
    
    source: IDiffModel;
    metadata: IDiffModel;
    outputs: IDiffModel;
    
    // All of these will have one local, and one remote model, although one entry may be null
    sourceView: IDiffViewModel;
    metadataView: IDiffViewModel;
    outputsView: IDiffViewModel;
    outputAreas: IOutputAreaModel[] = [];
}

export class PatchedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell, diff: IDiffEntry[]) {
        super();
        this.source = new PatchDiffModel(base.source, get_diff_key(diff, "source"));
        this.metadata = (base.metadata === undefined ?
            null : new PatchDiffModel(base.metadata, get_diff_key(diff, "metadata")));
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = new PatchDiffModel((base as ICodeCell).outputs, get_diff_key(diff, "outputs"));
        } else {
            this.outputs = null;
        }
        
        this.initViews();
    }
}

export class UnchangedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell) {
        super();
        this.source = new DirectDiffModel(base.source, base.source);
        this.metadata = base.metadata === undefined ? null : new DirectDiffModel(base.metadata, base.metadata);
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = new DirectDiffModel((base as ICodeCell).outputs, (base as ICodeCell).outputs);
        } else {
            this.outputs = null;
        }
        
        this.initViews();
    }
}

export class AddedCellDiffModel extends BaseCellDiffModel {
    constructor(remote: ICell) {
        super();
        this.source = new DirectDiffModel(null, remote.source);
        this.metadata = remote.metadata === undefined ? null : new DirectDiffModel(null, remote.metadata);
        if (remote.cell_type === "code" && (remote as ICodeCell).outputs) {
            this.outputs = new DirectDiffModel(null, (remote as ICodeCell).outputs);
        } else {
            this.outputs = null;
        }
        
        this.initViews();
    }
}

export class DeletedCellDiffModel extends BaseCellDiffModel {
    constructor(base: ICell) {
        super();
        this.source = new DirectDiffModel(base.source, null);
        this.metadata = base.metadata === undefined ? null : new DirectDiffModel(base.metadata, null);
        if (base.cell_type === "code" && (base as ICodeCell).outputs) {
            this.outputs = new DirectDiffModel((base as ICodeCell).outputs, null);
        } else {
            this.outputs = null;
        }
        
        this.initViews();
    }
}


export interface INotebookDiffModel {
    metadata: IDiffModel;
    cells: ICellDiffModel[];
}

/**
 * NotebookDiffModel
 */
export class NotebookDiffModel implements INotebookDiffModel {
    constructor(base: INotebookContent, diff: IDiffEntry[]) {
        let metaDiff = get_diff_key(diff, "metadata");
        this.metadata = (base.metadata || metaDiff) ? new PatchDiffModel(base.metadata, metaDiff) : null;
        
        this.cells = [];
        var take = 0;
        var skip = 0;
        for (var e of get_diff_key(diff, "cells")) {
            var op = e.op;
            var index = e.key as number;
            
            for (var i=take; i < index; i++) {
                this.cells.push(new UnchangedCellDiffModel(base.cells[i]));
            }
            
            if (op == DiffOp.SEQINSERT) {
                for (var e_i of (e as IDiffAddRange).valuelist) {
                    this.cells.push(new AddedCellDiffModel(e_i as ICell));
                }
                skip = 0;
            }
            else if (op == DiffOp.SEQDELETE) {
                skip = (e as IDiffRemoveRange).length;
                for (var i=index; i < index + skip; i++) {
                    this.cells.push(new DeletedCellDiffModel(base.cells[i]));
                }
            }
            else if (op == DiffOp.PATCH) {
                this.cells.push(new PatchedCellDiffModel(base.cells[index], (e as IDiffPatch).diff));
                skip = 1;
            }

            // Skip the specified number of elements, but never decrement take.
            // Note that take can pass index in diffs with repeated +/- on the
            // same index, i.e. [op_remove(index), op_add(index, value)]
            take = Math.max(take, index + skip);
        }
        // Take unchanged values at end
        for (var i=take; i < base.cells.length; i++) {
            this.cells.push(new UnchangedCellDiffModel(base.cells[i]));
        }
    }
    
    metadata: IDiffModel;
    cells: ICellDiffModel[];
}