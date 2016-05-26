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

export interface ICellDiffModel {
    source: IDiffModel;
    metadata: IDiffModel;
    outputs: IDiffModel;
    
    unchanged: boolean;
    added: boolean;
    deleted: boolean;
    
    // All of these will have one local, and one remote model, although one entry may be null
    source_editors: IEditorModel[];
    metadata_editors: IEditorModel[];
    outputs_editors: IEditorModel[];
    output_areas: IOutputAreaModel[];
}



/**
 * CellDiffModel
 */
export class BaseCellDiffModel implements ICellDiffModel {
    initIOAreas() {
        if (this.unchanged) {
            // No changes, make only one editor
            this.createInputs(1);
            this.source_editors[0].text = this.source.base;
            if (this.metadata) {
                this.metadata_editors[0].text = this.metadata.base;
            }
            if (this.outputs) {
                this.outputs_editors[0].text = this.outputs.base;
            }
        } else if (!this.source.remote) {
            // Cell deleted
            this.createInputs(1);
            this.source_editors[0].text = this.source.base;
            if (this.metadata) {
                this.metadata_editors[0].text = this.metadata.base;
            }
            if (this.outputs) {
                this.outputs_editors[0].text = this.outputs.base;
            }
        } else if (!this.source.base) {
            // Cell added
            this.createInputs(1);
            this.source_editors[0].text = this.source.remote;
            if (this.metadata) {
                this.metadata_editors[0].text = this.metadata.remote;
            }
            if (this.outputs) {
                this.outputs_editors[0].text = this.outputs.remote;
            }
        } else {
            // Partial changes
            this.createInputs(2);
            this.source_editors[0].text = this.source.base;
            this.source_editors[1].text = this.source.remote;
            if (this.metadata) {
                this.metadata_editors[0].text = this.metadata.base;
                this.metadata_editors[1].text = this.metadata.remote;
            }
            if (this.outputs) {
                this.outputs_editors[0].text = this.outputs.base;
                this.outputs_editors[1].text = this.outputs.remote;
            }
        }
    }
    
    createInputs(n_columns: number) {
        for (var i=0; i < n_columns; i++) {
            var editor = new EditorModel({readOnly: true});
            this.source_editors.push(editor);
            
            if (this.metadata) {
                editor = new EditorModel();
                this.metadata_editors.push(editor);
            }
            if (this.outputs) {
                editor = new EditorModel();
                this.outputs_editors.push(editor);
                
                this.output_areas.push(new OutputAreaModel());
            }
        }
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
    source_editors: IEditorModel[] = [];
    metadata_editors: IEditorModel[] = [];
    outputs_editors: IEditorModel[] = [];
    output_areas: IOutputAreaModel[] = [];
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
        
        this.initIOAreas();
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
        
        this.initIOAreas();
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
        
        this.initIOAreas();
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
        
        this.initIOAreas();
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