import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    AppState,
    Pressable,
    Text,
    View,
    type NativeEventSubscription,
} from 'react-native';
import { LucidePenLine, LucideLock } from '@/core/icons';
import { haptics } from '@/core/haptics';
import { localAuth } from '@/core/local-auth';
import { usePalette } from './ui/theme';
import { archiveConfig } from '@/config/archive';

/**
 * App 锁门禁（M3，面容/指纹/设备凭据）：
 *
 * - **覆盖层而非替换渲染**：锁定时以 absolute inset-0 全屏层盖在根布局内容之上
 *   （同块操作卡/chooser 的条件渲染 scrim 范式，禁 RN Modal），不卸载 Stack——
 *   解锁后回到锁定前的原屏（替换渲染会把导航树重置回首页，不可接受）；
 * - **三档锁定策略**（security.appLockMode，三档语义见 config/archive 字段注）：
 *   off 关闭；balanced 平衡——冷启锁定 + 会话级放行（sessionUnlocked，见下）；
 *   aggressive 激进——离开前台即重锁（v1 布尔开关的原始策略，含系统权限弹窗
 *   导致的短暂退后台）；
 * - **balanced 会话级放行**：authenticateAsync 成功置模块级 sessionUnlocked
 *   （模块级而非 ref：跨 AppLockGate 重挂载存活，last-route 的 lastRouteRestoreDone
 *   同款先例；本 JS 会话内恒存，进程重启 / Fast Refresh 重求值模块才复位）——
 *   background 监听据此整段跳过，权限弹窗 / 分享面板等短暂退后台不再打扰；冷启
 *   照旧锁定（模块复位即无会话凭证，本次 JS 会话内验证一次全程有效的语义）；
 * - **旧数据兼容**：v1 配置是布尔 security.appLock，字段已从 config 默认表移除，
 *   但 zustand persist 浅合并会把存量文档里的旧键原样带回 state——新档位为 off
 *   且旧布尔为 true 时按 balanced 生效（读取需 cast）；设置页切档时写 false 清除
 *   （同样 cast），存量用户切一次档即退出兼容回退；
 * - **解锁**：authenticateAsync 拉系统认证（iOS passcode / Android 设备凭据
 *   自动回退）；成功 haptics.success + 立即解锁进入 app（不停留在锁屏）；失败/
 *   取消留在锁屏，「解锁」钮是失败路径的必要手动重试入口（不在取消后自动重拉，
 *   防取消死循环）；Android 关闭识别后的系统确认步（requireConfirmation:
 *   false，人脸成功自动回 app，见 core/local-auth 注）；
 * - **自动拉起认证按锁定事件触发（每锁一弹）**：aggressive 档会反复重锁，触发
 *   器必须是「locked 进入 true 的跳变」而非组件生命周期只一次——effect 以 locked
 *   为依赖，每次锁定事件跑一次（冷启锁定与运行期重锁同路径）；取消/失败停留锁屏
 *   时 locked 不再变化，effect 不重跑；认证在途由 unlock 内 ref 守卫幂等（重跑 /
 *   连点不叠弹）；
 * - 档位在「设置」页安全卡切换（三档分段，仅 isSupportedAsync 通过时允许离开
 *   off 档——web 无系统认证恒关闭）；本组件读取同一配置，config 订阅驱动（切档
 *   即生效，无需重启）；
 * - 失败语义：认证通道异常（底层抛错）只在锁屏上给可重试文案，绝不静默解锁
 *   （安全边界失败必须显式可见）。
 */

/** App 锁三档模式（config 值存字符串、读取处 cast，同 ui.theme 写法）。 */
export type AppLockMode = 'off' | 'balanced' | 'aggressive';

/** 配置字段（archive.config）：App 锁三档模式。 */
export const APP_LOCK_MODE_CONFIG_KEY = 'security.appLockMode';

/** 旧版布尔开关字段（v1，已从 config 默认表移除）：仅供存量文档的兼容回退读取
    与清除写入，不再是有效配置项。 */
export const LEGACY_APP_LOCK_CONFIG_KEY = 'security.appLock';

/** 认证看门狗超时（ms）：覆盖正常慢认证（用户对着系统弹窗想几秒是常态）与
    「promise 永不回调」卡死的分界——10s 后按钮恢复可按、提示重试，在途 promise
    不掐断（见 unlock 内注）。 */
const AUTH_WATCHDOG_MS = 10_000;

/** balanced 档会话级解锁标记（模块级跨重挂载存活，机理见头注）：authenticateAsync
    成功置位；进程重启模块复位，冷启重新锁定。 */
let sessionUnlocked = false;

/**
 * 订阅生效档位（config store 反应式；设置页分段与门禁共用同一事实源，含旧数据
 * 兼容归一——两处消费必须读到同一个生效档，否则 UI 显示与门禁行为不一致）。
 */
export function useAppLockMode(): AppLockMode {
    return archiveConfig.use((config) => {
        // 新档位字段：值存字符串、读取处 cast（同 ui.theme 既有写法）
        const mode = config[APP_LOCK_MODE_CONFIG_KEY] as AppLockMode;
        // 旧布尔字段已不在 config 类型面，读取经 Record cast（persist 浅合并会把
        // 存量文档的旧键原样带回 state，见头注旧数据兼容）
        const legacy = (config as Record<string, unknown>)[LEGACY_APP_LOCK_CONFIG_KEY];
        return mode === 'off' && legacy === true ? 'balanced' : mode;
    });
}

export function AppLockGate({ children }: { children: ReactNode }) {
    const mode = useAppLockMode();
    const palette = usePalette();
    const [locked, setLocked] = useState(mode !== 'off');
    const [authenticating, setAuthenticating] = useState(false);
    // 锁屏文案：null = 常态引导；非 null = 上一次认证失败/异常的可重试说明
    const [hint, setHint] = useState<string | null>(null);
    // 认证在途守卫用 ref（与渲染态 authenticating 同步读写）：unlock 必须是无
    // 依赖恒等回调——自动拉起 effect 以 unlock 为依赖，若闭包随 authenticating
    // 重建，认证开始/结束都会重跑 effect，触发器就不再是纯「锁定事件」
    const authenticatingRef = useRef(false);
    // mode 是异步持久化的配置——首帧可能与持久层回放值不一致：仅跟随「off →
    // 非 off」的翻转加锁（运行期开启立即生效），「非 off → off」不动锁态也不
    // 自动解锁（解锁动作只能由验证成功触发，改配置的人已在 app 内）；非 off 档
    // 之间平移（balanced ↔ aggressive）不重锁——此刻会话必然已验证，改档人就在
    // app 里
    const prevModeRef = useRef(mode);
    useEffect(() => {
        const was = prevModeRef.current;
        prevModeRef.current = mode;
        if (mode !== 'off' && was === 'off') {
            setLocked(true);
            setHint(null);
        }
    }, [mode]);

    // 退后台重锁（按档位）：aggressive 维持「离开前台即重锁」；balanced 仅在
    // 会话尚未验证过时重锁（冷启锁定态下 background 保持锁屏并清过期的失败
    // 提示），会话已验证则整段跳过——切后台 / 权限弹窗 / 分享面板回前台不再打扰
    useEffect(() => {
        if (mode === 'off') return;
        const sub: NativeEventSubscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') return;
            if (mode === 'balanced' && sessionUnlocked) return;
            setLocked(true);
            setHint(null);
        });
        return () => sub.remove();
    }, [mode]);

    const unlock = useCallback(async () => {
        if (authenticatingRef.current) return;
        authenticatingRef.current = true;
        setAuthenticating(true);
        // 高可用看门狗（2026-11-19 用户反馈「卡住等待验证」）：系统认证弹窗偶发
        // 不回调（Activity 重建 / Expo Go 宿主切换等生命周期路径，promise 永不
        // settle）会让「等待验证…」永久卡死。超时后只放开「解锁」钮让用户重试
        // ——不 abort 在途 promise：迟到结算仍被处理（迟到成功照样解锁，迟到
        // 失败的 hint 会被新一轮结果覆盖），不会把还能用的认证白白掐死。
        const watchdog = setTimeout(() => {
            if (!authenticatingRef.current) return;
            authenticatingRef.current = false;
            setAuthenticating(false);
            setHint('认证没有响应，点「解锁」再试一次。');
        }, AUTH_WATCHDOG_MS);
        try {
            // requireConfirmation: false —— 人脸识别成功立即回 app（androidx 对
            // 被动识别的默认确认步 = 用户反馈的「面部识别成功，请继续」停留弹窗，
            // 2026-11-19 关闭；指纹按压本就即时，不受影响）
            const passed = await localAuth.authenticateAsync({
                promptMessage: '解锁 Archive',
                requireConfirmation: false,
            });
            if (passed) {
                haptics.success();
                // 会话级放行（balanced 档的 background 监听据此跳过重锁；本
                // JS 会话内恒存，进程重启模块复位后冷启重新锁定）
                sessionUnlocked = true;
                setLocked(false);
                setHint(null);
            } else {
                setHint('没有通过验证，再试一次。');
            }
        } catch (caught) {
            // 认证通道异常：锁屏上显式可重试文案，绝不静默解锁（安全边界失败可见）
            setHint(`验证不可用：${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
            clearTimeout(watchdog);
            authenticatingRef.current = false;
            setAuthenticating(false);
        }
    }, []);

    // 自动拉起认证（每锁一弹，见头注）：locked 进入 true 的跳变即触发——冷启
    // 锁定（config 回放翻转 / 注水前已回放的首帧初值）与运行期重锁同路径；
    // 取消/失败停留锁屏时 locked 恒为 true 不再重跑，防「取消 → 自动重拉」死循环
    useEffect(() => {
        if (!locked) return;
        void unlock();
    }, [locked, unlock]);

    if (!locked) return <>{children}</>;

    return (
        <>
            {children}
            {/* 锁定覆盖层（全屏不透明，盖过全部内容与 RecordingSessionHost 的
                悬浮 chip——zIndex 60 高于各覆盖层 z-50 档） */}
            <View className="absolute inset-0 z-[60] flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <LucidePenLine size={56} color={palette.secondary} strokeWidth={1.5} />
                <Text className="mt-5 text-[20px] font-semibold text-ink-text dark:text-inkd-text">
                    Archive
                </Text>
                <Text className="mt-1.5 text-[13px] text-ink-muted dark:text-inkd-muted">
                    {authenticating ? '等待验证…' : '已锁定，验证身份后继续'}
                </Text>
                {hint ? (
                    <Text className="mt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {hint}
                    </Text>
                ) : null}
                {/* 解锁钮：h-11 视觉盒 ≥44，px-6 自适应宽度；authenticating 禁按
                    （认证弹窗在途，重复触发会被 unlock 内部 ref 守卫忽略，按钮态
                    同步） */}
                <Pressable
                    onPress={() => void unlock()}
                    disabled={authenticating}
                    className={`mt-6 h-11 flex-row items-center justify-center gap-2 rounded-control bg-ink-surface px-6 active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                        authenticating ? 'opacity-50' : ''
                    }`}
                    accessibilityRole="button"
                    accessibilityLabel="解锁"
                >
                    <LucideLock size={16} strokeWidth={1.9} color={palette.secondary} />
                    <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                        解锁
                    </Text>
                </Pressable>
            </View>
        </>
    );
}
