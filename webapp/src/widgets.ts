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
    ICellDiffModel, INotebookDiffModel, NotebookDiffModel, IDiffModel
} from './model';

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
 * MetadataWidget
 */
export
class MetadataDiffWidget extends Widget {
    constructor(model: IDiffModel, rendermime: RenderMime<Widget>) {
        super();
        this._model = model;
        this._rendermime = rendermime;
        this.layout = new PanelLayout();
    }

    private _model: IDiffModel;
    private _rendermime: RenderMime<Widget> = null;
}

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
        layout.addChild(new MetadataDiffWidget(model.metadata, rendermime));
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
 * CellDiffRowWidget
 */
class CellDiffRowWidget extends Widget {
    constructor() {
        super();
        this.layout = new PanelLayout();
    }
    
    addWidget(widget: Widget) {
        (this.layout as PanelLayout).addChild(widget);
        this.widgets.push(widget);
    }
    
    widgets: Widget[] = [];
}


export
class CodeMirrorWidget extends Widget {
    /**
     * Construct a CodeMirror widget.
     */
    constructor(model: IEditorModel) {
        super();
        this.addClass(EDITOR_CLASS);
        this.addClass(CODEMIRROR_CLASS);
        this.editor = CodeMirror(this.node);
        let doc = this.editor.getDoc();
        doc.setValue(model.text);
        this._needsUpdate = true;
        this.editor.setOption('readOnly', 'nocursor');
    }
    
    public highlight(ranges: DiffRange[], clsCh: string, clsLine: string) {
        let doc = this.editor.getDoc();
        for (var r of ranges) {
            let fp = doc.posFromIndex(r.from);
            let tp = doc.posFromIndex(r.to);
            doc.markText(fp, tp, {className: clsCh});
            for (var i=fp.line; i<=tp.line; i++) {
                this.editor.addLineClass(i, "wrap", clsLine);
            }
        }
    }
    
    /**
     * Handle afterAttach messages.
     */
    protected onAfterAttach(msg: Message): void {
        if (this._needsUpdate) this.update();
        this.editor.refresh();
    }

    /**
     * A message handler invoked on an `'after-show'` message.
     */
    protected onAfterShow(msg: Message): void {
        if (this._needsUpdate) this.update();
        this.editor.refresh();
    }
    
    /**
     * Handle resize messages.
     */
    protected onResize(msg: ResizeMessage): void {
        if (msg.width < 0 || msg.height < 0) {
        this.editor.refresh();
        } else {
        this.editor.setSize(msg.width, msg.height);
        }
    }
    
    protected editor: CodeMirror.Editor;
    protected _needsUpdate = false;
}


/**
 * CellDiffWidget
 */
export
class CellDiffWidget extends Panel {
    /**
     * Create a new input widget.
     */
    static createEditor(model: IEditorModel): CodeMirrorWidget {
        return new CodeMirrorWidget(model);
    }
    
    constructor(model: ICellDiffModel, rendermime: RenderMime<Widget>) {
        super();
        this.addClass(CELLDIFF_CLASS);
        this._model = model;
        this._rendermime = rendermime;
        let constructor = this.constructor as typeof CellDiffWidget;
        
        // Add "cell added/deleted" notifiers, as appropriate
        var io_col = 0;
        if (model.added) {
            let widget = new Widget();
            widget.node.textContent = "Cell added";
            this.addWidget(widget, 0, 0, Infinity);
            io_col = 1;
            this.addClass(CELLADDED_CLASS);
        } else if (model.deleted) {
            let widget = new Widget();
            widget.node.textContent = "Cell deleted";
            this.addWidget(widget, 0, 1, Infinity);
            this.addClass(CELLDELETED_CLASS);
        } else if (model.unchanged) {
            this.addClass(CELLUNCHANGED_CLASS);
        } else {
            this.addClass(CELLTWOWAY_CLASS);
        }
        
        // Add inputs and outputs, on a row-by-row basis
        let sourceRowWidget = new CellDiffRowWidget();
        let metadataRowWidget = new CellDiffRowWidget();
        let outputsRowWidget = new CellDiffRowWidget();
        
        sourceRowWidget.addClass(SOURCE_ROW_CLASS);
        metadataRowWidget.addClass(METADATA_ROW_CLASS);
        outputsRowWidget.addClass(OUTPUTS_ROW_CLASS);
        
        for (var i = 0; i < model.source_editors.length; i++) {
            var w = model.source_editors[i];
            let inp = constructor.createEditor(w);
            sourceRowWidget.addWidget(inp);
            inp.addClass(DIFF_CLASSES[i]);
            this._widget_lookup["source" + i] = inp;
        }
        this.addWidget(sourceRowWidget, 0, io_col);
        
        if (model.metadata && !model.metadata.unchanged) {
            for (var i = 0; i < model.metadata_editors.length; i++) {
                var w = model.metadata_editors[i];
                let inp = constructor.createEditor(w);
                metadataRowWidget.addWidget(inp);
                inp.addClass(DIFF_CLASSES[i]);
            this._widget_lookup["metadata" + i] = inp;
            }
            this.addWidget(metadataRowWidget, 1, io_col);
        }
        
        if (model.outputs && !model.outputs.unchanged) {
            for (var i = 0; i < model.outputs_editors.length; i++) {
                var w = model.outputs_editors[i];
                let inp = constructor.createEditor(w);
                outputsRowWidget.addWidget(inp);
                inp.addClass(DIFF_CLASSES[i]);
            this._widget_lookup["outputs" + i] = inp;
            }
            this.addWidget(outputsRowWidget, 2, io_col);
        }
        
        if (!model.added && !model.deleted && !model.unchanged) {
            this.highlight();
        }
    }
    
    public highlight(): void {
        for (var s of ["source", "metadata", "outputs"]) {
            if (this.model[s] && !this.model[s].unchanged) {
                var editor = this._widget_lookup[s + "0"];
                if (editor) {
                    editor.highlight(
                        this.model[s].deletions,
                        DELETED_CHARS,
                        DELETED_LINES
                    );
                }
                
                var editor = this._widget_lookup[s + "1"];
                if (editor) {
                    editor.highlight(
                        this.model[s].additions,
                        ADDED_CHARS,
                        ADDED_LINES
                    );
                }
            }
        }
        
    }
    
    public addWidget(widget: Widget, row: number, col: number, row_span?:number, col_span?: number) {
        let constructor = this.constructor as typeof CellDiffWidget;
        /*constructor.setRow(widget, row);
        constructor.setColumn(widget, col);
        if (row_span) {
            constructor.setRowSpan(widget, row_span);
        }
        if (col_span) {
            constructor.setColumnSpan(widget, col_span);
        }*/
        this._widgets.push(widget);
        (this.layout as PanelLayout).addChild(widget);
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
    
    protected _model: ICellDiffModel = null;
    protected _rendermime: RenderMime<Widget> = null;
    protected _widgets: Widget[] = [];
    protected _widget_lookup: { [key: string]: CodeMirrorWidget} = {};
}