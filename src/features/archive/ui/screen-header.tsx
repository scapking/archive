import { Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { CloseButton } from './close-button';
import { safeBack } from './safe-back';

/**
 * 屏头（v0.4.6 方向文档 §2 字阶纪律的全屏收口点）：
 *
 * **字阶（本轮定档，全组一致）**：屏题 24 semibold / eyebrow·meta 11-12 /
 * 正文 16 / meta 12——屏题一档在此统一，各屏内联屏头（journal-edit /
 * trip-detail 等）随 B/A 同规格收敛。旧 20px 屏题在 375 屏上「设置/搜索/
 * 事件」与首页大标题「Archive」断档，24 把纸面层级一次拉开。
 *
 * **几何带不变（向后兼容承诺）**：容器 `px-6 pt-2` + 主行 `h-11` +
 * 返回钮 CloseButton 44 圆形触感底盒——几何带 = insets.top + pt-2(8) +
 * h-11(44)，与 journal-edit / trip-detail 的内联屏头逐 dp 同规格（几何带
 * 对齐轮的成果原样保留；题字号升档只动 type，不动带高）。24px 文字在
 * h-11(44) 行内天然垂直居中。
 *
 * prop 契约不变：title / subtitle / right / back 全部照旧（升档是纯样式
 * 变更，调用方零改动）；副行按「发现」而非口号写，调用方负责。
 */
export function ScreenHeader({
    title,
    subtitle,
    right,
    back = true,
}: {
    title: string;
    subtitle?: string;
    right?: ReactNode;
    back?: boolean;
}) {
    return (
        <View className="px-6 pb-3 pt-2">
            <View className="h-11 flex-row items-center justify-between">
                <View className="min-w-0 flex-1 flex-row items-center">
                    {back ? (
                        // 返回钮：CloseButton 44 圆形触感底盒（≥44 命中规范不传
                        // hitSlop），与 journal-edit / trip-detail 内联屏头返回钮
                        // 同组件同规格；右邻屏题为非按压体（ml-2.5 停车距），无重叠
                        <CloseButton icon="back" onPress={safeBack} />
                    ) : null}
                    <Text
                        numberOfLines={1}
                        // 条件类：back 有无只切左间距档（ml-2.5 对齐返回钮右侧 /
                        // ml-0 贴 px-6 内容缘），两侧均为 margin 类，变量集恒等
                        className={`min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text ${
                            back ? 'ml-2.5' : 'ml-0'
                        }`}
                    >
                        {title}
                    </Text>
                    {right}
                </View>
            </View>
            {subtitle ? (
                <Text className="mt-1 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                    {subtitle}
                </Text>
            ) : null}
        </View>
    );
}
