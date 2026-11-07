import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LucideChevronRight, LucideSearch } from '@/core/icons';
import { useArchiveStore } from './store';
import { formatTripSpan } from './trip-logic';
import { LineChart, LoadingView, StatusChip, useEffectiveTheme, usePalette, useThemePref, type ThemePref } from './ui';

/**
 * Me：曲线与指标、搜索入口、行程完成度、主题偏好。
 * 本屏唯一问题："我坚持得怎么样，东西在哪？"
 * KPI 手机端 2 列网格（app-screens §12：四列挤压是禁手），数值 tabular-nums。
 * 内联检索区已独立成 /search 页（DEV.md #5），此处只留一张入口卡。
 */
export function MeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const error = useArchiveStore((s) => s.error);

    if (!ready) return <LoadingView />;

    const ongoing = trips.filter((t) => t.status === 'ongoing').length;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[20px] font-semibold text-ink-text dark:text-inkd-text">Me</Text>
                    <Text
                        className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {metrics.streak > 0 ? `连续 ${metrics.streak} 天，别断` : '从今天开始连续记录'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-ink-negative dark:text-inkd-negative">{error}</Text>
                    ) : null}
                </View>

                {/* 阅读列宽约束（mx-auto + max-w-[560px]）：与其他屏同口径，桌面 web 不拉满全宽 */}
                <ScrollView
                    className="mx-auto w-full max-w-[560px]"
                    contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 32 }}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* 指标：2 列网格（4 格 → 2×2） */}
                    <View className="mt-3 gap-2">
                        <View className="flex-row gap-2">
                            <MetricCell value={`${metrics.streak}`} unit="天" label="连续记录" />
                            <MetricCell value={`${metrics.journalDays}`} unit="天" label="写过日记" />
                        </View>
                        <View className="flex-row gap-2">
                            <MetricCell value={formatCount(metrics.totalWords)} unit="" label="累计字数" />
                            <MetricCell value={`${ongoing}/${trips.length}`} unit="" label="进行中行程" />
                        </View>
                    </View>

                    {/* 30 天曲线 */}
                    <View className="mt-4 rounded-card border border-ink-border bg-ink-surface p-4 dark:border-inkd-border dark:bg-inkd-surface">
                        <View className="mb-1 flex-row items-center justify-between">
                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                最近 30 天写作量
                            </Text>
                            <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                字 / 天
                            </Text>
                        </View>
                        <LineChart points={metrics.curve} />
                    </View>

                    {/* 搜索入口卡（独立搜索页的 me 页入口，DEV.md #5） */}
                    <SearchEntryCard />

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
                                        <Pressable
                                            key={trip.id}
                                            onPress={() =>
                                                router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                            }
                                            className="rounded-control border border-ink-border bg-ink-surface px-4 py-3 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
                                        >
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
                                                <Text
                                                    className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {/* 区间文案走 formatTripSpan（持续性感知，open 行程安全：
                                                        formatTripRange 对 'open' 会抛 RangeError）；天数与
                                                        「已写」分母仅在固定跨度（dayCount != null）时追加，
                                                        持续性行程不渲染假分母（参照 archive-screen 口径） */}
                                                    {formatTripSpan(trip)}
                                                    {trip.dayCount != null ? ` · ${trip.dayCount} 天` : ''}
                                                    {trip.dayCount == null
                                                        ? ` · 已写 ${trip.journalDays} 天`
                                                        : ` · 已写 ${trip.journalDays}/${trip.dayCount} 天`}
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
                                        </Pressable>
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
        <View className="flex-1 rounded-card border border-ink-border bg-ink-surface px-4 py-3 dark:border-inkd-border dark:bg-inkd-surface">
            <Text
                className="text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {value}
                {unit ? <Text className="text-[12px] font-normal text-ink-muted dark:text-inkd-muted"> {unit}</Text> : null}
            </Text>
            <Text className="mt-0.5 text-[12px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

/**
 * 搜索入口卡（DEV.md #5）：内联检索区独立成 /search 后的 me 页入口。
 * 整卡即命中盒（≥44px，Pressable 默认 hitSlop 0，四周无相邻命中元素）。
 *
 * typedRoutes 说明：路由类型由 metro 启动时生成到 .expo/types/router.d.ts，
 * 本组不跑 Metro，生成物尚无 '/search' 字面量——`as never` 是最小妥协
 * （never 可赋给任何联合，不产生 any 的误拓宽），类型生成后可直接删除断言。
 */
function SearchEntryCard() {
    const router = useRouter();
    const palette = usePalette();
    return (
        <Pressable
            onPress={() => router.push('/search' as never)}
            className="mt-4 flex-row items-center gap-3 rounded-card border border-ink-border bg-ink-surface px-4 py-3 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel="搜索笔记与行程"
        >
            <View className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised">
                <LucideSearch size={18} color={palette.secondary} />
            </View>
            <View className="min-w-0 flex-1">
                <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                    搜索笔记与行程
                </Text>
                <Text numberOfLines={1} className="mt-0.5 text-[12px] text-ink-muted dark:text-inkd-muted">
                    按关键词或日期，翻找写过的字与走过的路
                </Text>
            </View>
            <LucideChevronRight size={16} color={palette.faint} />
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
            <View className="flex-row gap-1 rounded-control border border-ink-border bg-ink-surface p-1 dark:border-inkd-border dark:bg-inkd-surface">
                {options.map((option) => {
                    const active = pref === option.key;
                    return (
                        <Pressable
                            key={option.key}
                            onPress={() => setPref(option.key)}
                            // 分段本体 h-9(36px) < 44：纵向 hitSlop 4 补足 44 等效；
                            // 横向必须归 0——相邻分段 gap-1(4px) < 2×hitSlop，横向外扩会重叠
                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                            className={`h-9 flex-1 items-center justify-center rounded-lg active:bg-ink-raised dark:active:bg-inkd-raised ${
                                // 条件类两侧变量集合必须恒等（bg-色 类都携带 --tw-bg-opacity）：
                                // 一侧 transparent/空串 会让变量在首帧后"凭空出现"，触发
                                // css-interop 的 upgrade-remount 路径（dev 下 stringify 还会炸）
                                active
                                    ? 'bg-ink-base dark:bg-inkd-raised'
                                    : 'bg-ink-surface dark:bg-inkd-surface'
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
