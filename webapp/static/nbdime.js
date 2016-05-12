"use strict";

(function(nbdime) {

    // Note to new readers: if some code here looks weird,
    // my excuse is that I've been learning the quirks
    // of javascript/dom/css while writing this.
    // Please make pull requests and educate me!


    // from the nbdime diff format:
    // Valid values for the action field in diff entries
    var INSERT = "add";
    var DELETE = "remove";
    var REPLACE = "replace";
    var PATCH = "patch";
    var SEQINSERT = "addrange";
    var SEQDELETE = "removerange";

    var JSON_INDENT = "    ";

    CodeMirror.defaults.autoRefresh = true;


    function convert_merge_data(data) {
        // FIXME: Convert data from server same as convert_diff_data
        var celldata = [
            ["cell0\nsame", "cell0\nsame", "cell0\nsame"],    // All same
            ["cell1\nlocal", "cell1\nbase", "cell1\nremote"], // All differ
            [null, "cell2\nbase", "cell2\nremote"],           // Local removed, remote modified
            ["cell3\nlocal", "cell3\nbase", null]             // Local modified, remote removed
        ];
        return celldata;
    }

    function convert_diff_celldata(data) {
        var b = data.base;

        // Splits diff into list of cells with cell-wise diffs
        var celldata = [];

        var bcells = b.cells;
        var dcells = [];
        var consumed = 0;
        // Find cells' diff entry
        for (var i=0; i<data.diff.length; ++i) {
            if (data.diff[i].key === "cells") {
                console.assert(data.diff[i].op === "patch", "Non-patch diff-op on 'cells'.")
                var d = data.diff[i].diff;
            }
        }
        // Process cells
        for (var i=0; i<d.length; ++i) {
            var e = d[i];
            // nbdime diff format:
            var action = e.op;
            var index = e.key;

            // Add cells not mentioned in diff (unchanged)
            while (consumed<index) {
                celldata.push([bcells[consumed], undefined]);
                consumed++;
            }

            if (action === SEQINSERT) {
                // Add inserted cells
                var newcells = e.valuelist;
                for (var j=0; j<newcells.length; ++j) {
                    celldata.push([null, newcells[j]]);
                }
            } else if (action === SEQDELETE) {
                // Add deleted cells
                var num_deleted = e.length;
                for (var j=0; j<num_deleted; ++j) {
                    celldata.push([bcells[consumed+j], null]);
                }
                consumed += num_deleted;
            } else if (action === PATCH) {
                // Add modified cell
                var celldiff = e.diff;
                celldata.push([bcells[consumed], e.diff]);
                consumed++;
            } else {
                throw "Invalid diff action.";
            }
        }
        // Add cells at end not mentioned in diff
        while (consumed < bcells.length) {
            celldata.push([bcells[consumed], undefined]);
            consumed++;
        }

        return celldata;
    }


    /* Make a post request passing a json argument and receiving a json result. */
    function request_json(url, argument, callback, onError) {
        var xhttp = new XMLHttpRequest();
        xhttp.onreadystatechange = function() {
            if (xhttp.readyState == 4) {
                if (xhttp.status == 200) {
                    var result = JSON.parse(xhttp.responseText);
                    callback(result);
                } else {
                    onError();
                }
            }
        };
        xhttp.open("POST", url, true)
        xhttp.setRequestHeader("Content-type", "application/json");
        xhttp.send(JSON.stringify(argument));
    }


    function request_diff(base, remote) {
        request_json("/api/diff",
                     {base:base, remote:remote},
                     on_diff_request_completed,
                     on_diff_request_failed);
    }

    function on_diff_request_completed(data) {
        nbdime.init_diff(data);
    }

    function on_diff_request_failed() {
        console.log("Diff request failed.");
    }


    function request_merge(base, local, remote) {
        request_json("/api/merge",
                     {base:base, local:local, remote:remote},
                     on_merge_request_completed,
                     on_merge_request_failed);
    }

    function on_merge_request_completed(data) {
        nbdime.init_merge(data);
    }

    function on_merge_request_failed() {
        console.log("Merge request failed.");
    }


    function request_store_merge(merged) {
        request_json("/api/storemerge",
                     {merged:merged},
                     on_store_merge_request_completed,
                     on_store_merge_request_failed);
    }

    function on_store_merge_request_completed(data) {
        console.log("Store merge request:", data);
    }

    function on_store_merge_request_failed() {
        console.log("Store merge request failed.");
    }


    // TODO: Make a class to hold state instead of using globals.

    // Private variable holding the root element nbdime-root after
    // nbdime.init_diff() or nbdime.init_merge() have been called:
    // (are there better ways to do this?)
    var root;

    // List of all CodeMirror editor instances.
    // TODO: Store editors in a more accessible way.
    var editors = [];


    // TODO: Make this configurable
    //var mode = "text/python";


    // Default arguments for codemirror instances
    function cm_args() {
        return {
            lineNumbers: true,
            indentUnit: 4
            //mode: mode
        };
    }

    // Default arguments for codemirror diff viewers

    function dv_args() {
        return {
            lineNumbers: true,
            collapseIdentical: false,
            showDifferences: true,
            readOnly: true,
            viewportMargin: Infinity
            //mode: mode
        };
    }


    // Default arguments for mergeview instances
    function mv_args() {
        return {
            lineNumbers: true,
            collapseIdentical: false,
            showDifferences: true,
            allowEditingOriginals: true
            //mode: mode
        };
    }


    function isString(s) {
        return typeof(s) === "string" || s instanceof String;
    }


    function get_line_ending_indices(str) {
        var indices = [];
        for(var i=0; i<str.length;i++) {
            if (str[i] === "\n") indices.push(i);
        }
        return indices;
    }


    function add_editor(editor) {
        editors.push(editor);
    }


    // This just shows how to get content from editors.
    // Still missing: mapping editors to notebook cells
    // and recreating a full notebook.
    function extract_notebook() {
        var lines;
        var e;
        for (var i=0; i<editors.length; i++) {
            e = editors[i];
            lines = e.getDoc().getValue();
            console.log(lines);
        }
    }


    // Shorthand for creating element with children
    function elt(name, children, cls) {
        var node = document.createElement(name);
        if (cls) {
            if (cls !== null) {
                node.setAttribute("class", cls);
            }
        }
        if (children) {
            for (var i=0; i<children.length; i++) {
                var c = children[i];
                if (isString(c)) {
                    c = document.createTextNode(c);
                }
                node.appendChild(c);
            }
        }
        return node;
    }


    function remote_diff(base, diff) {
        // The patched string to build and return:
        var remote = "";
        // The indices of insertions in the reference frame of the patched string (returned)
        var insertion_indices = [];
        // Index into obj, the next item to take unless diff says otherwise
        var take = 0;
        var skip = 0;
        for (var i=0; i<diff.length; i++) {
            var e = diff[i];
            var op = e.op;
            var index = e.key;
            console.assert(typeof(index) == "number", "Diff index wrong type");

            // Take values from obj not mentioned in diff, up to not including index
            remote = remote.concat(base.slice(take, index));

            if (op == SEQINSERT) {
                // Extend with new values directly
                insertion_indices.push(remote.length);
                remote = remote.concat(e.valuelist);
                skip = 0;
            }
            else if (op == SEQDELETE) {
                // Delete a number of values by skipping
                skip = e.length;
            }
            else if (op == PATCH) {
                remote.push(patch(base[index], e.diff));
                skip = 1;
            }

            // Skip the specified number of elements, but never decrement take.
            // Note that take can pass index in diffs with repeated +/- on the
            // same index, i.e. [op_remove(index), op_add(index, value)]
            take = Math.max(take, index + skip);
        }

        // Take values at end not mentioned in diff
        remote = remote.concat(base.slice(take, base.length));

        return {remote: remote, insertion_indices: insertion_indices};
    }


    function index_to_cmpos(index, line_endings) {
        if (index < line_endings[0]) {
            return {line: 0, ch: index}
        }
        for (var i=1; i<line_endings.length; ++i) {
            if (index<line_endings[i]) {
                break;
            }
        }
        return {line: i, ch: index - line_endings[i-1] - 1}
    }


    // This is the list of all cells
    function elt_diff_cells(rows) {
        return elt("ul", rows, "nbdime-cells"); // nbdiff-cells
    }


    function elt_merge_cells(rows) {
        return elt("ul", rows, "nbdime-cells"); // nbmerge-cells
    }


    // This is a row aligning conflicting cells
    function elt_cellrow(cells) {
        return elt("li", cells, null);
    }


    // This is the headers row of the cells list
    function elt_cell_headers(titles, cls) {
        var cells = [];
        for (var i=0; i<titles.length; i++) {
            cells.push(elt("span", [titles[i]], cls));
        }
        return elt_cellrow(cells);
    }


    // This is used for any single cell of various classes
    function elt_cell(cls) {
        var src = elt("div", [], "nbdime-source-cell " + cls);
        var meta = elt("div", [], "nbdime-metadata-cell " + cls);
        var outputs = elt("div", [], "nbdime-outputs-cell " + cls);
        return elt("div", [src, meta, outputs], "nbdime-cell " + cls);
    }


    function elt_diff_row(local, remote) {
        if (local === null || remote === null) {
            // Cell has been deleted or added, show on the left or right side

            // Create added cell with editor
            var aclass = "nbdiff-cell-added";
            var dclass = "nbdiff-cell-deleted";
            var args = dv_args();
            if (remote === null) {
                var cl = elt_cell(aclass);
                var cr = elt_cell(dclass);
                cr.appendChild(document.createTextNode("Cell deleted"));
                var ca = cl;
                args.value = local.source;
            } else {
                var cl = elt_cell(dclass);
                var cr = elt_cell(aclass);
                cl.appendChild(document.createTextNode("Cell added"));
                var ca = cr;
                args.value = remote.source;
            }
            var editor = new CodeMirror(ca, args);
            add_editor(editor);

            return elt_cellrow([cl, cr]);
        } else if (remote === undefined) {
            // Cells are equal

            // Creating only one copy of the cell,
            //  but we can also add two equal cells with class nbdiff-cell-equal
            // if that's deemed more user friendly
            var c = elt_cell("nbdiff-cell-equal-content");
            var args = dv_args();
            args.value = local.source;
            var editor = new CodeMirror(c, args);
            add_editor(editor);

            return elt_cellrow([c]);
        } else {
            // Cells are different, show diff view
            var cl = elt_cell("nbdiff-cell-local");
            var argsl = dv_args();
            argsl.value = local.source;
            //argsl.mode = "python";
            var editorl = new CodeMirror(cl, argsl);
            add_editor(editorl);

            var cr = elt_cell("nbdiff-cell-remote");
            var argsr = dv_args();
            for (var i=0; i<remote.length; i++) {
                if (remote[i].key === "source") {
                    var remote_source = remote[i].diff;
                    break;
                }
            }

            var rdiff = remote_diff(local.source, remote_source);
            argsr.value = rdiff.remote;
            var editorr = new CodeMirror(cr, argsr);
            add_editor(editorr);

            // Index into obj, the next item to take unless diff says otherwise
            var i_insert = 0;
            var newline_indicesl = get_line_ending_indices(local.source);
            var newline_indicesr = get_line_ending_indices(rdiff.remote);
            for (var i=0; i<remote_source.length; i++) {
                var e = remote_source[i];
                var op = e.op;
                var index = e.key;

                if (op == SEQINSERT) {
                    var from = index_to_cmpos(rdiff.insertion_indices[i_insert], newline_indicesr);
                    var to = index_to_cmpos(rdiff.insertion_indices[i_insert] + e.valuelist.length, newline_indicesr);
                    editorr.doc.markText(from, to, {className: "nbdime-source-added"})
                    for (var j=from.line; j<=to.line; ++j) {
                        editorr.doc.addLineClass(j, "wrap", "nbdime-source-line-addition")
                    }
                    ++i_insert;
                }
                else if (op == SEQDELETE) {
                    // Highlight deletion in local
                    var from = index_to_cmpos(index, newline_indicesl)
                    var to = index_to_cmpos(index + e.length, newline_indicesl)
                    editorl.doc.markText(from, to, {className: "nbdime-source-removed"})
                    for (var j=from.line; j<=to.line; ++j) {
                        editorl.doc.addLineClass(j, "wrap", "nbdime-source-line-deletion")
                    }
                }
            }

            return elt_cellrow([cl, cr]);
        }
    }


    function elt_merge_row_unchanged(base) {
        var c = elt_cell("nbmerge-cell-equal-singular");
        var args = cm_args();
        args.value = base;
        var editor = new CodeMirror(c, args);
        add_editor(editor);

        return elt_cellrow([c]);
    }


    function elt_merge_row_deleted(local, base, remote) {
        // Create deleted cell (one side deleted)
        var cdel = elt_cell("nbmerge-cell-deleted");
        cdel.appendChild(document.createTextNode("DELETED"));

        // Create twoway diff cell
        var cdiff = elt_cell("nbmerge-cell-twoway");
        var args = mv_args();
        if (1) {
            args.origLeft = local;
            args.value = base;
            args.origRight = remote;
        } else {
            // Possible workaround for minor bugs in codemirror MergeView when passing origRight: null
            if (local === null) {
                args.value = base;
                args.orig = remote;
            } else {
                args.value = local;
                args.orig = base;
            }
        }
        var editor = new CodeMirror.MergeView(cdiff, args);
        add_editor(editor);

        // Put row together
        return elt_cellrow(remote === null ? [cdiff, cdel]: [cdel, cdiff]);
    }


    function elt_merge_row_full(local, base, remote) {
        var mergecell = elt_cell("nbmerge-cell-threeway");
        var args = mv_args();
        args.origLeft = local;
        args.value = base;
        args.origRight = remote;
        var editor = new CodeMirror.MergeView(mergecell, args);
        add_editor(editor);

        return elt_cellrow([mergecell]);
    }


    function elt_merge_row(local, base, remote) {
        if (local === null || remote === null) {
            // This shouldn't happen with valid celldata
            if (local === null && remote === null)
                throw "Not expecting cells deleted on both sides here.";
            // Cell deleted on one side and modified on the other
            return elt_merge_row_deleted(local, base, remote);
        } else if (local !== base || remote !== base) {
            // Cell modified on both sides
            // (if it was only modified on one side,
            // that has already been merged into base)
            return elt_merge_row_full(local, base, remote);
        } else {
            // Cell not involved in conflict
            return elt_merge_row_unchanged(base);
        }
    }


    function elt_diff_buttons() {
        var b0 = elt("button", ["Extract editor contents"], null);
        b0.setAttribute("type", "button");
        b0.onclick = extract_notebook;
        return elt("div", [b0], null);
    }


    // The main page generation script for nbdiff
    function elt_nbdiff_view(data) {
        // For each cell, generate an aligned row depending on conflict status:
        var rows = [elt_cell_headers(["Base", "Remote"], "nbdiff-cell-header")];
        // TODO: Handle document metadata changes, if any
        var celldata = convert_diff_celldata(data);
        for (var i=0; i<celldata.length; ++i) {
            // FIXME: Render cells properly, this just dumps cell json in editor
            var data = celldata[i];
            var base = data[0];
            var remote = data[1];
            rows.push(elt_diff_row(base, remote));
        }
        rows.push(elt_diff_buttons());  // This is nothing interesting yet
        return elt_diff_cells(rows);
    }


    // The main page generation script for nbmerge
    function elt_nbmerge_view(celldata) {
        // For each cell, generate an aligned row depending on conflict status:
        var rows = [elt_cell_headers(["Local", "Base", "Remote"], "nbmerge-cell-header")];
        for (var i=0; i<celldata.length; ++i) {
            // FIXME: Render cells properly, this just dumps cell json in editor
            var data = celldata[i];
            var base = data[0] == null ? null: JSON.stringify(data[0]);
            var local = data[1] == null ? null: JSON.stringify(data[1]);
            var remote = data[2] == null ? null: JSON.stringify(data[2]);
            rows.push(elt_merge_row(base, local, remote));
        }
        return elt_merge_cells(rows);
    }


    // To make nbdime more reusable, it's possible to take the root element
    // as argument to a constructor instead like CodeMirror does.
    function get_cleared_root() {
        // Find root div element to place everything inside
        var root = document.getElementById("nbdime-root");
        if (root === null) {
            throw "Found no div element with id nbdime-root in document.";
        }
        // Clear eventual html from root element
        root.innerHTML = "";
        // Clear list of CodeMirror editors
        editors = [];
        return root;
    }


    // This seems to be necessary to let the codemirror
    // editors resize to fit their place on the page
    function refresh_editors() {
        for (var i=0; i<editors.length; i++) {
            editors[i].refresh();
        }
    }


    // Initialization. Intended usage is to set body.onload=nbdime.init_diff() in parent document.
    nbdime.init_diff = function(data) {
        var view = elt_nbdiff_view(data);
        var root = get_cleared_root();
        root.appendChild(view);
        refresh_editors();
    }


    // Initialization. Intended usage is to set body.onload=nbdime.init_merge() in parent document.
    nbdime.init_merge = function(data) {
        var view = elt_nbmerge_view(data);
        var root = get_cleared_root();
        root.appendChild(view);
        refresh_editors();
    }


    /* Insert callbacks here for UI actions. */

    nbdime.on_diff = function() {
        var b = document.getElementById("merge-base").value;
        var r = document.getElementById("merge-remote").value;
        request_diff(b, r);
    }


    nbdime.on_merge = function() {
        var b = document.getElementById("merge-base").value;
        var l = document.getElementById("merge-local").value;
        var r = document.getElementById("merge-remote").value;
        request_merge(b, l, r);
    }


    nbdime.on_use_local = function() {
        alert("TODO: Add handler!");
    }


    nbdime.on_use_base = function() {
        alert("TODO: Add handler!");
    }


    nbdime.on_use_remote = function() {
        alert("TODO: Add handler!");
    }


    nbdime.on_use_none = function() {
        alert("TODO: Add handler!");
    }


    /* This function is called just after it's defined,
       passing the object window.nbdime or a new object as argument,
       simultaneously storing this new object on the window,
       with the result that nbdime above is in the global
       namespace of the page in this window: */
})(window.nbdime = window.nbdime || {});
