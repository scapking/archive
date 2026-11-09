import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideCalendar,
    LucideCheck,
    LucideChevronRight,
    LucideFlag,
    LucideSearch,
} from '@/core/icons';
import { archiveConfig, ensureUid } from '@/config/archive';
import { clipboard } from '@/core/clipboard';
import { fileStorage } from '@/core/file-storage';
import { imageManipulator, SaveFormat, type Action } from '@/core/image-manipulator';
import { imagePicker } from '@/core/image-picker';
import { useArchiveStore } from './store';
import { formatTripSpan } from './trip-logic';
// 头像同 key 覆盖写后，useFileUrlState 的会话缓存（web blob / 已解析 URI）需要
// revision 广播触发复验失效——通知走中立层 data-revision，不依赖 store mutation。
import { notifyDataRevision } from './data-revision';
import { ProfileAvatar } from './ui/avatar';
import { LineChart, LoadingView, StatusChip, useEffectiveTheme, usePalette, useThemePref, type ThemePref } from './ui';

/** 头像文件 key（固定覆盖写）：manipulator 统一转码 JPEG，ext 恒 jpg——
    key 由存储协议限定段内字符（profile/avatar.jpg 合法），改 ext 会留下旧文件孤儿。 */
const AVATAR_FILE_KEY = 'profile/avatar.jpg';

/** 头像落盘边长（正方形 px）：44dp@3x ≈ 132 已够标题行显示，512 留放大查看与
    未来展示尺寸上调的余量，JPEG 后体积可控。 */
const AVATAR_PIXELS = 512;

/**
 * Me：身份行（44dp 小头像融入原 Me 标题行 + UID 弱化角注）、指标合卡（KPI 2×2 +
 * 30 天曲线）、我的内容组（搜索 / 事件 / 行程列表）、主题偏好。
 * 本屏唯一问题："我坚持得怎么样，东西在哪？"
 *
 * 信息收敛口径（区块审计后的取舍，功能一项不丢）：
 * - 指标：4 格 KPI + 曲线卡（原 5 个视觉块）并作一张 surface 卡，2 列网格不变
 *   （app-screens §12：四列挤压是禁手），列/行 hairline 走 ink-border（元素级
 *   边界，卡片级描边仍按 #13 清除），数值 tabular-nums；
 * - 内容：搜索卡 + 事件卡 + 独立「行程」区（原 3 块）归并为一组「我的内容」行组
 *   卡，行解剖统一（入口行 48dp 单行，行程行保留两行信息密度），副题行删除
 *   （题名自释，a11y label 保留完整描述）；
 * - 层级：身份行 → 指标合卡 → 我的内容组 → 外观；区块间距统一 24（mt-6）；
 * - 关于/版本：审计确认本页无此区块，不新增（无需折叠）。
 * 内联检索区已独立成 /search 页（DEV.md #5），此处只留组内一行入口。
 */
export function MeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const error = useArchiveStore((s) => s.error);

    // 头像 key（config 持久化；'' = 未设置）。文件本体在 file-storage，
    // 三态解析交给 ProfileAvatar（含文件被删的 missing 占位）。
    const avatarKey = archiveConfig.use((s) => s['ui.avatar']);
    const [avatarBusy, setAvatarBusy] = useState(false);

    // 设备 UID（config 持久化）：订阅展示，注水后经 ensureUid 幂等生成。
    const uid = archiveConfig.use((s) => s['ui.uid']);
    // 复制反馈（check 图标短暂出现）；定时器句柄随卸载清理。
    const [uidCopied, setUidCopied] = useState(false);
    const uidCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 首启 UID：必须在配置注水完成后生成——未注水时 store 是默认空值，此刻
    // 生成的 uid 会被注水结果覆盖丢失（ensureUid 的调用时机契约，见 config/archive）。
    useEffect(() => {
        const persist = archiveConfig.use.persist;
        if (persist.hasHydrated()) {
            ensureUid();
            return;
        }
        const unsub = persist.onFinishHydration(() => ensureUid());
        return unsub;
    }, []);

    // 复制反馈定时器随卸载清理（防泄漏 + 防卸载后 setState）
    useEffect(() => {
        return () => {
            if (uidCopyTimer.current) clearTimeout(uidCopyTimer.current);
        };
    }, []);

    const copyUid = async () => {
        if (!uid) return;
        try {
            const ok = await clipboard.setStringAsync(uid);
            setUidCopied(ok);
            if (uidCopyTimer.current) clearTimeout(uidCopyTimer.current);
            uidCopyTimer.current = setTimeout(() => setUidCopied(false), 1600);
        } catch (caught) {
            // 剪贴板异常不外抛：反馈图标不出现即是失败信号（web 权限拒绝等场景）
            console.warn('[me] copy uid failed:', caught);
            setUidCopied(false);
        }
    };

    /**
     * 头像选取 → 正方形裁剪 → 落盘 → config 记 key。
     * 错误经 store.error 上浮（与 trip-form pickVideo 同一口径），picker 异常
     * 必须 catch（unhandled rejection 会红屏）。
     */
    const pickAvatar = async () => {
        if (avatarBusy) return;
        setAvatarBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                quality: 1,
                // 正方形裁剪：native 弹系统 1:1 裁剪框；web 忽略该选项，
                // 由下方 manipulator 中心裁剪兜底（三端最终一致）
                allowsEditing: true,
                aspect: [1, 1],
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            // 统一中心正方形裁剪 + 缩到 AVATAR_PIXELS：native 裁剪框产物已是方形
            // 则跳过 crop 动作；web 无裁剪框由此兜底。统一 JPEG 转码后 ext 恒 jpg，
            // 固定 key 覆盖写（不产生旧格式孤儿文件）
            const side = Math.min(asset.width, asset.height);
            const actions: Action[] = [];
            if (asset.width !== asset.height) {
                actions.push({
                    crop: {
                        originX: Math.floor((asset.width - side) / 2),
                        originY: Math.floor((asset.height - side) / 2),
                        width: side,
                        height: side,
                    },
                });
            }
            actions.push({ resize: { width: AVATAR_PIXELS, height: AVATAR_PIXELS } });
            const manipulated = await imageManipulator.manipulateAsync(asset.uri, actions, {
                compress: 0.85,
                format: SaveFormat.JPEG,
            });
            await fileStorage.put(AVATAR_FILE_KEY, manipulated.bytes);
            // config 记 key（固定值）+ revision 广播：同 key 覆盖写后，
            // useFileUrlState 的 web blob 缓存 / native 已解析 URI 须复验失效重取
            archiveConfig.update({ 'ui.avatar': AVATAR_FILE_KEY });
            notifyDataRevision();
        } catch (caught) {
            useArchiveStore.setState({
                error: `头像设置失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setAvatarBusy(false);
        }
    };

    if (!ready) return <LoadingView />;

    const ongoing = trips.filter((t) => t.status === 'ongoing').length;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    {/* 身份行：原 Me 标题行（题 + 连续天数）左融 44dp 小头像（点击换，
                        相册选图 → 覆盖写 profile/avatar.jpg 交互保留）；UID 弱化为
                        右侧短码角注（短码 + 复制，不占独立区块） */}
                    <View className="flex-row items-center gap-3">
                        <Pressable
                            onPress={() => void pickAvatar()}
                            className="active:opacity-80"
                            accessibilityRole="button"
                            accessibilityLabel={avatarKey ? '更换头像' : '设置头像'}
                            accessibilityState={{ busy: avatarBusy }}
                        >
                            {/* 头像 44dp 即命中盒（≥44，Pressable hitSlop 0）；右侧
                                文本列非按压体，无命中重叠核算项。按压反馈走 active:
                                体系（与 trip-form 图标格同口径） */}
                            <ProfileAvatar fileKey={avatarKey || null} size={44} />
                        </Pressable>
                        <View className="min-w-0 flex-1">
                            <Text className="text-[20px] font-semibold text-ink-text dark:text-inkd-text">
                                Me
                            </Text>
                            <Text
                                className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                                style={{ fontVariant: ['tabular-nums'] }}
                            >
                                {metrics.streak > 0 ? `连续 ${metrics.streak} 天，别断` : '从今天开始连续记录'}
                            </Text>
                        </View>
                        {uid ? (
                            <Pressable
                                onPress={() => void copyUid()}
                                // 11px 角注（视觉 ~14px 高）+ hitSlop 纵向 15 → 44 等效
                                // 命中；横向 8：左侧题/连续天数列（gap-3=12px）与下方
                                // error 文案均非按压体，右侧是 px-6 空白——外扩无重叠
                                // 核算项
                                hitSlop={{ top: 15, bottom: 15, left: 8, right: 8 }}
                                className="flex-row items-center gap-1"
                                accessibilityRole="button"
                                accessibilityLabel="复制设备 UID"
                            >
                                <Text
                                    className="text-[11px] text-ink-muted dark:text-inkd-muted"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {/* 展示短版前 8 位（commit-hash 惯例：显示短、复制全——
                                        完整 UUID 才是有效标识，config 里存的是完整值） */}
                                    UID {uid.slice(0, 8)}
                                </Text>
                                {uidCopied ? (
                                    <LucideCheck size={12} strokeWidth={2} color={palette.accent} />
                                ) : null}
                            </Pressable>
                        ) : null}
                    </View>
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
                    {/* 指标合卡：4 格 KPI + 30 天曲线并作一张 surface 卡（原 5 个视觉块
                        → 1）。2 列网格（app-screens §12：四列挤压是禁手），列/行分隔
                        hairline 走 ink-border（元素级边界，同 TripBadge border 口径；
                        卡片级描边仍按 #13 清除，tone 分层靠 surface-on-base） */}
                    <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        <View className="flex-row">
                            <MetricCell value={`${metrics.streak}`} unit="天" label="连续记录" />
                            <View className="w-px bg-ink-border dark:bg-inkd-border" />
                            <MetricCell value={`${metrics.journalDays}`} unit="天" label="写过日记" />
                        </View>
                        <View className="h-px bg-ink-border dark:bg-inkd-border" />
                        <View className="flex-row">
                            <MetricCell value={formatCount(metrics.totalWords)} unit="" label="累计字数" />
                            <View className="w-px bg-ink-border dark:bg-inkd-border" />
                            <MetricCell value={`${ongoing}/${trips.length}`} unit="" label="进行中行程" />
                        </View>
                        <View className="h-px bg-ink-border dark:bg-inkd-border" />
                        <View className="px-4 py-3">
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
                    </View>

                    {/* 我的内容：搜索 / 事件 / 行程归并为一组（原 2 张入口卡 + 独立「行程」
                        区 → 1 张行组卡）。typedRoutes：'/search'、'/events' 尚未进
                        .expo/types 路由联合（本组不跑 Metro，字面量由 metro 启动时生成）
                        ——`as never` 是最小妥协（never 可赋给任何联合，不产生 any 的误
                        拓宽），类型生成后可直接删除断言。 */}
                    <View className="mt-6">
                        <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            我的内容
                        </Text>
                        <View className="overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                            <ContentEntryRow
                                icon={<LucideSearch size={18} strokeWidth={1.9} color={palette.secondary} />}
                                label="搜索"
                                onPress={() => router.push('/search' as never)}
                                accessibilityLabel="搜索笔记与行程"
                            />
                            <RowDivider />
                            <ContentEntryRow
                                icon={<LucideFlag size={18} strokeWidth={1.9} color={palette.secondary} />}
                                label="事件"
                                onPress={() => router.push('/events' as never)}
                                accessibilityLabel="事件"
                            />
                            {trips.length === 0 ? (
                                <Fragment>
                                    <RowDivider />
                                    <TripsEmptyBlock />
                                </Fragment>
                            ) : (
                                trips.map((trip, index) => {
                                    const pct =
                                        trip.plansTotal > 0
                                            ? Math.round((trip.plansDone / trip.plansTotal) * 100)
                                            : null;
                                    return (
                                        <Fragment key={trip.id}>
                                            {/* 每条行程行前置换分隔线：首行分隔「事件」入口行，
                                                其后行间分隔（行组卡统一行解剖的一部分） */}
                                            <RowDivider />
                                            <Pressable
                                                onPress={() =>
                                                    router.push({ pathname: '/trip/[id]', params: { id: trip.id } })
                                                }
                                                className="px-4 py-3 active:bg-ink-raised dark:active:bg-inkd-raised"
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
                                        </Fragment>
                                    );
                                })
                            )}
                        </View>
                    </View>

                    {/* 主题偏好 */}
                    <ThemeSection />
                </ScrollView>
            </View>
        </View>
    );
}

/** KPI 单元（指标合卡内的表格单元，不带自己的卡壳）：数值 20px tabular + 弱化标签。
    密度与原 2×2 卡片网格一致（px-4 py-3），壳层成本由合卡统一承担。 */
function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
    return (
        <View className="flex-1 px-4 py-3">
            <Text
                className="text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {value}
                {unit ? <Text className="text-[12px] font-normal text-ink-muted dark:text-inkd-muted"> {unit}</Text> : null}
            </Text>
            <Text className="mt-0.5 text-[12px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

/** 行组卡内部分隔 hairline：元素级边界（ink/border token 成对），全出血贴卡缘；
    卡片级描边不在此列（#13 清除的是卡片外描边）。 */
function RowDivider() {
    return <View className="h-px bg-ink-border dark:bg-inkd-border" />;
}

/**
 * 内容入口行（搜索/事件共用行解剖）：48dp 单行 = 图标 + 题 + chevron。
 * 副题行收敛删除（题名自释，完整描述保留在 a11y label）；整行即命中盒
 * （h-12 ≥44，Pressable 默认 hitSlop 0），同卡相邻行以 RowDivider 分隔、
 * 相互为非按压体，按压态无重叠核算项。
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
 * 行程空态（原 TripsEmptyCard 收敛为行组卡末行块）：图标行 + 一行"怎么做" +
 * CTA「创建行程」（frontend-design：空屏是指引，不是情绪）。卡壳由行组卡承担，
 * 本块只贡献内容；CTA h-11 全宽即命中盒，卡内四周无相邻命中元素。
 * 按压反馈由外层 BouncyPressable 承担，内层 View 不用 active: 伪类（css-interop
 * 会把 View 升级成 Pressable 首帧后 remount，同 EmptyState/ChooserRow 口径）。
 */
function TripsEmptyBlock() {
    const router = useRouter();
    const palette = usePalette();
    return (
        <View className="px-4 py-3">
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
        <View className="mt-6">
            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                外观（当前 {theme === 'dark' ? '深色' : '浅色'}）
            </Text>
            {/* 轨道无边框（#13 收敛：容器级描边清除，surface-on-base 即 tone 档），
                与 trip-form EndModeSwitch / search 范围分段同一轨道语言 */}
            <View className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                {options.map((option) => {
                    const active = pref === option.key;
                    return (
                        <Pressable
                            key={option.key}
                            onPress={() => setPref(option.key)}
                            // 分段本体 h-9(36px) < 44：纵向 hitSlop 4 补足 44 等效；
                            // 横向必须归 0——相邻分段 gap-1(4px) < 2×hitSlop，横向外扩会重叠
                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                            className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                // 条件类铁律：两侧变量集合必须恒等（bg-色 类都携带 --tw-bg-opacity）：
                                // 一侧 transparent/空串 会让变量在首帧后"凭空出现"，触发
                                // css-interop 的 upgrade-remount 路径（dev 下 stringify 还会炸）。
                                // 选中方向收敛为「加深一档」（raised），与 EndModeSwitch /
                                // 输入框聚焦态同一亮度语言（原 light 侧 bg-ink-base 是反向漂移）
                                active
                                    ? 'bg-ink-raised dark:bg-inkd-raised'
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
