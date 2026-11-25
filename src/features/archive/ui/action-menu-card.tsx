import { useEffect } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, Pressable, Text, View } from 'react-native';
import { CloseButton } from './close-button';
// tintIcon 深路径注记：editor-icons 未入 ui/index.ts 出口（该文件不在本组改动
// 权限内），域内深取；barrel 出口扩充时收口（close-button / editor-icons 先例）。
import { tintIcon } from './editor-icons';
import { PAPER_FLOAT_SHADOW } from './paper-shadow';
import { usePalette } from './theme';

/**
 * 操作菜单卡（共享组件，DayActionCard / PlanActionCard / 首页 chooser 同语言
 * 的通用收口——scrim + 居中卡 + 行组，禁 RN Modal 条件渲染）：
 *
 * - 结构铁律同源：卡头 = 题 + 右上 CloseButton（关闭语言统一 #8）；行 =
 *   单容器行组（rounded-card surface 包裹 + overflow-hidden，行 h-12 贴靠
 *   零线条，裸图标 + 题单行，active:bg 行级高亮——2026-11-19 与 + 菜单统一）；
 * - 图标着色在卡内统一收口（调用点只给形状）：默认 secondary，danger 行 negative
 *   ——颜色只上语义不上装饰（PlanActionCard 删除行同口径）；
 * - 打开即收键盘（长按可能发生在输入态旁，DayActionCard 同款）；
 * - Android 返回键关闭（替代 Modal onRequestClose 语义，范式同各覆盖层）；
 * - 依赖边界（v5 require cycle 纪律）：本组件不 import store——动作语义全部
 *   由调用方经 onAction(key) 分派，组件保持纯展示；二次确认等有状态流程
 *   （删除确认步等）由调用方自行换行数据实现（key 不变 = 卡不重建）。
 */

export interface ActionMenuRow {
    key: string;
    icon: React.ReactNode;
    title: string;
    hint?: string | null;
    /** 危险行（negative 色，图标/题文同色只上语义）。 */
    danger?: boolean;
    /**
     * hint 槽转 spinner（in-flight 反馈，与 hint 互斥；同块操作卡「保存到手机」
     * 行口径——长任务行禁用防重复触发由调用方自行传导，这里只管视觉）。
     */
    spinner?: boolean;
}

export function ActionMenuCard({
    title,
    rows,
    onAction,
    onClose,
}: {
    title: string;
    rows: ActionMenuRow[];
    onAction(key: string): void;
    onClose(): void;
}) {
    const palette = usePalette();

    // 打开即收键盘；Android 返回键关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭操作菜单"
            >
                {/* 卡体拦截冒泡：点卡不关（同 DayActionCard / chooser 卡体结构） */}
                {/* 容器收紧（v0.4.6）：max-w-sm p-3 既有弹窗口径不动；卡身加
                    PAPER_FLOAT 投影——scrim 之下的真悬浮物才有影 */}
                <Pressable
                    className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base"
                    style={PAPER_FLOAT_SHADOW}
                >
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[16px] font-semibold text-ink-text dark:text-inkd-text">
                            {title}
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    {/* 单容器行组（2026-11-19 用户指令「全部这类的选择弹窗都要」
                        同 + 菜单语言）：rounded-card surface 包裹 + overflow-hidden
                        裁行高亮进圆角；行 h-12（48 ≥44，hitSlop 0）贴靠零线条，
                        按压 = 行级 active:bg 高亮（Pressable 直挂无 remount 风险），
                        裸图标 + 题单行，danger 行 negative 只上语义 */}
                    <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        {rows.map((row) => (
                            <Pressable key={row.key} onPress={() => onAction(row.key)} className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised">
                                <View pointerEvents="none">
                                    {tintIcon(row.icon, row.danger ? palette.negative : palette.secondary)}
                                </View>
                                <Text
                                    className={`flex-1 text-[16px] font-medium ${
                                        row.danger
                                            ? 'text-ink-negative dark:text-inkd-negative'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                >
                                    {row.title}
                                </Text>
                                {row.spinner ? (
                                    // in-flight 反馈：行尾 spinner
                                    <ActivityIndicator size="small" color={palette.secondary} />
                                ) : null}
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
