import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, Text, TextInput, View } from 'react-native';
import { LucideCheck, LucideClose } from '@/core/icons';
import { CloseButton } from './close-button';
import { usePalette } from './theme';
// 标题长度上限与 store 落库钳制同源（normalizeJournalTitle / JOURNAL_TITLE_MAX）：
// 输入框 maxLength 是第一道闸，store 落库前再钳一次防绕过 UI 直写。
// journal-logic 是纯逻辑叶模块（禁 react/native，无 ui 反向依赖），引用无环。
import { JOURNAL_TITLE_MAX } from '../journal-logic';

/**
 * 日记标题重命名卡（共享组件）——原 journal-edit-screen 的 TitleRenameCard
 * （屏头编辑钮入口）与 archive-screen 的 JournalRenameCard（首页计划卡长按
 * 入口）逐行等价的重复实现在此收口；两处入口同一语义与设计语言（卡头
 * CloseButton + 无边框 inline 输入 raised/surface 焦点亮度一档变化 + 保存/
 * 取消成对动作 + scrim/Android 返回键出口）。
 *
 * 依赖边界（v5 require cycle 纪律）：本组件不 import store——落库通道由
 * 调用方经 onSave 注入（两屏共用 store.updateJournalTitle，锁定预检 #7 在
 * store 兜底：已收笔不可改）；失败文案由调用方从 store.error 反应式经
 * errorText 传入，卡片自身保持纯展示。
 *
 * - 条件渲染由调用方控制（不设 visible prop）：挂屏根 scrim + 居中卡，禁 RN Modal；
 * - 保存失败（onSave resolve false）：卡片不关、errorText 就地展示可重试——
 *   「点了没反应」是可感知缺陷，静默关闭会让失败输入丢失且无解释；
 * - onClose 是统一出口（保存成功 / 取消钮 / 卡头 X / scrim 点击 / Android
 *   返回键）：调用方在其中做幂等回读刷新（journal-edit 以 DB 归一化标题为准）；
 * - savingRef 防连点：保存进行中重复触发（回车 / 连点保存钮）直接忽略。
 */
export function RenameCard({
    initialTitle,
    onSave,
    onClose,
    errorText = null,
}: {
    /** 打开时的标题初值（未命名传空串）。 */
    initialTitle: string;
    /** 保存通道（调用方落库）：resolve false = 失败（卡片保持打开），其余 = 成功关闭。 */
    onSave(title: string): Promise<boolean | void>;
    /** 关闭回调（保存成功 / 取消 / scrim / Android 返回键统一出口）。 */
    onClose: () => void;
    /** 保存失败的就地文案（仅在本次保存失败后展示，避免陈旧错误串场）。 */
    errorText?: string | null;
}) {
    const palette = usePalette();
    const [title, setTitle] = useState(initialTitle);
    const [focused, setFocused] = useState(false);
    // 保存失败标记：错误文案只在失败后就地展示，避免打开卡片时旧错误串场
    const [saveFailed, setSaveFailed] = useState(false);
    const savingRef = useRef(false);

    // Android 返回键关闭（替代 Modal onRequestClose 语义，范式同各覆盖层）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    const save = async () => {
        if (savingRef.current) return;
        savingRef.current = true;
        try {
            const saved = await onSave(title);
            // onSave 契约：false = 失败（卡片保持打开可重试）；void/true = 成功关闭
            if (saved === false) {
                setSaveFailed(true);
            } else {
                onClose();
            }
        } catch {
            // 调用方正常路径不 throw（失败走 false + error 文案）；防御环境异常
            setSaveFailed(true);
        } finally {
            savingRef.current = false;
        }
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭重命名"
            >
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮（scrim 点击与 Android
                        返回键之外的显式出口；底部「取消」钮保留——与「保存」成对的
                        显式动作语义，卡头 X = 逃生口，二者职责不同） */}
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            重命名计划
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    {/* 输入井：rest = surface / focus = raised（「加深一档」方向，
                        与 FieldInput surface tone / 搜索框 / DateInput 同一语言；
                        原实现两态反向是漂移，一致性审计轮归一）；内边距对齐
                        FieldInput 容器口径 px-3.5 py-2 */}
                    <View
                        className={`mt-4 rounded-control px-3.5 py-2 ${
                            focused
                                ? 'bg-ink-raised dark:bg-inkd-raised'
                                : 'bg-ink-surface dark:bg-inkd-surface'
                        }`}
                    >
                        <TextInput
                            value={title}
                            onChangeText={setTitle}
                            onFocus={() => setFocused(true)}
                            onBlur={() => setFocused(false)}
                            onSubmitEditing={() => void save()}
                            placeholder="标题"
                            placeholderTextColor={palette.muted}
                            className="text-[15px] font-medium text-ink-text dark:text-inkd-text"
                            underlineColorAndroid="transparent"
                            style={{ paddingVertical: 0, backgroundColor: 'transparent' }}
                            returnKeyType="done"
                            // 与 store 落库钳制同源（normalizeJournalTitle / JOURNAL_TITLE_MAX）
                            maxLength={JOURNAL_TITLE_MAX}
                            accessibilityLabel="计划标题"
                        />
                    </View>
                    {saveFailed && errorText ? (
                        <Text className="mt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {errorText}
                        </Text>
                    ) : null}
                    {/* 单容器行组（2026-11-19 弹窗统一：与 + 菜单/ActionMenuCard
                        同语言）：rounded-card surface 包裹，行 h-12 贴靠零线条，
                        行级 active:bg 高亮 */}
                    <View className="mt-4 overflow-hidden rounded-control bg-ink-surface dark:bg-inkd-surface">
                        <Pressable
                            onPress={() => void save()}
                            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                            accessibilityRole="button"
                            accessibilityLabel="保存标题"
                        >
                            <LucideCheck size={18} strokeWidth={1.9} color={palette.secondary} />
                            <Text className="flex-1 text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                保存
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={onClose}
                            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                            accessibilityRole="button"
                            accessibilityLabel="取消重命名"
                        >
                            <LucideClose size={18} strokeWidth={1.9} color={palette.muted} />
                            <Text className="flex-1 text-[15px] font-medium text-ink-muted dark:text-inkd-muted">
                                取消
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
