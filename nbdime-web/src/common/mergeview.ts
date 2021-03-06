// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// This code is based on the CodeMirror mergeview.js source:
// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

'use strict';

import * as CodeMirror from 'codemirror';

import {
  Widget, ResizeMessage
} from 'phosphor/lib/ui/widget';

import {
  Panel
} from 'phosphor/lib/ui/panel';

import {
  CodeMirrorWidget
} from 'jupyterlab/lib/codemirror/widget';

import {
  loadModeByMIME
} from 'jupyterlab/lib/codemirror';

import {
  IStringDiffModel
} from '../diff/model';

import {
  DecisionStringDiffModel
} from '../merge/model';

import {
  DiffRangePos
} from '../diff/range';

import {
  ChunkSource, Chunk, lineToNormalChunks
} from '../chunking';

import {
  valueIn
} from '../common/util';

import {
  Action
} from '../merge/decisions';


const PICKER_SYMBOL = '\u27ad';

const CONFLICT_MARKER = '\u26A0'; // '\u2757'


export enum DIFF_OP {
  DIFF_DELETE = -1,
  DIFF_INSERT = 1,
  DIFF_EQUAL = 0
}

export enum EventDirection {
  INCOMING,
  OUTGOING
}

type GDiffEntry = [DIFF_OP, string];
type GDiff = GDiffEntry[];
export type DiffClasses = {
  chunk: string,
  start: string,
  end: string,
  insert: string,
  del: string,
  connect: string,
  gutter: string
};


class Editor extends CodeMirrorWidget {
  /**
   * A message handler invoked on an `'resize'` message.
   */
  protected onResize(msg: ResizeMessage): void {
    if (msg.width < 0 || msg.height < 0) {
      this.editor.setSize();
    } else {
      super.onResize(msg);
    }
  }
}


const GUTTER_PICKER_CLASS = 'jp-Merge-gutter-picker';
const GUTTER_CONFLICT_CLASS = 'jp-Merge-gutter-conflict';

const CHUNK_CONFLICT_CLASS = 'jp-Merge-conflict';

const leftClasses: DiffClasses = { chunk: 'CodeMirror-merge-l-chunk',
          start: 'CodeMirror-merge-l-chunk-start',
          end: 'CodeMirror-merge-l-chunk-end',
          insert: 'CodeMirror-merge-l-inserted',
          del: 'CodeMirror-merge-l-deleted',
          connect: 'CodeMirror-merge-l-connect',
          gutter: 'CodeMirror-merge-l-gutter'};
const rightClasses: DiffClasses = { chunk: 'CodeMirror-merge-r-chunk',
          start: 'CodeMirror-merge-r-chunk-start',
          end: 'CodeMirror-merge-r-chunk-end',
          insert: 'CodeMirror-merge-r-inserted',
          del: 'CodeMirror-merge-r-deleted',
          connect: 'CodeMirror-merge-r-connect',
          gutter: 'CodeMirror-merge-r-gutter'};

const mergeClassPrefix: DiffClasses = {chunk: 'CodeMirror-merge-m-chunk',
          start: 'CodeMirror-merge-m-chunk-start',
          end: 'CodeMirror-merge-m-chunk-end',
          insert: 'CodeMirror-merge-m-inserted',
          del: 'CodeMirror-merge-m-deleted',
          connect: 'CodeMirror-merge-m-connect',
          gutter: 'CodeMirror-merge-m-gutter'};


/**
 * A wrapper view for showing StringDiffModels in a MergeView
 */
export
function createNbdimeMergeView(
      remote: IStringDiffModel, editorClasses: string[],
      local?: IStringDiffModel, merged?: IStringDiffModel): MergeView {
  let opts: IMergeViewEditorConfiguration = {remote: remote, orig: null};
  opts.collapseIdentical = true;
  opts.local = local ? local : null;
  opts.merged = merged ? merged : null;
  let mergeview = new MergeView(opts);
  let editors: DiffView[] = [];
  if (mergeview.left) {
    editors.push(mergeview.left);
  }
  if (mergeview.right) {
    editors.push(mergeview.right);
  }
  if (mergeview.merge) {
    editors.push(mergeview.merge);
  }

  if (remote.mimetype) {
    // Set the editor mode to the MIME type.
    for (let e of editors) {
      loadModeByMIME(e.orig, remote.mimetype);
    }
    loadModeByMIME(mergeview.base.editor, remote.mimetype);
  }
  return mergeview;
}


export
class DiffView {
  constructor(public model: IStringDiffModel, public type: string,
              public alignChunks: (force?: boolean) => void,
              options: CodeMirror.MergeView.MergeViewEditorConfiguration) {
    this.classes = type === 'left' ?
      leftClasses : type === 'right' ? rightClasses : null;
    let orig = this.model.remote || '';
    this.origWidget = new Editor(copyObj({value: orig}, copyObj(options)));
    this.showDifferences = options.showDifferences !== false;
  }

  init(edit: CodeMirror.Editor) {
    this.edit = edit;
    (this.edit.state.diffViews || (this.edit.state.diffViews = [])).push(this);
    this.orig.state.diffViews = [this];

    this.edit.on('gutterClick', this.onGutterClick.bind(this));
    this.orig.on('gutterClick', this.onGutterClick.bind(this));

    this.lineChunks = this.model.getLineChunks();
    this.chunks = lineToNormalChunks(this.lineChunks);
    this.dealigned = false;

    this.forceUpdate = this.registerUpdate();
    this.setScrollLock(true, false);
    this.registerScroll();
  }

  setShowDifferences(val) {
    val = val !== false;
    if (val !== this.showDifferences) {
      this.showDifferences = val;
      this.forceUpdate('full');
    }
  }

  registerUpdate() {
    let editMarkers = [];
    let origMarkers = [];
    let debounceChange;
    let self: DiffView = this;
    self.updating = false;
    self.updatingFast = false;
    function update(mode?: string) {
      self.updating = true;
      self.updatingFast = false;
      if (mode === 'full') {
        self.syncModel();
        if (self.classes === null) {
          clearMergeMarks(self.edit, editMarkers);
          clearMergeMarks(self.orig, origMarkers);
        } else {
          clearMarks(self.edit, editMarkers, self.classes);
          clearMarks(self.orig, origMarkers, self.classes);
        }
      }
      if (self.showDifferences) {
        self.updateMarks(
          self.orig, self.model.additions,
          editMarkers, DIFF_OP.DIFF_INSERT);
        self.updateMarks(
          self.edit, self.model.deletions,
          origMarkers, DIFF_OP.DIFF_DELETE);
      }

      self.alignChunks(true);
      self.updating = false;
    }
    function setDealign(fast) {
        let upd = false;
        for (let dv of self.edit.state.diffViews) {
          upd = upd || dv.updating;
        }
        if (upd) {
          return;
        }
        self.dealigned = true;
        set(fast);
    }
    function set(fast) {
      let upd = false;
      for (let dv of self.edit.state.diffViews) {
        upd = upd || dv.updating || dv.updatingFast;
      }
      if (upd) {
        return;
      }
      clearTimeout(debounceChange);
      if (fast === true) {
        self.updatingFast = true;
      }
      debounceChange = setTimeout(update, fast === true ? 20 : 250);
    }
    function change(_cm, change) {
      if (self.model instanceof DecisionStringDiffModel) {
        (self.model as DecisionStringDiffModel).invalidate();
      }
      // Update faster when a line was added/removed
      setDealign(change.text.length - 1 !== change.to.line - change.from.line);
    }
    this.edit.on('change', change);
    this.orig.on('change', change);
    this.edit.on('markerAdded', setDealign);
    this.edit.on('markerCleared', setDealign);
    this.orig.on('markerAdded', setDealign);
    this.orig.on('markerCleared', setDealign);
    this.edit.on('viewportChange', function() { set(false); });
    this.orig.on('viewportChange', function() { set(false); });
    update();
    return update;
  }

  modelInvalid(): boolean {
    return this.model instanceof DecisionStringDiffModel &&
            (this.model as DecisionStringDiffModel).invalid;
  }

  syncModel() {
    if (this.modelInvalid()) {
      this.orig.setValue(this.model.remote);
      this.lineChunks = this.model.getLineChunks();
      this.chunks = lineToNormalChunks(this.lineChunks);
    }
  }

  buildGap(): HTMLElement {
    let lock = this.lockButton = elt('div', null, 'CodeMirror-merge-scrolllock');
    lock.title = 'Toggle locked scrolling';
    let lockWrap = elt('div', [lock], 'CodeMirror-merge-scrolllock-wrap');
    let self: DiffView = this;
    CodeMirror.on(lock, 'click', function() {
      self.setScrollLock(!self.lockScroll);
    });
    return this.gap = elt('div', [lockWrap], 'CodeMirror-merge-gap');
  }

  onGutterClick(instance: CodeMirror.Editor, line: number, gutter: string, clickEvent: Event): void {
    let li = instance.lineInfo(line);
    if (!li.gutterMarkers || !li.gutterMarkers.hasOwnProperty(gutter)) {
      return;
    }
    let node = li.gutterMarkers[gutter];
    if (node && node.sources) {
      let ss = node.sources as ChunkSource[];
      if (gutter === GUTTER_PICKER_CLASS) {
        if (instance === this.orig) {
          for (let s of ss) {
            s.decision.action = s.action as Action;
          }
        } else if (instance === this.edit) {
          for (let s of ss) {
            s.decision.action = 'base';
          }
        }
      } else if (gutter === GUTTER_CONFLICT_CLASS) {
        for (let s of ss) {
          s.decision.conflict = false;
        }
      }
      for (let dv of this.edit.state.diffViews as DiffView[]) {
        if (dv.model instanceof DecisionStringDiffModel) {
          (dv.model as DecisionStringDiffModel).invalidate();
          dv.forceUpdate('full');
        }
      }
    }
  }

  registerScroll(): void {
    let self = this;
    this.edit.on('scroll', function() {
      self.syncScroll(EventDirection.OUTGOING);
    });
    this.orig.on('scroll', function() {
      self.syncScroll(EventDirection.INCOMING);
    });
  }

  /**
   * Sync scrolling between `edit` and `orig`. `type` is used to indicate which
   * editor is the source, and which editor is the destination of the sync.
   */
  syncScroll(type: EventDirection): void {
    if (this.modelInvalid()) {
      return;
    }
    if (!this.lockScroll) {
      return;
    }
    // editor: What triggered event, other: What needs to be synced
    let editor, other, now = +new Date;
    if (type === EventDirection.OUTGOING) {
      editor = this.edit;
      other = this.orig;
    } else {
      editor = this.orig;
      other = this.edit;
    }

    if (editor.state.scrollSetBy === this) {
      editor.state.scrollSetBy = null;
      return;
    }

    // Position to update to
    other.state.scrollPosition = editor.getScrollInfo();

    // If ticking, we already have a scroll queued
    if (other.state.scrollTicking) {
      return;
    }

    let sInfo = other.getScrollInfo();
    // Don't queue an event if already synced.
    if (other.state.scrollPosition.top === sInfo.top &&
        other.state.scrollPosition.left === sInfo.left) {
      return;
    }
    // Throttle by requestAnimationFrame().
    // If event is outgoing, this will lead to a one frame delay of other DiffViews
    let self = this;
    window.requestAnimationFrame(function() {
      other.scrollTo(other.state.scrollPosition.left, other.state.scrollPosition.top);
      other.state.scrollTicking = false;
      other.state.scrollSetBy = self;
    });
    other.state.scrollTicking = true;
    return;
  }

  setScrollLock(val: boolean, action?: boolean) {
    this.lockScroll = val;
    if (val && action !== false) {
      this.syncScroll(EventDirection.OUTGOING);
    }
    if (this.lockButton) {
      this.lockButton.innerHTML = val ? '\u21db\u21da' : '\u21db&nbsp;&nbsp;\u21da';
    }
  }


  updateMarks(editor: CodeMirror.Editor, diff: DiffRangePos[],
              markers: any[], type: DIFF_OP) {
    let classes = this.classes;
    let givenClasses = classes !== null;
    if (!givenClasses) {
      classes = copyObj(mergeClassPrefix) as DiffClasses;
    }

    let self = this;
    function markChunk(editor: CodeMirror.Editor, from: number, to: number,
                       sources: ChunkSource[]) {
      if (!givenClasses && sources.length > 0) {
        classes = copyObj(mergeClassPrefix) as DiffClasses;
        // First, figure out 'action' state of chunk
        let s: string = sources[0].action;
        if (sources.length > 1) {
          for (let si of sources.slice(1)) {
            if (si.action !== s) {
              s = 'mixed';
              break;
            }
          }
        }
        for (let k of Object.keys(classes)) {
          classes[k] += '-' + s;
        }
      }
      // Next, figure out conflict state
      let conflict = false;
      if (sources.length > 0) {
        for (let s of sources) {
          if (s.decision.conflict) {
            conflict = true;
            break;
          }
        }
      }

      for (let i = from; i < to; ++i) {
        let line = editor.addLineClass(i, 'background', classes.chunk);
        if (conflict) {
          editor.addLineClass(line, 'background', CHUNK_CONFLICT_CLASS);
        }
        if (i === from) {
          editor.addLineClass(line, 'background', classes.start);
          if (self.type !== 'merge') {
            // For all editors except merge editor, add a picker button
            let picker = elt('div', PICKER_SYMBOL, classes.gutter);
            (picker as any).sources = sources;
            picker.classList.add(GUTTER_PICKER_CLASS);
            editor.setGutterMarker(line, GUTTER_PICKER_CLASS, picker);
          } else if (conflict && editor === self.orig) {
            // Add conflict markers on editor, if conflicted
            let conflictMarker = elt('div', CONFLICT_MARKER, '');
            (conflictMarker as any).sources = sources;
            conflictMarker.classList.add(GUTTER_CONFLICT_CLASS);
            editor.setGutterMarker(line, GUTTER_CONFLICT_CLASS, conflictMarker);
          }
        }
        if (i === to - 1) {
          editor.addLineClass(line, 'background', classes.end);
        }
        markers.push(line);
      }
      // When the chunk is empty, make sure a horizontal line shows up
      if (from === to) {
        let line = editor.addLineClass(from, 'background', classes.start);
        if (self.type !== 'merge') {
          let picker = elt('div', PICKER_SYMBOL, classes.gutter);
          (picker as any).sources = sources;
          picker.classList.add(GUTTER_PICKER_CLASS);
          editor.setGutterMarker(line, GUTTER_PICKER_CLASS, picker);
        } else if (conflict) {
          // Add conflict markers on editor, if conflicted
          let conflictMarker = elt('div', CONFLICT_MARKER, '');
          (conflictMarker as any).sources = sources;
          conflictMarker.classList.add(GUTTER_CONFLICT_CLASS);
          editor.setGutterMarker(line, GUTTER_CONFLICT_CLASS, conflictMarker);
        }
        markers.push(line);
      }
    }
    let cls = type === DIFF_OP.DIFF_DELETE ? classes.del : classes.insert;
    editor.operation(function() {
      let edit = editor === self.edit;
      if (self.classes) {
        clearMarks(editor, markers, classes);
      } else {
        clearMergeMarks(editor, markers);
      }
      highlightChars(editor, diff, markers, cls);
      for (let c of self.chunks) {
        if (edit) {
          markChunk(editor, c.editFrom, c.editTo, c.sources);
        } else {
          markChunk(editor, c.origFrom, c.origTo, c.sources);
        }
      }
    });
  }

  origWidget: CodeMirrorWidget;

  get orig(): CodeMirror.Editor {
    return this.origWidget.editor;
  }

  classes: DiffClasses;
  showDifferences: boolean;
  dealigned: boolean;
  forceUpdate: Function;
  edit: CodeMirror.Editor;
  chunks: Chunk[];
  lineChunks: Chunk[];
  copyButtons: HTMLElement;
  lockButton: HTMLElement;
  gap: HTMLElement;
  lockScroll: boolean;
  updating: boolean;
  updatingFast: boolean;
}


// Updating the marks for editor content

function clearMergeMarks(editor: CodeMirror.Editor, arr: any[]) {
  for (let postfix of ['-local', '-remote', '-either', '-custom']) {
    let classes = copyObj(mergeClassPrefix) as DiffClasses;
    for (let k of Object.keys(classes)) {
      classes[k] += postfix;
    }
    clearMarks(editor, arr, classes);
  }
}

function clearMarks(editor: CodeMirror.Editor, arr: any[], classes: DiffClasses) {
  for (let i = 0; i < arr.length; ++i) {
    let mark = arr[i];
    if ('clear' in mark) {
      mark.clear();
    } else if (mark.parent) {
      editor.removeLineClass(mark, 'background', classes.chunk);
      editor.removeLineClass(mark, 'background', classes.start);
      editor.removeLineClass(mark, 'background', classes.end);
      editor.removeLineClass(mark, 'background', CHUNK_CONFLICT_CLASS);
      // Merge editor does not set a marker currently, so don't clear for it:
      if (valueIn(classes.gutter, [leftClasses.gutter, rightClasses.gutter])) {
        editor.setGutterMarker(mark, GUTTER_PICKER_CLASS, null);
      } else {
        editor.setGutterMarker(mark, GUTTER_CONFLICT_CLASS, null);
      }
    }
  }
  arr.length = 0;
}

function highlightChars(editor: CodeMirror.Editor, ranges: DiffRangePos[],
                        markers: any[], cls: string) {
  let doc = editor.getDoc();
  let origCls: string = null;
  if (valueIn(cls, [mergeClassPrefix.del, mergeClassPrefix.insert])) {
    origCls = cls;
  }
  for (let r of ranges) {
    if (origCls !== null) {
      cls = origCls + (r.source ? '-' + r.source.action : '');
    }
    markers.push(doc.markText(r.from, r.to, {className: cls}));
  }
}


// Updating the gap between editor and original


function getMatchingOrigLine(editLine: number, chunks: Chunk[]): number {
  let editStart = 0;
  let origStart = 0;
  // Start values correspond to either the start of the chunk,
  // or the start of a preceding unmodified part before the chunk.
  // It is the difference between these two that is interesting.
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (chunk.editTo > editLine && chunk.editFrom <= editLine) {
      return null;
    }
    if (chunk.editFrom > editLine) {
      break;
    }
    editStart = chunk.editTo;
    origStart = chunk.origTo;
  }
  return editLine + (origStart - editStart);
}


/**
 * From a line in base, find the matching line in another editor by line chunks
 */
function getMatchingOrigLineLC(toMatch: Chunk, chunks: Chunk[]): number {
  let editLine = toMatch.editFrom;
  for (let i = 0; i < chunks.length; ++i) {
    let chunk = chunks[i];
    if (chunk.editFrom === editLine) {
      return chunk.origTo;
    }
    if (chunk.editFrom > editLine) {
      break;
    }
  }
  return toMatch.editTo;
}


/**
 * Find which line numbers align which each other, in the
 * set of DiffViews. The returned array is of the format:
 *
 * [ aligned line #1:[Edit line number, (DiffView#1 line number, DiffView#2 line number,) ...],
 *   algined line #2 ..., etc.]
 */
function findAlignedLines(dvs: DiffView[]): number[][] {
  let linesToAlign: number[][] = [];
  let ignored: number[] = [];

  // First fill directly from first DiffView
  let dv = dvs[0];
  let others = dvs.slice(1);
  for (let i = 0; i < dv.lineChunks.length; i++) {
    let chunk = dv.lineChunks[i];
    let lines = [chunk.editTo, chunk.origTo];
    for (let o of others) {
      lines.push(getMatchingOrigLineLC(chunk, o.lineChunks));
    }
    if (linesToAlign.length > 0 &&
        linesToAlign[linesToAlign.length - 1][0] === lines[0]) {
      let last = linesToAlign[linesToAlign.length - 1];
      for (let j = 0; j < lines.length; ++j) {
        last[j] = Math.max(last[j], lines[j]);
      }
    } else {
      if (linesToAlign.length > 0) {
        let prev = linesToAlign[linesToAlign.length - 1];
        let diff = lines[0] - prev[0];
        for (let j = 1; j < lines.length; ++j) {
          if (diff !== lines[j] - prev[j]) {
            diff = null;
            break;
          }
        }
        if (diff === null) {
          linesToAlign.push(lines);
        } else {
          ignored.push(lines[0]);
          continue;
        }
      } else {
        linesToAlign.push(lines);
      }
    }
  }
  // Then fill any chunks from remaining DiffView, which are not already added
  for (let o = 0; o < others.length; o++) {
    for (let i = 0; i < others[o].lineChunks.length; i++) {
      let chunk = others[o].lineChunks[i];
      // Check agains existing matches to see if already consumed:
      let j = 0;
      for (; j < linesToAlign.length; j++) {
        let align = linesToAlign[j];
        if (valueIn(chunk.editTo, ignored)) {
          // Chunk already consumed, continue to next chunk
          j = -1;
          break;
        } else if (align[0] >= chunk.editTo) {
          // New chunk, which should be inserted in pos j,
          // such that linesToAlign are sorted on edit line
          break;
        }
      }
      if (j > -1) {
        let lines = [chunk.editTo,
                     getMatchingOrigLineLC(chunk, dv.lineChunks)];
        for (let k = 0; k < others.length; k++) {
          if (k === o) {
            lines.push(chunk.origTo);
          } else {
            lines.push(getMatchingOrigLineLC(chunk, others[k].lineChunks));
          }
        }
        if (linesToAlign.length > j && linesToAlign[j][0] === chunk.editTo) {
          let last = linesToAlign[j];
          for (let k = 0; k < lines.length; ++k) {
            last[k] = Math.max(last[k], lines[k]);
          }
        } else {
          linesToAlign.splice(j, 0, lines);
        }
      }
    }
  }
  return linesToAlign;
}


function alignLines(cm: CodeMirror.Editor[], lines: number[], aligners): void {
  let maxOffset = 0;
  let offset = [];
  for (let i = 0; i < cm.length; i++) {
    if (lines[i] !== null) {
      let off = cm[i].heightAtLine(lines[i], 'local');
      offset[i] = off;
      maxOffset = Math.max(maxOffset, off);
    }
  }
  for (let i = 0; i < cm.length; i++) {
    if (lines[i] !== null) {
      let diff = maxOffset - offset[i];
      if (diff > 1) {
        aligners.push(padAbove(cm[i], lines[i], diff));
      }
    }
  }
}

function padAbove(cm: CodeMirror.Editor, line: number, size: number): CodeMirror.LineWidget {
  let above = true;
  if (line > cm.getDoc().lastLine()) {
    line--;
    above = false;
  }
  let elt = document.createElement('div');
  elt.className = 'CodeMirror-merge-spacer';
  elt.style.height = size + 'px'; elt.style.minWidth = '1px';
  return cm.addLineWidget(line, elt, {height: size, above: above});
}


export
interface IMergeViewEditorConfiguration extends CodeMirror.EditorConfiguration {
  /**
   * When true stretches of unchanged text will be collapsed. When a number is given, this indicates the amount
   * of lines to leave visible around such stretches (which defaults to 2). Defaults to false.
   */
  collapseIdentical?: boolean | number;

  /**
   * Original value
   */
  orig: any;

  /**
   * Provides remote diff of document to be shown on the right of the base.
   * To create a diff view, provide only remote.
   */
  remote: IStringDiffModel;

  /**
   * Provides local diff of the document to be shown on the left of the base.
   * To create a diff view, omit local.
   */
  local?: IStringDiffModel;

  /**
   * Provides the partial merge input for a three-way merge.
   */
  merged?: IStringDiffModel;

  /**
   * When true, the base of a three-way merge is shown. Defaults to true.
   */
  showBase?: boolean;

  /**
   * When true, changed pieces of text are highlighted. Defaults to true.
   */
  showDifferences?: boolean;
}

// Merge view, containing 1 or 2 diff views.
export
class MergeView extends Panel {
  constructor(options: IMergeViewEditorConfiguration) {
    super();
    this.options = options;
    let remote = options.remote;
    let local = options.local;
    let merged = options.merged;

    let panes: number = 0;
    let left: DiffView = this.left = null;
    let right: DiffView = this.right = null;
    let merge: DiffView = this.merge = null;
    this.base = null;
    let self = this;
    this.diffViews = [];
    this.aligners = [];
    options.value = (options.remote.base !== null ?
      options.remote.base : options.remote.remote);
    options.lineNumbers = options.lineNumbers !== false;

    /*
     * Different cases possible:
     *   - Local and merged supplied: Merge:
     *     - Always use left, right and merge panes
     *     - Use base if `showBase` not set to false
     *   - Only remote supplied: Diff:
     *     - No change: Use ony base editor
     *     - Entire content added/deleted: Use only base editor,
     *       but with different classes
     *     - Partial changes: Use base + right editor
     */

    let hasMerge = local !== null && merged !== null;
    let dvOptions = options as CodeMirror.MergeView.MergeViewEditorConfiguration;

    if (hasMerge) {
      options.gutters = [GUTTER_CONFLICT_CLASS, GUTTER_PICKER_CLASS];
    }

    let showBase = options.showBase !== false;
    if (showBase || !hasMerge) {
      this.base = new Editor(copyObj(options));
      this.base.addClass('CodeMirror-merge-pane');
      this.base.addClass('CodeMirror-merge-pane-base');
      if (hasMerge) {
        this.base.editor.setOption('readOnly', true);
      }
    }

    if (hasMerge) {
      console.assert(remote.base === local.base);

      let leftWidget: Widget;
      if (local.remote === null) {
        // Local value was deleted
        left = this.left = null;
        leftWidget = new Widget({node: elt('div', 'Value missing', 'jp-mod-missing')});
      } else {
        left = this.left = new DiffView(local, 'left', this.alignViews.bind(this),
          copyObj({readOnly: true}, copyObj(dvOptions)) as CodeMirror.MergeView.MergeViewEditorConfiguration);
        this.diffViews.push(left);
        leftWidget = left.origWidget;
      }
      leftWidget.addClass('CodeMirror-merge-pane');
      leftWidget.addClass('CodeMirror-merge-pane-local');
      this.addWidget(leftWidget);

      if (showBase) {
        this.addWidget(this.base);
      }

      let rightWidget: Widget;
      if (remote.remote === null) {
        // Remote value was deleted
        right = this.right = null;
        rightWidget = new Widget({node: elt('div', 'Value missing', 'jp-mod-missing')});
      } else {
        right = this.right = new DiffView(remote, 'right', this.alignViews.bind(this),
          copyObj({readOnly: false}, copyObj(dvOptions)) as CodeMirror.MergeView.MergeViewEditorConfiguration);
        this.diffViews.push(right);
        rightWidget = right.origWidget;
      }
      rightWidget.addClass('CodeMirror-merge-pane');
      rightWidget.addClass('CodeMirror-merge-pane-remote');
      this.addWidget(rightWidget);

      //this.push(elt('div', null, 'CodeMirror-merge-clear', 'height: 0; clear: both;'));

      merge = this.merge = new DiffView(merged, 'merge', this.alignViews.bind(this), dvOptions);
      this.diffViews.push(merge);
      let mergeWidget = merge.origWidget;
      mergeWidget.addClass('CodeMirror-merge-pane');
      mergeWidget.addClass('CodeMirror-merge-pane-final');
      this.addWidget(mergeWidget);

      panes = 3 + (showBase ? 1 : 0);
    } else {
      this.addWidget(this.base);
      if (remote.unchanged || remote.added || remote.deleted) {
        if (remote.unchanged) {
          this.base.addClass('CodeMirror-merge-pane-unchanged');
        } else if (remote.added) {
          this.base.addClass('CodeMirror-merge-pane-added');
        } else if (remote.deleted) {
          this.base.addClass('CodeMirror-merge-pane-deleted');
        }
        panes = 1;
      } else {
        right = this.right = new DiffView(remote, 'right', this.alignViews.bind(this), dvOptions);
        this.diffViews.push(right);
        let rightWidget = right.origWidget;
        rightWidget.addClass('CodeMirror-merge-pane');
        rightWidget.addClass('CodeMirror-merge-pane-remote');
        this.addWidget(new Widget({node: right.buildGap()}));
        this.addWidget(rightWidget);
        panes = 2;
      }
      //this.push(elt('div', null, 'CodeMirror-merge-clear', 'height: 0; clear: both;'));
    }

    this.addClass('CodeMirror-merge');
    this.addClass('CodeMirror-merge-' + panes + 'pane');

    for (let dv of [left, right, merge]) {
      if (dv) {
        dv.init(this.base.editor);
      }
    }

    if (options.collapseIdentical) {
      this.base.editor.operation(function() {
          collapseIdenticalStretches(self, options.collapseIdentical);
      });
    }
    this.initialized = true;
    if (this.left || this.right || this.merge) {
      (this.left || this.right || this.merge).alignChunks(true);
    }
  }

  alignViews(force?: boolean) {
    let dealigned = false;
    if (!this.initialized) {
      return;
    }
    for (let dv of this.diffViews) {
      dv.syncModel();
      if (dv.dealigned) {
        dealigned = true;
        dv.dealigned = false;
      }
    }

    if (!dealigned && !force) {
      return; // Nothing to do
    }
    // Find matching lines
    let linesToAlign = findAlignedLines(this.diffViews);

    // Function modifying DOM to perform alignment:
    let self: MergeView = this;
    let f = function () {

      // Clear old aligners
      let aligners = self.aligners;
      for (let i = 0; i < aligners.length; i++) {
        aligners[i].clear();
      }
      aligners.length = 0;

      // Editors (order is important, so it matches
      // format of linesToAlign)
      let cm: CodeMirror.Editor[] = [self.base.editor];
      let scroll = [];
      for (let dv of self.diffViews) {
        cm.push(dv.orig);
      }
      for (let i = 0; i < cm.length; i++) {
        scroll.push(cm[i].getScrollInfo().top);
      }

      for (let ln = 0; ln < linesToAlign.length; ln++) {
        alignLines(cm, linesToAlign[ln], aligners);
      }

      for (let i = 0; i < cm.length; i++) {
        cm[i].scrollTo(null, scroll[i]);
      }
    };

    // All editors should have an operation (simultaneously),
    // so set up nested operation calls.
    if (!this.base.editor.curOp) {
      f = function(fn) {
        return function() { self.base.editor.operation(fn); };
      }(f);
    }
    for (let dv of this.diffViews) {
      if (!dv.orig.curOp) {
        f = function(fn) {
          return function() { dv.orig.operation(fn); };
        }(f);
      }
    }
    // Perform alignment
    f();
  }

  setShowDifferences(val) {
    if (this.right) {
      this.right.setShowDifferences(val);
    }
    if (this.left) {
      this.left.setShowDifferences(val);
    }
  }

  left: DiffView;
  right: DiffView;
  merge: DiffView;
  base: CodeMirrorWidget;
  options: any;
  diffViews: DiffView[];
  aligners: CodeMirror.LineWidget[];
  initialized: boolean = false;
}

function collapseSingle(cm: CodeMirror.Editor, from: number, to: number): {mark: CodeMirror.TextMarker, clear: () => void} {
  cm.addLineClass(from, 'wrap', 'CodeMirror-merge-collapsed-line');
  let widget = document.createElement('span');
  widget.className = 'CodeMirror-merge-collapsed-widget';
  widget.title = 'Identical text collapsed. Click to expand.';
  let mark = cm.getDoc().markText(
    CodeMirror.Pos(from, 0), CodeMirror.Pos(to - 1),
    {
      inclusiveLeft: true,
      inclusiveRight: true,
      replacedWith: widget,
      clearOnEnter: true
    }
  );
  function clear() {
    mark.clear();
    cm.removeLineClass(from, 'wrap', 'CodeMirror-merge-collapsed-line');
  }
  CodeMirror.on(widget, 'click', clear);
  return {mark: mark, clear: clear};
}

function collapseStretch(size: number, editors: {line: number, cm: CodeMirror.Editor}[]): CodeMirror.TextMarker {
  let marks = [];
  function clear() {
    for (let i = 0; i < marks.length; i++) {
      marks[i].clear();
    }
  }
  for (let i = 0; i < editors.length; i++) {
    let editor = editors[i];
    let mark = collapseSingle(editor.cm, editor.line, editor.line + size);
    marks.push(mark);
    (mark.mark as any).on('clear', clear);
  }
  return marks[0].mark;
}

function unclearNearChunks(dv: DiffView, margin: number, off: number, clear: boolean[]): void {
  for (let i = 0; i < dv.chunks.length; i++) {
    let chunk = dv.chunks[i];
    for (let l = chunk.editFrom - margin; l < chunk.editTo + margin; l++) {
      let pos = l + off;
      if (pos >= 0 && pos < clear.length) {
        clear[pos] = false;
      }
    }
  }
}

function collapseIdenticalStretches(mv: MergeView, margin: boolean | number): void {
  // FIXME: Use all panes
  if (typeof margin !== 'number') {
    margin = 2;
  }
  let clear = [];
  let edit = mv.base.editor;
  let off = edit.getDoc().firstLine();
  for (let l = off, e = edit.getDoc().lastLine(); l <= e; l++) {
    clear.push(true);
  }
  if (mv.left) {
    unclearNearChunks(mv.left, margin as number, off, clear);
  }
  if (mv.right) {
    unclearNearChunks(mv.right, margin as number, off, clear);
  }
  if (mv.merge) {
    unclearNearChunks(mv.merge, margin as number, off, clear);
  }

  for (let i = 0; i < clear.length; i++) {
    if (clear[i]) {
      let line = i + off;
      let size = 1;
      for (; i < clear.length - 1 && clear[i + 1]; i++, size++) {
        // Just finding size
      }
      if (size > margin) {
        let editors = [{line: line, cm: edit}];
        if (mv.left) {
          editors.push({line: getMatchingOrigLine(line, mv.left.chunks),
            cm: mv.left.orig});
        }
        if (mv.right) {
          editors.push({line: getMatchingOrigLine(line, mv.right.chunks),
            cm: mv.right.orig});
        }
        if (mv.merge) {
          editors.push({line: getMatchingOrigLine(line, mv.merge.chunks),
            cm: mv.merge.orig});
        }
        let mark = collapseStretch(size, editors);
        if (mv.options.onCollapse) {
          mv.options.onCollapse(mv, line, size, mark);
        }
      }
    }
  }
}

// General utilities

function elt(tag: string, content?: string | HTMLElement[], className?: string, style?: string): HTMLElement {
  let e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  if (style) {
    e.style.cssText = style;
  }
  if (typeof content === 'string') {
    e.appendChild(document.createTextNode(content as string));
  } else if (content) {
    for (let i = 0; i < content.length; ++i) {
      e.appendChild((content as HTMLElement[])[i]);
    }
  }
  return e;
}

function copyObj(obj: Object, target?: Object) {
  if (!target) {
    target = {};
  }
  for (let prop in obj) {
    if (obj.hasOwnProperty(prop)) {
      target[prop] = obj[prop];
    }
  }
  return target;
}

function findPrevDiff(chunks: Chunk[], start: number, isOrig: boolean): number {
  for (let i = chunks.length - 1; i >= 0; i--) {
    let chunk = chunks[i];
    let to = (isOrig ? chunk.origTo : chunk.editTo) - 1;
    if (to < start) {
      return to;
    }
  }
}

function findNextDiff(chunks: Chunk[], start: number, isOrig: boolean): number {
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    let from = (isOrig ? chunk.origFrom : chunk.editFrom);
    if (from > start) {
      return from;
    }
  }
}

function goNearbyDiff(cm, dir): void | any {
  let found = null;
  let views = cm.state.diffViews;
  let line = cm.getCursor().line;
  if (views) {
    for (let i = 0; i < views.length; i++) {
      let dv = views[i];
      let isOrig = cm === dv.orig;
      let pos = dir < 0 ?
        findPrevDiff(dv.chunks, line, isOrig) :
        findNextDiff(dv.chunks, line, isOrig);
      if (pos !== null && (found === null ||
            (dir < 0 ? pos > found : pos < found))) {
        found = pos;
      }
    }
  }
  if (found !== null) {
    cm.setCursor(found, 0);
  } else {
    return CodeMirror.Pass;
  }
}

CodeMirror.commands.goNextDiff = function(cm) {
  return goNearbyDiff(cm, 1);
};
CodeMirror.commands.goPrevDiff = function(cm) {
  return goNearbyDiff(cm, -1);
};
