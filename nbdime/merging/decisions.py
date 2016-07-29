# coding: utf-8

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

from __future__ import unicode_literals

from six import string_types
from six.moves import xrange as range
import copy
from collections import namedtuple

from ..diffing import diff
from ..diff_format import DiffOp, SequenceDiffBuilder, MappingDiffBuilder, DiffEntry, as_dict_based_diff, offset_op
from ..patching import patch
from .chunks import make_merge_chunks


# Set to true to enable some expensive debugging assertions
DEBUGGING = 0

# Sentinel to allow None value
Missing = object()

collection_types = string_types + (list, dict)


class MergeDecisionBuilder(object):
    def __init__(self):
        self.decisions = []

    def validated(self):
        return self.decisions

    def add_decision(self, path, key, conflict, action, custom_diff, local_diff, remote_diff):
        self.decisions.append(dict(
            path=path,
            key=key,
            conflict=conflict,
            action=action,
            custom_diff=custom_diff,
            local_diff=local_diff,
            remote_diff=remote_diff,
            #value=value,
            ))

    def keep(self, path, key):
        self.decisions.append(dict(
            path=path,
            key=key,
            conflict=False,
            action="base",
            ))

    def onesided(self, path, key, local_diff, remote_diff):
        assert local_diff or remote_diff
        assert not (local_diff and remote_diff)
        if local_diff:
            action = "local"
        elif remote_diff:
            action = "remote"
        self.decisions.append(dict(
            path=path,
            key=key,
            conflict=False,
            action=action,
            local_diff=local_diff,
            remote_diff=remote_diff,
            ))

    def agreement(self, path, key, local_diff, remote_diff):
        assert local_diff and remote_diff
        assert local_diff == remote_diff
        self.decisions.append(dict(
            path=path,
            key=key,
            conflict=False,
            action="either",
            local_diff=local_diff,
            remote_diff=remote_diff,
            ))

    def conflict(self, path, key, local_diff, remote_diff):
        assert local_diff and remote_diff
        assert local_diff != remote_diff
        action = "undecided"
        self.decisions.append(dict(
            path=path,
            key=key,
            conflict=True,
            action=action,
            local_diff=local_diff,
            remote_diff=remote_diff,
            ))


def _merge_dicts(base, local, remote, base_local_diff, base_remote_diff, path, decisions):
    """Perform a three-way merge of dicts. See docstring of merge."""
    assert isinstance(base, dict) and isinstance(local, dict) and isinstance(remote, dict)

    # Converting to dict-based diff format for dicts for convenience
    # This step will be unnecessary if we change the diff format to work this way always
    base_local_diff = as_dict_based_diff(base_local_diff)
    base_remote_diff = as_dict_based_diff(base_remote_diff)

    # Summary of diff entry cases with (#) references to below code
    # r\l | N/A   -   +   :   !
    # ----|----------------------
    # N/A | (1)  (2)---------(2)
    #  -  | (3)  (4) (5)-----(5)
    #  +  |  |   (5) (6) (5) (5)
    #  :  |  |    |  (5) (7) (5)
    #  !  | (3)  (5) (5  (5) (8)

    # Get diff keys
    bldkeys = set(base_local_diff.keys())
    brdkeys = set(base_remote_diff.keys())
    dkeys = bldkeys | brdkeys

    # (1) Use base values for all keys with no change
    for key in sorted(set(base.keys()) - dkeys):
        decisions.keep(path, key)

    # (2)-(3) Apply one-sided diffs
    for key in sorted(bldkeys ^ brdkeys):
        decisions.onesided(path, key,
                           base_local_diff.get(key),
                           base_remote_diff.get(key))

    # Data structures for storing conflicts
    #local_conflict_diff = MappingDiffBuilder()
    #remote_conflict_diff = MappingDiffBuilder()

    # (4) (5) (6) (7) (8)
    # Then we have the potentially conflicting changes
    for key in sorted(brdkeys & bldkeys):
        # Get diff entries for this key (we know both sides have an
        # entry here because all other cases are covered above)
        ld = base_local_diff[key]
        rd = base_remote_diff[key]

        # Get values (using Missing as a sentinel to allow None as a value)
        bv = base.get(key, Missing)
        lv = local.get(key, Missing)
        rv = remote.get(key, Missing)

        # Switch on diff ops
        lop = ld.op
        rop = rd.op
        if lop != rop: # Note that this means the below cases always have the same op
            # (5) Conflict: removed one place and edited another, or edited in different ways
            decisions.conflict(path, key, ld, rd)
        elif lop == DiffOp.REMOVE:
            # (4) Removed in both local and remote, just don't add it to merge result
            decisions.agreement(path, key, ld, rd)
        elif lop in (DiffOp.ADD, DiffOp.REPLACE, DiffOp.PATCH) and lv == rv:
            # If inserting/replacing/patching produces the same value, just use it
            decisions.agreement(path, key, ld, rd)
        elif lop == DiffOp.ADD:
            # (6) Insert in both local and remote, values are different
            decisions.conflict(path, key, ld, rd)
            # # Try partially merging the inserted values
            # if type(lv) == type(rv) and isinstance(lv, collection_types):
            #     # Use empty collection of the right type as base
            #     me, lco, rco = merge(type(lv)(), lv, rv)
            #     # Insert partially merged result
            #     merged[key] = me
            #     # And add patch entries for the conflicting parts
            #     if lco or rco:
            #         assert lco and rco
            #         local_conflict_diff.patch(key, lco)
            #         remote_conflict_diff.patch(key, rco)
            # else:
            #     # Recursive merge not possible, record conflicting adds (no base value)
            #     local_conflict_diff.append(ld)
            #     remote_conflict_diff.append(rd)
        elif lop == DiffOp.REPLACE:
            # (7) Replace in both local and remote, values are different,
            #     record a conflict against original base value
            decisions.conflict(path, key, ld, rd)
        elif lop == DiffOp.PATCH:
            # (8) Patch on both local and remote, values are different
            # Patches produce different values, try merging the substructures
            # (a patch command only occurs when the type is a collection, so we
            # can safely recurse here and know we won't encounter e.g. an int)
            _merge(bv, lv, rv, ld.diff, rd.diff, "/".join((path, key)), decisions)
        else:
            raise ValueError("Invalid diff ops {} and {}.".format(lop, rop))


def _merge_lists(base, local, remote, base_local_diff, base_remote_diff, path, decisions):
    """Perform a three-way merge of lists. See docstring of merge."""
    assert isinstance(base, list) and isinstance(local, list) and isinstance(remote, list)

    # Interleave changes that local and remote agrees on in a merged object
    #merged = []

    # Data structures for storing conflicts
    #local_conflict_diff = SequenceDiffBuilder()
    #remote_conflict_diff = SequenceDiffBuilder()

    # Offset of indices between base and merged
    #merged_offset = 0

    # Split up and combine diffs into chunks [(begin, end, localdiffs, remotediffs)]
    chunks = make_merge_chunks(base, base_local_diff, base_remote_diff)

    # Loop over chunks of base[j:k], grouping insertion at j into
    # the chunk starting with j
    for (j, k, d0, d1) in chunks:
        #assert len(merged) == j + merged_offset

        # FIXME: do we want the format to know about chunks,
        #        {common_path="/cells", range=(j,k), ...}
        #        ?

        if not (bool(d0) or bool(d1)):
            # Unmodified chunk
            decisions.keep_chunk(path, j, k)  # FIXME: Missing function

        elif (all(e.op == DiffOp.ADDRANGE for e in d0) and
              all(e.op == DiffOp.ADDRANGE for e in d1)):
            # Treating two-sided insertions as non-conflicting.
            # NB! This behaviour is possibly contentious, and if
            # this behaviour is not wanted, this elif block can be deleted.
            # Note that insertions should definitely always be part of
            # conflict if at the beginning of a patch or removerange,
            # but in this case there are two insertions before a
            # list item that will be kept.
            assert j <= len(base)
            # for e in d0 + d1:
            #     merged.extend(e.valuelist)
            #     merged_offset += len(e.valuelist)
            decisions.local_then_remote(path, j, k, d0, d1)  # FIXME: Missing function
            #merged.extend(base[j:k])
            decisions.keep_chunk(path, j, k)  # FIXME: Missing function

        elif not (bool(d0) and bool(d1)):
            # One-sided modification of chunk
            decisions.onesided_chunk(path, j, k, d0, d1)  # FIXME: Missing function

        elif d0 == d1:
            # Exactly the same modifications
            decisions.agreement_chunk(path, j, k, d0, d1)  # FIXME: Missing function

            # FIXME: do the above two cases fully cover what the below one did?
        # elif bool(d0) != bool(d1) or (d0 == d1):  # d0 xor d1 or d0 == d1
        #     # One-sided modification of chunk (or exactly the same modifications)
        #     d = d0 or d1  # Pick the non-empty one
        #     # Apply diff entries (either just one or an add + remove or patch)
        #     for e in d:
        #         assert j == e.key
        #         if e.op == DiffOp.PATCH:
        #             assert j < len(base)
        #             merged.append(patch(base[j], e.diff))
        #         elif e.op == DiffOp.ADDRANGE:
        #             assert j <= len(base)
        #             merged.extend(e.valuelist)
        #             merged_offset += len(e.valuelist)
        #         elif e.op == DiffOp.REMOVERANGE:
        #             assert j < len(base)
        #             merged_offset -= e.length
        #         else:
        #             raise ValueError("Unexpected diff op {}".format(e.op))
        #     if (all(e.op == DiffOp.ADDRANGE for e in d0) and
        #         all(e.op == DiffOp.ADDRANGE for e in d1)):
        #         merged.extend(base[j:k])

        else:
            # Two-sided modification, i.e. a conflict, keeping diffs with an index offset
            # It's possible that something more clever can be done here to reduce
            # the number of conflicts. For now we leave this up to the autoresolve
            # code and manual conflict resolution.
            decisions.conflict_chunk(path, j, k, d0, d1)


def _merge_strings(base, local, remote, base_local_diff, base_remote_diff, path, decisions):
    """Perform a three-way merge of strings. See docstring of merge."""
    assert isinstance(base, string_types) and isinstance(local, string_types) and isinstance(remote, string_types)

    FIXME

    # Merge characters as lists
    me, lco, rco = _merge_lists(list(base), list(local), list(remote), base_local_diff, base_remote_diff, path, decisions)

    # Convert to string compatible format
    merged = "".join(me)

    return merged, lco, rco


def _merge(base, local, remote, base_local_diff, base_remote_diff, path, decisions):
    if not (type(base) == type(local) and type(base) == type(remote)):
        raise ValueError("Expecting matching types, got {}, {}, and {}.".format(
            type(base), type(local), type(remote)))

    if isinstance(base, dict):
        return _merge_dicts(base, local, remote, base_local_diff, base_remote_diff, path, decisions)
    elif isinstance(base, list):
        return _merge_lists(base, local, remote, base_local_diff, base_remote_diff, path, decisions)
    elif isinstance(base, string_types):
        return _merge_strings(base, local, remote, base_local_diff, base_remote_diff, path, decisions)
    else:
        raise ValueError("Cannot handle merge of type {}.".format(type(base)))


def merge_with_diff(base, local, remote, base_local_diff, base_remote_diff):
    """Do a three-way merge of same-type collections b, l, r with given diffs b->l and b->r."""
    path = "" # or "/"?
    decisions = MergeDecisionBuilder()
    _merge(base, local, remote, base_local_diff, base_remote_diff, path, decisions)
    return decisions.validated()


def merge(base, local, remote):
    """Do a three-way merge of same-type collections b, l, r.

    Terminology:

        collection = list | dict | string
        value = int | float | string

        (string is a collection of chars or an atomic value depending on parameters)

        (an alternative way to handle string parameters would be a pre/postprocessing
        splitting/joining of strings into lists of lines, lists of words, lists of chars)

    Input:

        b - base collection
        l - local collection
        r - remote collection
        bld - base-local diff
        brd - base-remote diff

    ### Output:

        ad - agreed upon diff
        cld - part of local diff bld that is in conflict with remote diff brd
        crd - part of remote diff brd that is in conflict with local diff bld

    The merge result can be computed by patching base with the agreed diff ad.
    If the conflict diffs cld and crd are empty, the merge result is final,
    otherwise it is the intermediate agreed upon part.

    Note that the diff indices in the conflict diffs still relate to base,
    and will have to be mapped appropriately to the intermediate merge output.


    ### Alternative output:

        m - merge result (partial, or final if no conflicts)
        cld - part of local diff bld that is in conflict with remote diff brd
        crd - part of remote diff brd that is in conflict with local diff bld

    Note that the diff indices in the conflict diffs here relate to the
    intermediate merge result m, and will have to be mapped appropriately
    to the intermediate merge output.


    ### Combination of the two Output:

        ad - agreed upon diff parts (relating to base)
        m - merge result (partial, or final if no conflicts)
        cld - part of local diff bld that is in conflict with remote diff brd
        crd - part of remote diff brd that is in conflict with local diff bld

    Note that the diff indices in the conflict diffs here relate to the
    intermediate merge result m, and will have to be mapped appropriately
    to the intermediate merge output. Postcondition: m == patch(base, ad).

    Critical question: can we be sure the partial merge result is a valid notebook?

    ## Trying to figure out problem with diff vs diff entry in recursion:

    merge(b, l, r) -> compute bld,brd and call _merge
    _merge(b, l, r, bld, brd) -> switch on type of b,l,r
    merge_dicts(b, l, r, bld, brd)
    merge_lists(b, l, r, bld, brd)
    merge_strings(b, l, r, bld, brd)

    Case: b,l,r are dicts, bld,brd are dict diffs, keys of bld,brd correspond to keys in b,l,r.
    Case: b,l,r are lists, bld,brd are list diffs, indices in bld,brd entries correspond to indices in b(,l,r).

    Case: purely nested dicts of values. Alternatives for each dict key:

        One sided ops always ok:
        N,-
        N,!
        N,:
        N,+
        -,N
        !,N
        :,N
        +,N

        Two sided equal ops ok if argument is the same:
        -,- = ok (agree on delete)
        +,+ = ok if equal inserts, otherwise conflict (two sided insert)
        !,! = ok if equal patches, otherwise conflict (two sided patch)
        :,: = ok if equal replacement value, otherwise conflict (two sided replace)

        Different op always conflicts:
        !,- = conflict (delete and patch)
        -,! = conflict (delete and patch)
        :,- = conflict (delete and replace)
        -,: = conflict (delete and replace)
        :,! = conflict (patch and replace)
        !,: = conflict (patch and replace)

        Conflict situations (symmetric, only listing from one side):
        delete / replace or delete / patch -- manual resolution needed
        replace / replace with different value -- manual resolution needed
        insert / insert with different value -- manual resolution needed - recursion will not have a base value for further merging.
        patch / patch with different diff -- recurse!
        replace / patch -- manual resolution needed, will only happen if collection type changes in replace


        Takeaways:
        - Ensure that diff always uses patch on collections unless the type changes and replace on values.
        - The only recursion will happen on the patch / patch op of equal type collections!
        - Patch op is [DiffOp.PATCH, key, subdiff], providing subdiff for both sides, and meaning values exist on both sides.


    ## Next trying to figure out list situations:

    Case: purely nested lists of values. Alternatives for each base item:

        One sided ops always ok:
        N,-
        N,+
        N,!

        Delete and patch is a conflict:
        -,! = conflict (delete and patch)

        Two sided equal ops ok if argument is the same:
        -,- = ok (agree on deleting this item)
        -,+ = ok (delete this item and insert new values)
        +,+ = ok (always insert both, or pick one if new values are equal?)
        !,! = ok (recurse)
        !,+ = ok (patch this item and insert new values)

        Conflict situations (symmetric, only listing from one side):
        delete / replace or delete / patch -- manual resolution needed
        replace / replace with different value -- manual resolution needed
        insert / insert with different value -- manual resolution needed - recursion will not have a base value for further merging.
        patch / patch with different diff -- recurse!
        replace / patch -- manual resolution needed, will only happen if collection type changes in replace

    """
    base_local_diff = diff(base, local)
    base_remote_diff = diff(base, remote)
    return merge_with_diff(base, local, remote, base_local_diff, base_remote_diff)
