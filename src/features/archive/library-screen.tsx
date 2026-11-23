import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as db from './db';
import type { JournalRow } from './db';
import { useArchiveRevision, useArchiveStore, type TripCard } from './store';
import { formatEventDateTime } from './event-logic';
import { formatTripSpan, tripDisplayTitle } from './trip-logic';
import { CardDeck, LoadingView, safeBack, type DeckItem } from './ui';
import { CloseButton } from './ui';

/**
 * 堆叠库（v8，/notes 与 /trips 两个路由壳共用本屏，kind 区分——2026-11-19
 * 用户指令「计划就是计划，不是计划和行程」：每类入口只翻自己那一类卡）：
 * 计划堆 = 进行中的独立计划；行程堆 = 进行中（planning + ongoing）的行程——
 * 已完成的进搜索（2026-11-19 用户指令「历史的都放在搜索」）。点前卡进内容
 * （计划 → 编辑器，行程 → 详情）。顶部返回，无筛选无搜索（职责在 Me 搜索卡）。
 *
 * 数据刷新对齐 trip-detail 的自持界面取径：计划读 db.listPlans()，用
 * useArchiveRevision() 驱动重载（计划 mutation 只 bump revision）；行程读
 * store.trips（任一版本前进即重跑 loadAll，行程卡统计不滞留旧值）。
 *
 * 卡面从简（2026-11-19 用户指令）：只给标题 + 一行 meta（身份信息），不渲染
 * 计划内容/行程详情；卡高由 CardPile 按竖版相纸比例自适应（长卡居中）。
 */

/** 库类型（路由壳注入）：note = 计划堆 / trip = 行程堆。 */
export type LibraryKind = 'note' | 'trip';

export function LibraryScreen({ kind }: { kind: LibraryKind }) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const revision = useArchiveRevision();

    // 行程堆数据通道 = store.trips（loadAll 内重建）：任一版本前进即重跑
    // loadAll（saveJournalBlocks 等 revision 型 mutation 后不滞留旧值）；
    // revision = 0 是启动基线，首轮加载由 !ready effect 独占（archive 首页同款）
    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);
    useEffect(() => {
        if (revision > 0) void loadAll();
    }, [revision, loadAll]);

    // 计划列表（updated_at DESC，kind = 'note'）：revision 驱动重载。
    // null = 首载未完成 → LoadingView；[] = 已查（无计划或失败，失败经
    // store.error 上浮，下一次 revision 自动重试）。行程堆不读库。
    const [notes, setNotes] = useState<JournalRow[] | null>(kind === 'note' ? null : []);
    useEffect(() => {
        if (kind !== 'note') return;
        let active = true;
        db.listPlans()
            .then((rows) => {
                if (active) setNotes(rows);
            })
            .catch((caught) => {
                if (active) {
                    setNotes([]);
                    useArchiveStore.setState({
                        error: `计划列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [revision, kind]);

    // 卡序列（useMemo 引用稳定，hooks 铁律：挂在下方 early return 之前——
    // 「Rendered more hooks」崩溃的教训，2026-11-19 真机实证）
    const items = useMemo<DeckItem[]>(() => {
        if (kind === 'trip') {
            // 只显进行中（2026-11-19 用户指令「历史的都放在搜索」）：planning +
            // ongoing，finished（回忆）不进堆
            return trips
                .filter((trip: TripCard) => trip.status !== 'finished')
                .map((trip: TripCard): DeckItem => ({
                key: `trip-${trip.id}`,
                onPress: () => router.push({ pathname: '/trip/[id]', params: { id: trip.id } }),
                // 卡面内容（卡壳与页码由 deck 统一绘制）：eyebrow 类型行 → 题 → 描述 → meta 行
                node: (
                    <View className="flex-1 flex-col px-6 py-5">
                        <Text
                            numberOfLines={1}
                            className="text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {'行程 · '}
                            {formatTripSpan(trip)}
                        </Text>
                        <Text
                            numberOfLines={2}
                            className="mt-1 text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {tripDisplayTitle(trip.title)}
                        </Text>
                        {trip.description.trim() ? (
                            <Text
                                numberOfLines={6}
                                className="mt-2 text-[13px] leading-5 text-ink-muted dark:text-inkd-muted"
                            >
                                {trip.description}
                            </Text>
                        ) : null}
                        <View className="min-h-0 flex-1" />
                        <Text
                            className="text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`已写 ${trip.journalDays} 天`}
                        </Text>
                    </View>
                ),
            }));
        }
        // 计划堆只显 open（完成的进搜索）
        return (notes ?? [])
            .filter((note) => note.status === 'open')
            .map((note): DeckItem => ({
            key: `note-${note.id}`,
            onPress: () => router.push({ pathname: '/plan/[id]', params: { id: note.id } } as never),
            // 卡面内容（卡壳与页码由 deck 统一绘制）：eyebrow 类型行 → 题 → 描述 → meta 行
            node: (
                <View className="flex-1 flex-col px-6 py-5">
                    <Text
                        numberOfLines={1}
                        className="text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {'计划 · '}
                        {`更新于 ${formatEventDateTime(note.updated_at)}`}
                    </Text>
                    <Text
                        numberOfLines={2}
                        className="mt-1 text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                    >
                        {note.title?.trim() || '未命名计划'}
                    </Text>
                    {note.description?.trim() ? (
                        <Text
                            numberOfLines={6}
                            className="mt-2 text-[13px] leading-5 text-ink-muted dark:text-inkd-muted"
                        >
                            {note.description}
                        </Text>
                    ) : null}
                    <View className="min-h-0 flex-1" />
                    <Text
                        className="text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {`${note.word_count} 字`}
                    </Text>
                </View>
            ),
        }));
    }, [kind, notes, trips, router]);

    if (!ready) return <LoadingView />;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头内联（trip-detail 同规格）：CloseButton back + 题，无副标 */}
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {kind === 'note' ? '计划' : '行程'}
                        </Text>
                    </View>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                </View>

                {/* deck 主体（重叠露条多卡泛化，长卡 520——首页 430 不受影响）；
                    水平居中（mx-auto 阅读列）+ 左右屏边距 px-6（用户指令「卡片
                    要有左右边距」），垂直位置照旧不居中 */}
                <View className="mx-auto w-full max-w-[560px] pt-4">
                    <View className="px-6">
                        <CardDeck items={items} height={520} />
                    </View>
                </View>
            </View>
        </View>
    );
}
