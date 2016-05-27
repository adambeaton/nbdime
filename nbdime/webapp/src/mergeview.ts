// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

// declare global: DIFF_INSERT, DIFF_DELETE, DIFF_EQUAL


"use strict";

import * as CodeMirror from 'codemirror';

import {
    IEditorModel
} from 'jupyter-js-notebook/lib/editor';

import {
    IDiffViewModel, Chunk
} from './diffmodel';

var Pos = CodeMirror.Pos;
var svgNS = "http://www.w3.org/2000/svg";

 
enum DIFF_OP {
    DIFF_DELETE = -1,
    DIFF_INSERT = 1,
    DIFF_EQUAL = 0
}

enum EventDirection {
    INCOMING,
    OUTGOING
}

type GDiffEntry = [DIFF_OP, string];
type GDiff = GDiffEntry[];
type DiffClasses = {chunk: string, start: string, end: string, insert: string, del: string, connect: string};


var updating = false;

export
class DiffView {
    constructor(public model: IDiffViewModel, public type: string) {
        this.classes = type == "left"
            ? { chunk: "CodeMirror-merge-l-chunk",
                start: "CodeMirror-merge-l-chunk-start",
                end: "CodeMirror-merge-l-chunk-end",
                insert: "CodeMirror-merge-l-inserted",
                del: "CodeMirror-merge-l-deleted",
                connect: "CodeMirror-merge-l-connect"}
            : { chunk: "CodeMirror-merge-r-chunk",
                start: "CodeMirror-merge-r-chunk-start",
                end: "CodeMirror-merge-r-chunk-end",
                insert: "CodeMirror-merge-r-inserted",
                del: "CodeMirror-merge-r-deleted",
                connect: "CodeMirror-merge-r-connect"};
    }
    
    init(pane: HTMLElement, options: CodeMirror.MergeView.MergeViewEditorConfiguration) {
        this.edit = this.mv.edit;
        (this.edit.state.diffViews || (this.edit.state.diffViews = [])).push(this);
        let orig = this.model.our.text;
        this.orig = CodeMirror(pane, copyObj({value: orig, readOnly: !this.mv.options.allowEditingOriginals}, copyObj(options)));
        this.orig.state.diffViews = [this];

        this.chunks = this.model.getChunks();
        this.dealigned = false;

        this.showDifferences = options.showDifferences !== false;
        this.forceUpdate = this.registerUpdate();
        this.setScrollLock(true, false);
        this.registerScroll();
    }
    
    setShowDifferences(val) {
        val = val !== false;
        if (val != this.showDifferences) {
        this.showDifferences = val;
        this.forceUpdate("full");
        }
    }
    
    registerUpdate() {
        var edit = {from: 0, to: 0, marked: []};
        var orig = {from: 0, to: 0, marked: []};
        var debounceChange, updatingFast = false;
        function update(mode?: string) {
            updating = true;
            updatingFast = false;
            if (mode == "full") {
                if (this.svg) clear(this.svg);
                if (this.copyButtons) clear(this.copyButtons);
                //clearMarks(this.edit, edit.marked, this.classes);
                //clearMarks(this.orig, orig.marked, this.classes);
                edit.from = edit.to = orig.from = orig.to = 0;
            }
            if (this.showDifferences) {
                //updateMarks(this.edit, this.diff, edit, DIFF_OP.DIFF_INSERT, this.classes);
                //updateMarks(this.orig, this.diff, orig, DIFF_OP.DIFF_DELETE, this.classes);
            }

            if (this.mv.options.connect == "align")
            this.alignChunks();
            this.updating = false;
        }
        function setDealign(fast) {
            if (updating) return;
            this.dealigned = true;
            set(fast);
        }
        function set(fast) {
            if (updating || updatingFast) return;
            clearTimeout(debounceChange);
            if (fast === true) updatingFast = true;
            debounceChange = setTimeout(update, fast === true ? 20 : 250);
        }
        this.edit.on("markerAdded", setDealign);
        this.edit.on("markerCleared", setDealign);
        this.orig.on("markerAdded", setDealign);
        this.orig.on("markerCleared", setDealign);
        this.edit.on("viewportChange", function() { set(false); });
        this.orig.on("viewportChange", function() { set(false); });
        update();
        return update;
    }

    
    alignChunks(force) {
        if (!this.dealigned && !force) return;
        if (!this.orig.curOp) return this.orig.operation(function() {
            this.alignChunks(force);
        });

        this.dealigned = false;
        var other = this.mv.left == this ? this.mv.right : this.mv.left;
        if (other) {
            other.dealigned = false;
        }
        var linesToAlign = findAlignedLines(this, other);

        // Clear old aligners
        var aligners = this.mv.aligners;
        for (var i = 0; i < aligners.length; i++)
            aligners[i].clear();
        aligners.length = 0;

        var cm = [this.orig, this.edit], scroll = [];
        if (other) cm.push(other.orig);
        for (var i = 0; i < cm.length; i++)
            scroll.push(cm[i].getScrollInfo().top);

        for (var ln = 0; ln < linesToAlign.length; ln++)
            alignLines(cm, linesToAlign[ln], aligners);

        for (var i = 0; i < cm.length; i++)
            cm[i].scrollTo(null, scroll[i]);
    }
    
    buildGap(): HTMLElement {
        var lock = this.lockButton = elt("div", null, "CodeMirror-merge-scrolllock");
        lock.title = "Toggle locked scrolling";
        var lockWrap = elt("div", [lock], "CodeMirror-merge-scrolllock-wrap");
        CodeMirror.on(lock, "click", function() { this.setScrollLock(!this.lockScroll); });
        var gapElts = [lockWrap];
        if (this.mv.options.revertButtons !== false) {
            this.copyButtons = elt("div", null, "CodeMirror-merge-copybuttons-" + this.type);
            CodeMirror.on(this.copyButtons, "click", function(e) {
                var node = e.target || e.srcElement;
                if (!node.chunk) return;
                if (node.className == "CodeMirror-merge-copy-reverse") {
                    copyChunk(this, this.orig, this.edit, node.chunk);
                    return;
                }
                copyChunk(this, this.edit, this.orig, node.chunk);
            });
            gapElts.unshift(this.copyButtons);
        }

        return this.gap = elt("div", gapElts, "CodeMirror-merge-gap");
    }
    
    registerScroll(): void {
        this.edit.on("scroll", function() {
            this.syncScroll(EventDirection.INCOMING);
        });
        this.orig.on("scroll", function() {
            this.syncScroll(EventDirection.OUTGOING);
        });
    }

    /**
     * Sync scrolling between `edit` and `orig`. `type` is used to indicate which
     * editor is the source, and which editor is the destination of the sync.
     */
    syncScroll(type: EventDirection): void {
        if (!this.lockScroll) return;
        // editor: What triggered event, other: What needs to be synced
        var editor, other, now = +new Date;
        if (type == EventDirection.INCOMING) { editor = this.edit; other = this.orig; }
        else { editor = this.orig; other = this.edit; }
        
        other.state.scrollPosition = editor.getScrollInfo();
        
        // If ticking, we already have a scroll queued
        if (other.state.scrollTicking) return;
        var sInfo = other.getScrollInfo();
        // Don't queue an event if already synced.
        if (other.state.scollPosition.top == sInfo.top && other.state.scollPosition.left == sInfo.left) return;
        // Throttle by requestAnimationFrame().
        // If event is outgoing, this will lead to a one frame delay of other DiffViews
        window.requestAnimationFrame(function() {
            other.scrollTo(other.state.scrollPosition.left, other.state.scrollPosition.top);
            other.state.scrollTicking = false;
        });
        other.state.scrollTicking = true;
        return;
    }

    setScrollLock(val, action) {
        this.lockScroll = val;
        if (val && action != false) this.syncScroll(EventDirection.INCOMING);
        this.lockButton.innerHTML = val ? "\u21db\u21da" : "\u21db&nbsp;&nbsp;\u21da";
    }
    
    classes: DiffClasses;
    showDifferences: boolean;
    dealigned: boolean;
    forceUpdate: Function;
    orig: CodeMirror.Editor;
    edit: CodeMirror.Editor;
    chunks: Chunk[];
    copyButtons: HTMLElement;
    lockButton: HTMLElement;
    gap: HTMLElement;
    lockScroll: boolean;
}


function getOffsets(editor, around) {
    var bot = around.after;
    if (bot == null) bot = editor.lastLine() + 1;
    return {top: editor.heightAtLine(around.before || 0, "local"),
            bot: editor.heightAtLine(bot, "local")};
}


// Updating the gap between editor and original


function getMatchingOrigLine(editLine: number, chunks: Chunk[]): number {
    var editStart = 0, origStart = 0;
    for (var i = 0; i < chunks.length; i++) {
        var chunk = chunks[i];
        if (chunk.editTo > editLine && chunk.editFrom <= editLine) return null;
        if (chunk.editFrom > editLine) break;
        editStart = chunk.editTo;
        origStart = chunk.origTo;
    }
    return origStart + (editLine - editStart);
}

function findAlignedLines(dv: DiffView, other: DiffView): number[][] {
    var linesToAlign: number[][] = [];
    for (var i = 0; i < dv.chunks.length; i++) {
        var chunk = dv.chunks[i];
        linesToAlign.push([chunk.origTo, chunk.editTo, other ? getMatchingOrigLine(chunk.editTo, other.chunks) : null]);
    }
    if (other) {
        for (var i = 0; i < other.chunks.length; i++) {
        var chunk = other.chunks[i];
        for (var j = 0; j < linesToAlign.length; j++) {
            var align = linesToAlign[j];
            if (align[1] == chunk.editTo) {
            j = -1;
            break;
            } else if (align[1] > chunk.editTo) {
            break;
            }
        }
        if (j > -1)
            linesToAlign.splice(j - 1, 0, [getMatchingOrigLine(chunk.editTo, dv.chunks), chunk.editTo, chunk.origTo]);
        }
    }
    return linesToAlign;
}


function alignLines(cm: CodeMirror.Editor[], lines: number[], aligners): void {
    var maxOffset = 0, offset = [];
    for (var i = 0; i < cm.length; i++) if (lines[i] !== null) {
        var off = cm[i].heightAtLine(lines[i], "local");
        offset[i] = off;
        maxOffset = Math.max(maxOffset, off);
    }
    for (var i = 0; i < cm.length; i++) if (lines[i] !== null) {
        var diff = maxOffset - offset[i];
        if (diff > 1)
        aligners.push(padAbove(cm[i], lines[i], diff));
    }
}

function padAbove(cm: CodeMirror.Editor, line: number, size: number): CodeMirror.LineWidget {
    var above = true;
    if (line > cm.getDoc().lastLine()) {
        line--;
        above = false;
    }
    var elt = document.createElement("div");
    elt.className = "CodeMirror-merge-spacer";
    elt.style.height = size + "px"; elt.style.minWidth = "1px";
    return cm.addLineWidget(line, elt, {height: size, above: above});
}

function copyChunk(dv: DiffView, to: CodeMirror.Doc, from: CodeMirror.Doc, chunk: Chunk): void {
    var editStart = chunk.editTo > to.lastLine() ? Pos(chunk.editFrom - 1) : Pos(chunk.editFrom, 0);
    var origStart = chunk.origTo > from.lastLine() ? Pos(chunk.origFrom - 1) : Pos(chunk.origFrom, 0);
    to.replaceRange(from.getRange(origStart, Pos(chunk.origTo, 0)), editStart, Pos(chunk.editTo, 0));
}

interface MergeViewEditorConfiguration extends CodeMirror.EditorConfiguration {
    /**
     * When true stretches of unchanged text will be collapsed. When a number is given, this indicates the amount
     * of lines to leave visible around such stretches (which defaults to 2). Defaults to false.
     */
    collapseIdentical?: boolean | number;

    /**
     * Callback for when stretches of unchanged text are collapsed.
     */
    onCollapse?(mergeView: MergeViewEditor, line: number, size: number, mark: TextMarker): void;

    /**
     * Provides remote diff of document to be shown on the right of the base.
     * To create a diff view, provide only remote.
     */
    remote: IDiffViewModel;

    /**
     * Provides local diff of the document to be shown on the left of the base.
     * To create a diff view, omit local.
     */
    local?: IDiffViewModel;
    
    /**
     * Provides the partial merge input for a three-way merge.
     */
    merged?: IEditorModel;

    /**
     * When true, changed pieces of text are highlighted. Defaults to true.
     */
    showDifferences?: boolean;
}

// Merge view, containing 0, 1, or 2 diff views.
export
class MergeView {
    constructor(node: Node, options: MergeViewEditorConfiguration) {
        this.options = options;
        var remote = options.remote;
        var local = options.local;
        var merged = options.merged;
        
        var hasLeft = local !== null, hasMerge = hasLeft && merged !== null;
        var hasRight = !remote.unchanged();
        var panes = 2 + (hasLeft ? 1 : 0) + (hasMerge ? 1 : 0);
        var wrap = [], left = this.left = null, right = this.right = null;
        var self = this;
        
        console.assert(remote.base == local.base)

        if (hasLeft) {
            left = this.left = new DiffView(local, "left");
            var leftPane = elt("div", null, "CodeMirror-merge-pane");
            wrap.push(leftPane);
            wrap.push(left.buildGap());
        }

        var editPane = elt("div", null, "CodeMirror-merge-pane");
        wrap.push(editPane);

        if (hasRight) {
            right = this.right = new DiffView(remote, "right");
            wrap.push(right.buildGap());
            var rightPane = elt("div", null, "CodeMirror-merge-pane");
            wrap.push(rightPane);
        }

        (hasRight ? rightPane : editPane).className += " CodeMirror-merge-pane-rightmost";

        wrap.push(elt("div", null, null, "height: 0; clear: both;"));

        var wrapElt = this.wrap = node.appendChild(elt("div", wrap, "CodeMirror-merge CodeMirror-merge-" + panes + "pane"));
        this.edit = CodeMirror(editPane, copyObj(options));

        if (left) left.init(leftPane, origLeft, options);
        if (right) right.init(rightPane, origRight, options);

        if (options.collapseIdentical)
            this.editor().operation(function() {
            collapseIdenticalStretches(self, options.collapseIdentical);
            });
        if (options.connect == "align") {
            this.aligners = [];
            (this.left || this.right).alignChunks(true);
        }
    }
    
    
    
    editor() { return this.edit; }
    rightOriginal() { return this.right && this.right.orig; }
    leftOriginal() { return this.left && this.left.orig; }
    setShowDifferences(val) {
        if (this.right) this.right.setShowDifferences(val);
        if (this.left) this.left.setShowDifferences(val);
    }
    rightChunks() {
        if (this.right) { return this.right.chunks; }
    }
    leftChunks() {
        if (this.left) { return this.left.chunks; }
    }
    
    left: DiffView;
    right: DiffView;
    wrap: Node;
    edit: CodeMirror.Editor;
    options: any;
    aligners: CodeMirror.LineWidget[];
}

function asString(obj: string | CodeMirror.Editor): string {
    if (typeof obj == "string") return obj as string;
    else return (obj as CodeMirror.Editor).getValue();
}

/**
 * 
 */
function endOfLineClean(diff: GDiff, i: number): boolean {
    if (i == diff.length - 1) return true;
    var next = diff[i + 1][1];
    if (next.length == 1 || next.charCodeAt(0) != 10) return false;
    if (i == diff.length - 2) return true;
    next = diff[i + 2][1];
    return next.length > 1 && next.charCodeAt(0) == 10;
}

function startOfLineClean(diff: GDiff, i: number): boolean {
    if (i === 0) return true;
    var last = diff[i - 1][1];
    if (last.charCodeAt(last.length - 1) != 10) return false;
    if (i == 1) return true;
    last = diff[i - 2][1];
    return last.charCodeAt(last.length - 1) == 10;
}

function chunkBoundariesAround(chunks: Chunk[], n: number, nInEdit: boolean): {
            edit: {before: number, after: number}, orig: {before: number, after: number}} {
    var beforeE, afterE, beforeO, afterO;
    for (var i = 0; i < chunks.length; i++) {
        var chunk = chunks[i];
        var fromLocal = nInEdit ? chunk.editFrom : chunk.origFrom;
        var toLocal = nInEdit ? chunk.editTo : chunk.origTo;
        if (afterE === null) {
        if (fromLocal > n) { afterE = chunk.editFrom; afterO = chunk.origFrom; }
        else if (toLocal > n) { afterE = chunk.editTo; afterO = chunk.origTo; }
        }
        if (toLocal <= n) { beforeE = chunk.editTo; beforeO = chunk.origTo; }
        else if (fromLocal <= n) { beforeE = chunk.editFrom; beforeO = chunk.origFrom; }
    }
    return {edit: {before: beforeE, after: afterE}, orig: {before: beforeO, after: afterO}};
}

function collapseSingle(cm: CodeMirror.Editor, from: number, to: number): {mark: CodeMirror.TextMarker, clear: () => void} {
    cm.addLineClass(from, "wrap", "CodeMirror-merge-collapsed-line");
    var widget = document.createElement("span");
    widget.className = "CodeMirror-merge-collapsed-widget";
    widget.title = "Identical text collapsed. Click to expand.";
    var mark = cm.getDoc().markText(Pos(from, 0), Pos(to - 1), {
        inclusiveLeft: true,
        inclusiveRight: true,
        replacedWith: widget,
        clearOnEnter: true
    });
    function clear() {
        mark.clear();
        cm.removeLineClass(from, "wrap", "CodeMirror-merge-collapsed-line");
    }
    CodeMirror.on(widget, "click", clear);
    return {mark: mark, clear: clear};
}

function collapseStretch(size: number, editors: {line: number, cm: CodeMirror.Editor}[]): CodeMirror.TextMarker {
    var marks = [];
    function clear() {
        for (var i = 0; i < marks.length; i++) marks[i].clear();
    }
    for (var i = 0; i < editors.length; i++) {
        var editor = editors[i];
        var mark = collapseSingle(editor.cm, editor.line, editor.line + size);
        marks.push(mark);
        (mark.mark as any).on("clear", clear);
    }
    return marks[0].mark;
}

function unclearNearChunks(dv: DiffView, margin: number, off: number, clear: boolean[]): void {
    for (var i = 0; i < dv.chunks.length; i++) {
        var chunk = dv.chunks[i];
        for (var l = chunk.editFrom - margin; l < chunk.editTo + margin; l++) {
            var pos = l + off;
            if (pos >= 0 && pos < clear.length) clear[pos] = false;
        }
    }
}

function collapseIdenticalStretches(mv: MergeView, margin: boolean | number): void {
    if (typeof margin != "number") margin = 2;
    var clear = [], edit = mv.editor(), off = edit.getDoc().firstLine();
    for (var l = off, e = edit.getDoc().lastLine(); l <= e; l++) clear.push(true);
    if (mv.left) unclearNearChunks(mv.left, margin as number, off, clear);
    if (mv.right) unclearNearChunks(mv.right, margin as number, off, clear);

    for (var i = 0; i < clear.length; i++) {
        if (clear[i]) {
            var line = i + off;
            for (var size = 1; i < clear.length - 1 && clear[i + 1]; i++, size++) {}
            if (size > margin) {
                var editors = [{line: line, cm: edit}];
                if (mv.left) editors.push({line: getMatchingOrigLine(line, mv.left.chunks), cm: mv.left.orig});
                if (mv.right) editors.push({line: getMatchingOrigLine(line, mv.right.chunks), cm: mv.right.orig});
                var mark = collapseStretch(size, editors);
                if (mv.options.onCollapse) mv.options.onCollapse(mv, line, size, mark);
            }
        }
    }
}

// General utilities

function elt(tag: string, content?: string | HTMLElement[], className?: string, style?: string) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (style) e.style.cssText = style;
    if (typeof content == "string") e.appendChild(document.createTextNode(content as string));
    else if (content) for (var i = 0; i < content.length; ++i) e.appendChild((content as HTMLElement[])[i]);
    return e;
}

function clear(node: HTMLElement) {
    for (var count = node.childNodes.length; count > 0; --count)
        node.removeChild(node.firstChild);
}

function attrs(elt: HTMLElement) {
    for (var i = 1; i < arguments.length; i += 2)
        elt.setAttribute(arguments[i], arguments[i+1]);
}

function copyObj(obj: Object, target?: Object) {
    if (!target) target = {};
    for (var prop in obj) if (obj.hasOwnProperty(prop)) target[prop] = obj[prop];
    return target;
}

function posMin(a: CodeMirror.Position, b: CodeMirror.Position): CodeMirror.Position {
    return (a.line - b.line || a.ch - b.ch) < 0 ? a : b;
}
function posMax(a: CodeMirror.Position, b: CodeMirror.Position): CodeMirror.Position {
    return (a.line - b.line || a.ch - b.ch) > 0 ? a : b;
}
function posEq(a: CodeMirror.Position, b: CodeMirror.Position): boolean {
    return a.line == b.line && a.ch == b.ch;
}

function findPrevDiff(chunks: Chunk[], start: number, isOrig: boolean): number {
    for (var i = chunks.length - 1; i >= 0; i--) {
        var chunk = chunks[i];
        var to = (isOrig ? chunk.origTo : chunk.editTo) - 1;
        if (to < start) return to;
    }
}

function findNextDiff(chunks: Chunk[], start: number, isOrig: boolean): number {
    for (var i = 0; i < chunks.length; i++) {
        var chunk = chunks[i];
        var from = (isOrig ? chunk.origFrom : chunk.editFrom);
        if (from > start) return from;
    }
}

function goNearbyDiff(cm, dir): void | any {
    var found = null, views = cm.state.diffViews, line = cm.getCursor().line;
    if (views) for (var i = 0; i < views.length; i++) {
        var dv = views[i], isOrig = cm == dv.orig;
        var pos = dir < 0 ? findPrevDiff(dv.chunks, line, isOrig) : findNextDiff(dv.chunks, line, isOrig);
        if (pos !== null && (found === null || (dir < 0 ? pos > found : pos < found)))
        found = pos;
    }
    if (found !== null)
        cm.setCursor(found, 0);
    else
        return CodeMirror.Pass;
}

CodeMirror.commands.goNextDiff = function(cm) {
    return goNearbyDiff(cm, 1);
}
CodeMirror.commands.goPrevDiff = function(cm) {
    return goNearbyDiff(cm, -1);
}
