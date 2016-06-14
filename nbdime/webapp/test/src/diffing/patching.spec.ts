// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import expect = require('expect.js');

import {
  patch, patchStringified, DiffOp
} from '../../../build/patch';

import {
    IDiffEntry, IDiffAdd, IDiffRemove, IDiffReplace,
    IDiffPatch, IDiffAddRange, IDiffRemoveRange, JSON_INDENT
} from '../../../build/diffutil'


function makeAddRange(key: number, values: string | any[]) : IDiffAddRange {
    return {key: key, op: DiffOp.SEQINSERT, valuelist: values};
}

function makeRemoveRange(key: number, length: number) : IDiffRemoveRange {
    return {key: key, op: DiffOp.SEQDELETE, length: length};
}

function makeAdd(key: number, value: any) : IDiffAdd {
    return {key: key, op: DiffOp.ADD, value: value};
}

function makeRemove(key: number) : IDiffRemove {
    return {key: key, op: DiffOp.REMOVE};
}

function makeReplace(key: number, value: any) : IDiffReplace {
    return {key: key, op: DiffOp.REPLACE, value: value};
}

function makePatch(key: number, diff: IDiffEntry[]) : IDiffPatch {
    return {key: key, op: DiffOp.PATCH, diff: diff};
}


describe('nbdime', () => {

    describe('patchStringified', () => {

        it('should patch a simple string addition', () => {
            let base = "abcdef";
            let diff = makeAddRange(3, "ghi");
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be("abcghidef");
            expect(value.additions).to.eql([{from: 3, to: 6}]);
            expect(value.deletions).to.be.empty();
        });

        it('should patch a simple string deletion', () => {
            let base = "abcdef";
            let diff = makeRemoveRange(2, 2);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be("abef");
            expect(value.additions).to.be.empty();
            expect(value.deletions).to.eql([{from: 2, to: 4}]);
        });

        it('should patch a list addition', () => {
            let base = [1, 2, 3];
            let diff = makeAddRange(2, [-1, -2]);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "1,\n" +
                JSON_INDENT + "2,\n" +
                JSON_INDENT + "-1,\n" +
                JSON_INDENT + "-2,\n" +
                JSON_INDENT + "3\n" +
                "]"
            );
            let f = "[\n1,\n2,\n".length + JSON_INDENT.length * 2;
            let t = f + "-1,\n-2,\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.eql([{from: f, to: t}]);
            expect(value.deletions).to.be.empty();
        });

        it('should patch a list addition at start', () => {
            let base = [1, 2, 3];
            let diff = makeAddRange(0, [-1, -2]);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "-1,\n" +
                JSON_INDENT + "-2,\n" +
                JSON_INDENT + "1,\n" +
                JSON_INDENT + "2,\n" +
                JSON_INDENT + "3\n" +
                "]"
            );
            let f = "[\n".length;
            let t = f + "-1,\n-2,\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.eql([{from: f, to: t}]);
            expect(value.deletions).to.be.empty();
        });

        it('should patch a list addition at end', () => {
            let base = [1, 2, 3];
            let diff = makeAddRange(3, [-1, -2]);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "1,\n" +
                JSON_INDENT + "2,\n" +
                JSON_INDENT + "3,\n" +
                JSON_INDENT + "-1,\n" +
                JSON_INDENT + "-2\n" +
                "]"
            );
            let f = "[\n1,\n2,\n3,\n".length + JSON_INDENT.length * 3;
            let t = f + "-1,\n-2\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.eql([{from: f, to: t}]);
            expect(value.deletions).to.be.empty();
        });

        it('should patch a list deletion', () => {
            let base = [1, 2, 3, 4, 5];
            let diff = makeRemoveRange(2, 2);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "1,\n" +
                JSON_INDENT + "2,\n" +
                JSON_INDENT + "5\n" +
                "]"
            );
            let f = "[\n1,\n2,\n".length + JSON_INDENT.length * 2;
            let t = f + "3,\n4,\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.be.empty();
            expect(value.deletions).to.eql([{from: f, to: t}]);
        });

        it('should patch a list deletion at start', () => {
            let base = [1, 2, 3, 4, 5];
            let diff = makeRemoveRange(0, 2);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "3,\n" +
                JSON_INDENT + "4,\n" +
                JSON_INDENT + "5\n" +
                "]"
            );
            let f = "[\n".length;
            let t = f + "1,\n2,\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.be.empty();
            expect(value.deletions).to.eql([{from: f, to: t}]);
        });

        it('should patch a list deletion at end', () => {
            let base = [1, 2, 3, 4, 5];
            let diff = makeRemoveRange(3, 2);
            let value = patchStringified(base, [diff]);
            expect(value.remote).to.be(
                "[\n" +
                JSON_INDENT + "1,\n" +
                JSON_INDENT + "2,\n" +
                JSON_INDENT + "3\n" +
                "]"
            );
            let f = "[\n1,\n2,\n3\n,".length + JSON_INDENT.length * 3;
            let t = f + "4,\n5\n".length + JSON_INDENT.length * 2;
            expect(value.additions).to.be.empty();
            expect(value.deletions).to.eql([{from: f, to: t}]);
        });

    });

});