import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as db from './db';
import type { JournalRow } from './db';
import { useArchiveRevision, useArchiveStore, type TripCard } from './store';
import { isPlanOpen } from './plan-logic';
import { tripDisplayTitle } from './trip-logic';
import { CardDeck, CloseButton, LoadingView, safeBack, type DeckItem } from './ui';
// 深路径注记（v0.4.6 指令 4/7）：堆叠卡面与首页**同一实现源**——行程卡/计划卡
// 直接复用 archive-screen 导出的 TripCard / NoteDeckCard（屏间深取，同
// trip-detail ← DeadEndView 先例；两屏均在本组改动权限内）。首页卡面口径
// 「行程名不上卡面」（即使命名也不显示）经共用组件天然传导到本堆。
import { NoteDeckCard, TripCard as TripDeckCard } from './archive-screen';

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
 * 卡面（v0.4.6 指令 4/7 重样）：**与首页 deck 共用同一卡面组件**——行程卡
 * = 封面 + eyebrow（类型 + 区间/今天）+ 状态片 + 描述 + 统计（进度/已写），
 * 不再渲染行程名（兜底「未命名行程」一并退场）；计划卡 = eyebrow（类型 +
 * 建立日期）+ 题 + 引导行 + 正文预算，「更新于 …」「N 字」冗余串退场。
 * 空堆给设计过的邀请态（deck emptyState 槽），不再是一片死白。
 * 卡高由 CardPile 520 竖版档承担（首页 430 不受影响）。
 */

/** 库类型（路由壳注入）：note = 计划堆 / trip = 行程堆。 */
export type LibraryKind = 'note' | 'trip';

/** 空堆邀请态（deck emptyState 槽）：空区是行动指引，不是空白。 */
function EmptyPile({ kind }: { kind: LibraryKind }) {
    return (
        <View className="items-center px-6">
            <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                {kind === 'note' ? '计划' : '行程'}
            </Text>
            <Text className="mt-2 text-[24px] font-semibold text-ink-text dark:text-inkd-text">
                {kind === 'note' ? '没有进行中的计划' : '没有在途的行程'}
            </Text>
            <Text className="mt-2 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                {kind === 'note'
                    ? '计划是一件要做的事——回首页点 +，起个名字就成立。'
                    : '旅途从一段日期开始——回首页点 +，建好就进堆。'}
            </Text>
        </View>
    );
}

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
            // ongoing，finished（回忆）不进堆。卡面 = 首页 TripCard 同一实现
            // （无长按菜单面，点按由 deck 壳层承担）
            return trips
                .filter((trip: TripCard) => trip.status !== 'finished')
                .map((trip: TripCard): DeckItem => ({
                    key: `trip-${trip.id}`,
                    accessibilityLabel: `打开行程：${tripDisplayTitle(trip.title)}`,
                    onPress: () => router.push({ pathname: '/trip/[id]', params: { id: trip.id } }),
                    node: (
                        <TripDeckCard
                            trip={trip}
                            onOpen={() => router.push({ pathname: '/trip/[id]', params: { id: trip.id } })}
                        />
                    ),
                }));
        }
        // 计划堆只显进行中（已完成/已失败进搜索）——比较收口 plan-logic.isPlanOpen；
        // 卡面 = 首页 NoteDeckCard 同一实现
        return (notes ?? [])
            .filter(isPlanOpen)
            .map((note): DeckItem => ({
                key: `note-${note.id}`,
                accessibilityLabel: note.title?.trim() ? `打开计划：${note.title}` : '打开未命名计划',
                onPress: () => router.push({ pathname: '/plan/[id]', params: { id: note.id } } as never),
                node: <NoteDeckCard note={note} />,
            }));
    }, [kind, notes, trips, router]);

    if (!ready) return <LoadingView />;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头内联（trip-detail 同规格，v0.4.6 字阶纪律屏题档 24），无副标 */}
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text"
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
                    要有左右边距」）；空堆走 emptyState 邀请态 */}
                <View className="mx-auto w-full max-w-[560px] pt-4">
                    <View className="px-6">
                        <CardDeck items={items} height={520} emptyState={<EmptyPile kind={kind} />} />
                    </View>
                </View>
            </View>
        </View>
    );
}
