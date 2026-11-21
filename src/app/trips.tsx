import { LibraryScreen } from '@/features/archive';

/**
 * 行程堆路由（v8，/trips）：Me 页「行程」行进入——只旅行程卡。route adapter
 * 模式与 notes 同款。
 */
export default function TripsRoute() {
    return <LibraryScreen kind="trip" />;
}
