import { Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { CloseButton } from './close-button';
import { safeBack } from './safe-back';

/**
 * 屏头（app-screens：无 hero）：屏题 20px（字号阶第二档），副行放「发现」而非口号。
 *
 * 屏头统一规格（用户反馈「新建行程/搜索顶部与笔记编辑、行程详情不一致」，
 * 四屏屏头统一轮）：容器 `px-6 pt-2` + 主行 `h-11` + 返回钮 CloseButton 44
 * 圆形触感底盒 + 屏题 20px semibold——与 journal-edit / trip-detail 的内联
 * 屏头逐 dp 同规格（几何带 = insets.top + pt-2(8) + h-11(44)，四屏相等）。
 * 旧实现 36 裸图标盒 + hitSlop 10 与内联屏头的 CloseButton 视觉/命中双漂移，
 * 在此收口为同一组件（#8 关闭/返回语言统一）；标题与返回钮间距 ml-2.5 对齐
 * journal-edit / trip-detail 名称行档位。容器底部 pb-3 是屏头带之下的内容
 * 节奏（journal 内联屏头为 pb-2 同理），不参与带高对齐。
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
                        className={`min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text ${
                            back ? 'ml-2.5' : 'ml-0'
                        }`}
                    >
                        {title}
                    </Text>
                    {right}
                </View>
            </View>
            {subtitle ? (
                <Text className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                    {subtitle}
                </Text>
            ) : null}
        </View>
    );
}
