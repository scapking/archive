import { Text, View } from 'react-native';
import { BouncyPressable, LucideMapPin } from '@/core/icons';
import { isEventDone, type Event, type EventStatus } from '../event-logic';
import { usePalette } from './theme';

/**
 * 事件卡（v6 事件实体，/events 列表主体）+ 事件状态片（EventStatusChip）。
 *
 * 设计口径（frontend-design + app-screens 房规在本域的落法）：
 * - **工单语言来自题材本身**：左侧时间线轴（贯穿竖线 + 空心节点）是工单
 *   「一件事情被持续处理」的空间隐喻——节点的色只上状态这一数据（进行中
 *   accent / 已完成 muted faint），轴与卡面全部中性灰阶（色彩不上 chrome）；
 * - 卡片 = surface-on-base tone 分层、rounded-card 16、无描边无阴影（#13）；
 *   卡内分区靠留白不靠线（Apple Journal 卡片节奏）；
 * - 信息层级：状态片 + 标题（15 semibold 卡题档）→ 摘要（13 secondary 两行，
 *   eventBlocksPreview 口径，空正文给 muted 邀请文案）→ 对象/处理人轻量行
 *   （12 secondary，GPS 有坐标时前置定位 icon）→ 时间线（11 muted tabular，
 *   event-logic.eventTimeline 口径：未编辑只报创建时刻，不渲染假更新位）；
 * - 数字位 tabular-nums（房规）；条件类两侧变量集合恒等（css-interop 铁律）；
 * - 命中核算：卡体 BouncyPressable 视觉盒远超 44，不传 hitSlop（0）；
 *   轴列 pointerEvents="none"（装饰层不参与触摸）。
 */

const KIND_CLASS = {
    accent: 'border border-transparent bg-ink-accent-bg dark:bg-inkd-accent-bg',
    filled: 'border border-transparent bg-ink-raised dark:bg-inkd-raised',
} as const;

const KIND_LABEL_CLASS = {
    accent: 'text-ink-accent dark:text-inkd-accent',
    filled: 'text-ink-muted dark:text-inkd-muted',
} as const;

/**
 * 事件状态片（进行中 = accent 淡底 + accent 圆点；已完成 = raised 填充）：
 * 与 ui/status-chip.tsx（行程）同一药丸语言，词表/状态域独立（事件 open|done，
 * 行程 planning|ongoing|finished——不共用组件，避免两域状态机耦合）。
 */
export function EventStatusChip({ status }: { status: EventStatus }) {
    const kind = status === 'open' ? 'accent' : 'filled';
    const label = status === 'open' ? '进行中' : '已完成';
    return (
        <View
            className={`h-6 flex-row items-center rounded-full px-2.5 ${KIND_CLASS[kind]}`}
            accessibilityLabel={`状态：${label}`}
        >
            {kind === 'accent' ? (
                <View className="mr-1.5 h-1.5 w-1.5 rounded-full bg-ink-accent dark:bg-inkd-accent" />
            ) : null}
            <Text className={`text-[11px] font-medium ${KIND_LABEL_CLASS[kind]}`}>{label}</Text>
        </View>
    );
}

/**
 * 事件卡（时间线轴 + 卡体）。轴列贯穿整行高——FlatList 相邻行轴自然连成
 * 一条「工单时间线」；行间距收在卡体一侧（pb-3），轴不因此断线。
 */
export function EventCard({ event, onPress }: { event: Event; onPress: () => void }) {
    const palette = usePalette();
    const done = isEventDone(event);
    const hasGps = event.gps_lat != null && event.gps_lng != null;
    // 对象/处理人轻量行（原子对约束：subjectKindLabel 与 subject_value 同源装饰，
    // 任一缺失即整体不渲染该段——event-logic.decorateEvent 已保证成对）
    const subjectPart = event.subject_value
        ? event.subjectKindLabel
            ? `${event.subjectKindLabel} ${event.subject_value}`
            : event.subject_value
        : null;
    const metaParts = [
        subjectPart,
        event.handled_by ? `处理人 ${event.handled_by}` : null,
    ].filter((part): part is string => part != null);
    const metaText = metaParts.join(' · ');
    return (
        <View className="flex-row">
            {/* 时间线轴列：竖线（rule 色细线）+ 空心节点（base 色描边在线上挖出
                「孔」，节点色 = 状态数据色）。w-6 轴心 x=12，1px 线落在 left-[11.5px]。 */}
            <View className="w-6 self-stretch items-center" pointerEvents="none">
                <View className="absolute inset-y-0 left-[11.5px] w-px bg-ink-rule dark:bg-inkd-rule" />
                {/* 节点纵向锚定卡头状态行：卡体 py-3.5(14) + 药丸半高(12) ≈ 26，
                    节点 mt-5(20) + 半径 5 → 圆心 25 与药丸圆心对齐 */}
                <View
                    className={`mt-5 h-2.5 w-2.5 rounded-full border-2 border-ink-base dark:border-inkd-base ${
                        done
                            ? 'bg-ink-faint dark:bg-inkd-faint'
                            : 'bg-ink-accent dark:bg-inkd-accent'
                    }`}
                />
            </View>
            {/* 卡间距挂内容列（mb-4）：轴线列 self-stretch 随行高延伸，间隙内
                时间线不断裂；末卡的尾段线属时间线收尾观感，可接受 */}
            <View className="mb-4 min-w-0 flex-1 pb-3 pl-2">
                <BouncyPressable onPress={onPress} scaleTo={0.985}>
                    <View
                        className="rounded-card bg-ink-surface px-4 py-3.5 dark:bg-inkd-surface"
                        accessibilityRole="button"
                        accessibilityLabel={`${event.statusLabel}事件：${event.title}，点开查看`}
                    >
                        {/* 状态 + 标题行：已完成标题降 muted（工单「已结单」语言），
                            条件类两侧变量集合恒等 */}
                        <View className="flex-row items-center gap-2">
                            <EventStatusChip status={event.status} />
                            <Text
                                numberOfLines={1}
                                className={`min-w-0 flex-1 text-[15px] font-semibold ${
                                    done
                                        ? 'text-ink-muted dark:text-inkd-muted'
                                        : 'text-ink-text dark:text-inkd-text'
                                }`}
                            >
                                {event.title}
                            </Text>
                        </View>
                        {/* 摘要行（eventBlocksPreview 口径，两行封顶）：空正文 =
                            muted 邀请文案（空态是指引，不是 mood 板） */}
                        <Text
                            numberOfLines={2}
                            className={`mt-1.5 text-[13px] leading-5 ${
                                event.preview
                                    ? 'text-ink-secondary dark:text-inkd-secondary'
                                    : 'text-ink-muted dark:text-inkd-muted'
                            }`}
                        >
                            {event.preview || '正文还没写，点开补记录'}
                        </Text>
                        {/* 对象/处理人轻量行：GPS 有坐标前置定位 icon（标记语义，
                            不显示坐标文本——详情头才是坐标的完整读位） */}
                        {hasGps || metaText ? (
                            <View className="mt-2 flex-row items-center gap-1.5">
                                {hasGps ? (
                                    <LucideMapPin
                                        size={12}
                                        strokeWidth={1.9}
                                        color={palette.secondary}
                                    />
                                ) : null}
                                {metaText ? (
                                    <Text
                                        numberOfLines={1}
                                        className="min-w-0 flex-1 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    >
                                        {metaText}
                                    </Text>
                                ) : (
                                    <View className="flex-1" />
                                )}
                            </View>
                        ) : null}
                        {/* 时间线行（event-logic.eventTimeline 单一口径）：tabular-nums
                            防数字换位抖动；未编辑过只报创建时刻 */}
                        <Text
                            className="mt-1.5 text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {event.timeline.edited
                                ? `创建 ${event.timeline.createdText} · 更新 ${event.timeline.updatedText}`
                                : `创建 ${event.timeline.createdText}`}
                        </Text>
                    </View>
                </BouncyPressable>
            </View>
        </View>
    );
}
