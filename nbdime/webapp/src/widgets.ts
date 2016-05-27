// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
    RenderMime
} from 'jupyter-js-ui/lib/rendermime';

import {
    Widget, ResizeMessage
} from 'phosphor-widget';

import {
    Panel, PanelLayout
} from 'phosphor-panel';

import {
  Message
} from 'phosphor-messaging';

/*import {
    GridPanel
} from 'phosphor-gridpanel';*/

import * as CodeMirror from 'codemirror';

import {
    DiffView, MergeView
} from './mergeview';

import {
    IEditorModel, IEditorWidget
} from 'jupyter-js-notebook/lib/editor';

import {
    InputAreaWidget, InputAreaModel, IInputAreaModel
} from 'jupyter-js-notebook/lib/input-area';

import {
    MimeBundle
} from 'jupyter-js-notebook/lib/notebook/nbformat';

import {
    OutputAreaWidget, IOutputAreaModel
} from 'jupyter-js-notebook/lib/output-area';

import {
    IDiffEntry, DiffRange
} from './diffutil';

import {
    ICellDiffModel, INotebookDiffModel, NotebookDiffModel, IDiffModel,
    IDiffViewModel, DiffViewModel
} from './diffmodel';


const NBDIFF_CLASS = 'jp-Notebook-diff';

const CELLDIFF_CLASS = 'jp-Cell-diff';

const SOURCE_ROW_CLASS = 'jp-Cellrow-source';
const METADATA_ROW_CLASS = 'jp-Cellrow-metadata';
const OUTPUTS_ROW_CLASS = 'jp-Cellrow-outputs';

const CELLTWOWAY_CLASS = 'jp-Cell-twoway';
const CELLADDED_CLASS = 'jp-Cell-added';
const CELLDELETED_CLASS = 'jp-Cell-deleted';
const CELLUNCHANGED_CLASS = 'jp-Cell-unchanged';

const DIFF_CLASSES = ["jp-Cell-base", "jp-Cell-remote"];

const ADDED_CHARS = "nbdime-source-added";
const DELETED_CHARS = "nbdime-source-removed";
const ADDED_LINES = "nbdime-source-line-addition";
const DELETED_LINES = "nbdime-source-line-deletion";

/**
 * The class name added to Editor widget instances.
 */
const EDITOR_CLASS = 'jp-Editor';

/**
 * The class name added to CodeMirrorWidget instances.
 */
const CODEMIRROR_CLASS = 'jp-CodeMirror';

/**
 * NotebookDiffWidget
 */
export
class NotebookDiffWidget extends Widget {
    constructor(model: INotebookDiffModel, rendermime: RenderMime<Widget>) {
        super();
        this._model = model;
        this._rendermime = rendermime;
        this.layout = new PanelLayout();
        
        this.addClass(NBDIFF_CLASS);
        
        let layout = this.layout as PanelLayout;
        layout.addChild(new MetadataDiffWidget(model.metadata));
        for (var c of model.cells) {
            layout.addChild(new CellDiffWidget(c, rendermime));
        }
    }
    
    /**
     * Get the model for the widget.
     *
     * #### Notes
     * This is a read-only property.
     */
    get model(): INotebookDiffModel {
        return this._model;
    }
    
    private _model: INotebookDiffModel;
    private _rendermime: RenderMime<Widget> = null;
}


/**
 * MetadataWidget for changes to Notebook-level metadata
 */
export
class MetadataDiffWidget extends Widget {
    constructor(model: IDiffModel) {
        super();
        this._model = model;
        this.layout = new PanelLayout();
    }

    private _model: IDiffModel;
}

/**
 * CellDiffWidget for cell changes
 */
export
class CellDiffWidget extends Panel {
    /**
     * Create a new view.
     */
    static createView(model: IDiffViewModel, editorClasses: string[]): NbdimeMergeView {
        return new NbdimeMergeView(model, editorClasses);
    }

    /**
     * 
     */
    constructor(model: ICellDiffModel, rendermime: RenderMime<Widget>) {
        super();
        this.addClass(CELLDIFF_CLASS);
        this._model = model;
        this._rendermime = rendermime;
        
        this.init();
    }
    
    protected init() {
        let constructor = this.constructor as typeof CellDiffWidget;
        var model = this.model;

        // Add "cell added/deleted" notifiers, as appropriate
        var CURR_DIFF_CLASSES = DIFF_CLASSES.slice();  // copy
        if (model.added) {
            let widget = new Widget();
            widget.node.textContent = "Cell added";
            this.addWidget(widget);
            this.addClass(CELLADDED_CLASS);
            CURR_DIFF_CLASSES = DIFF_CLASSES.slice(0, 1);
        } else if (model.deleted) {
            let widget = new Widget();
            widget.node.textContent = "Cell deleted";
            this.addWidget(widget);
            this.addClass(CELLDELETED_CLASS);
            CURR_DIFF_CLASSES = DIFF_CLASSES.slice(1, 2);
        } else if (model.unchanged) {
            this.addClass(CELLUNCHANGED_CLASS);
        } else {
            this.addClass(CELLTWOWAY_CLASS);
        }
        
        // Add inputs and outputs, on a row-by-row basis
        let sourceView = constructor.createView(model.source_editors, CURR_DIFF_CLASSES);
        sourceView.addClass(SOURCE_ROW_CLASS);
        this.addView(sourceView);
        
        if (model.metadata && !model.metadata.unchanged) {
            let metadataView = constructor.createView(model.metadata_editors, CURR_DIFF_CLASSES);
            metadataView.addClass(METADATA_ROW_CLASS);
            this.addView(metadataView);
        }
        if (model.outputs && !model.outputs.unchanged) {
            let outputsView = constructor.createView(model.outputs_editors, CURR_DIFF_CLASSES);
            outputsView.addClass(OUTPUTS_ROW_CLASS);
            this.addView(outputsView);
        }
    }
    
    public addWidget(widget: Widget) {
        (this.layout as PanelLayout).addChild(widget);
    }
    
    public addView(view: NbdimeMergeView) {
        this._views.push(view);
        (this.layout as PanelLayout).addChild(view);
    }
    
    /**
     * Get the model for the widget.
     *
     * #### Notes
     * This is a read-only property.
     */
    get model(): ICellDiffModel {
        return this._model;
    }
    
    get views(): NbdimeMergeView[] {
        return this._views;
    }
    
    protected _model: ICellDiffModel = null;
    protected _rendermime: RenderMime<Widget> = null;
    protected _views: NbdimeMergeView[] = [];
}

/**
 * NbdimeMergeView
 */
class NbdimeMergeView extends Widget {
    constructor(models: IEditorModel[], editorClasses: string[]) {
        super();
        if (models.length == 1) {
            
        }
        let opts: CodeMirror.MergeView.MergeViewEditorConfiguration = {orig: null};
        opts.allowEditingOriginals = false;
        opts.readOnly = 'nocursor';
        opts.collapseIdentical = true;
        if (models.length === 1) {
            opts.value = models[0].text;
        } else if (models.length === 2) {
            opts.origLeft = models[0].text;
            opts.value = models[1].text;
        } else if (models.length === 3) {
            opts.origLeft = models[0].text;
            opts.value = models[1].text;
            opts.origRight = models[2].text;
        }
        this._mergeview = new MergeView(this.node, opts);
        this._editors = [];
        if (this._mergeview.left) {
            this._editors.push(this._mergeview.left);
        }
        if (this._mergeview.right) {
            this._editors.push(this._mergeview.right);
        }
        for (var edt of this._editors) {
           
        }
    }
    
    protected _models: IEditorModel[];
    protected _mergeview: MergeView;
    protected _editors: DiffView[];
}