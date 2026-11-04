import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideCalendar, LucideBookOpen, LucideSearch } from '@/core/icons';
import * as db from './db';
import { useArchiveRevision, useArchiveStore } from './store';
import { decorateTrip, formatTripRange } from './trip-logic';
import { previewText, parseBlocks } from './journal-logic';
import { LineChart } from './ui/line-chart';
import { StatusChip } from './ui/status-chip';
import { ScreenHeader } from './ui/screen-header';
import { useEffectiveTheme, useThemePref, type ThemePref } from './ui/theme';

/**
 * Me：曲线与指标、日记与行程检索、行程完成度、主题偏好。
 * 本屏唯一问题："我坚持得怎么样，东西在哪？"
 */
export function MeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const error = useArchiveStore((s) => s.error);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<{ journals: db.JournalRow[]; trips: db.TripRow[] } | null>(null);
    const [searching, setSearching] = useState(false);

    // 搜索防抖（300ms）：空串清结果
    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setResults(null);
            setSearching(false);
            return;
        }
        setSearching(true);
        const timer = setTimeout(() => {
            void (async () => {
                const [journals, found] = await Promise.all([db.searchJournals(q), db.searchTrips(q)]);
                setResults({ journals, trips: found });
                setSearching(false);
            })();
        }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    if (!ready) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <ActivityIndicator color="#3B82F6" />
            </View>
        );
    }

    const ongoing = trips.filter((t) => t.status === 'ongoing').length;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[17px] font-semibold text-ink-text dark:text-inkd-text">Me</Text>
                    <Text className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                        {metrics.streak > 0 ? `连续 ${metrics.streak} 天，别断` : '从今天开始连续记录'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-ink-negative dark:text-inkd-negative">{error}</Text>
                    ) : null}
                </View>

                <ScrollView
                    contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 32 }}
                >
                    {/* 指标 */}
                    <View className="mt-3 flex-row gap-2">
                        <MetricCell value={`${metrics.streak}`} unit="天" label="连续记录" />
                        <MetricCell value={`${metrics.journalDays}`} unit="天" label="写过日记" />
                        <MetricCell value={formatCount(metrics.totalWords)} unit="" label="累计字数" />
                        <MetricCell value={`${ongoing}/${trips.length}`} unit="" label="进行中行程" />
                    </View>

                    {/* 30 天曲线 */}
                    <View className="mt-4 rounded-xl border border-ink-border bg-ink-surface p-4 dark:border-inkd-border dark:bg-inkd-surface">
                        <View className="mb-1 flex-row items-center justify-between">
                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                最近 30 天写作量
                            </Text>
                            <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                                字 / 天
                            </Text>
                        </View>
                        <LineChart points={metrics.curve} />
                    </View>

                    {/* 检索 */}
                    <View className="mt-4">
                        <View className="h-11 flex-row items-center gap-2 rounded-lg border border-ink-border bg-ink-surface px-3 dark:border-inkd-border dark:bg-inkd-surface">
                            <LucideSearch size={16} color="#8B939C" />
                            <TextInput
                                className="h-full flex-1 text-[14px] text-ink-text dark:text-inkd-text"
                                placeholder="查找日记内容或行程…"
                                placeholderTextColor="#8B939C"
                                value={query}
                                onChangeText={setQuery}
                                returnKeyType="search"
                            />
                            {searching ? <ActivityIndicator size="small" color="#3B82F6" /> : null}
                        </View>
                        {results ? (
                            <View className="mt-3 gap-2">
                                {results.journals.length === 0 && results.trips.length === 0 ? (
                                    <Text className="py-2 text-[13px] text-ink-muted dark:text-inkd-muted">
                                        没有匹配的日记或行程
                                    </Text>
                                ) : null}
                                {results.trips.map((row) => {
                                    const trip = decorateTrip(row);
                                    return (
                                        <ResultRow
                                            key={trip.id}
                                            icon={<LucideCalendar size={16} color="#3B82F6" />}
                                            title={`${trip.icon ?? ''} ${trip.title}`.trim()}
                                            sub={`${formatTripRange(trip.start_date, trip.end_date)} · 行程`}
                                            onPress={() =>
                                                router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                            }
                                        />
                                    );
                                })}
                                {results.journals.map((row) => (
                                    <ResultRow
                                        key={row.id}
                                        icon={<LucideBookOpen size={16} color="#3B82F6" />}
                                        title={previewText(parseBlocks(row.blocks), 40) || '[媒体]'}
                                        sub={`${row.local_date} · ${row.status === 'open' ? '进行中' : '已收笔'}`}
                                        onPress={() =>
                                            router.push({ pathname: '/journal/[id]', params: { id: row.id } })
                                        }
                                    />
                                ))}
                            </View>
                        ) : null}
                    </View>

                    {/* 行程完成度列表 */}
                    <View className="mt-5">
                        <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            行程
                        </Text>
                        {trips.length === 0 ? (
                            <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                                还没有行程
                            </Text>
                        ) : (
                            <View className="gap-2">
                                {trips.map((trip) => {
                                    const pct =
                                        trip.plansTotal > 0
                                            ? Math.round((trip.plansDone / trip.plansTotal) * 100)
                                            : null;
                                    return (
                                        <BouncyPressable
                                            key={trip.id}
                                            scaleTo={0.98}
                                            onPress={() =>
                                                router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                            }
                                        >
                                            <View className="rounded-lg border border-ink-border bg-ink-surface px-4 py-3 dark:border-inkd-border dark:bg-inkd-surface">
                                                <View className="flex-row items-center justify-between">
                                                    <Text
                                                        numberOfLines={1}
                                                        className="mr-3 flex-1 text-[14px] font-medium text-ink-text dark:text-inkd-text"
                                                    >
                                                        {trip.icon ?? '🧭'} {trip.title}
                                                    </Text>
                                                    <StatusChip status={trip.status} />
                                                </View>
                                                <View className="mt-1.5 flex-row items-center">
                                                    <Text className="text-[12px] text-ink-secondary dark:text-inkd-secondary">
                                                        {formatTripRange(trip.start_date, trip.end_date)} · 已写 {trip.journalDays}/{trip.dayCount} 天
                                                    </Text>
                                                    {pct !== null ? (
                                                        <Text
                                                            className="ml-auto text-[12px] text-ink-muted dark:text-inkd-muted"
                                                            style={{ fontVariant: ['tabular-nums'] }}
                                                        >
                                                            计划 {pct}%
                                                        </Text>
                                                    ) : null}
                                                </View>
                                            </View>
                                        </BouncyPressable>
                                    );
                                })}
                            </View>
                        )}
                    </View>

                    {/* 主题偏好 */}
                    <ThemeSection />
                </ScrollView>
            </View>
        </View>
    );
}

function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
    return (
        <View className="flex-1 rounded-xl border border-ink-border bg-ink-surface px-3 py-3 dark:border-inkd-border dark:bg-inkd-surface">
            <Text className="text-[18px] font-semibold text-ink-text dark:text-inkd-text">
                {value}
                {unit ? <Text className="text-[11px] font-normal"> {unit}</Text> : null}
            </Text>
            <Text className="mt-0.5 text-[11px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

function ResultRow({
    icon,
    title,
    sub,
    onPress,
}: {
    icon: React.ReactNode;
    title: string;
    sub: string;
    onPress(): void;
}) {
    return (
        <Pressable
            onPress={onPress}
            className="flex-row items-center gap-2.5 rounded-lg border border-ink-border bg-ink-surface px-3 py-2.5 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
        >
            {icon}
            <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-[14px] text-ink-text dark:text-inkd-text">
                    {title}
                </Text>
                <Text numberOfLines={1} className="text-[11px] text-ink-muted dark:text-inkd-muted">
                    {sub}
                </Text>
            </View>
        </Pressable>
    );
}

/** 主题偏好：system（跟随系统）/ light（灰白）/ dark。 */
function ThemeSection() {
    const [pref, setPref] = useThemePref();
    const theme = useEffectiveTheme();
    const options: Array<{ key: ThemePref; label: string }> = [
        { key: 'system', label: '跟随系统' },
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
    ];
    return (
        <View className="mt-5">
            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                外观（当前 {theme === 'dark' ? '深色' : '浅色'}）
            </Text>
            <View className="flex-row gap-1 rounded-lg border border-ink-border bg-ink-surface p-1 dark:border-inkd-border dark:bg-inkd-surface">
                {options.map((option) => {
                    const active = pref === option.key;
                    return (
                        <Pressable
                            key={option.key}
                            onPress={() => setPref(option.key)}
                            className={`h-9 flex-1 items-center justify-center rounded-md ${
                                active
                                    ? 'bg-ink-base shadow-none dark:bg-inkd-raised'
                                    : 'bg-transparent'
                            }`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                        >
                            <Text
                                className={`text-[12px] ${
                                    active
                                        ? 'font-medium text-ink-text dark:text-inkd-text'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                            >
                                {option.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

function formatCount(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return `${n}`;
}
