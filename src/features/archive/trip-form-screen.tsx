import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
    type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideCalendar,
    LucideTrash,
    LucideVideo,
} from '@/core/icons';
import { imagePicker } from '@/core/image-picker';
import { useArchiveStore } from './store';
import {
    addDaysLocal,
    dayDiff,
    isTripLocked,
    isTripOpenEnded,
    isValidLocalDate,
    todayLocal,
    validateTripInput,
} from './trip-logic';
import { runTripSubmit } from './trip-submit-logic';
import { safeBack } from './ui';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 close-button / editor-icons 先例）。
import { FieldInput } from './ui/field-input';
import {
    ActionMenuCard,
    EmptyState,
    isDateInputComplete,
    PAPER_CARD_SHADOW,
    PrimaryButton,
    ScreenHeader,
    Segmented,
    TRIP_ICON_DEFAULT,
    TripBadge,
    TripCoverVideo,
    usePalette,
} from './ui';
// 深路径注记（v0.4.7 日期选择重构）：DateField / DatePickerSheet 新组件族，
// ui/index.ts 不在本组改动权限内（扩表清单见交付报告），域内深取直连
// （FieldInput / field-input 先例同款）。
import { DateField, DatePickerSheet } from './ui/date-picker';
import type { TripRow } from './db';

/**
 * 行程可选图标候选（即 DB 存储值，emoji 语义不变）：每项在 TripBadge 中都有对应的
 * 线性徽标呈现；🐼 无线性对应（呈现会退回 emoji 原样，选择环内观感不一），换 🧳。
 * 首位 🧭 与 TRIP_ICON_DEFAULT 同值，仅为展示顺序——默认值来源是具名常量，不是「取第一个」。
 */
/** 横向图标带的滚动链收口样式（见消费处注释；overscrollBehavior* 为 RNW
 *  消费键，RN core 类型面未收录——单点 cast，值禁散写第二处）。 */
const ICON_STRIP_STYLE = { overscrollBehaviorX: 'contain' } as unknown as ViewStyle;

const ICON_CHOICES = ['🧭', '⛰️', '🌊', '🏛️', '🏙️', '🚗', '✈️', '🚄', '🏕️', '🍜', '📷', '🎡', '⛷️', '🏝️', '🧳', '🗺️'];

/**
 * 删除钮（二次确认态由父级持有）：普通表单危险区与锁定只读态共用同一决策点，
 * 避免「锁定了却连删都删不掉」的死角（#7 锁的是内容修改，删行程不是内容修改）。
 */
function DeleteTripControl({
    confirmDelete,
    onPress,
}: {
    confirmDelete: boolean;
    onPress(): void;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={onPress}
            className={`h-12 items-center justify-center rounded-control border ${
                confirmDelete
                    ? 'border-ink-negative bg-ink-negative-bg dark:border-inkd-negative dark:bg-inkd-negative-bg'
                    : // 条件类铁律：bg-transparent 会缺 --tw-bg-opacity 变量槽位，用 base 底
                      //（按钮坐在 base 画布上，视觉等价透明）保持两侧变量集恒等
                      'border-ink-border bg-ink-base dark:border-inkd-border dark:bg-inkd-base'
            }`}
            accessibilityRole="button"
            accessibilityLabel="删除行程"
        >
            <View className="flex-row items-center gap-1.5">
                <LucideTrash size={14} color={palette.negative} />
                <Text className="text-[13px] font-medium text-ink-negative dark:text-inkd-negative">
                    {/* 二次确认文案对齐 store.deleteTrip 的级联行为（日记/媒体/计划一并软删）：
                        危险操作必须把真实影响面说在确认文案里，不能只说「确认删除」 */}
                    {confirmDelete ? '将同时删除该行程下的全部日记与照片视频，再点一次确认删除' : '删除行程'}
                </Text>
            </View>
        </Pressable>
    );
}

/**
 * 行程表单（新建 / 编辑双模式，DEV.md #4 工作台口径的「创建像计划一样轻量」）。
 *
 * v0.4.7 行程域重构（令 2）：出发/返回日期从「三段裸数字输入格 + 嵌套在卡内」
 * 改为 DateField（纸井显示格式化日期）+ DatePickerSheet（月历浮层两步选定，
 * 区间闸网格禁选，手输兜底保留）；图标横滑带加滚动链收口（overscroll 截断 +
 * nestedScrollEnabled，纵向滚动卡顿归因见交付报告）；错误可见性收进 tinted
 * 横幅卡（settings 同源）。
 *
 * 极简化口径（用户需求「较少不必要的描述、减少步骤」）：
 * - 无分区标题：名称/日期/描述字段全部自说明（placeholder、分段标签、入口文案
 *   即说明），Section 标题属「不必要的描述」整层移除。v0.4.6 大胆重样（方向令
 *   §1/§3/§5，apple 参考）：三段各归一张 surface 纸卡 + PAPER_CARD 投影
 *   （卡间 mt-4 呼吸，卡内字段一律 raised 井——base-tripnew 的「大片空白」
 *   重排成有节奏的分组表单），字段文字 16/24 正文档、日期题 eyebrow 11 档，
 *   结束语义开关收口 ui/segmented（私有 EndModeSwitch 退役）；
 * - 图标 = 默认徽章 + 点击换：当前图标以 TripBadge 常驻名称行左侧，点徽章展开
 *   一行横滑选择格（选完即收，一步完成）——替代旧 2 行 16 格平铺（首屏高度 -56，
 *   选择是低频动作，不该常驻两行）；
 * - 描述默认展开（R4「默认一个输入框而不是点击后才出现」）：multiline
 *   FieldInput 常驻表单（新建/编辑同一形态，placeholder 自说明选填）；
 * - 封面视频（编辑模式）视觉降级：104px 大虚线框 → 一行轻量入口；已有视频
 *   保留预览 + 更换/移除（预览是内容不是步骤，必保）。
 *
 * 字段契约（R2 放宽）：标题选填（空串落库，展示层 tripDisplayTitle 兜底「未
 * 命名行程」）；出发日期选填——新建预填今天，清空仍须补齐才可提交；结束日期
 * 可选——分段切换「持续进行（默认）/ 设定结束」；提交统一走
 * endDate: string | null 语义（null = 持续进行，store 落 TRIP_OPEN_ENDED 哨兵），
 * 日期原值透传（#2：date-input 的自然输入归一已在组件内完成，表单不再二次
 * 加工）。已结束行程（isTripLocked）整表只读锁定：直达深链在此拦下，删除入口
 * 保留。
 */
export function TripFormScreen({ trip }: { trip?: TripRow } = {}) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const createTrip = useArchiveStore((s) => s.createTrip);
    const updateTrip = useArchiveStore((s) => s.updateTrip);
    const deleteTrip = useArchiveStore((s) => s.deleteTrip);
    const attachTripVideo = useArchiveStore((s) => s.attachTripVideo);
    const storeError = useArchiveStore((s) => s.error);

    // 默认初始图标 = 具名常量（TripBadge 内空值兜底同源）；编辑模式下 trip.icon 为历史
    // 空值时仍回退到同一常量，两条路径共用一个决策点，不再散落字面量
    const [icon, setIcon] = useState<string | null>(trip?.icon ?? TRIP_ICON_DEFAULT);
    const [title, setTitle] = useState(trip?.title ?? '');
    // 出发日期默认今天（R2「触发时间非必须自动按照当前时间设置」）：新建预填
    // today，可清可改；编辑模式原值透传
    const [startDate, setStartDate] = useState(trip?.start_date ?? todayLocal());
    // 结束语义：'open' = 持续进行 / 'fixed' = 有返回日。编辑既有行程按 end_date
    // 哨兵初始化，新建默认 open；DateInput 值域是日期串，'open' 绝不能进输入框
    const [endMode, setEndMode] = useState<'open' | 'fixed'>(
        trip && !isTripOpenEnded(trip) ? 'fixed' : 'open',
    );
    const [endDate, setEndDate] = useState(
        trip && !isTripOpenEnded(trip) ? trip.end_date : '',
    );
    const [description, setDescription] = useState(trip?.description ?? '');
    const [videoKey, setVideoKey] = useState<string | null>(trip?.video_key ?? null);
    const [submitting, setSubmitting] = useState(false);
    const [videoBusy, setVideoBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // 封面视频管理菜单（长按预览入口）：更换 = pickVideo 通道；移除 = removeVideo
    const [coverMenu, setCoverMenu] = useState(false);
    // 图标选择格展开态：默认收起（徽章已展示当前图标）；选完即收（一步完成）
    const [iconPickerOpen, setIconPickerOpen] = useState(false);
    // 日期选择浮层目标（v0.4.7 重构：点字段开月历，两步选定；null = 无浮层）
    const [pickerTarget, setPickerTarget] = useState<'start' | 'end' | null>(null);

    const isEdit = Boolean(trip);
    // 锁定（#7）：已结束行程只读。store.updateTrip 无锁预检，UI 是唯一闸门——
    // 详情页已隐藏编辑入口，这里拦直达 /trip/[id]/edit 的深链路径
    const locked = isEdit && trip ? isTripLocked(trip) : false;

    // 提交语义单一出口：open 模式 endDate = null（持续性），fixed 模式原值透传
    const endDateValue = endMode === 'fixed' ? endDate : null;
    const validation = useMemo(
        () => validateTripInput({ title, startDate, endDate: endDateValue }),
        [title, startDate, endDateValue],
    );
    const canSubmit =
        !submitting &&
        validation === null &&
        isDateInputComplete(startDate) &&
        (endMode === 'open' || isDateInputComplete(endDate));
    // 即时天数反馈（仅固定结束态）：持续进行无固定跨度，不渲染「共 N 天」
    const dayCount =
        endMode === 'fixed' &&
        isDateInputComplete(startDate) &&
        isDateInputComplete(endDate) &&
        endDate >= startDate &&
        isValidLocalDate(startDate)
            ? dayDiff(startDate, endDate) + 1
            : null;

    // Android 硬件返回先退出删除二次确认态，不直接退屏（写法参照 archive-screen）
    useEffect(() => {
        if (!confirmDelete) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setConfirmDelete(false);
            return true;
        });
        return () => sub.remove();
    }, [confirmDelete]);
    useEffect(() => {
        if (!coverMenu) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setCoverMenu(false);
            return true;
        });
        return () => sub.remove();
    }, [coverMenu]);

    /** 月历选定回写（DateField 主路径）：start 且返回日早于新出发日时把返回
     *  日同步挪到同一天（同日往返最常见形态，「不出错」——绝不让校验在用户
     *  看不见的位置炸开）；end 直接落值。上抛值已由 DatePickerSheet 过区间闸。 */
    const handlePickDate = (target: 'start' | 'end', date: string) => {
        if (target === 'start') {
            setStartDate(date);
            if (endMode === 'fixed' && isDateInputComplete(endDate) && endDate < date) {
                setEndDate(date);
            }
        } else {
            setEndDate(date);
        }
        setPickerTarget(null);
    };

    const switchEndMode = (mode: 'open' | 'fixed') => {
        setEndMode(mode);
        // 切到固定结束且结束日无效时用出发日兜底：同日往返是最常见形态，
        // 让用户从「合法值」上改比从空值上填少一步（可随时清空重填）
        if (mode === 'fixed' && !isDateInputComplete(endDate) && isDateInputComplete(startDate)) {
            setEndDate(startDate);
        }
    };

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            const submitTripId = trip?.id;
            await runTripSubmit({
                tripId: submitTripId,
                create: () =>
                    createTrip({
                        title,
                        startDate,
                        endDate: endDateValue,
                        description,
                        icon,
                    }),
                update: () => {
                    if (!submitTripId) {
                        throw new Error('行程更新缺少行程 ID');
                    }
                    return updateTrip(submitTripId, {
                        title,
                        startDate,
                        endDate: endDateValue,
                        description,
                        icon,
                        videoKey,
                    });
                },
                // 成功路径不复位 submitting：离场屏在原生移除过渡中不得再变更。
                onCreated: (tripId) => {
                    router.replace({ pathname: '/trip/[id]', params: { id: tripId } });
                },
                onUpdated: () => {
                    safeBack();
                },
                onFailed: () => {
                    setSubmitting(false);
                },
            });
        } catch (caught) {
            // 防御：updateTrip/createTrip 契约不 throw（失败走 false/null + store.error），
            // 这里只兜环境级意外，不让异常变 unhandled rejection
            useArchiveStore.setState({
                error: `保存失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
            setSubmitting(false);
        }
    };

    const pickVideo = async () => {
        if (videoBusy || !trip) return;
        setVideoBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
            if (result.canceled || result.assets.length === 0) return;
            const ok = await attachTripVideo(trip.id, result.assets[0].uri);
            // key 规则确定（trip-video/<id>.mp4），上传成功即回填预览
            if (ok) setVideoKey(`trip-video/${trip.id}.mp4`);
        } catch (caught) {
            // picker 抛错必须可见（对齐 journal-edit-screen 的 pick 写法），不能是 unhandled rejection
            useArchiveStore.setState({
                error: `视频选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setVideoBusy(false);
        }
    };

    const removeVideo = async () => {
        if (!trip) return;
        // 乐观摘预览（成功路径即时反馈，行为不变）；失败回滚必须用**删除前的本地
        // 值**而非 trip.video_key——trip 是路由壳挂载时的一次性快照，本会话内刚
        // attach 的视频只存在于 videoKey state（trip.video_key 仍为 null），修前
        // 回滚会把刚选的视频抹成 null（预览没了、库里还在的半更新态）
        const prevKey = videoKey;
        setVideoKey(null);
        const ok = await updateTrip(trip.id, { videoKey: null });
        // 失败回滚预览：防「界面删了、数据还在」的半更新态（失败文案经 store.error 上浮）
        if (!ok) setVideoKey(prevKey);
    };

    const remove = async () => {
        if (!trip) return;
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        const ok = await deleteTrip(trip.id);
        if (ok) safeBack();
    };

    // 锁定只读态（#7）：内容字段全部不可达，只保留「返回 + 删除」。
    // 删除保留的原因：已结束行程仍需可清理，否则旧行程在 UI 层无任何删除路径
    if (locked) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base">
                <View className="flex-1" style={{ paddingTop: insets.top }}>
                    <ScreenHeader title="行程" />
                    <EmptyState
                        icon={<LucideCalendar size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="行程已完成，内容锁定"
                        hint="已结束的行程只读，不能修改内容。"
                        actionLabel="返回"
                        onAction={safeBack}
                    />
                    <View
                        className="border-t border-ink-rule px-6 pt-5 dark:border-inkd-rule"
                        style={{ paddingBottom: insets.bottom + 24 }}
                    >
                        <DeleteTripControl confirmDelete={confirmDelete} onPress={() => void remove()} />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            {/* 屏头固定带（新建/编辑两态共用 ScreenHeader，规格同一）：对齐
                journal-edit / trip-detail / search 的四屏结构——ScreenHeader 在
                滚动容器**之外**。修前它嵌在 ScrollView 内且 contentContainer
                自带 paddingHorizontal 24，与 ScreenHeader 容器自带的 px-6(24)
                **双计**，返回钮/屏题左缘 = 48dp（其他三屏均为 24dp），即用户
                反馈「屏头返回键与行程/计划不对称」的根因；且屏头随内容滚动
                （其他三屏固定）。修后逐项对齐：几何带 = insets.top + pt-2(8) +
                h-11(44) 与四屏相等；返回钮 = CloseButton 'back' 44 圆形触感底
                盒（hitSlop 0，命中 = 视觉盒）、左缘 24 与表单字段同列对齐；
                标题 24px semibold（v0.4.6 屏题档）ml-2.5；safeBack 退出——全部经 ScreenHeader
                单点收口，两态（新建/编辑）零分叉。 */}
            <View style={{ paddingTop: insets.top }}>
                {/* 副标已删（2026-11-19 简洁化口径：屏头描述性副标全线退役——字段
                    自说明，placeholder/分段标签即说明，屏头只留屏题） */}
                <ScreenHeader title={isEdit ? '编辑行程' : '新建行程'} />
            </View>
            <ScrollView
                contentContainerStyle={{
                    paddingBottom: insets.bottom + 32,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                {/* ── 名称：当前图标徽章 + 名称输入同行（无分区标题，字段自说明）──
                    徽章 44×44 即命中盒（Pressable hitSlop 0，右邻输入容器非按压体）；
                    按压反馈走 active: 体系（TripBadge 不透明底会盖住 active:bg，
                    整格降透明度，与旧选择格同口径） */}
                <View
                    className="rounded-card bg-ink-surface p-4 dark:bg-inkd-surface"
                    style={PAPER_CARD_SHADOW}
                >
                    <View className="flex-row items-center gap-3">
                        <Pressable
                            onPress={() => setIconPickerOpen((open) => !open)}
                            className="active:opacity-80"
                            accessibilityRole="button"
                            accessibilityLabel={iconPickerOpen ? '收起图标选择' : '更换图标'}
                            accessibilityState={{ expanded: iconPickerOpen }}
                        >
                            <TripBadge icon={icon} size="cell" />
                        </Pressable>
                        <View className="flex-1">
                            {/* #1 推广收口：标题输入走 FieldInput；v0.4.6 升
                                tone raised（纸卡上的井，与日期字段同档）+ 16/24
                                正文档（方向令 §2 字阶），容器 h-14 命中档不变 */}
                            <FieldInput
                                tone="raised"
                                value={title}
                                onChangeText={setTitle}
                                placeholder="行程名称"
                                maxLength={40}
                                returnKeyType="next"
                                containerClassName="h-14"
                                style={{ fontSize: 16, lineHeight: 24 }}
                            />
                        </View>
                    </View>
                </View>

                {/* 图标选择：一行横滑（默认徽章 + 点击换的展开态）。外层垂直滚动，
                    内层水平滚动正交不冲突；contentContainer gap-2（8px 停车距）+
                    命中区 = 格本体（无 hitSlop，互不交叠）；选中态由 TripBadge
                    accent 框呈现（条件类变量集恒等在组件内收口）。选完即收：
                    选择是单步动作，收起让表单回到「名称 + 日期」的最小形态 */}
                {iconPickerOpen ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        className="mt-3"
                        contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                        keyboardShouldPersistTaps="handled"
                        // 纵向滚动卡顿修因（v0.4.7 令 4，实测归因见交付报告）：
                        // 横向带嵌在垂直 ScrollView 里，触屏沿「双轴接管」竞态——
                        // Android 显式声明嵌套（nestedScrollEnabled），web 用
                        // overscroll-behavior-x: contain 掐断横向滚动链上浮（该键
                        // RN ViewStyle 类型未收录，RNW 消费，单点 cast；纯纵向
                        // 手势不再被外层滚动仲裁拖进本容器的滚动管线）
                        nestedScrollEnabled
                        style={ICON_STRIP_STYLE}
                    >
                        {ICON_CHOICES.map((choice) => {
                            const active = icon === choice;
                            return (
                                <Pressable
                                    key={choice}
                                    onPress={() => {
                                        setIcon(choice);
                                        setIconPickerOpen(false);
                                    }}
                                    className="active:opacity-80"
                                    accessibilityRole="button"
                                    accessibilityLabel={`图标 ${choice}`}
                                    accessibilityState={{ selected: active }}
                                >
                                    <TripBadge icon={choice} size="cell" selected={active} />
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                ) : null}

                {/* ── 日期卡（v0.4.7 重构令 2：「一眼、两步、不出错」）：
                    结束语义仍走 ui/segmented row 档；日期本体从三段裸数字格
                    升为 DateField 纸井（显示「11月13日 周五」格式化文案 =
                    一眼）+ DatePickerSheet 月历浮层（开层点日即选定 = 两步；
                    返回日区间闸 [出发日, +365] 在网格禁选 = 不出错）。「手输」
                    兜底通道在浮层内保留（DateInput 语义原样，键盘可达）。
                    天数反馈挪上「返回日期」eyebrow 行尾 pill（数据与标签
                    同位，卡内不再多占一行散文）。── */}
                <View className="mt-4 rounded-card bg-ink-surface p-4 dark:bg-inkd-surface" style={PAPER_CARD_SHADOW}>
                    <Segmented
                        density="row"
                        accessibilityRole="radio"
                        options={[
                            { key: 'open', label: '持续进行' },
                            { key: 'fixed', label: '设定结束' },
                        ]}
                        value={endMode}
                        onChange={switchEndMode}
                        labelPrefix="结束日期"
                    />
                    <View className="mt-4">
                        <Text className="mb-1.5 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            出发日期
                        </Text>
                        <DateField
                            value={startDate}
                            accessibilityLabel="出发日期"
                            onPress={() => setPickerTarget('start')}
                        />
                    </View>
                    {endMode === 'fixed' ? (
                        <View className="mt-4">
                            <View className="mb-1.5 flex-row items-center justify-between">
                                <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    返回日期
                                </Text>
                                {dayCount !== null ? (
                                    <Text
                                        className="rounded-full bg-ink-raised px-2.5 py-0.5 text-[12px] font-medium text-ink-text dark:bg-inkd-raised dark:text-inkd-text"
                                        style={{ fontVariant: ['tabular-nums'] }}
                                    >
                                        {`共 ${dayCount} 天`}
                                    </Text>
                                ) : null}
                            </View>
                            <DateField
                                value={endDate}
                                accessibilityLabel="返回日期"
                                onPress={() => setPickerTarget('end')}
                            />
                            {dayCount !== null ? (
                                <Text className="mt-2 text-[12px] text-ink-muted dark:text-inkd-muted">
                                    每天会自动生成一格
                                </Text>
                            ) : null}
                        </View>
                    ) : null}
                </View>

                {/* ── 描述：默认展开的输入框（R4）——新建/编辑同一形态，不再「点击
                    后才出现」。多行起手高度 + 顶距：容器随内容自然撑开（minHeight 80
                    为 Yoga border-box 口径），调用侧 paddingTop 16 让首行与容器顶缘
                    有呼吸（调用侧 style 位于合并数组末位，覆盖 INPUT_TRANSPARENT_STYLE
                    的 paddingVertical: 0 简写）；FieldInput 口径与标题输入同源
                    （tone surface）。不 autofocus：进表单即弹键盘盖住上部主字段 */}
                <View
                    className="mt-4 rounded-card bg-ink-surface p-4 dark:bg-inkd-surface"
                    style={PAPER_CARD_SHADOW}
                >
                    <FieldInput
                        tone="raised"
                        multiline
                        value={description}
                        onChangeText={setDescription}
                        placeholder="行程描述"
                        maxLength={500}
                        style={{ minHeight: 88, paddingTop: 16, fontSize: 16, lineHeight: 26 }}
                    />
                </View>

                {/* ── 封面视频（编辑模式；锁定态整表已提前返回，不会到这里）──
                    视觉降级取舍：大虚线框 → 一行轻量入口（与「添加描述」同语言，
                    视频是低频增强项，不该占一屏的首屏高度）；已有视频保留预览 +
                    更换/移除（预览是内容不是步骤） */}
                {isEdit ? (
                    videoKey ? (
                        <View className="mt-5 gap-2">
                            <TripCoverVideo
                                fileKey={videoKey}
                                height={176}
                                onCoverAction={() => setCoverMenu(true)}
                            />
                            {/* 封面管理入口收敛为「长按预览」（2026-11-19 用户指令
                                「两个按钮删除，改成长按弹出」）：长按预览 → 封面视频
                                菜单（更换/移除，单容器 ActionMenuCard） */}
                            <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                                长按封面可更换或移除
                            </Text>
                        </View>
                    ) : (
                        // 入口行 h-11 即命中盒；busy 态禁按（pickVideo 内亦有守卫，双道闸）
                        <Pressable
                            onPress={() => void pickVideo()}
                            disabled={videoBusy}
                            className={`mt-5 h-11 flex-row items-center gap-1.5${videoBusy ? ' opacity-50' : ''}`}
                            accessibilityRole="button"
                            accessibilityLabel="添加封面视频"
                            accessibilityState={{ busy: videoBusy }}
                        >
                            <LucideVideo size={16} strokeWidth={1.9} color={palette.muted} />
                            <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                {videoBusy ? '上传中…' : '添加封面视频'}
                            </Text>
                        </Pressable>
                    )
                ) : null}

                {/* 封面视频管理菜单（长按预览入口，单容器 ActionMenuCard） */}
                {coverMenu ? (
                    <ActionMenuCard
                        title="封面"
                        rows={[
                            {
                                key: 'replace',
                                icon: <LucideVideo size={18} strokeWidth={1.9} />,
                                title: '更换视频',
                            },
                            {
                                key: 'remove',
                                icon: <LucideTrash size={18} strokeWidth={1.9} />,
                                title: '移除视频',
                                danger: true,
                            },
                        ]}
                        onAction={(key) => {
                            setCoverMenu(false);
                            if (key === 'replace') void pickVideo();
                            else void removeVideo();
                        }}
                        onClose={() => setCoverMenu(false)}
                    />
                ) : null}

                {/* 错误可见性（v0.4.7 令 3 对齐 settings）：tinted 横幅卡取代
                    裸行红字——校验错与 store 错同一语言，validation 优先
                    （输入闸在本地，先于远端态） */}
                {validation || storeError ? (
                    <View className="mt-4 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                        <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                            {validation ?? storeError}
                        </Text>
                    </View>
                ) : null}

                <View className="mt-6">
                    <PrimaryButton
                        label={isEdit ? '保存修改' : '创建行程'}
                        onPress={() => void submit()}
                        disabled={!canSubmit}
                    />
                </View>

                {/* 危险区（编辑模式）：与主流程隔开 */}
                {isEdit ? (
                    <View className="mt-8 border-t border-ink-rule pt-5 dark:border-inkd-rule">
                        <DeleteTripControl confirmDelete={confirmDelete} onPress={() => void remove()} />
                    </View>
                ) : null}

                {submitting || videoBusy ? (
                    <ActivityIndicator color={palette.spinner} style={{ marginTop: 12 }} />
                ) : null}
            </ScrollView>
            {/* 日期选择浮层（条件渲染，禁 Modal；层级在滚动容器外，scrim 盖整屏）
                区间闸：start 无上界（出发日可任意，校验只约束相对关系）；
                end ∈ [出发日, 出发日+365]（与 validateTripInput 的 366 天上限
                同源——闸与校验不漂移） */}
            {pickerTarget ? (
                <DatePickerSheet
                    title={pickerTarget === 'start' ? '出发日期' : '返回日期'}
                    value={pickerTarget === 'start' ? startDate : endDate}
                    minDate={
                        pickerTarget === 'end' && isDateInputComplete(startDate) ? startDate : undefined
                    }
                    maxDate={
                        pickerTarget === 'end' && isDateInputComplete(startDate)
                            ? addDaysLocal(startDate, 365)
                            : undefined
                    }
                    onPick={(date) => handlePickDate(pickerTarget, date)}
                    onClose={() => setPickerTarget(null)}
                />
            ) : null}
        </KeyboardAvoidingView>
    );
}
