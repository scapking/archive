import { Pressable, Text, View } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LucideBack, LucideBookOpen, LucideUser } from '@/core/icons';
import { usePalette } from './theme';

const NAV_ITEMS = [
    { href: '/(tabs)', label: 'Archive', icon: LucideBookOpen },
    { href: '/me', label: 'Me', icon: LucideUser },
] as const;

/**
 * 高亮归属（web desktop 侧栏常驻后重定义）：Me 无子路由，精确匹配（含
 * /me/ 前缀防御）；其余一切路径——含 root Stack push 的编辑/创建/详情屏
 * （/write、/trip/[id]/write/[date]、/journal/[id]、/trip/[id]、/events*、
 * /search 等）——都归属「档案」主域（入口 hub），stack 页激活时档案项保持
 * 高亮，不再因整窗 push 熄灭。
 */
function isActive(pathname: string, href: string): boolean {
    if (href === '/me') return pathname === '/me' || pathname.startsWith('/me/');
    return !pathname.startsWith('/me');
}

/**
 * 桌面侧栏（≥1024，action shell 惯例）：产品标记 + 两个目的地。
 * 品牌标记 = 近黑方块（primary-btn 体系，无渐变）；激活项按亮度提亮
 * （text 提亮 + raised 底），不上彩色药丸（房规：active nav by brightness）。
 *
 * onCollapse（可选）：web desktop 全局壳（ui/desktop-shell）传入——渲染底部
 * 「收起侧栏」钮并回传折叠意图（持久化在壳的 useSidebarCollapsed）；
 * native 宽屏仍由 (tabs) 布局内嵌渲染本组件（无壳、无收起动画），不传即
 * 不渲染收起钮，行为与历史一致。
 */
export function Sidebar({ onCollapse }: { onCollapse?: () => void } = {}) {
    const router = useRouter();
    const pathname = usePathname() ?? '';
    const insets = useSafeAreaInsets();
    const palette = usePalette();

    return (
        <View
            className="w-[232px] shrink-0 justify-between border-r border-ink-border bg-ink-base px-3 pb-5 dark:border-inkd-border dark:bg-inkd-base"
            style={{ paddingTop: insets.top + 12 }}
        >
            <View>
                <View className="flex-row items-center gap-2.5 px-2">
                    <View
                        className="h-7 w-7 items-center justify-center rounded-control"
                        style={{ backgroundColor: palette.primaryBtn }}
                    >
                        <LucideBookOpen size={15} color={palette.onPrimaryBtn} />
                    </View>
                    <View className="min-w-0 flex-1">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            Archive
                        </Text>
                        <Text className="text-[11px] leading-4 text-ink-muted dark:text-inkd-muted">
                            行程 × 日记
                        </Text>
                    </View>
                </View>

                <View className="mt-6 gap-0.5">
                    {NAV_ITEMS.map((item) => {
                        const active = isActive(pathname, item.href);
                        const Icon = item.icon;
                        return (
                            <Pressable
                                key={item.href}
                                accessibilityRole="link"
                                accessibilityLabel={item.label}
                                onPress={() => router.navigate(item.href)}
                                // h-11 = 44px 最小触摸目标（平板触屏也会走到 ≥1024 宽的侧栏）
                                className={`h-11 flex-row items-center gap-2.5 rounded-control px-2.5 active:opacity-80 ${
                                    // 条件类铁律：两侧变量集恒等（bg-transparent 缺变量槽位，
                                    // 用 base 底 = 视觉等价透明）
                                    active
                                        ? 'bg-ink-raised dark:bg-inkd-raised'
                                        : 'bg-ink-base dark:bg-inkd-base'
                                }`}
                            >
                                <Icon
                                    size={16}
                                    strokeWidth={1.9}
                                    color={active ? palette.text : palette.muted}
                                />
                                <Text
                                    className={`text-[14px] ${
                                        active
                                            ? 'font-medium text-ink-text dark:text-inkd-text'
                                            : 'text-ink-secondary dark:text-inkd-secondary'
                                    }`}
                                >
                                    {item.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            <View>
                {onCollapse ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="收起侧栏"
                        onPress={onCollapse}
                        // h-11 = 44px 最小触摸目标（与导航项同规格）
                        className="mb-1 h-11 flex-row items-center gap-2.5 rounded-control px-2.5 active:opacity-80"
                    >
                        <LucideBack size={16} strokeWidth={1.9} color={palette.secondary} />
                        <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                            收起侧栏
                        </Text>
                    </Pressable>
                ) : null}
                <Text className="px-2 text-[11px] text-ink-faint dark:text-inkd-faint">
                    本地优先 · 数据不出设备
                </Text>
            </View>
        </View>
    );
}
