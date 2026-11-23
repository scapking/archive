import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeWheelTime,
    wheelIndexFromOffset,
    wheelOffsetForIndex,
} from '../src/features/archive/trip-item-form-logic.ts';

test('wheel offset and index round-trip across the value range', () => {
    for (let i = 0; i < 24; i += 1) {
        const offset = wheelOffsetForIndex(i, 44);
        assert.equal(wheelIndexFromOffset(offset, 44, 24), i);
    }
    for (let i = 0; i < 12; i += 1) {
        assert.equal(wheelIndexFromOffset(wheelOffsetForIndex(i, 44), 44, 12), i);
    }
});

test('wheel index clamps out-of-range offsets to the value range', () => {
    assert.equal(wheelIndexFromOffset(-100, 44, 12), 0);
    assert.equal(wheelIndexFromOffset(99999, 44, 12), 11);
    assert.equal(wheelIndexFromOffset(0, 44, 12), 0);
});

test('wheel index snaps to the nearest row, not the floor', () => {
    const base = wheelOffsetForIndex(3, 44);
    assert.equal(wheelIndexFromOffset(base + 21, 44, 24), 3);
    assert.equal(wheelIndexFromOffset(base + 23, 44, 24), 4);
});

test('normalizeWheelTime renders HH:mm with zero padding', () => {
    assert.equal(normalizeWheelTime(9, 5), '09:05');
    assert.equal(normalizeWheelTime(23, 55), '23:55');
});