import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAdoptExternalText } from '../src/features/archive/ui/ime-adoption.ts';

// IME 外部文本采纳判定（native uncontrolled 化后，唯一允许 setText 落位的时机）
test('blocks adoption while focused (composition session may be live)', () => {
    assert.equal(
        shouldAdoptExternalText({ focused: true, pendingCommit: false, shown: 'a', incoming: 'b' }),
        false,
    );
});

test('blocks adoption while a debounced commit is pending (native draft is authority)', () => {
    assert.equal(
        shouldAdoptExternalText({ focused: false, pendingCommit: true, shown: 'a', incoming: 'b' }),
        false,
    );
});

test('no-op when text already matches the shown baseline', () => {
    assert.equal(
        shouldAdoptExternalText({ focused: false, pendingCommit: false, shown: 'same', incoming: 'same' }),
        false,
    );
});

test('adopts real external change when idle', () => {
    assert.equal(
        shouldAdoptExternalText({ focused: false, pendingCommit: false, shown: 'old', incoming: 'new' }),
        true,
    );
});
