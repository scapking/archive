import { useEffect, useState } from 'react';
import { BackHandler, Keyboard, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideCamera,
    LucideCheck,
    LucideFlag,
    LucideImage,
    LucideMic,
    LucidePlus,
    LucideVideo,
} from '@/core/icons';
import { ImagePlayIcon, tintIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { isRecordingSupported } from './recorder-overlay';
import { isVideoCaptureSupported } from './camera-overlay';
import { usePalette } from './theme';

/**
 * + 号插入选择器（罗盘）：条件渲染遮罩（禁 RN Modal——Fabric 触摸失效坑）。
 * 七行卡片（#8/#10 视觉对标大厂快捷面板）：相册图片 / 相册视频 / 录音 /
 * 拍照 / 拍视频 / 添加输入框 / 完成收笔，icon + 标题 + 副标双行。
 * 行序（2026-11 调整）：相册两行（图库选取）前移到录音之前——插媒体里
 * 「从图库选」是最高频路径，取材行（相册）前置、采集行（录音/拍摄）次之，
 * 输入与收笔仍压轴；纯顺序调整，onAction 词表与行为不变。
 *
 * - 「添加输入框」（#11）：媒体行之后、完成收笔之前——输入是编辑器的一级
 *   动作（与插媒体同级），收笔是终态动作压轴；分发由屏层追加空文本段并聚焦。
 *
 * - 完成收笔收进选择器（二选一决策：masthead 保纯上下文展示，动作型入口
 *   统一收敛到 + 罗盘一处；副标常驻警示「收笔后不可再修改」，选中后还有
 *   一步卡内确认，双重防误触——产品决策 #7）；
 * - 行卡片无边框规范（#13）：border 零、bg-ink-surface 接近色底、
 *   rounded-control；按压反馈由 BouncyPressable 承担，不再用 View 的
 *   active: 伪类（css-interop 会把 View 升级成 Pressable——首帧后升级会
 *   remount 视图，触摸中途被杀，正是「点了没反应」的一类来源）；
 * - 打开即收起键盘（blur），Android 返回键关闭。
 *
 * 关闭语言统一（#8 打磨轮）：底部「取消」文字行退役，关闭入口统一为
 * 卡头右上 CloseButton（圆形触感底）+ scrim 点击 + Android 返回键三条路，
 * 与块操作卡 / 重命名卡 / 行程动作卡 / 拍摄卡 / 录音卡同一设计语言。
 *
 * 全局录制会话状态行（跨页面后台录制）：会话进行中（无论发起自哪篇笔记）
 * 时在行列表顶部展示「● 录音中 0:32 · 继续」，点按重开全局覆盖层；非 owner
 * 屏副标注明「素材将保存到发起的笔记」（归属铁律可视化）。状态行数据经
 * props 注入（屏层从会话 store 投影），本组件不感知会话实现。
 */

export type InsertAction =
    | 'record'
    | 'photo'
    | 'video'
    | 'library-image'
    | 'library-video'
    | 'append-text'
    /** 新建事件（v6 事件实体入口）：**组件内直推 /events/new 路由**，不经
     *  onAction 分发——本菜单的宿主屏（journal-edit-screen）的 runInsert 词表
     *  未同步扩展（本轮不改屏逻辑结构的约束），且该动作是「离开当前编辑上下文
     *  去建工单」的导航语义而非编辑器动作，路由收口在本组件内最诚实（事件组
     *  接线报告项）。 */
    | 'new-event'
    | 'complete';

/** 全局录制会话状态行数据（屏层从会话 store 投影；本组件不 import 会话模块
 *  ——依赖方向纪律：ui 层只收 props，防 store→ui→会话→store 环）。 */
export interface ActiveCaptureStatus {
    /** 状态行标题，如「● 录音中 0:32」。 */
    title: string;
    /** 副标（归属提示：owner 本尊 / 非 owner 的「素材归发起笔记」口径）。 */
    hint: string;
    /** 点按 = 重开全局覆盖层（无缝恢复，会话状态一直在）。 */
    onResume: () => void;
}

export function InsertMenu({
    onClose,
    onAction,
    activeCapture,
}: {
    onClose: () => void;
    onAction: (action: InsertAction) => void;
    /** 全局录制会话进行中（任意发起方）时展示状态行；null = 不展示。 */
    activeCapture?: ActiveCaptureStatus | null;
}) {
    const palette = usePalette();
    // 「新建事件」行的路由出口（组件内直推，见 InsertAction 'new-event' 注——
    // 宿主屏 runInsert 词表不动，导航语义收口在本组件）
    const router = useRouter();
    // 收笔确认步：行卡片 → 确认卡（同卡替换内容，仍是条件渲染遮罩）
    const [confirming, setConfirming] = useState(false);

    // 打开即收键盘（需求口径：选择器打开时键盘收起）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);

    // Android 返回键关闭（替代 Modal onRequestClose 语义，范式同 archive-screen chooser；
    // 确认步先退回行卡片）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (confirming) {
                setConfirming(false);
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose, confirming]);

    /** 行配置：web 能力边界内裁剪（录音 MediaRecorder 缺失 / 视频 recordAsync 无 web 实现）。
     *  行序：相册取材两行 → 采集三行（录音/拍照/拍视频）→ 添加输入框 → 完成收笔。 */
    const rows: Array<{ action: InsertAction; icon: React.ReactNode; title: string; hint: string }> = [
        { action: 'library-image', icon: <LucideImage size={20} strokeWidth={1.9} />, title: '相册图片', hint: '从图库选取，可多选' },
        { action: 'library-video', icon: <ImagePlayIcon size={20} strokeWidth={1.9} />, title: '相册视频', hint: '从图库选取，可多选' },
        ...(isRecordingSupported()
            ? [{ action: 'record' as const, icon: <LucideMic size={20} strokeWidth={1.9} />, title: '录音', hint: '声纹即时记录' }]
            : []),
        { action: 'photo', icon: <LucideCamera size={20} strokeWidth={1.9} />, title: '拍照', hint: '现场快照，直接进日记' },
        ...(isVideoCaptureSupported()
            ? [{ action: 'video' as const, icon: <LucideVideo size={20} strokeWidth={1.9} />, title: '拍视频', hint: '时长不限' }]
            : []),
        // 「+」语言一致（添加语义同 FAB 罗盘本钮）；排在媒体行之后、完成收笔之前（#11）
        { action: 'append-text', icon: <LucidePlus size={20} strokeWidth={1.9} />, title: '添加输入框', hint: '末尾另起一段继续写' },
        // v6 事件实体入口（任务口径 LucideFlag）：工单式记录独立于日记，行位在
        // 输入之后、完成收笔压轴之前（创建动作不入终态区）
        { action: 'new-event', icon: <LucideFlag size={20} strokeWidth={1.9} />, title: '新建事件', hint: '工单式记录，独立于这篇笔记' },
        { action: 'complete', icon: <LucideCheck size={20} strokeWidth={1.9} />, title: '完成收笔', hint: '收笔后不可再修改' },
    ];

    const run = (action: InsertAction) => {
        if (action === 'complete') {
            // 收笔不直接执行：进确认步（#7 强调「收笔后不可再修改」）
            setConfirming(true);
            return;
        }
        onClose();
        // 新建事件 = 组件内直推路由（不经 onAction——宿主屏分发词表未扩展，
        // 见 InsertAction 'new-event' 注）；typedRoutes 类型未生成 → as never
        // 最小妥协先例（me 页 SearchEntryCard 同口径）
        if (action === 'new-event') {
            router.push('/events/new' as never);
            return;
        }
        onAction(action);
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
            >
                {/* 卡片本体：无边框规范（#13）——border 零，base 底 + 圆角卡 */}
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    {confirming ? (
                        <>
                            {/* 卡头：标题 + 右上关闭（关闭语言统一：X = 关闭整个选择器，
                                「再写一会儿」钮 = 同义动作的显式确认路径） */}
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                                    确认收笔？
                                </Text>
                                <CloseButton onPress={onClose} />
                            </View>
                            <Text className="mt-3 text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                收笔后这一页就定稿了，不可再修改。今天想继续写的话，明天还有新的一页。
                            </Text>
                            <View className="mt-4 gap-2.5">
                                {/* 两钮均 h-11 视觉盒 ≥44，纵向 gap-2.5(10px) 为不可点间隙：
                                    不传 hitSlop（0），命中盒 == 视觉盒，无重叠核算项 */}
                                <BouncyPressable onPress={() => setConfirming(false)} scaleTo={0.97}>
                                    <View
                                        className="h-11 items-center justify-center rounded-control bg-ink-surface dark:bg-inkd-surface"
                                        accessibilityRole="button"
                                        accessibilityLabel="再写一会儿"
                                    >
                                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                            再写一会儿
                                        </Text>
                                    </View>
                                </BouncyPressable>
                                <BouncyPressable
                                    onPress={() => {
                                        onClose();
                                        onAction('complete');
                                    }}
                                    scaleTo={0.97}
                                >
                                    <View
                                        className="h-11 items-center justify-center rounded-control"
                                        style={{ backgroundColor: palette.primaryBtn }}
                                        accessibilityRole="button"
                                        accessibilityLabel="确认收笔"
                                    >
                                        <Text
                                            className="text-[15px] font-semibold"
                                            style={{ color: palette.onPrimaryBtn }}
                                        >
                                            确认收笔
                                        </Text>
                                    </View>
                                </BouncyPressable>
                            </View>
                        </>
                    ) : (
                        <>
                            {/* 卡头：标题 + 右上关闭（关闭语言统一，替代旧底部取消行） */}
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                                    插入什么？
                                </Text>
                                <CloseButton onPress={onClose} />
                            </View>
                            <View className="mt-4 gap-2.5">
                                {/* 全局录制会话状态行（跨页面后台录制 + 归属铁律的可视化）：
                                    「● 录音中 0:32 · 继续」——点按重开全局覆盖层（任意页面
                                    可恢复）；停止产物归发起笔记（ownerJournalId），与当前
                                    编辑的笔记零耦合。行高 ~64 ≥44，不传 hitSlop（0） */}
                                {activeCapture ? (
                                    <BouncyPressable onPress={activeCapture.onResume} scaleTo={0.97}>
                                        <View
                                            className="flex-row items-center gap-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface"
                                            accessibilityRole="button"
                                            accessibilityLabel={`${activeCapture.title}，点按回到录制界面`}
                                        >
                                            {/* 录制红点标识（negative 色，与 chip/录制态一致）：
                                                容器 40×40 rounded-control，与 MenuRow 图标容器同几何 */}
                                            <View
                                                pointerEvents="none"
                                                className="h-10 w-10 items-center justify-center rounded-control"
                                                style={{ backgroundColor: `${palette.negative}24` }}
                                            >
                                                <View
                                                    className="h-2.5 w-2.5 rounded-full"
                                                    style={{ backgroundColor: palette.negative }}
                                                />
                                            </View>
                                            <View className="flex-1">
                                                <Text
                                                    className="text-[15px] font-medium text-ink-text dark:text-inkd-text"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {activeCapture.title}
                                                </Text>
                                                <Text
                                                    numberOfLines={1}
                                                    className="text-[12px] text-ink-muted dark:text-inkd-muted"
                                                >
                                                    {activeCapture.hint}
                                                </Text>
                                            </View>
                                            <Text
                                                className="shrink-0 text-[13px] font-medium"
                                                style={{ color: palette.secondary }}
                                            >
                                                继续
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                ) : null}
                                {/* 各行完整视觉盒（icon 容器 40 + p-3 → 行高 ~64 ≥44）：不传
                                    hitSlop（0），命中盒 == 视觉盒；行距 gap-2.5(10px) 为不可点
                                    间隙（archive chooser 同口径） */}
                                {rows.map((row) => (
                                    <BouncyPressable key={row.action} onPress={() => run(row.action)} scaleTo={0.97}>
                                        <MenuRow
                                            icon={row.icon}
                                            title={row.title}
                                            hint={row.hint}
                                            tint={palette.secondary}
                                        />
                                    </BouncyPressable>
                                ))}
                            </View>
                        </>
                    )}
                </Pressable>
            </Pressable>
        </View>
    );
}

/** 选择器行卡片（#8/#10：icon + 标题 + 副标；无边框规范 #13——border 零、
    bg-ink-surface 接近色底、rounded-control）。图标容器统一 40×40
    rounded-control + raised 触感底（#8 打磨轮口径：三卡行语言与
    archive chooser 一致，替代旧的「线性裸排」），图标 tint secondary。 */
function MenuRow({
    icon,
    title,
    hint,
    tint,
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    tint: string;
}) {
    return (
        <View className="flex-row items-center gap-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
            {/* 图标容器：raised 触感底 + rounded-control（半径体系控件档），
                与行卡 surface 底形成一级亮度差（taste-skill：表面靠色调分级，不靠线） */}
            <View
                pointerEvents="none"
                className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised"
            >
                {tintIcon(icon, tint)}
            </View>
            <View className="flex-1">
                <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">{hint}</Text>
            </View>
        </View>
    );
}
