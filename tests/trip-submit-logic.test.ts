import assert from 'node:assert/strict';
import test from 'node:test';
import { runTripSubmit } from '../src/features/archive/trip-submit-logic.ts';

test('a created trip navigates without resetting busy', async () => {
    let createdTripId: string | undefined;
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    const result = await runTripSubmit({
        create: async () => ({ id: 'trip-1' }),
        update: async () => {
            throw new Error('update must not run while creating');
        },
        onCreated: (tripId) => {
            createdTripId = tripId;
            createdCount += 1;
        },
        onUpdated: () => {
            updatedCount += 1;
        },
        onFailed: () => {
            failedCount += 1;
        },
    });

    assert.deepEqual(result, { kind: 'created', tripId: 'trip-1' });
    assert.equal(createdTripId, 'trip-1');
    assert.equal(createdCount, 1);
    assert.equal(updatedCount, 0);
    assert.equal(failedCount, 0);
});

test('an updated trip navigates without resetting busy', async () => {
    let updatedCount = 0;
    let createdCount = 0;
    let failedCount = 0;

    const result = await runTripSubmit({
        tripId: 'trip-1',
        create: async () => {
            throw new Error('create must not run while updating');
        },
        update: async () => true,
        onCreated: () => {
            createdCount += 1;
        },
        onUpdated: () => {
            updatedCount += 1;
        },
        onFailed: () => {
            failedCount += 1;
        },
    });

    assert.deepEqual(result, { kind: 'updated' });
    assert.equal(updatedCount, 1);
    assert.equal(createdCount, 0);
    assert.equal(failedCount, 0);
});

test('a failed create or update resets busy', async () => {
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    const createResult = await runTripSubmit({
        create: async () => null,
        update: async () => {
            throw new Error('update must not run while creating');
        },
        onCreated: () => {
            createdCount += 1;
        },
        onUpdated: () => {
            updatedCount += 1;
        },
        onFailed: () => {
            failedCount += 1;
        },
    });
    const updateResult = await runTripSubmit({
        tripId: 'trip-1',
        create: async () => {
            throw new Error('create must not run while updating');
        },
        update: async () => false,
        onCreated: () => {
            createdCount += 1;
        },
        onUpdated: () => {
            updatedCount += 1;
        },
        onFailed: () => {
            failedCount += 1;
        },
    });

    assert.deepEqual(createResult, { kind: 'failed' });
    assert.deepEqual(updateResult, { kind: 'failed' });
    assert.equal(failedCount, 2);
    assert.equal(createdCount, 0);
    assert.equal(updatedCount, 0);
});

test('an unexpected store rejection remains observable', async () => {
    const rejection = new Error('database unavailable');
    let failedCount = 0;

    await assert.rejects(
        runTripSubmit({
            create: async () => {
                throw rejection;
            },
            update: async () => {
                throw new Error('update must not run while creating');
            },
            onCreated: () => {},
            onUpdated: () => {},
            onFailed: () => {
                failedCount += 1;
            },
        }),
        (caught: unknown) => caught === rejection,
    );
    assert.equal(failedCount, 0);
});
