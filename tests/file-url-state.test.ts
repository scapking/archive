import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LOADING_FILE_URL_STATE,
    nextFileUrlState,
    type FileUrlState,
} from '../src/features/archive/ui/file-url-state.ts';

const ready = (uri: string): FileUrlState => ({ status: 'ready', uri });

test('a cached neighbour resolves synchronously to ready on switch', () => {
    const next = nextFileUrlState(ready('file://a.jpg'), 'b-key', 'file://b.jpg');
    assert.deepEqual(next, { status: 'ready', uri: 'file://b.jpg' });
});

test('an uncached key falls back to loading', () => {
    assert.equal(
        nextFileUrlState(ready('file://a.jpg'), 'b-key', null),
        LOADING_FILE_URL_STATE,
    );
});

test('a null key resolves to missing', () => {
    const next = nextFileUrlState(ready('file://a.jpg'), null, null);
    assert.equal(next.status, 'missing');
    assert.equal(next.uri, null);
});

test('the same key and uri keep the previous state object (referential stability)', () => {
    const prev = ready('file://a.jpg');
    assert.equal(nextFileUrlState(prev, 'a-key', 'file://a.jpg'), prev);
});