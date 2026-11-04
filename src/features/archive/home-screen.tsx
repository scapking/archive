import { useEffect, useMemo } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { NoteIcon } from '@/core/icons';
import { useArchiveStore } from './store';
import { formatDateGroupLabel, todayEntryDate, type TimelineGroup } from './entry-logic';
import { EntryCard } from './ui/entry-card';
import { ComposeFab } from './ui/compose-fab';
import { EmptyState } from './ui/empty-state';

/**
 * 时间线（首页）：碎片流按日期归档。
 * 本屏唯一问题："今天写了没？"——副行放今天的状态（发现先行），FAB 是最高频动作。
 */
export function TimelineScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const timeline = useArchiveStore((s) => s.timeline);
    const loadAll = useArchiveStore((s) => s.loadAll);

    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);

    const today = todayEntryDate();
    const todayCount = useMemo(
        () => timeline.find((group) => group.localDate === today)?.entries.length ?? 0,
        [timeline, today],
    );

    if (!ready) {
        return (
            <View className="flex-1 items-center justify-center bg-hatch-base">
                <ActivityIndicator color="#10B981" />
            </View>
        );
    }

    return (
        <View className="flex-1 bg-hatch-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-3 pt-2">
                    <Text className="text-[17px] font-semibold text-hatch-text">时间线</Text>
                    <Text className="mt-1 text-[13px] text-hatch-secondary">
                        {todayCount > 0 ? `今天已写 ${todayCount} 条` : '今天还没写，写下第一条'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-[#F87171]">{error}</Text>
                    ) : null}
                </View>

                <FlatList
                    data={timeline}
                    keyExtractor={(group) => group.localDate}
                    renderItem={({ item }) => <TimelineDay group={item} today={today} />}
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 96,
                    }}
                    ListEmptyComponent={
                        <EmptyState
                            icon={<NoteIcon size={40} color="#5F6664" />}
                            title="还没有碎片"
                            hint="一句话、一张图，都算。今天从第一条开始。"
                            actionLabel="写一条"
                            onAction={() => router.push('/write')}
                        />
                    }
                />
            </View>
            <ComposeFab onPress={() => router.push('/write')} accessibilityLabel="写一条" />
        </View>
    );
}

/** 一天：日期栏（手账页边距）+ 该日碎片。 */
function TimelineDay({ group, today }: { group: TimelineGroup; today: string }) {
    const label = formatDateGroupLabel(group.localDate, today);
    return (
        <View className="mb-6">
            <View className="mb-2.5 flex-row items-baseline">
                <Text className="text-[15px] font-semibold text-hatch-text">{label.monthDay}</Text>
                <Text className="ml-2 text-[12px] text-hatch-muted">{label.weekday}</Text>
                {label.relative ? (
                    <Text className="ml-2 text-[11px] font-medium text-hatch-accent">
                        {label.relative}
                    </Text>
                ) : null}
                <Text
                    className="ml-auto text-[11px] text-hatch-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {group.entries.length} 条
                </Text>
            </View>
            <View className="gap-2">
                {group.entries.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} />
                ))}
            </View>
        </View>
    );
}
