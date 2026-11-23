import { useEffect, useState } from 'react';
import { BackHandler, Keyboard, Pressable, Text, View } from 'react-native';
import {
    BouncyPressable,
    LucideCamera,
    LucideCheck,
    LucideClapperboard,
    LucideFilm,
    LucideImage,
    LucideMic,
    LucidePlus,
    LucideVideo,
} from '@/core/icons';
import { tintIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { isRecordingSupported } from './recorder-overlay';
import { isVideoCaptureSupported } from './camera-overlay';
import { usePalette } from './theme';

/**
 * + 号插入选择器（罗盘）：条件渲染遮罩（禁 RN Modal——Fabric 触摸失效坑）。
 * 行卡片（#8/#10 视觉对标大厂快捷面板）：相册图片 / 相册视频 / 录音 /
 * 拍照 / 拍视频 / 添加输入框 / 完成收笔（journal 全行；事件编辑器经 `actions`
 * 过滤复用本组件——行序同源，仅裁「完成收笔」），icon + 标题单行
 * （2026-11-19 用户指令「全部从简」：行副标描述全线退役，标题自释）。
 * 行序（2026-11 调整）：相册两行（图库选取）前移到录音之前——插媒体里
 * 「从图库选」是最高频路径，取材行（相册）前置、采集行（录音/拍摄）次之，
 * 输入与收笔仍压轴；纯顺序调整，onAction 词表与行为不变。
 *
 * 「新建事件」行退役（2026-11 口径）：新建事件是首页 + 号的职责（archive
 * chooser 专属入口），本菜单只管计划内容块——编辑上下文里跳走建工单，
 * 会把「写计划」和「建事件」两条动线搅在一起。
 *
 * - 「添加输入框」（#11）：媒体行之后、完成收笔之前——输入是编辑器的一级
 *   动作（与插媒体同级），收笔是终态动作压轴；分发由屏层追加空文本段并聚焦。
 *
 * - 完成收笔收进选择器（二选一决策：masthead 保纯上下文展示，动作型入口
 *   统一收敛到 + 罗盘一处；副标常驻警示「收笔后不可再修改」，选中后还有
 *   一步卡内确认，双重防误触——产品决策 #7）；
 * - 单容器行组（2026-11-19 用户指令）：一个 rounded-card surface 容器包裹
 *   全部行，行间零线条，行内 Pressable 直挂 active: 高亮（Pressable 本体挂
 *   active: 类无 css-interop remount 风险，View 才有——首帧后升级会 remount
 *   视图，触摸中途被杀，正是「点了没反应」的一类来源）；
 * - 打开即收起键盘（blur），Android 返回键关闭。
 *
 * 关闭语言统一（#8 打磨轮）：底部「取消」文字行退役，关闭入口统一为
 * 卡头右上 CloseButton（圆形触感底）+ scrim 点击 + Android 返回键三条路，
 * 与块操作卡 / 重命名卡 / 行程动作卡 / 拍摄卡 / 录音卡同一设计语言。
 *
 * 全局录制会话状态行（跨页面后台录制）：会话进行中（无论发起自哪篇计划）
 * 时在行列表顶部展示「● 录音中 0:32 · 继续」，点按重开全局覆盖层；非 owner
 * 屏副标注明「素材将保存到发起的计划」（归属铁律可视化）。状态行数据经
 * props 注入（屏层从会话 store 投影），本组件不感知会话实现。
 */

export type InsertAction =
    | 'record'
    | 'photo'
    | 'video'
    | 'library-image'
    | 'library-video'
    | 'append-text'
    | 'complete';

/** 全局录制会话状态行数据（屏层从会话 store 投影；本组件不 import 会话模块
 *  ——依赖方向纪律：ui 层只收 props，防 store→ui→会话→store 环）。 */
export interface ActiveCaptureStatus {
    /** 状态行标题，如「● 录音中 0:32」。 */
    title: string;
    /** 副标（归属提示：owner 本尊 / 非 owner 的「素材归发起计划」口径）。 */
    hint: string;
    /** 点按 = 重开全局覆盖层（无缝恢复，会话状态一直在）。 */
    onResume: () => void;
}

export function InsertMenu({
    onClose,
    onAction,
    activeCapture,
    actions,
}: {
    onClose: () => void;
    onAction: (action: InsertAction) => void;
    /** 全局录制会话进行中（任意发起方）时展示状态行；null = 不展示。 */
    activeCapture?: ActiveCaptureStatus | null;
    /**
     * 行过滤（v6.1 事件编辑器复用本组件的接线面）：传入时只渲染词表内的行
     * （行序 = 本组件既定行序——相册两行 → 采集三行 → 输入 → 收笔，与需求
     * 事件词表「相册图片/相册视频/录音/拍照/拍视频/添加输入框」为同一前缀），
     * 未列出的行（journal 版的「完成收笔」）整行退场，确认步等专属分支随之
     * 不可达。缺省 = 全行（journal 屏原行为，零改动）。
     */
    actions?: readonly InsertAction[];
}) {
    const palette = usePalette();
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
     *  行序：相册取材两行 → 采集三行（录音/拍照/拍视频）→ 添加输入框 → 完成收笔。
     *  actions 过滤（事件屏复用）：既定行序内筛除未列入的行（过滤不重排——
     *  journal 行序 = 事件行序的同源保证）。 */
    const allRows: Array<{ action: InsertAction; icon: React.ReactNode; title: string }> = [
        { action: 'library-image', icon: <LucideImage size={20} strokeWidth={1.9} />, title: '相册图片' },
        { action: 'library-video', icon: <LucideFilm size={20} strokeWidth={1.9} />, title: '相册视频' },
        ...(isRecordingSupported()
            ? [{ action: 'record' as const, icon: <LucideMic size={20} strokeWidth={1.9} />, title: '录音' }]
            : []),
        { action: 'photo', icon: <LucideCamera size={20} strokeWidth={1.9} />, title: '拍照' },
        ...(isVideoCaptureSupported()
            ? [{ action: 'video' as const, icon: <LucideClapperboard size={20} strokeWidth={1.9} />, title: '拍摄视频' }]
            : []),
        // 「+」语言一致（添加语义同 FAB 罗盘本钮）；排在媒体行之后、完成收笔之前（#11）
        { action: 'append-text', icon: <LucidePlus size={20} strokeWidth={1.9} />, title: '添加文本' },
        { action: 'complete', icon: <LucideCheck size={20} strokeWidth={1.9} />, title: '完成收笔' },
    ];
    const rows = actions ? allRows.filter((row) => actions.includes(row.action)) : allRows;

    const run = (action: InsertAction) => {
        if (action === 'complete') {
            // 收笔不直接执行：进确认步（#7 强调「收笔后不可再修改」）
            setConfirming(true);
            return;
        }
        onClose();
        onAction(action);
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
            >
                {/* 卡片本体：无边框规范（#13）——border 零，base 底 + 圆角卡 */}
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
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
                                        accessibilityLabel="暂不收笔"
                                    >
                                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                            暂不收笔
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
                            {/* 单容器行组（2026-11-19 用户指令「一个卡片容器包裹，
                                内部没有横线区分」——chooser / Me 内容卡同语言）：
                                rounded-card surface 包裹 + overflow-hidden 裁行高亮
                                进圆角；行 h-12（48 ≥44，hitSlop 0）贴靠零线条，
                                按压 = 行级 active:bg 高亮（Pressable 直挂无 remount
                                风险），裸图标 + 题单行 */}
                            <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                                {/* 全局录制会话状态行（跨页面后台录制 + 归属铁律的可视化）：
                                    「● 录音中 0:32 · 继续」——点按重开全局覆盖层；行高
                                    两行信息 py-3 ≥44，不传 hitSlop（0） */}
                                {activeCapture ? (
                                    <Pressable
                                        onPress={activeCapture.onResume}
                                        className="flex-row items-center gap-3 px-4 py-3 active:bg-ink-raised dark:active:bg-inkd-raised"
                                        accessibilityRole="button"
                                        accessibilityLabel={`${activeCapture.title}，点按回到录制界面`}
                                    >
                                        {/* 录制红点标识（negative 色，与 chip/录制态一致） */}
                                        <View
                                            pointerEvents="none"
                                            className="h-8 w-8 items-center justify-center rounded-control"
                                            style={{ backgroundColor: `${palette.negative}24` }}
                                        >
                                            <View
                                                className="h-2.5 w-2.5 rounded-full"
                                                style={{ backgroundColor: palette.negative }}
                                            />
                                        </View>
                                        <View className="min-w-0 flex-1">
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
                                    </Pressable>
                                ) : null}
                                {rows.map((row) => (
                                    <Pressable
                                        key={row.action}
                                        onPress={() => run(row.action)}
                                        className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                                        accessibilityRole="button"
                                        accessibilityLabel={row.title}
                                    >
                                        <View pointerEvents="none">{tintIcon(row.icon, palette.secondary)}</View>
                                        <Text className="flex-1 text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                            {row.title}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                        </>
                    )}
                </Pressable>
            </Pressable>
        </View>
    );
}
