import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideCalendar } from '@/core/icons';
import { useArchiveStore } from './store';
import { formatTripRange } from './trip-logic';
import { StatusChip } from './ui/status-chip';
import { ComposeFab } from './ui/compose-fab';
import { EmptyState } from './ui/empty-state';
import { ActivityIndicator } from 'react-native';

/**
 * 行程列表：计划 → 进行 → 回忆，同一份数据的三种视角。
 * 本屏唯一问题："我的行程都怎样了？"——状态片先行，点击进入天骨架。
 */
export function TripsScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);

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
                    <Text className="text-[17px] font-semibold text-hatch-text">行程</Text>
                    <Text className="mt-1 text-[13px] text-hatch-secondary">
                        {trips.length > 0 ? `共 ${trips.length} 个行程` : '出发前是计划，回来后是回忆'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-[#F87171]">{error}</Text>
                    ) : null}
                </View>

                {trips.length === 0 ? (
                    <EmptyState
                        icon={<LucideCalendar size={40} color="#5F6664" />}
                        title="还没有行程"
                        hint="定下出发和返回的日子，每天会自动生成一格。"
                        actionLabel="新建行程"
                        onAction={() => router.push('/trip/new')}
                    />
                ) : (
                    <View className="gap-2 px-6" style={{ paddingBottom: insets.bottom + 96 }}>
                        {trips.map((trip) => (
                            <BouncyPressable
                                key={trip.id}
                                scaleTo={0.98}
                                onPress={() =>
                                    router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                }
                            >
                                <View className="rounded-lg border border-hatch-border bg-hatch-surface px-4 py-4">
                                    <View className="flex-row items-center justify-between">
                                        <Text
                                            numberOfLines={1}
                                            className="mr-3 flex-1 text-[15px] font-medium text-hatch-text"
                                        >
                                            {trip.title}
                                        </Text>
                                        <StatusChip status={trip.status} />
                                    </View>
                                    <View className="mt-2 flex-row items-center">
                                        <Text className="text-[13px] text-hatch-secondary">
                                            {formatTripRange(trip.start_date, trip.end_date)} · {trip.dayCount} 天
                                        </Text>
                                        <Text
                                            className="ml-auto text-[13px] text-hatch-muted"
                                            style={{ fontVariant: ['tabular-nums'] }}
                                        >
                                            {trip.entryCount} 条碎片
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        ))}
                    </View>
                )}
            </View>
            <ComposeFab onPress={() => router.push('/trip/new')} accessibilityLabel="新建行程" />
        </View>
    );
}
