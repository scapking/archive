import { useEffect, useRef, useState } from 'react';
import { Animated as RNAnimated, Pressable, View } from 'react-native';
import type { ComponentProps, ReactNode } from 'react';
import type { IconProps } from './icon-base';

/**
 * 弹跳按压容器：按下去缩小+变暗、松手回弹（spring）。任何内容都能包——
 * 内置图标、自定义 SVG、任意组件通用（"能动一下"的基础设施）。
 *
 * 动画底层 = **RN 内置 Animated（native driver）**，不用 reanimated：
 * reanimated 4.x 在 Fabric (Expo Go) 上驱动样式更新会使同视图的触摸
 * 判定概率性失效（实测 press-in 动画在跑、onPress 被吞，重复点才成）。
 * RN Animated + native driver 是最保守通道，触摸链上零中间层。
 *
 * 双击才生效修复（DEV.md #1，2026-11）：
 * - 按压动画改由 **committed 的 pressed state → effect** 驱动，不再在
 *   onPressIn/onPressOut 触摸回调里同步起 spring——把 native animated 的
 *   节点创建/启动 marshalling 移出 DOWN..UP 的关键触摸窗口（Expo Go dev
 *   的 JS 线程正是这段最挤）；触摸回调本身只剩一次 setState（与 Pressable
 *   内部 setPressed 同批合并，每按压净渲染 +1 次）。
 * - Pressable 的 onLongPress 一并透传（媒体块长按操作卡的公共通道）：
 *   Pressability 语义 = 长按触发后本次松手不再补发 onPress，天然二选一。
 * - disabled（onPress/onLongPress 全空）不出按压反馈，避免假按钮手感；
 *   反馈与恢复都走同一条 effect 通道，不存在 press-out 漏恢复的路径。
 * - **disabled 触摸穿透（deck 露条死区修复，2026-11）**：Pressable 只认显式
 *   `disabled` prop——Pressability 的 onStartShouldSetResponder 返回
 *   `!disabled ?? true`，仅置空 onPress 时仍会抢 responder，把触摸吞在
 *   自己这层（deck 后卡封面露条「点了没反应」的根因）。因此本组件把
 *   「不可交互」统一传导为 Pressable 的 disabled=true：显式 disabled prop
 *   优先，否则按 onPress/onLongPress 全空自动判定。行为矩阵：
 *   · onPress/onLongPress 任一传入 → 可响应 + 按压反馈（不变）；
 *   · 两者全空 / 显式 disabled → Pressable disabled，触摸穿透父级
 *     （deck 后卡封面 → 露条换位；未就绪媒体块 → 上层容器语义），
 *     无按压反馈、无音效，accessibilityState.disabled 同步为 true；
 *   · busy 态置空 onPress 的调用点（主按钮/工具 chip/模式 chip）：
 *     视觉禁用样式在内层 View（opacity），穿透后父级无按压体，可观察
 *     行为与旧版一致（旧版是抢 responder 但不触发任何回调）。
 *
 * hitSlop **无默认值（等效 0）**：曾默认外扩 10，相邻紧凑元素（工具 chip、
 * 分段控件、图标格）各自外扩后命中区横向重叠，重叠带按绘制序右侧获胜
 * → 点 A 触发 B，用户感知「概率失效」。改为调用点按规则显式给：
 * - 纯图标小钮（视觉 < 44px）：显式 hitSlop 8~12 凑足 44px 等效目标；
 * - 自带 padding 的按钮/行（视觉 ≥ 44px）：不传（0），杜绝与邻居重叠。
 * 核算口径：相邻调用点间距 < 2×hitSlop 时，至少一方归零。
 */
const BouncyView = RNAnimated.createAnimatedComponent(View);

export function BouncyPressable({
    onPress,
    onLongPress,
    disabled = false,
    scaleTo = 0.82,
    hitSlop,
    children,
}: {
    onPress?: () => void;
    /** 长按回调（长按触发后 Pressability 不再补发本次 onPress）。 */
    onLongPress?: () => void;
    /** 显式禁用（优先于 onPress/onLongPress 判定）：true 时触摸穿透本层
     *  （Pressable disabled → responder 不认领），不出按压反馈。 */
    disabled?: boolean;
    scaleTo?: number;
    /** 扩大命中区（RN hitSlop 语义，Rect | number）。仅纯图标小钮（视觉 <44px）
     *  显式传 8~12；视觉 ≥44px 的按钮/行不传（0）——相邻元素间距 < 2×hitSlop
     *  会使命中区重叠误触，禁止再设全局默认 */
    hitSlop?: ComponentProps<typeof Pressable>['hitSlop'];
    children: ReactNode;
}) {
    const scale = useRef(new RNAnimated.Value(1)).current;
    const opacity = useRef(new RNAnimated.Value(1)).current;
    // pressed = 提交态按压标记（动画唯一驱动源）；interactive 守卫 disabled 假按钮
    const [pressed, setPressed] = useState(false);
    // 可交互判定：显式 disabled 优先，否则看回调是否传入（全空 = 非响应体，
    // 必须传导 Pressable disabled 触摸才穿透——见文件头「disabled 触摸穿透」节）
    const interactive = !disabled && (onPress != null || onLongPress != null);
    const active = pressed && interactive;

    useEffect(() => {
        // 状态驱动的进/出反馈：同一条通道负责按压与恢复（不遗漏、不竞态——
        // 后到的 effect 天然接管同 value 上的前一个 spring）
        const targetScale = active ? scaleTo : 1;
        const targetOpacity = active ? 0.6 : 1;
        const friction = active ? 7 : 9;
        RNAnimated.parallel([
            RNAnimated.spring(scale, { toValue: targetScale, friction, useNativeDriver: true }),
            RNAnimated.spring(opacity, { toValue: targetOpacity, friction, useNativeDriver: true }),
        ]).start();
    }, [active, scaleTo, scale, opacity]);

    return (
        <Pressable
            // disabled 传导（见文件头）：非交互态必须显式 disabled，Pressability
            // 的 onStartShouldSetResponder 只认这个 prop（`!disabled ?? true`），
            // 仅置空回调仍会抢 responder 吞掉穿透触摸
            disabled={!interactive}
            onPress={onPress}
            onLongPress={onLongPress}
            hitSlop={hitSlop}
            onPressIn={interactive ? () => setPressed(true) : undefined}
            onPressOut={interactive ? () => setPressed(false) : undefined}
        >
            <BouncyView style={{ transform: [{ scale }], opacity }}>{children}</BouncyView>
        </Pressable>
    );
}

export type { IconProps };
