import { useState } from 'react';
import {
    TextInput,
    View,
    type StyleProp,
    type TextInputProps,
    type TextStyle,
} from 'react-native';
import { usePalette } from './theme';

/**
 * 统一输入组件（FieldInput）——「容器承载视觉、输入彻底透明」的跨平台抹平层。
 *
 * 背景（用户反馈）：Web/Android/iOS 的 TextInput 各带一套平台默认视觉
 * （下划线、内边距、焦点高亮、圆角继承……）逐属性对齐永远补不完；RN 又没有
 * 自绘文本编辑的现实方案，TextInput 不可抛弃。正确解法 = **外层 View 容器
 * 承担全部视觉（底色/圆角/内边距/焦点态/高度），内部 TextInput 彻底透明
 * （零平台默认视觉）+ 平台 props 在本文件一处收口**。三端差异只剩字体渲染
 * 本身，视觉全部来自 ink/inkd token（无边框规范 #13：border 恒 0）。
 *
 * 视觉口径：
 * - 容器：rounded-control（10px 半径档）+ tone 底色 + 焦点亮度一档变化
 *   （onFocus/onBlur 本地状态驱动；方向 = 沿中性灰阶加深一档：浅色变深、
 *   深色变浅，与 RenameCard 的 inline 输入同一「一档」语言）；单行 min-h-11
 *   （44 命中规范）+ justify-center，多行自然增高（容器随内容撑开）；
 * - 内部 TextInput：底色透明、paddingVertical 0、字色随主题（palette.text：
 *   浅色深墨 #171A1E / 深色近白 #E7EAE9——TextInput 平台默认色不随暗色主题
 *   反转，深色下会黑字压深底，必须显式收口在此，调用方零改动）、
 *   placeholder 弱文本色、selectionColor 收口到语义色（消灭 iOS 默认蓝）；
 * - 平台硬口径（rest 覆盖不了，见 INPUT_PLATFORM_PROPS）：underlineColorAndroid
 *   透明、textAlignVertical top；Android ripple 天然无（容器是普通 View，
 *   非 Pressable）。
 *
 * 契约表（并行组 trip-form / me / search / trip-detail 替换用）：
 * | prop                | 类型                          | 默认      | 说明 |
 * |---------------------|-------------------------------|-----------|------|
 * | value               | string                        | 必填      | 受控值 |
 * | onChangeText        | (text: string) => void        | 必填      | 受控回写 |
 * | placeholder         | string                        | undefined | 占位文案（弱文本色） |
 * | multiline           | boolean                       | false     | 多行（容器随内容增高） |
 * | maxLength           | number                        | undefined | 原生截断 |
 * | autoFocus           | boolean                       | undefined | 挂载聚焦 |
 * | tone                | 'surface'｜'raised'｜'canvas' | 'surface' | 视觉档位（见下） |
 * | containerClassName  | string                        | ''        | 追加到容器 View 的 className（宽度/margin 等布局职责在调用方） |
 * | ...TextInputProps   | —                             | —         | 其余 props 透传（style 合并在 tone 默认之后，调用方可覆盖） |
 *
 * tone 档位：
 * - surface：表单卡内近色底（bg-ink-surface，焦点 → raised 加深一档）——默认；
 * - raised：高一级触感底（bg-ink-raised，焦点 → border 灰阶再深一档）；
 * - canvas：画布无盒（容器零视觉，仅透传布局 className）——正文段口径，
 *   画布内不要用它（TextBlock 直用本文件导出的常量/helper，保持无盒）。
 *
 * 深路径注记：本组件未入 ui/index.ts 出口（该文件不在本轮改动权限内），
 * 消费方按域内深取纪律 `./ui/field-input` 直连（同 editor-icons / close-button
 * 先例），出口扩充时再收口。
 */

/** 输入视觉档位。 */
export type FieldTone = 'surface' | 'raised' | 'canvas';

/* ------------------------------------------------------------------ */
/* 单点收口：平台 props / 透明化样式 / 字号行高 / 高度派生 helper        */
/* （TextBlock 等不套容器的输入从这里取，禁止再散写平台口径）            */
/* ------------------------------------------------------------------ */

/**
 * TextInput 平台 props 收口（一处定义，所有输入共用）：
 * - underlineColorAndroid 透明：杀 Android 默认下划线；
 * - textAlignVertical 'top'：Android 多行文字从顶部排（iOS/web 天然如此）。
 * 本组件内排在 rest 之后硬挂（调用方透传覆盖不了——收口语义）。
 */
export const INPUT_PLATFORM_PROPS = {
    underlineColorAndroid: 'transparent',
    textAlignVertical: 'top',
} as const;

/**
 * 输入透明化底样式：paddingVertical 归零（平台默认纵向内边距是三端高度
 * 不一致的根源）+ 底色透明（视觉全部交给容器/画布）。
 */
export const INPUT_TRANSPARENT_STYLE: TextStyle = {
    paddingVertical: 0,
    backgroundColor: 'transparent',
};

/** 各档位字号/行高（字号阶 15 正文）：表单域 15/22，正文画布 15/26 journaling。 */
export const FIELD_TONE_TEXT: Record<FieldTone, { fontSize: number; lineHeight: number }> = {
    surface: { fontSize: 15, lineHeight: 22 },
    raised: { fontSize: 15, lineHeight: 22 },
    canvas: { fontSize: 15, lineHeight: 26 },
};

/**
 * 自适应高度派生（唯一实现）：max(minHeight, 内容实高)。内容高未量出（首帧 /
 * 平台上报 0）时回落 minHeight 兜底，不存在「首帧特别矮」的窗口。
 */
export function fieldInputHeight(minHeight: number, contentHeight: number | null): number {
    return Math.max(minHeight, contentHeight ?? minHeight);
}

/** onContentSizeChange 事件类型：从 RN prop 签名反推（RN 0.88 生成类型改了
 *  事件命名形状，手写 NativeSyntheticEvent<...> 会双重包装而失配）。 */
type ContentSizeChangeEvent = Parameters<
    NonNullable<TextInputProps['onContentSizeChange']>
>[0];

/**
 * onContentSizeChange 事件 → 有效内容高度：无效值（0 / NaN / 负数——空段与
 * Android 首帧可能上报）返回 null，由调用方保持现值；有效值向上取整防亚像素抖动。
 */
export function readContentHeight(event: ContentSizeChangeEvent): number | null {
    const raw = event.nativeEvent.contentSize.height;
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.ceil(raw);
}

/* ------------------------------------------------------------------ */
/* 容器视觉档位表                                                       */
/* ------------------------------------------------------------------ */

/** 容器底色（焦点沿中性灰阶加深一档；两侧类名结构恒等：一组 light + dark bg）。 */
const TONE_BG: Record<Exclude<FieldTone, 'canvas'>, { rest: string; focus: string }> = {
    surface: {
        rest: 'bg-ink-surface dark:bg-inkd-surface',
        focus: 'bg-ink-raised dark:bg-inkd-raised',
    },
    raised: {
        rest: 'bg-ink-raised dark:bg-inkd-raised',
        focus: 'bg-ink-border dark:bg-inkd-border',
    },
};

export type FieldInputProps = Omit<
    TextInputProps,
    'value' | 'onChangeText' | 'placeholder' | 'multiline' | 'maxLength' | 'autoFocus' | 'style'
> & {
    /** 受控值。 */
    value: string;
    /** 受控回写。 */
    onChangeText: (text: string) => void;
    /** 占位文案（弱文本色）。 */
    placeholder?: string;
    /** 多行（容器随内容自然增高；单行 min-h-11）。 */
    multiline?: boolean;
    /** 原生截断（与 store 层钳制同源使用，双道闸）。 */
    maxLength?: number;
    /** 挂载聚焦。 */
    autoFocus?: boolean;
    /** 视觉档位（默认 surface；canvas = 画布无盒透传）。 */
    tone?: FieldTone;
    /** 追加到容器 View 的 className：宽度 / margin / 其他布局职责在调用方。 */
    containerClassName?: string;
    /** 输入样式覆盖（合并在 tone 默认之后，调用方优先）。 */
    style?: StyleProp<TextStyle>;
};

export function FieldInput({
    value,
    onChangeText,
    placeholder,
    multiline = false,
    maxLength,
    autoFocus,
    tone = 'surface',
    containerClassName,
    style,
    onFocus,
    onBlur,
    ...rest
}: FieldInputProps) {
    const palette = usePalette();
    // 焦点态本地持有（容器亮度变化驱动；canvas 无视觉，状态闲置无害）
    const [focused, setFocused] = useState(false);
    // canvas = 画布无盒：容器零视觉（连圆角/内边距都不给），只透传布局 className
    const containerClass =
        tone === 'canvas'
            ? containerClassName ?? ''
            : `min-h-11 justify-center rounded-control px-3.5 py-2 ${
                  focused ? TONE_BG[tone].focus : TONE_BG[tone].rest
              } ${containerClassName ?? ''}`;
    return (
        <View className={containerClass}>
            <TextInput
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder}
                placeholderTextColor={palette.muted}
                multiline={multiline}
                maxLength={maxLength}
                autoFocus={autoFocus}
                // 选区/光标色收口到语义色（消灭 iOS 默认蓝等平台色）
                selectionColor={palette.secondary}
                // 输入行为合理默认：自然书写（调用方可经 rest 覆盖，如搜索框给 false/'none'）
                autoCorrect
                autoCapitalize="sentences"
                onFocus={(event) => {
                    setFocused(true);
                    onFocus?.(event);
                }}
                onBlur={(event) => {
                    setFocused(false);
                    onBlur?.(event);
                }}
                {...rest}
                // 平台硬口径收口：放在 rest 之后，调用方透传覆盖不了
                {...INPUT_PLATFORM_PROPS}
                // 视觉：透明化底 → tone 字号行高 → 主题字色（TextInput 默认色
                // 不随深色主题反转，必须显式给，深浅两档都走 palette.text）→
                // 调用方覆盖
                style={[
                    INPUT_TRANSPARENT_STYLE,
                    FIELD_TONE_TEXT[tone],
                    { color: palette.text },
                    style,
                ]}
            />
        </View>
    );
}
