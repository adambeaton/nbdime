
(function(nbdime) {
    "use strict";
    
    
    /* Insert callbacks here for UI actions. */

    nbdime.on_diff = function() {
        var b = document.getElementById("diff-base").value;
        var r = document.getElementById("diff-remote").value;
        request_diff(b, r);
    };
    
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
    
    // Build diff
    nbdime.init_diff = function(data) {
        var view = elt_nbdiff_view(data);
        var root = get_cleared_root();
        root.appendChild(view);
        refresh_editors();
    };
    
    /* This function is called just after it's defined,
       passing the object window.nbdime or a new object as argument,
       simultaneously storing this new object on the window,
       with the result that nbdime above is in the global
       namespace of the page in this window: */
})(window.nbdime = window.nbdime || {});
