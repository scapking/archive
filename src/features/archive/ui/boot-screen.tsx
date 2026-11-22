import { useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    Image,
    Text,
    View,
    useWindowDimensions,
    type NativeEventSubscription,
} from 'react-native';
import { useEffectiveTheme } from './theme';

/** 品牌 PNG 双变体（与 app.json expo-splash-screen plugin 同一文件，见头注）。 */
const BOOT_LOGO_LIGHT = require('../../../assets/images/splash-icon.png');
const BOOT_LOGO_DARK = require('../../../assets/images/splash-icon-dark.png');

/**
 * 启动过渡页（boot screen，Android-only 参与；web/iOS 由 _layout 直接进 app）。
 *
 * 【为什么存在】Expo Go 冷启 E2E 自愈 = 主题双翻（theme.ts useAndroidE2eSelfRepair）
 * 会连发两次 Activity 重建；重建若发生在 app 首页可见之后，用户就会看到首页闪现
 * 对档主题再翻回（「双翻修复会变颜色不统一」）。本页在 bootReady=false 期间由
 * _layout 替代 Stack 渲染，把整条修复链盖在启动页之下——「没真正进入 app 首页
 * 之前完成」。
 *
 * 【底色跟随】全屏底 = bg-ink-base / dark:bg-inkd-base（与 palette sceneBg、
 * expo-splash-screen plugin 底色 light #ffffff / dark #080A0A 三段同源）：双翻
 * 期间页面底色随生效主题翻转，黑在黑 / 白在白，与系统层（窗口背景，_layout
 * applyAndroidSceneBackground 同步重设）和内容层零色差衔接。css-interop 在
 * native 的初始生效档 = Appearance 系统档（color-scheme.ts:54-61 fallback），
 * 故 dark: 变体从首帧即正确，splash → 过渡页无缝。
 *
 * 【Logo 选型（v0.4.2 重定）】品牌 PNG（assets/images/splash-icon.png，浅色档 /
 * splash-icon-dark.png，深色档）——v0.4.1 重生成后为 1254×1254 RGBA 透明底品牌笔
 * （旧注「不透明白底 RGB」描述的是重生成前的旧资产，已失效）。**关键约束 = 与
 * 原生 splash 零缝交接**：本页与 expo-splash-screen plugin 配置引用同一对 PNG，
 * plugin 底色（app.json，#FFFFFF/#080A0A）与页面底色 token 三段同源，图像渲染
 * 几何复刻 contain 数学（方形资产渲染边 = min(屏宽, 屏高)，居中）——splash 隐去
 * 与本页淡入同图同位同底色，用户看到的是「一个 logo」，不再是两层图标叠显
 * （v0.4.2 用户反馈）。仍不取 Skia/GradientCycle 动画 logo：动画引擎 + 渐变双
 * 红线冲突（本页动画只许 RN Animated transform/opacity、无渐变）。
 *
 * 【动效】两个克制项，全部 RN Animated transform/opacity + useNativeDriver：
 * ① logo + 文案整体淡入 320ms；② 淡入完成后 logo 呼吸缩放 1↔1.04（2600ms 循环，
 * 与既有 HatchLogo 呼吸节奏一致）。系统 reduceMotion 开启时降级为静态终态
 * （无淡入无呼吸，直接全显）。
 *
 * 【只播一次】开场动画的播放机会以模块级标记（bootIntroPlayed，跨 Activity 重建
 * 存活）只消费一次：双翻重建后本页重挂载读到 true → 初值即终态、零时间线，
 * 不闪回动画、不重新计时（计时权威在 theme.ts 的模块级相位机，与本页无关）。
 */

/** 开场动画已播标记（模块级 = 跨重建存活；effect 期置位，重建重挂载据此定帧）。 */
let bootIntroPlayed = false;

/** 淡入时长：短到不拖启动、长到能看清标记（再快就只是闪一下，不如不做）。 */
const BOOT_INTRO_FADE_MS = 320;

/** 呼吸半程时长：单程 1300ms × 2 = 2600ms 循环（对齐 HatchLogo 呼吸节奏）。 */
const BOOT_BREATH_HALF_MS = 1300;

/** 呼吸峰值：1.04（肉眼可感的下限附近，克制不抢戏）。 */
const BOOT_BREATH_PEAK = 1.04;

/**
 * 笔迹下缘在品牌资产内的纵向占比：资产 1254×1254，笔 + 收笔横线止于约 73%
 * 高度处（下部 27% 是留白）。状态注记锚在笔迹下缘而非图像底缘——图像全宽
 * （复刻 splash contain 几何）后，若按图像底缘排，「初始化中」会漂到离笔迹
 * 100+dp 的下方，构图散架。资产重生成时随 brand-assets.test 一起复核此值。
 */
const BOOT_INK_BOTTOM_RATIO = 0.73;

/** 状态注记与笔迹下缘的间距（对齐原 mt-6 的 24dp 节奏）。 */
const BOOT_NOTE_GAP = 24;

export function BootScreen() {
    // 生效主题档（nativewind useColorScheme 认 set 覆盖）：双翻期间随档翻转，
    // logo 资产随之换浅/深变体（与 plugin dark 配置同一对文件，交接无换图感）。
    const theme = useEffectiveTheme();
    // splash 几何复刻：contain 模式下方形资产渲染边 = min(屏宽, 屏高)，居中
    // （竖屏手机 = 全屏宽，与原生 splash 逐像素同位）。
    const { width, height } = useWindowDimensions();
    const logoSize = Math.min(width, height);
    // reduceMotion（系统减弱动态）：检测是异步的，初值 false；检测返回 true 时
    // 由下方 effect 收敛到静态终态（最坏代价 = 首拍 logo 晚 1-2 帧出现）。
    const [reduceMotion, setReduceMotion] = useState(false);
    // 本实例是否负责播开场（渲染期读模块标记，ref 定格快照——避免后续重渲翻转
    // 该值触发动画 effect 重跑杀掉进行中的淡入）。
    const introRef = useRef(!bootIntroPlayed);
    const intro = introRef.current;

    const fadeAnim = useRef(new Animated.Value(intro ? 0 : 1)).current;
    const breathAnim = useRef(new Animated.Value(1)).current;
    // 呼吸循环在淡入完成回调里启动，cleanup 需要拿到它才能停——经 ref 转交。
    const breathRef = useRef<Animated.CompositeAnimation | null>(null);

    // 系统 reduceMotion 检测 + 订阅（boot 存续期内跟随系统开关变化）。
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                // 读不到系统设置 → 按「无减弱」处理（动画照常，可接受的降级）
            });
        let sub: NativeEventSubscription | null = null;
        try {
            sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
        } catch {
            // 事件通道不可用的极端环境：只认首拍检测结果
        }
        return () => {
            cancelled = true;
            sub?.remove();
        };
    }, []);

    // 开场时间线：淡入 → 完成后接呼吸循环。重建重挂载（intro=false）与
    // reduceMotion 均不出时间线，直接终态。
    useEffect(() => {
        if (!intro) return;
        // 播放机会在首次挂载即消费（即使 reduceMotion 命中，重建后也不补播）
        bootIntroPlayed = true;
        if (reduceMotion) {
            fadeAnim.setValue(1);
            return;
        }
        fadeAnim.setValue(0);
        const fade = Animated.timing(fadeAnim, {
            toValue: 1,
            duration: BOOT_INTRO_FADE_MS,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        fade.start(({ finished }) => {
            if (!finished) return;
            const breath = Animated.loop(
                Animated.sequence([
                    Animated.timing(breathAnim, {
                        toValue: BOOT_BREATH_PEAK,
                        duration: BOOT_BREATH_HALF_MS,
                        easing: Easing.inOut(Easing.quad),
                        useNativeDriver: true,
                    }),
                    Animated.timing(breathAnim, {
                        toValue: 1,
                        duration: BOOT_BREATH_HALF_MS,
                        easing: Easing.inOut(Easing.quad),
                        useNativeDriver: true,
                    }),
                ]),
            );
            breathRef.current = breath;
            breath.start();
        });
        return () => {
            fade.stop();
            breathRef.current?.stop();
            breathRef.current = null;
        };
    }, [intro, reduceMotion, fadeAnim, breathAnim]);

    return (
        // 全屏底：ink/inkd token，与 splash / Stack contentStyle 同源（见头注）。
        // 条件类恒等：dark 变体静态写出，无动态拼串。
        <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
            {/* 淡入作用域 = logo（绝对定位满幅居中，与 splash 图像同位） */}
            <Animated.View
                style={{ opacity: fadeAnim }}
                className="absolute inset-0 items-center justify-center"
            >
                {/* 呼吸作用域仅 logo。fadeDuration 0 = 关掉 RN Image 自带淡入
                （Android 默认 ~150ms）：splash 隐去瞬间 logo 必须已在位，否则
                出现「空底 → logo 后到」的二次出现感 */}
                <Animated.View style={{ transform: [{ scale: breathAnim }] }}>
                    <Image
                        source={theme === 'dark' ? BOOT_LOGO_DARK : BOOT_LOGO_LIGHT}
                        style={{ width: logoSize, height: logoSize }}
                        resizeMode="contain"
                        fadeDuration={0}
                    />
                </Animated.View>
            </Animated.View>
            {/* 极轻状态注记（用户口径「Logo 然后进行初始化」）：meta 字号 + muted，
                绝对定位锚在笔迹下缘（见 BOOT_INK_BOTTOM_RATIO 注）——logo 满幅后
                不再随图像底缘走，与淡入同一条时间线出场 */}
            <Animated.View
                style={{ opacity: fadeAnim, top: height / 2 + (BOOT_INK_BOTTOM_RATIO - 0.5) * logoSize + BOOT_NOTE_GAP }}
                pointerEvents="none"
                className="absolute left-0 right-0 items-center"
            >
                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                    初始化中
                </Text>
            </Animated.View>
        </View>
    );
}
