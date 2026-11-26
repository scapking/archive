import { Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { CloseButton } from './close-button';
import { safeBack } from './safe-back';

/**
 * 屏头（v0.4.6 方向文档 §2 字阶纪律的全屏收口点；v0.5.2 轮 B 定稿）：
 *
 * **字阶与几何（全站一档）**：屏题 24 semibold / eyebrow·meta 11-12 /
 * 正文 16；容器 `px-6 pb-3 pt-2` + 主行 `h-11` + 返回钮 CloseButton 44
 * 圆形触感底盒 + 屏题 ml-2.5 停车距——几何带 = insets.top + pt-2(8) +
 * h-11(44)，24px 文字在 h-11(44) 行内天然垂直居中。各屏内联手写法退役
 * （journal-edit / trip-detail / trip-day 的迁移差量见 v0.5.2 交付报告）。
 *
 * **副标退役（v0.5.2 令 2）**：`subtitle` prop 已整体删除——屏头描述性
 * 副标全线退役（字段/卡面自说明，删掉后仍可完成任务的介绍句一律不进屏
 * 头）。实时状态（步骤计数、结果数）经 `right` 槽或页面状态通道呈现，
 * 错误走各屏 store.error 横幅卡。源码头闸 tests/v052-header-uniform.test.ts
 * 锁定本组件不再接受 subtitle。
 *
 * `onBack`（v0.5.2 轮 B 新增）：有未保存语义的屏（event-detail 的
 * handleLeave）注入自定义返回处理，缺省仍走 safeBack——其余调用方零改动。
 */
export function ScreenHeader({
    title,
    right,
    back = true,
    onBack,
}: {
    title: string;
    right?: ReactNode;
    back?: boolean;
    /** 返回钮行为（缺省 safeBack）；仅 back=true 时有意义。 */
    onBack?: () => void;
}) {
    return (
        <View className="px-6 pb-3 pt-2">
            <View className="h-11 flex-row items-center justify-between">
                <View className="min-w-0 flex-1 flex-row items-center">
                    {back ? (
                        // 返回钮：CloseButton 44 圆形触感底盒（≥44 命中规范不传
                        // hitSlop），与内联屏头旧实现同组件同规格；右邻屏题为
                        // 非按压体（ml-2.5 停车距），无重叠
                        <CloseButton icon="back" onPress={onBack ?? safeBack} />
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
        </View>
    );
}
