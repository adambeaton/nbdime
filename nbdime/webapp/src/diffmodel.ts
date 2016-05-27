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
    get_diff_key, DiffRange, IDiffEntry, IDiffAddRange, IDiffRemoveRange, IDiffPatch
} from './diffutil';
    
import {
    diffOutput, PatchResult, stringify, DiffOp
} from './patch';


// DIFF MODELS:

export interface IDiffModel {
    base: string;
    remote: string;
    
    additions: DiffRange[];
    deletions: DiffRange[];
    
    unchanged: boolean;
}

export class DiffModel implements IDiffModel {
    constructor(
        public base: string,
        public remote:string,
        public additions: DiffRange[],
        public deletions: DiffRange[]) {
        }
    
    get unchanged(): boolean {
        return this.base == this.remote;
        //return !this.additions && !this.deletions;
    }
}

/**
 * CellDiffEntry
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
        var additions: DiffRange[] = [];
        var deletions: DiffRange[] = []
        if (base === null) {
            // Added cell
            additions.push(new DiffRange(0, remote_str.length));
        } else if (remote === null) {
            // Deleted cell
            deletions.push(new DiffRange(0, base_str.length));
        }
        super(base_str, remote_str, additions, deletions);
    }
}


export type Chunk = {from: number, to: number, additions: DiffRange[], deletions: DiffRange[]};

export interface IDiffViewModel {
    base: IEditorModel;
    our: IEditorModel;
    
    additions: DiffRange[];
    deletions: DiffRange[];
    
    getChunks(): Chunk[];
    
    unchanged(): boolean;
}

export class DiffViewModel implements IDiffViewModel {
    constructor(public base: IEditorModel, public our: IEditorModel,
                public additions: DiffRange[], public deletions: DiffRange[]) {
    }
    
    getChunks(): Chunk[] { 
    }

    unchanged(): boolean {
        return this.additions.length == 0 && this.deletions.length == 0;
    }
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
        let base = !!this.source.base
        let remote = !this.unchanged && !!this.source.remote;
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
            return new DiffViewModel(edit, null, [], []);
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