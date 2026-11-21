export type TripSubmitResult =
    | { kind: 'created'; tripId: string }
    | { kind: 'updated' }
    | { kind: 'failed' };

export interface TripSubmitOptions {
    tripId?: string;
    create(): Promise<{ id: string } | null>;
    update(): Promise<boolean>;
    onCreated(tripId: string): void;
    onUpdated(): void;
    onFailed(): void;
}

/**
 * Runs one trip create/update attempt and reports its outcome through exactly one
 * callback. Successful callbacks deliberately leave the caller's busy state alone
 * so a screen being removed by a native transition is not mutated in that frame.
 * Unexpected persistence rejections propagate unchanged.
 */
export async function runTripSubmit(options: TripSubmitOptions): Promise<TripSubmitResult> {
    if (options.tripId !== undefined) {
        const updated = await options.update();
        if (!updated) {
            options.onFailed();
            return { kind: 'failed' };
        }
        options.onUpdated();
        return { kind: 'updated' };
    }

    const created = await options.create();
    if (!created) {
        options.onFailed();
        return { kind: 'failed' };
    }
    options.onCreated(created.id);
    return { kind: 'created', tripId: created.id };
}
