import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
    Animated,
    Easing,
    Platform,
    Pressable,
    useWindowDimensions,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LucidePanelLeftOpen, LucidePenLine } from '@/core/icons';
import { archiveConfig } from '@/config/archive';
import { usePalette } from './theme';
import { Sidebar } from './sidebar';

/**
 * Web Desktop 全局壳（2026-11-11 侧边栏常驻改造）：
 *
 * 背景：侧栏原本只挂在 (tabs) 布局里（≥1024 隐藏底部标签栏 + 左侧栏），
 * root Stack push 的屏（计划编辑 /trip/[id]/write/[date]、事件新建 /events/new、
 * 行程详情 /trip/[id]、搜索等）整窗覆盖，侧栏消失。本模块把侧栏提升为根布局
 * 层的常驻 chrome——app/_layout 渲染 <DesktopShell><Stack/></DesktopShell>，
 * 宽屏下 Stack 落在侧栏右侧 flex-1 容器内，任何 push 都不再盖住侧栏；
 * 窄屏（手机）与 native 树结构原样（children 直出，零行为变化）。
 *
 * 结构与铁律对齐：
 * - 动画容器与触摸容器分离：Animated 只挂在槽位（width，仅 web 分支）与滑出
 *   层（transform.translateX，白名单内）；展开把手在静态布局层，不在被动画
 *   变换的元素里。
 * - width 动画合法性：RN Animated 的 native driver 白名单只有 transform/
 *   opacity，本特性 web desktop 专属——web 端 useNativeDriver 实际恒走 JS
 *   驱动（无原生视图桥），逐帧改 layout 合法；组件整树只在 web 挂载
 *   （Platform.OS !== 'web' 短路），native 不可能渲染到这条路径。
 * - 跨断点缩放窗口不重挂：WebDesktopShell 恒挂载（flex-row + flex-1 双槽
 *   结构不变），窄屏只把槽位渲染为 null——children 的树位置恒定，Stack
 *   （含导航态）不因宽度跨越 1024 而 remount。
 * - viewer 透明路由不受影响：web 端全屏媒体查看器经 ViewerPortal 挂
 *   document.body（containing block = 视口），portal 内容天然覆盖侧栏。
 *   RecordingSessionHost / 降级提示条也是 Stack 的兄弟节点（壳之外），
 *   全窗覆盖语义保持。
 *
 * 设计口径（design-taste app-screens「navigation recedes」）：侧栏 = 产品级
 * chrome，折叠态收敛为 48dp 窄条把手（品牌标留驻 + 底部展开钮），展开钮与
 * 收起钮同在底部角落（收起处展开，视线不搬家）。
 */

/** 桌面断点（dp）：沿用既有 (tabs) 响应式壳的 1024 同值，收口为单一常量。 */
export const DESKTOP_BREAKPOINT = 1024;

/** 侧栏展开宽度（dp）：sidebar.tsx 根节点 w-[232px] 同值，两处必须同步。 */
const SIDEBAR_WIDTH = 232;

/** 折叠态窄条宽度（dp）：4dp 网格，内含 44dp 展开钮（w-12 槽 + w-11 钮）。 */
const RAIL_WIDTH = 48;

/** 折叠/展开过渡时长（ms）：200ms 桌面 chrome 惯例档。 */
const COLLAPSE_DURATION_MS = 200;

/**
 * 当前是否处于 web desktop 壳模式（web 且窗口 ≥ 断点）。
 * (tabs) 布局用它让位：壳活跃时侧栏由根布局持有，tabs 内不再自渲染。
 */
export function useIsDesktopShell(): boolean {
    const { width } = useWindowDimensions();
    return Platform.OS === 'web' && width >= DESKTOP_BREAKPOINT;
}

/**
 * 侧栏折叠偏好（持久化在 archive.config 'ui.sidebarCollapsed'，默认展开）：
 * [是否折叠, 设置]。zustand persist 异步回灌——冷启首帧恒读默认 false，
 * 折叠用户重载时槽位先以展开态出现再动画收拢到窄条（一次 200ms 的视觉
 * settle，读作有意为之的入场动画；配置存储无同步读通道，接受该折衷）。
 */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
    const collapsed = archiveConfig.use((state) => state['ui.sidebarCollapsed']);
    const setCollapsed = useCallback((next: boolean) => {
        archiveConfig.update({ 'ui.sidebarCollapsed': next });
    }, []);
    return [collapsed, setCollapsed];
}

/**
 * 根布局壳入口：native 直接透传 children（树结构与历史逐节点一致，Android
 * E2E 自愈 / last-route / 录制会话宿主等根层机制零扰动）；web 交给
 * WebDesktopShell（恒挂载壳，见其注）。
 */
export function DesktopShell({ children }: { children: ReactNode }) {
    if (Platform.OS !== 'web') return <>{children}</>;
    return <WebDesktopShell>{children}</WebDesktopShell>;
}

/**
 * web 恒挂载壳：flex-row（侧栏槽位 + 内容 flex-1）结构不随断点变化，
 * 窄屏时槽位为 null（children 树位置恒定 → 跨 1024 缩放不 remount Stack）。
 */
function WebDesktopShell({ children }: { children: ReactNode }) {
    const active = useIsDesktopShell();
    const [collapsed] = useSidebarCollapsed();
    return (
        <View className="flex-1 flex-row">
            {active ? <ShellSlot collapsed={collapsed} /> : null}
            <View className="flex-1">{children}</View>
        </View>
    );
}

/**
 * 侧栏槽位（仅 web 宽屏挂载）：固定高度容器裁切（overflow hidden）+ 侧栏
 * 整体 translateX 滑出 + 折叠窄条从右缘推入。三要素共用同一驱动值：
 * - 槽位 width：SIDEBAR_WIDTH ↔ RAIL_WIDTH（仅 web 分支，见模块头注）；
 * - 侧栏 translateX：0 ↔ -SIDEBAR_WIDTH（完全滑出槽外，白名单 transform）；
 * - 窄条 right 锚定：随槽位右缘移动，动画全程填满滑出层让出的缝隙
 *   （侧栏右缘与槽位右缘之间的空隙 = 窄条的右侧切片，无透底闪烁），
 *   收拢终点自然落在 [0..48]。
 * 展开态下窄条被侧栏（不透明底 + border-r）完整盖住，不可点；折叠态侧栏
 * 已滑出槽外（overflow hidden 裁切），窄条把手独占命中。
 */
function ShellSlot({ collapsed }: { collapsed: boolean }) {
    const [, setCollapsed] = useSidebarCollapsed();
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    // 槽位宽度驱动值（惰性构造：初值取挂载瞬间的折叠态，避免折叠用户在
    // 窄→宽跨越挂载时闪一次展开）
    const widthRef = useRef<Animated.Value | null>(null);
    if (widthRef.current === null) {
        widthRef.current = new Animated.Value(collapsed ? RAIL_WIDTH : SIDEBAR_WIDTH);
    }
    const width = widthRef.current;

    useEffect(() => {
        // width 动画仅 web 分支（模块头注「width 动画合法性」）：native driver
        // 白名单限制只约束原生端，本组件树 web-only。快速连点折叠/展开时
        // timing 以最新 toValue 重启，收敛于最后一次操作。
        Animated.timing(width, {
            toValue: collapsed ? RAIL_WIDTH : SIDEBAR_WIDTH,
            duration: COLLAPSE_DURATION_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: false,
        }).start();
    }, [collapsed, width]);

    // 滑出位移由同一驱动值派生：两动画每帧严格同步（同一 ticker 同一值）
    const shift = width.interpolate({
        inputRange: [RAIL_WIDTH, SIDEBAR_WIDTH],
        outputRange: [-SIDEBAR_WIDTH, 0],
        extrapolate: 'clamp',
    });

    return (
        // 动画容器（仅 width）：overflow hidden 裁切滑出层；触摸容器分离——
        // 展开把手在下方静态布局层，不在任何被变换的元素内
        <Animated.View style={{ width, overflow: 'hidden' }}>
            <View className="h-full">
                {/* 折叠窄条（底层，right 锚定随槽缘推入）：品牌标留驻 + 底部展开钮。
                    顶部留白与 sidebar 品牌行（insets.top + 12）对齐；底部 pb-3(12dp)
                    在 4dp 网格上，44dp 钮在 48dp 条内水平居中。 */}
                <View
                    className="absolute inset-y-0 right-0 w-12 flex-col items-center justify-between border-r border-ink-border bg-ink-base pb-3 dark:border-inkd-border dark:bg-inkd-base"
                    style={{ paddingTop: insets.top + 12 }}
                >
                    <View
                        className="h-7 w-7 items-center justify-center rounded-control"
                        style={{ backgroundColor: palette.primaryBtn }}
                    >
                        <LucidePenLine size={15} color={palette.onPrimaryBtn} />
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="展开侧栏"
                        onPress={() => setCollapsed(false)}
                        className="h-11 w-11 items-center justify-center rounded-control active:opacity-80"
                    >
                        <LucidePanelLeftOpen size={18} strokeWidth={1.9} color={palette.secondary} />
                    </Pressable>
                </View>
                {/* 侧栏（顶层）：固定 232 宽，折叠时整体左滑出槽外被裁切。
                    定位一律走内联 style——nativewind className interop 不覆盖
                    Animated.View（非原生 View 系组件，className 被静默丢弃，
                    实测以 absolute 失效、绝对定位的窄条反盖其上），style 契约
                    在 Animated 系组件上恒可靠。 */}
                <Animated.View
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: 0,
                        width: SIDEBAR_WIDTH,
                        // row 方向：侧栏根（w-232，无高度约束）在此拉伸到槽位全高
                        //（RN 默认 column 下子项主轴高 = 内容高，纵向会缩到 243px，
                        // 底部「收起钮/本地优先」群与窄条把手全部失位）
                        flexDirection: 'row',
                        transform: [{ translateX: shift }],
                    }}
                >
                    <Sidebar onCollapse={() => setCollapsed(true)} />
                </Animated.View>
            </View>
        </Animated.View>
    );
}
