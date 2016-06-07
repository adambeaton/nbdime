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
    DiffView, MergeView, MergeViewEditorConfiguration
} from './mergeview';

import {
    IEditorModel
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
    IDiffEntry, DiffRangeRaw, DiffRangePos
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


const COLLAPISBLE_HEADER = 'jp-Collapsible-header';
const COLLAPISBLE_HEADER_ICON = 'jp-Collapsible-header-icon';
const COLLAPISBLE_HEADER_ICON_OPEN = 'jp-Collapsible-header-icon-opened';
const COLLAPISBLE_HEADER_ICON_CLOSED = 'jp-Collapsible-header-icon-closed';
const COLLAPISBLE_SLIDER = 'jp-Collapsible-slider';
const COLLAPSIBLE_OPEN = 'jp-Collapsible-opened';
const COLLAPSIBLE_CLOSED = 'jp-Collapsible-closed';
const COLLAPSIBLE_CONTAINER = 'jp-Collapsible-container';



/**
 * CollapsiblePanel
 */
class CollapsibleWidget extends Widget {
    static createHeader(headerTitle?: string): HTMLSpanElement {
        let header = document.createElement("div");
        header.className = COLLAPISBLE_HEADER;
        if (headerTitle) {
            //let title = document.createElement("span");
            header.innerText = headerTitle;
            //header.appendChild(title);
        }
        let button = document.createElement("span");
        button.className = COLLAPISBLE_HEADER_ICON;
        header.appendChild(button)
        
        return header;
    }
    
    constructor(public inner: Widget, headerTitle?: string, collapsed?: boolean) {
        super();
        let constructor = this.constructor as typeof CollapsibleWidget;
        let header = constructor.createHeader(headerTitle);
        this.button = header.getElementsByClassName(COLLAPISBLE_HEADER_ICON)[0] as HTMLElement;
        header.onclick = this.toggleCollapsed.bind(this);
        this.node.appendChild(header);
        this.container = document.createElement("div");
        this.container.className = COLLAPSIBLE_CONTAINER;
        this.slider = document.createElement("div");
        this.slider.classList.add(COLLAPISBLE_SLIDER);
        this.slider.appendChild(inner.node)
        this.container.appendChild(this.slider);
        this.node.appendChild(this.container);
        
        this.slider.classList.add(collapsed === true ? COLLAPSIBLE_CLOSED : COLLAPSIBLE_OPEN);
        this.button.classList.add(collapsed === true ? COLLAPISBLE_HEADER_ICON_CLOSED : COLLAPISBLE_HEADER_ICON_OPEN);
    }
    
    toggleCollapsed(): void {
        let slider = this.slider;
        if (this.collapsed) {
            slider.classList.remove(COLLAPSIBLE_CLOSED);
            slider.classList.add(COLLAPSIBLE_OPEN);
            
        } else {
            slider.classList.remove(COLLAPSIBLE_OPEN);
            slider.classList.add(COLLAPSIBLE_CLOSED);
        }
    }
    
    get collapsed(): boolean {
        return this.slider.classList.contains(COLLAPSIBLE_CLOSED);
    }
    
    slider: HTMLElement;
    container: HTMLElement;
    button: HTMLElement;
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
        let layout = this.layout = new PanelLayout();
        
        this.addClass(NBDIFF_CLASS);
        
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
     * Create a new collapsible view.
     */
    static createCollapsibleView(model: IDiffViewModel, editorClasses: string[],
            header?: string, collapsed?: boolean): CollapsibleWidget {
        let view = new NbdimeMergeView(model, editorClasses);
        let collapser = new CollapsibleWidget(view, header, collapsed);
        return collapser;
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
        let sourceView = constructor.createView(model.sourceView, CURR_DIFF_CLASSES);
        sourceView.addClass(SOURCE_ROW_CLASS);
        this.addWidget(sourceView);
        
        if (model.metadata && !model.metadata.unchanged) {
            let metadataCollapser = constructor.createCollapsibleView(
                model.metadataView, CURR_DIFF_CLASSES, "Metadata changed", true);
            metadataCollapser.addClass(METADATA_ROW_CLASS);
            this.addWidget(metadataCollapser);
        }
        if (model.outputs && !model.outputs.unchanged) {
            let outputsView = constructor.createCollapsibleView(
                model.outputsView, CURR_DIFF_CLASSES, "Output changed", false);
            outputsView.addClass(OUTPUTS_ROW_CLASS);
            this.addWidget(outputsView);
        }
    }
    
    public addWidget(widget: Widget) {
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
}

/**
 * NbdimeMergeView
 */
class NbdimeMergeView extends Widget {
    constructor(remote: IDiffViewModel, editorClasses: string[],
                local?: IDiffViewModel, merged?: IEditorModel) {
        super();
        let opts: MergeViewEditorConfiguration = {remote: remote};
        opts.collapseIdentical = true;
        opts.local = local ? local : null;
        opts.merged = merged ? merged : null;
        this._mergeview = new MergeView(this.node, opts);
        this._editors = [];
        if (this._mergeview.left) {
            this._editors.push(this._mergeview.left);
        }
        if (this._mergeview.right) {
            this._editors.push(this._mergeview.right);
        }
        if (this._mergeview.merge) {
            this._editors.push(this._mergeview.merge);
        }
    }
    
    protected _models: IEditorModel[];
    protected _mergeview: MergeView;
    protected _editors: DiffView[];
}