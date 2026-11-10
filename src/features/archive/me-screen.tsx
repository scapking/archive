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
    LucideImage,
    LucideSearch,
} from '@/core/icons';
import { useArchiveStore, type TripCard } from './store';
import { formatTripSpan } from './trip-logic';
import { LineChart, LoadingView, StatusChip, usePalette, useThemePref, type ThemePref } from './ui';
import { useMediaAlignPref, type MediaAlign } from './ui/theme';

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
 *   remount 风险（View 挂 active: 才会被升级 remount）。
 *   行程数量增减时行自然增减；入口行 48dp 单行，行程行保留两行信息密度，
 *   副题行删除（题名自释，a11y 完整描述保留在入口行 label）；
 * - 层级：身份行 → 指标卡 → 我的内容组 → 外观卡，共 4 块；区块间距统一
 *   24（mt-6），全部落在 4dp 网格上；
 * - 外观卡（2026-11 四版迭代：v1 文字分段滑块、v2 预览缩略图、v3 去卡壳
 *   轻行式均被否；用户定调「多用卡片」——v4 定稿 = **实时预览卡**：卡上
 *   半迷你日记页随主题/对齐即时演示，下半两组紧凑分段，卡内零 hairline；
 *   详见 AppearanceSection 注）；
 * - 动效（RN Animated native driver，同 BouncyPressable / boot-screen 通道，
 *   不用 reanimated——Fabric 上驱动触摸视图样式有概率吞按压）：内容单元
 *   fade + translateY 交错进场（300ms ease-out、60ms 步进、reduceMotion 直接
 *   终态，见 Enter），曲线 opt-in 淡入（line-chart.animated，仅本屏开启），
 *   外观卡进场动画见 AppearanceSection 注；动画层与布局/触摸层分离
 *   （Enter 外层普通 View 承担 className、内层 Animated.View 只挂动画 style，
 *   Pressable 一律在其 children 内部）；
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
 * - 动画层与布局/触摸层分离：**className 挂外层普通 View，Animated.View 只挂
 *   内联动画 style（仅 opacity + transform、useNativeDriver，铁律）**——
 *   2026-11 修复 web desktop「Me 页部分 css 失效」：根因 = css-interop 的
 *   interop 注册表只登记 RN 原生组件（wrapJSX 按类型查表替换，见
 *   react-native-css-interop runtime/components.js），Animated.View 不在表；
 *   native 上 RN 源码 JSX 经 nativewind jsxImportSource 编译、内部 View 命中
 *   注册表，className「转发落地」恰好可用；web 上 react-native-web 是预编译
 *   产物（无 JSX，且 css-interop babel 插件的 allowedFileRegex 明确排除
 *   react-native-web 的 createElement 改写）→ Animated.View 内部渲染的 View
 *   不经过 wrapJSX，className 被静默丢弃（desktop-shell ShellSlot 同款实测
 *   先例）——本屏 KPI flex-1 ×3 与曲线段 px-4 py-3 在桌面 web 全数失效。
 *   修复后布局类落在两端都注册的普通 View 上，动画层保持纯 style 契约；
 *   Pressable / BouncyPressable 一律在 children 内部，触摸面永不与动画
 *   style 混挂；
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
        <View className={className}>
            <Animated.View
                style={{
                    opacity: progress,
                    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [y, 0] }) }],
                }}
            >
                {children}
            </Animated.View>
        </View>
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
                                曲线后到，两拍节奏替代「一根横线」的段落划分。
                                height=120 显式定高（4dp 网格，96~120 档上沿）：不用
                                aspectRatio/flex/百分比这类 web 宽容器下会计算失控的
                                尺寸策略，LineChart 内部即「显式 height style + onLayout
                                测宽」，两端一致；168 在空数据态显得空旷（desktop 大
                                空白反馈的观感成分之一），120 收紧后 plotH 仍有 88 */}
                            <LineChart points={metrics.curve} animated height={120} />
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

                    {/* 外观卡（主题 + 图片对齐）：区块在行组时间线之后淡入（严格
                        自上而下，delay 锚点沿用原 ThemeSection 口径），实时预览卡
                        = 预览块 + 两组紧凑分段（见 AppearanceSection 注）；进场 =
                        标题与卡体两拍交错（克制） */}
                    <AppearanceSection delay={280 + ENTER_STAGGER * (2 + trips.length)} />
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
 * 外观卡（2026-11 四版迭代定稿：v1 文字分段滑块「太丑」、v2 预览缩略图
 * 「不行」、v3 去卡壳轻行式仍「太丑」；用户定调「多用卡片」）。复盘共同
 * 病根 = 卡内没有「主角」：v1/v2 全是控件没有内容，v3 孤行悬在页面底。
 * v4 = **实时预览卡**，设置自己演示自己：
 * - 卡上半 = 迷你日记页预览块（AppearancePreview）：报头日期 + 两行正文 +
 *   媒体块。随主题整块翻色（bg-ink-base / dark:bg-inkd-base CSS 类自动切，
 *   零 JS）；随图片对齐媒体块当场挪位（self-start/center/end，三元两侧
 *   常量类）——点「深色」的第一反馈就是预览变暗，语义零学习成本；
 * - 卡下半 = 两组「label 左 14px medium + CompactSegmented 右」字段行
 *   （主题三档 / 图片对齐三档，同构不复制粘贴）；编辑器媒体块渲染对齐的
 *   设置入口，渲染消费在编辑器侧（另一链路），此处只做设置 UI；
 * - 卡内分区零 hairline：预览块与行组 mt-4(16) 留白、行组间 mt-2；
 * - 消费 useThemePref / useMediaAlignPref（persist 均在 hook 内收口）；
 *   预览正文 = 固定常量（大厂风固定文案口径，禁随机话术池）；
 * - 区块进场 = 标题（y=0 纯淡入）与卡体（y=8）两拍交错，时间线锚点由
 *   调用方传入（沿用原 ThemeSection 的「行组之后」口径，严格自上而下）。
 */
function AppearanceSection({ delay }: { delay: number }) {
    const [pref, setPref] = useThemePref();
    const [align, setAlign] = useMediaAlignPref();
    const themeOptions: Array<{ key: ThemePref; label: string }> = [
        { key: 'system', label: '跟随系统' },
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
    ];
    const alignOptions: Array<{ key: MediaAlign; label: string }> = [
        { key: 'left', label: '靠左' },
        { key: 'center', label: '居中' },
        { key: 'right', label: '靠右' },
    ];
    return (
        <View className="mt-6">
            <Enter delay={delay} y={0}>
                <Text className="mb-3 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                    外观
                </Text>
            </Enter>
            <Enter delay={delay + ENTER_STAGGER} y={8}>
                <View className="rounded-card bg-ink-surface dark:bg-inkd-surface">
                    {/* 实时预览块：迷你日记页（随主题翻色、随对齐挪位） */}
                    <View className="px-4 pt-4">
                        <AppearancePreview align={align} />
                    </View>
                    {/* 主题行：label 左 + 紧凑分段右（与预览块 mt-4 留白不加线） */}
                    <View className="mt-4 flex-row items-center justify-between px-4">
                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">主题</Text>
                        <CompactSegmented options={themeOptions} value={pref} onChange={setPref} labelPrefix="主题" />
                    </View>
                    {/* 图片对齐行：行间 mt-2 留白不加线（去线自然化口径） */}
                    <View className="mb-1 mt-2 flex-row items-center justify-between px-4">
                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">图片对齐</Text>
                        <CompactSegmented options={alignOptions} value={align} onChange={setAlign} labelPrefix="图片对齐" />
                    </View>
                </View>
            </Enter>
        </View>
    );
}

/** 预览块报头日期：真实本地日期（M月D日 · 周X，local 取值不落 UTC）。 */
function previewDateLabel(): string {
    const now = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    return `${now.getMonth() + 1}月${now.getDate()}日 · ${week}`;
}

/**
 * 迷你日记页预览块（外观卡的主角）：内容结构 = 编辑器真实层次（报头日期
 * 行 → 正文流 → 媒体块），文案固定常量非随机池；页 = ink-base（卡面
 * surface 的下一档 well，同原分段轨道阶梯，dark 反转自动翻色）；媒体块
 * 按 align 档 self-start/center/end 落位（三元两侧常量类，无变量凭空
 * 出现路径），块内 LucideImage 占位示「这是一张图」。
 */
function AppearancePreview({ align }: { align: MediaAlign }) {
    const palette = usePalette();
    const self = align === 'left' ? 'self-start' : align === 'center' ? 'self-center' : 'self-end';
    return (
        <View className="rounded-control bg-ink-base p-4 dark:bg-inkd-base">
            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">{previewDateLabel()}</Text>
            <Text className="mt-2 text-[12px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                今天把三天行程串了一遍，效率比想象中高。
            </Text>
            <Text className="mt-1 text-[12px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                给大理段补了两张图，晚上把账记了。
            </Text>
            <View className={`mt-3 h-14 w-3/5 items-center justify-center rounded-thumb bg-ink-control dark:bg-inkd-control ${self}`}>
                <LucideImage size={18} strokeWidth={1.9} color={palette.muted} />
            </View>
        </View>
    );
}

/**
 * 紧凑分段滑块（v1 SegmentedTrack 的泛型紧凑版，两组同构不复制粘贴；
 * 轨道回到 surface 卡内 tone 阶梯上移一档：轨道 ink-border、选中滑块
 * ink-base 反白；行右侧自然宽度，不做 flex-1 满宽）：
 * - 滑块承载选中背景（绝对定位铺段后，spring 跟随 friction 9，短滑不过冲），
 *   段落本体不挂条件 bg——规避 css-interop 条件 bg 三元 remount 风险点；
 *   首次布局直接落位不播横扫，选中变更 spring 滑移；
 * - **滑块几何一律内联 style**（Animated 系组件 className 在 web 被
 *   css-interop 静默丢弃，见 Enter 注）：Animated.View 只挂定位/宽度/
 *   transform，涂装交内层普通 View className；
 * - 几何：轨道 p-1(4)、段间无 gap、三段等分 → 段宽 = (轨道宽 - 8) / 3；
 *   滑块 top/bottom/left 4、宽 = 段宽、translateX = 段序 × 段宽；
 * - 命中：段本体 h-8(32) < 44 → 纵向 hitSlop 4 补足；段间零间隙横向归 0
 *   （外扩会与邻段重叠误触）。
 */
function CompactSegmented<T extends string>({
    options,
    value,
    onChange,
    labelPrefix,
}: {
    options: Array<{ key: T; label: string }>;
    value: T;
    onChange: (key: T) => void;
    labelPrefix: string;
}) {
    const [trackW, setTrackW] = useState(0);
    const placedRef = useRef(false);
    const sliderX = useRef(new Animated.Value(0)).current;
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === value));
    // 段宽：轨道 p-1(4)×2、段间无 gap → (trackW - 8) / options.length（等分内容区）
    const segW = trackW > 0 ? (trackW - 8) / options.length : 0;
    useEffect(() => {
        if (segW <= 0) return;
        const target = activeIndex * segW;
        if (!placedRef.current) {
            placedRef.current = true;
            sliderX.setValue(target);
            return;
        }
        const spring = Animated.spring(sliderX, { toValue: target, friction: 9, useNativeDriver: true });
        spring.start();
        return () => spring.stop();
    }, [activeIndex, segW, sliderX]);
    return (
        <View
            className="flex-row rounded-control bg-ink-border p-1 dark:bg-inkd-border"
            onLayout={(event) => setTrackW(event.nativeEvent.layout.width)}
        >
            {/* 滑块：纯视觉层先渲染（段落文字浮其上），几何内联 style（web 可靠性
                见组件注），涂装在内层普通 View */}
            <Animated.View
                pointerEvents="none"
                style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: 4,
                    width: segW,
                    transform: [{ translateX: sliderX }],
                }}
            >
                <View className="h-full w-full rounded-thumb bg-ink-base dark:bg-inkd-base" />
            </Animated.View>
            {options.map((option) => {
                const active = value === option.key;
                return (
                    <Pressable
                        key={option.key}
                        onPress={() => onChange(option.key)}
                        hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                        className="h-8 items-center justify-center px-4"
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`${labelPrefix}：${option.label}`}
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
    );
}

function formatCount(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return `${n}`;
}
