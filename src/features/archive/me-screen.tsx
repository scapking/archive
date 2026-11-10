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
 * - 层级：身份行 → 指标卡 → 我的内容组 → 外观轻行，共 4 块；区块间距统一
 *   24（mt-6），全部落在 4dp 网格上；
 * - 外观区块（2026-11 三版迭代：v1 文字分段滑块「太丑」、v2 预览缩略图
 *   「不行」均被否——共同病根 = 第三张同质灰卡 + 控件堆砌；v3 定稿 =
 *   **去卡壳轻行式**：两组「label 左 + 控件右」字段行直接落页面底色，
 *   主题 = 三色圆点色板、图片对齐 = 紧凑分段滑块，行间留白不加线；详见
 *   AppearanceSection 注）；
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

                    {/* 外观区块（主题 + 图片对齐）：区块在行组时间线之后淡入（严格
                        自上而下，delay 锚点沿用原 ThemeSection 口径），无卡壳两
                        字段行（见 AppearanceSection 注）；进场 = 标题与行组两拍
                        交错（克制） */}
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
 * 外观区块（2026-11 三版定稿：v1 文字分段滑块、v2 预览缩略图均被否——
 * 共同病根 = 「第三张与指标卡/内容卡同质的灰卡 + 控件堆砌」，全页最弱内容
 * 占了最重的卡壳）：**去卡壳轻行式**——区块标题下两组「字段行」（label 左
 * 14px medium + 控件右，iOS 设置行口径，对齐内容卡行高节奏），直接落页面
 * 底色，行间留白不加线；轻重对比让区块退为页面的安静收尾。
 * - 主题行 = 三色圆点色板（ThemeDots）：颜色即内容，圆点自释各档；
 * - 图片对齐行 = 紧凑分段滑块（AlignSegmented）：轨道 ink-raised（页面
 *   base 上的顺延 well）、选中滑块 ink-base 反白（v1 的 tone 反转——容器
 *   从 surface 卡换到页面底色，阶梯整体上移一档）；
 * - 消费 useThemePref / useMediaAlignPref（persist 均在 hook 内收口），
 *   编辑器媒体块渲染对齐的设置入口，渲染消费在编辑器侧（另一链路）；
 * - 区块进场 = 标题（y=0 纯淡入）与行组（y=8）两拍交错，时间线锚点由
 *   调用方传入（沿用原 ThemeSection 的「行组之后」口径，严格自上而下）。
 */
function AppearanceSection({ delay }: { delay: number }) {
    const [pref, setPref] = useThemePref();
    const [align, setAlign] = useMediaAlignPref();
    return (
        <View className="mt-6">
            <Enter delay={delay} y={0}>
                <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                    外观
                </Text>
            </Enter>
            <Enter delay={delay + ENTER_STAGGER} y={8}>
                {/* 主题行：字段行（label 左 + 圆点色板右） */}
                <View className="h-12 flex-row items-center justify-between">
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">主题</Text>
                    <ThemeDots value={pref} onChange={setPref} />
                </View>
                {/* 图片对齐行：行间 mt-2 留白不加线（去线自然化口径） */}
                <View className="mt-2 h-12 flex-row items-center justify-between">
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">图片对齐</Text>
                    <AlignSegmented value={align} onChange={setAlign} />
                </View>
            </Enter>
        </View>
    );
}

/**
 * 主题三色圆点色板：颜色即内容的主题选择器（Telegram / Android 12 主题
 * 点同构）——白点 = 浅色、黑点 = 深色、左浅右深分屏点 = 跟随系统，无文字
 * 标签（形态自解释，语义在 a11y label 完整保留）。
 * - 圆点颜色**固定写死、不随当前主题**（depict 各档观感）：取值 = 调色板
 *   字面量（#FFFFFF = ink.base、#080A0A = inkd.base；描边 #8B939C =
 *   ink.muted、#7A827F = inkd.muted——control 档太淡，白点在白页底像空圈，
 *   实测加深一档）；三点统一描边——白点在浅色页面
 *   底、黑点在深色页面底各需描边才可见，统一挂比逐点条件更安静；
 * - 选中态 = radio 式外环（36dp 环圈 border-2 ink-text + 24dp 圆点居中，
 *   天然 4dp 呼吸缝）：accent 禁上 chrome（tailwind.config 注），ink-text
 *   是 iOS 蓝环的 ink-only 替代；未选中环透明占位（border-2 恒挂，选中
 *   切换无布局跳动）；
 * - 命中：环圈 36dp < 44 → hitSlop 6 补足；点距 = 36 + gap-3.5(14) = 50，
 *   6×2 slop < 14 相邻不重叠。
 */
function ThemeDots({ value, onChange }: { value: ThemePref; onChange: (pref: ThemePref) => void }) {
    const options: Array<{ key: ThemePref; label: string }> = [
        { key: 'system', label: '跟随系统' },
        { key: 'light', label: '浅色' },
        { key: 'dark', label: '深色' },
    ];
    return (
        <View className="flex-row items-center gap-3.5">
            {options.map((option) => (
                <Pressable
                    key={option.key}
                    onPress={() => onChange(option.key)}
                    hitSlop={6}
                    className="active:opacity-60"
                    accessibilityRole="button"
                    accessibilityState={{ selected: value === option.key }}
                    accessibilityLabel={`主题：${option.label}`}
                >
                    <View
                        className={`h-9 w-9 items-center justify-center rounded-full border-2 ${
                            value === option.key ? 'border-ink-text dark:border-inkd-text' : 'border-transparent'
                        }`}
                    >
                        <ThemeDotSwatch kind={option.key} />
                    </View>
                </Pressable>
            ))}
        </View>
    );
}

/**
 * 主题圆点涂装（颜色固定写死，见 ThemeDots 注）：「跟随系统」= 左浅右深
 * 分屏一圆；浅/深 = 单色圆 + 统一描边。
 */
function ThemeDotSwatch({ kind }: { kind: ThemePref }) {
    if (kind === 'system') {
        return (
            <View className="h-6 w-6 flex-row overflow-hidden rounded-full border border-[#8B939C] dark:border-[#7A827F]">
                <View className="h-full w-1/2 bg-[#FFFFFF]" />
                <View className="h-full w-1/2 bg-[#080A0A]" />
            </View>
        );
    }
    return (
        <View
            className={`h-6 w-6 rounded-full border border-[#8B939C] dark:border-[#7A827F] ${
                kind === 'light' ? 'bg-[#FFFFFF]' : 'bg-[#080A0A]'
            }`}
        />
    );
}

/**
 * 图片对齐紧凑分段滑块（v1 SegmentedTrack 的紧凑复刻，轨道在页面底色上
 * tone 上移一档：轨道 ink-raised、选中滑块 ink-base 反白；无卡壳行右侧
 * 自然宽度，不做 flex-1 满宽）：
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
function AlignSegmented({ value, onChange }: { value: MediaAlign; onChange: (align: MediaAlign) => void }) {
    const options: Array<{ key: MediaAlign; label: string }> = [
        { key: 'left', label: '靠左' },
        { key: 'center', label: '居中' },
        { key: 'right', label: '靠右' },
    ];
    const [trackW, setTrackW] = useState(0);
    const placedRef = useRef(false);
    const sliderX = useRef(new Animated.Value(0)).current;
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === value));
    // 段宽：轨道 p-1(4)×2、段间无 gap → (trackW - 8) / 3（三段等分）
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
            className="flex-row rounded-control bg-ink-raised p-1 dark:bg-inkd-raised"
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
                        accessibilityLabel={`图片对齐：${option.label}`}
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
