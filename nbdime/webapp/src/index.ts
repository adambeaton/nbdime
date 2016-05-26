/*-----------------------------------------------------------------------------
| Copyright (c) 2016, Jupyter Development Team.
|
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/
'use strict';

import {
    INotebookContent
} from 'jupyter-js-notebook/lib/notebook/nbformat';

import {
  RenderMime
} from 'jupyter-js-ui/lib/rendermime';

import {
  HTMLRenderer, LatexRenderer, ImageRenderer, TextRenderer,
  ConsoleTextRenderer, JavascriptRenderer, SVGRenderer, MarkdownRenderer
} from 'jupyter-js-ui/lib/renderers';

import {
  Widget
} from 'phosphor-widget';

import {
  Panel
} from 'phosphor-panel';

import {
  IDiffEntry
} from './diffutil';

import {
  NotebookDiffModel
} from './model';

import {
  NotebookDiffWidget
} from './widgets';

import 'jupyter-js-notebook/lib/index.css';
import 'jupyter-js-notebook/lib/theme.css';

function init_diff(data: {base: INotebookContent, diff: IDiffEntry[]}) {
  
    const transformers = [
        new JavascriptRenderer(),
        new MarkdownRenderer(),
        new HTMLRenderer(),
        new ImageRenderer(),
        new SVGRenderer(),
        new LatexRenderer(),
        new ConsoleTextRenderer(),
        new TextRenderer()
    ];

    let rendermime = new RenderMime<Widget>();
    for (let t of transformers) {
        for (let m of t.mimetypes) {
            rendermime.order.push(m);
            rendermime.renderers[m] = t;
        } 
    }

    let nbdModel = new NotebookDiffModel(data.base, data.diff);
    let nbdWidget = new NotebookDiffWidget(nbdModel, rendermime);

    let root = document.getElementById('nbdime-root');
    root.innerHTML = "";
    let panel = new Panel();
    panel.id = 'main';
    panel.attach(root);
    panel.addChild(nbdWidget);
    window.onresize = () => { panel.update(); };
}

function on_diff(e: Event) {
    e.preventDefault();
    var b = (document.getElementById("diff-base") as HTMLInputElement).value;
    var r = (document.getElementById("diff-remote") as HTMLInputElement).value;
    request_diff(b, r);
    let uri = "/diff?base=" + encodeURIComponent(b) + "&remote=" + encodeURIComponent(r);
    history.pushState({base: b, remote: r}, "Diff: \"" + b + "\" vs \"" + r + "\"", uri);
    return false;
};

function on_pop_state(e: PopStateEvent) {
    if (e.state) {
        request_diff(e.state.base, e.state.remote);
    }
}

    /* Make a post request passing a json argument and receiving a json result. */
function request_json(url: string, argument: any, callback: any, onError: any) {
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

function request_diff(base: string, remote: string) {
    request_json("/api/diff",
                  {base:base, remote:remote},
                  on_diff_request_completed,
                  on_diff_request_failed);
}

function on_diff_request_completed(data: any) {
    init_diff(data);
}

function on_diff_request_failed() {
    console.log("Diff request failed.");
}

/**
 * Global config data for the Nbdime application.
 */
var configData: any = null;

/**
 *  Make an object fully immutable by freezing each object in it.
 */
function deepFreeze(obj: any): any {

  // Freeze properties before freezing self
  Object.getOwnPropertyNames(obj).forEach(function(name) {
    var prop = obj[name];

    // Freeze prop if it is an object
    if (typeof prop == 'object' && prop !== null && !Object.isFrozen(prop))
      deepFreeze(prop);
  });

  // Freeze self
  return Object.freeze(obj);
}

export
function getConfigOption(name: string): string;

export
function getConfigOption(name: string): any {
  if (configData) {
    return configData[name];
  }
  if (typeof document !== 'undefined') {
    let el = document.getElementById('nbdime-config-data');
    if (el) {
      configData = JSON.parse(el.textContent);
    } else {
      configData = {};
    }
  }
  configData = deepFreeze(configData);
  return configData[name];
}

function closeTool() {
    var xhttp = new XMLHttpRequest();
    var url = "/api/closetool";
    xhttp.open("POST", url, false);
    xhttp.send();
    window.close();
}

function attachToForm() {
    var frm = document.getElementById('nbdime-diff-form') as HTMLFormElement;
    if (frm) {
        frm.onsubmit = on_diff;
        window.onpopstate = on_pop_state;
    }
}


function initialize() {
    attachToForm();
    // If arguments supplied, run diff
    let base = getConfigOption("base");
    let remote = getConfigOption("remote");
    if (base && remote) {
        request_diff(base, remote);
    }
    let close_btn = document.getElementById('nbdime-close') as HTMLButtonElement;
    if (close_btn) {
        close_btn.onclick = closeTool;
    }
    window.onbeforeunload = closeTool;
}

window.onload = initialize;