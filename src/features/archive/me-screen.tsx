import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    Pressable,
    ScrollView,
    Text,
    View,
    type NativeEventSubscription,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideCalendar,
    LucideChevronRight,
    LucideFlag,
    LucideSearch,
} from '@/core/icons';
import { useArchiveStore, type TripCard } from './store';
import { formatTripSpan } from './trip-logic';
import { LineChart, LoadingView, StatusChip, useEffectiveTheme, usePalette, useThemePref, type ThemePref } from './ui';

/**
 * Me：身份行（Me 标题 + 连续天数）、指标卡（3 格 KPI 单行 + 30 天曲线）、
 * 我的内容组（搜索 / 事件 / 行程列表）、主题偏好。
 * 本屏唯一问题："我坚持得怎么样，东西在哪？"
 *
 * 信息收敛口径（区块审计后的取舍，功能一项不丢）：
 * - 身份行：纯文本标题行（无头像/UID），连续天数只在此出现一次——KPI 不再
 *   重复渲染同语义数值（去重后 3 格收单行）；
 * - 指标：3 格 KPI 单行 + 曲线并作一张 surface 卡（连续天数已在身份行，KPI
 *   去重后由 2×2 收单行；3 列是本卡单行容纳的上限，单元横向 padding 收窄为
 *   px-3 防 label 换行），数值 tabular-nums。**去线自然化（2026-11 用户反馈
 *   「线条划分怪怪的」）**：KPI 格间竖线、KPI 与曲线段横线全部拆除，卡内
 *   分区靠留白不靠线（Apple Journal 卡片节奏，同 event-card 口径）——格间
 *   24px（px-3×2）留白、曲线段与 KPI 段 24px（py-3×2）纵向节奏；
 * - 内容：搜索 / 事件 / 行程行们（+ 行程空态块）并作**一张** rounded-card
 *   surface 卡（2026-11 用户反馈「三个卡片合并为一个卡片，不能划分线条要
 *   自然」——第三轮迭代：独立小卡 → 单卡多行）。卡内行与行**零线条**：行间
 *   分隔完全交给留白与行内 padding 节奏（入口行 h-12 单行、行程行/空态块
 *   py-3.5，行内统一 px-4 左缘；Apple Journal 卡片节奏，同 event-card / 指标
 *   卡口径），无任何 hairline 元素。按压语言 = 行级 Pressable +
 *   active:bg-ink-raised 背景**高亮**（iOS 设置列表式）：合并卡内行不再有
 *   自己的卡面，BouncyPressable 的 scale 变形会让行在卡内「抖动」、整卡 dim
 *   会透出卡底，且相邻行静止 / 被按行缩放的联动观感怪——底色高亮与「一张
 *   大卡」的容器隐喻自洽；Pressable 本体直接挂 active: 类无 css-interop
 *   remount 风险（View 挂 active: 才会被升级 remount，ThemeSection 同款先例）。
 *   行程数量增减时行自然增减；入口行 48dp 单行，行程行保留两行信息密度，
 *   副题行删除（题名自释，a11y 完整描述保留在入口行 label）；
 * - 层级：身份行 → 指标卡 → 我的内容组 → 外观，共 4 块；区块间距统一 24
 *   （mt-6），全部落在 4dp 网格上；
 * - 动效（RN Animated native driver，同 BouncyPressable / boot-screen 通道，
 *   不用 reanimated——Fabric 上驱动触摸视图样式有概率吞按压）：内容单元
 *   fade + translateY 交错进场（300ms ease-out、60ms 步进、reduceMotion 直接
 *   终态，见 Enter），曲线 opt-in 淡入（line-chart.animated，仅本屏开启），
 *   外观分段滑块 spring 跟随（见 ThemeSection）；动画层与触摸层分离
 *   （Enter 只做 Animated.View，Pressable 一律在其 children 内部）；
 * - 关于/版本：审计确认本页无此区块，不新增（无需折叠）。
 * 内联检索区已独立成 /search 页（DEV.md #5），此处只留组内一行入口。
 */

/** 进场节奏常量：单元 300ms（boot-screen 淡入同档）、交错 60ms（40~70ms
    区间中值）、卡片类位移 10dp（8~12 上限内）。整条时间线 ~1s 内收尾。 */
const ENTER_DURATION = 300;
const ENTER_STAGGER = 60;
const ENTER_OFFSET_Y = 10;

/**
 * 进场单元：fade + translateY 一次性入场（mount 即播，不重放）。
 * - 动画层与内容/触摸层分离：本组件只做 Animated.View（style 仅 opacity +
 *   transform、useNativeDriver，铁律），className 透传给动画层承担布局与
 *   留白；Pressable / BouncyPressable 一律在 children 内部，触摸面永不与本
 *   层动画 style 混挂；
 * - reduceMotion（系统减弱动态）：异步检测，命中即收敛静态终态——boot-screen
 *   同款取舍（检测异步，最坏代价 = 命中前已起播的 300ms 被截停跳终态）。
 */
function Enter({
    delay = 0,
    y = ENTER_OFFSET_Y,
    className,
    children,
}: {
    /** 开播延迟（ms）：区块级时间线用，单元内交错也走它（无嵌套时间线）。 */
    delay?: number;
    /** 初始纵向位移（dp）：0 = 纯淡入（文案类），默认 10（卡片类）。 */
    y?: number;
    className?: string;
    children: ReactNode;
}) {
    const [reduceMotion, setReduceMotion] = useState(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                // 读不到系统设置 → 按「无减弱」处理（动画照常，可接受的降级）
            });
        let sub: NativeEventSubscription | null = null;
        try {
            sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
        } catch {
            // 事件通道不可用的极端环境：只认首拍检测结果
        }
        return () => {
            cancelled = true;
            sub?.remove();
        };
    }, []);
    const progress = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        if (reduceMotion) {
            progress.setValue(1);
            return;
        }
        const anim = Animated.timing(progress, {
            toValue: 1,
            duration: ENTER_DURATION,
            delay,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
    }, [reduceMotion, delay, progress]);
    return (
        <Animated.View
            className={className}
            style={{
                opacity: progress,
                transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [y, 0] }) }],
            }}
        >
            {children}
        </Animated.View>
    );
}

export function MeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
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
                    {/* streak 轻动画：纯淡入（y=0），不位移不抢戏（用户口径「可选、不要过度」） */}
                    <Enter delay={80} y={0}>
                        <Text
                            className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {metrics.streak > 0 ? `连续 ${metrics.streak} 天，别断` : '从今天开始连续记录'}
                        </Text>
                    </Enter>
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
                    {/* 指标卡：3 格 KPI 单行 + 30 天曲线并作一张 surface 卡（连续天数
                        已在身份行，KPI 去重后由 2×2 收单行）。**无任何内部分隔线**：
                        KPI 格间靠两侧 px-3 留白相加（24px），曲线段与 KPI 段靠 py-3×2
                        纵向节奏——卡内分区靠留白不靠线（同 event-card / Apple Journal
                        口径）。卡片级仍是 surface-on-base tone 分层、rounded-card 16、
                        无描边无阴影（#13）。卡壳不做整体动画：KPI 格 / 曲线段各自
                        交错进场，卡面作为安静的「底」先立住，内容依次落位。 */}
                    <View className="mt-3 rounded-card bg-ink-surface dark:bg-inkd-surface">
                        <View className="flex-row">
                            <Enter className="flex-1" delay={0} y={8}>
                                <MetricCell value={`${metrics.journalDays}`} unit="天" label="写过日记" />
                            </Enter>
                            <Enter className="flex-1" delay={ENTER_STAGGER} y={8}>
                                <MetricCell value={formatCount(metrics.totalWords)} unit="" label="累计字数" />
                            </Enter>
                            <Enter className="flex-1" delay={ENTER_STAGGER * 2} y={8}>
                                <MetricCell value={`${ongoing}/${trips.length}`} unit="" label="进行中行程" />
                            </Enter>
                        </View>
                        <Enter className="px-4 py-3" delay={200} y={8}>
                            <View className="mb-1 flex-row items-center justify-between">
                                <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                    最近 30 天写作量
                                </Text>
                                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                    字 / 天
                                </Text>
                            </View>
                            {/* animated opt-in（组件默认行为不变，仅本屏开启）：曲线在段
                                容器进场后再淡入一拍（组件内延迟 260ms）——标题先立、
                                曲线后到，两拍节奏替代「一根横线」的段落划分 */}
                            <LineChart points={metrics.curve} animated />
                        </Enter>
                    </View>

                    {/* 我的内容：一张卡（搜索 / 事件 / 行程行们合并，卡内零线条——
                        行间靠 py 节奏与 px-4 统一左缘自然过渡，无 hairline）。卡壳
                        不做整体动画：行作为内容单元交错淡入，卡面作为安静的「底」
                        先立住（指标卡同款模式）。typedRoutes：'/search'、'/events'
                        尚未进 .expo/types 路由联合（本组不跑 Metro，字面量由 metro
                        启动时生成）——`as never` 是最小妥协（never 可赋给任何联合，
                        不产生 any 的误拓宽），类型生成后可直接删除断言。 */}
                    <View className="mt-6">
                        <Enter delay={240} y={0}>
                            <Text className="mb-3 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                我的内容
                            </Text>
                        </Enter>
                        <View className="rounded-card bg-ink-surface dark:bg-inkd-surface">
                            <Enter delay={280}>
                                <ContentEntryRow
                                    icon={<LucideSearch size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="搜索"
                                    onPress={() => router.push('/search' as never)}
                                    accessibilityLabel="搜索笔记与行程"
                                />
                            </Enter>
                            <Enter delay={280 + ENTER_STAGGER}>
                                <ContentEntryRow
                                    icon={<LucideFlag size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="事件"
                                    onPress={() => router.push('/events' as never)}
                                    accessibilityLabel="事件"
                                />
                            </Enter>
                            {trips.length === 0 ? (
                                <Enter delay={280 + ENTER_STAGGER * 2}>
                                    <TripsEmptyBlock />
                                </Enter>
                            ) : (
                                trips.map((trip, index) => (
                                    <Enter key={trip.id} delay={280 + ENTER_STAGGER * (2 + index)}>
                                        <TripRow
                                            trip={trip}
                                            onPress={() =>
                                                router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                            }
                                        />
                                    </Enter>
                                ))
                            )}
                        </View>
                    </View>

                    {/* 主题偏好：区块在行组时间线之后淡入（严格自上而下），段内滑块
                        spring 跟随选中项（见 ThemeSection） */}
                    <Enter delay={280 + ENTER_STAGGER * (2 + trips.length)}>
                        <ThemeSection />
                    </Enter>
                </ScrollView>
            </View>
        </View>
    );
}

/** KPI 单元（指标卡内的表格单元，不带自己的卡壳；flex-1 由外层 Enter 进场
    动画层承担）：数值 20px tabular + 弱化标签。单行 3 格，格间分隔 = 两侧
    px-3 留白相加（24px，无 hairline）；横向 padding 收窄为 px-3（px-4 在
    320pt 级窄屏会挤到 label 换行），py-3 与卡内曲线段行距一致；label 间距
    mt-1 落 4dp 网格。 */
function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
    return (
        <View className="px-3 py-3">
            <Text
                className="text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {value}
                {unit ? <Text className="text-[12px] font-normal text-ink-muted dark:text-inkd-muted"> {unit}</Text> : null}
            </Text>
            <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

/**
 * 内容入口行（搜索/事件共用行解剖）：48dp 单行 = 图标 + 题 + chevron，无卡壳
 * （卡面归合并卡整体，见屏头注释）。副题行收敛删除（题名自释，完整描述保留在
 * a11y label）。按压 = Pressable + active:bg-ink-raised 行级高亮（iOS 设置列表
 * 式，合并卡统一按压语言，取舍理由见屏头注释）：Pressable 本体直接挂 active:
 * 类无 css-interop remount 风险（View 挂 active: 才会被升级成 Pressable 首帧
 * 后 remount）。命中盒 = h-12（48 ≥44，hitSlop 0）；行间无 gap 贴靠，各行独立
 * 可按、触摸面无重叠（iOS 设置列表同款）。a11y 属性挂 Pressable 本体（无内层
 * 卡 View，不再需要 BouncyPressable 契约绕行）。
 */
function ContentEntryRow({
    icon,
    label,
    onPress,
    accessibilityLabel,
}: {
    icon: ReactElement;
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={onPress}
            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
        >
            {icon}
            <Text className="flex-1 text-[14px] font-medium text-ink-text dark:text-inkd-text">{label}</Text>
            <LucideChevronRight size={16} strokeWidth={1.9} color={palette.faint} />
        </Pressable>
    );
}

/**
 * 行程行（合并卡内的行程条目行）：题名行（emoji + 标题 + 状态片）+ 副题行
 * （区间 · 天数 · 已写 · 计划百分比），无卡壳。按压 = 行级 active:bg-ink-raised
 * 高亮（合并卡统一按压语言，同 ContentEntryRow）；命中盒 = px-4 py-3.5 全宽
 * 两行（自然高 ≥44，hitSlop 0），相邻行程行贴靠不重叠。a11y role 挂 Pressable
 * 本体（题名 Text 自释，无显式 label——与原独立卡同口径）。
 */
function TripRow({ trip, onPress }: { trip: TripCard; onPress: () => void }) {
    const pct = trip.plansTotal > 0 ? Math.round((trip.plansDone / trip.plansTotal) * 100) : null;
    return (
        <Pressable
            onPress={onPress}
            className="px-4 py-3.5 active:bg-ink-raised dark:active:bg-inkd-raised"
            accessibilityRole="button"
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
            <View className="mt-1 flex-row items-center">
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
}

/**
 * 行程空态（合并卡内的块，无卡壳——卡面归整卡）：图标行 + 一行"怎么做" +
 * CTA「创建行程」（frontend-design：空屏是指引，不是情绪）。块本身不是按压体，
 * 只有 CTA 可按；CTA h-11 全宽即命中盒，块内四周无相邻命中元素。按压反馈由
 * CTA 的 BouncyPressable 承担（控件级弹跳保留——它是按钮不是行），内层 View
 * 不用 active: 伪类（css-interop 会把 View 升级成 Pressable 首帧后 remount，同
 * EmptyState/ChooserRow 口径）。
 */
function TripsEmptyBlock() {
    const router = useRouter();
    const palette = usePalette();
    return (
        <View className="px-4 py-3.5">
            <View className="flex-row items-center gap-3">
                <LucideCalendar size={18} strokeWidth={1.9} color={palette.secondary} />
                <View className="min-w-0 flex-1">
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                        还没有行程
                    </Text>
                    <Text numberOfLines={1} className="mt-0.5 text-[12px] text-ink-muted dark:text-inkd-muted">
                        建一个行程，路上的日子就有地方记了
                    </Text>
                </View>
            </View>
            <View className="mt-3">
                <BouncyPressable onPress={() => router.push('/trip/new')} scaleTo={0.97}>
                    <View className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-base dark:border-inkd-border dark:bg-inkd-base">
                        <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                            创建行程
                        </Text>
                    </View>
                </BouncyPressable>
            </View>
        </View>
    );
}

/**
 * 主题偏好：system（跟随系统）/ light（灰白）/ dark。
 *
 * 分段滑块（Animated translateX spring 跟随选中项）：
 * - 滑块承载选中背景（raised，绝对定位铺在段后），段落本体不再挂条件 bg 类
 *   ——原「active ? bg-raised : bg-surface」三元是本区最大的 css-interop
 *   remount 风险点（bg-色 类携带 --tw-bg-opacity），滑块方案直接消除；
 *   文字层级仍随选中切换（font/色 纯静态类条件，沿用既有口径，无变量凭空
 *   出现路径）；按压反馈保留 active: 一档底色（未选中段按压可见，选中段与
 *   滑块同色不可见，天然无叠加冲突）；
 * - 几何：轨道 p-1(4) + 段间 gap-1(4)×2、三段 flex-1 等分 → 段宽 =
 *   (轨道宽 - 16) / 3；滑块 inset-y-1（高 = h-9 段高 36）、left-1、宽 = 段宽、
 *   translateX = 段序 × (段宽 + 4)。首次布局直接落位（不播「从最左横扫到位」），
 *   此后选中变更 spring 滑移（friction 9，BouncyPressable 回弹同档：短滑不
 *   过冲，克制）；
 * - 命中口径保留：分段本体 h-9(36) < 44 → 纵向 hitSlop 4 补足 44 等效；横向
 *   归 0（相邻段 gap-1 < 2×hitSlop，横向外扩会重叠误触）；
 * - 滑块 pointerEvents="none"（纯视觉层不参与触摸，EventCard 轴列同口径）；
 *   首帧轨道宽未测得时宽 0 不可见，onLayout 到位后落位。
 */
function ThemeSection() {
    const [pref, setPref] = useThemePref();
    const theme = useEffectiveTheme();
    const options: Array<{ key: ThemePref; label: string }> = [
        { key: 'system', label: '跟随系统' },
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
    ];
    const [trackW, setTrackW] = useState(0);
    const placedRef = useRef(false);
    const sliderX = useRef(new Animated.Value(0)).current;
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === pref));
    // 段宽：轨道 p-1(4)×2 + 段间 gap-1(4)×2 → (trackW - 16) / 3（flex-1 三等分内容区）
    const segW = trackW > 0 ? (trackW - 16) / options.length : 0;
    useEffect(() => {
        if (segW <= 0) return;
        const target = activeIndex * (segW + 4);
        if (!placedRef.current) {
            // 首次布局直接落位：进场不播横扫（克制；轨道旋转/web 拉伸后 segW
            // 变化走同一条 effect，自然重定位到新几何）
            placedRef.current = true;
            sliderX.setValue(target);
            return;
        }
        const spring = Animated.spring(sliderX, { toValue: target, friction: 9, useNativeDriver: true });
        spring.start();
        return () => spring.stop();
    }, [activeIndex, segW, sliderX]);
    return (
        <View className="mt-6">
            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                外观（当前 {theme === 'dark' ? '深色' : '浅色'}）
            </Text>
            {/* 轨道无边框（#13 收敛：容器级描边清除，surface-on-base 即 tone 档），
                与 trip-form EndModeSwitch / search 范围分段同一轨道语言 */}
            <View
                className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface"
                onLayout={(event) => setTrackW(event.nativeEvent.layout.width)}
            >
                {/* 滑块：先于段落渲染（后绘的段落文字浮在其上），纯视觉层 */}
                <Animated.View
                    pointerEvents="none"
                    className="absolute inset-y-1 left-1 rounded-thumb bg-ink-raised dark:bg-inkd-raised"
                    style={{ width: segW, transform: [{ translateX: sliderX }] }}
                />
                {options.map((option) => {
                    const active = pref === option.key;
                    return (
                        <Pressable
                            key={option.key}
                            onPress={() => setPref(option.key)}
                            // 分段本体 h-9(36px) < 44：纵向 hitSlop 4 补足 44 等效；
                            // 横向必须归 0——相邻分段 gap-1(4px) < 2×hitSlop，横向外扩会重叠
                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                            className="h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised"
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
