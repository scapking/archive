import { Pressable, Text, View } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { LucideBookOpen, LucideUser } from '@/core/icons';
import { useAccentGradient } from './theme';

const NAV_ITEMS = [
    { href: '/(tabs)', label: 'Archive', icon: LucideBookOpen },
    { href: '/me', label: 'Me', icon: LucideUser },
] as const;

function isActive(pathname: string, href: string): boolean {
    if (href === '/(tabs)') return pathname === '/' || pathname === '/(tabs)';
    return pathname.endsWith(href);
}

/**
 * 桌面侧栏（≥1024，action shell 惯例）：产品标记 + 两个目的地。
 * 暗色导航纪律：激活项只提亮（text 提亮 + raised 底），不上彩色药丸。
 */
export function Sidebar() {
    const router = useRouter();
    const pathname = usePathname() ?? '';
    const insets = useSafeAreaInsets();
    const [from, to] = useAccentGradient();

    return (
        <View
            className="w-[232px] shrink-0 justify-between border-r border-ink-border bg-ink-base px-3 pb-5 dark:border-inkd-border dark:bg-inkd-base"
            style={{ paddingTop: insets.top + 12 }}
        >
            <View>
                <View className="flex-row items-center gap-2.5 px-2">
                    <LinearGradient
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        colors={[from, to]}
                        className="h-7 w-7 items-center justify-center rounded-md"
                    >
                        <LucideBookOpen size={15} color="#FFFFFF" />
                    </LinearGradient>
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
                                className={`h-10 flex-row items-center gap-2.5 rounded-md px-2.5 ${
                                    active
                                        ? 'bg-ink-raised dark:bg-inkd-raised'
                                        : 'bg-transparent'
                                }`}
                            >
                                <Icon
                                    size={17}
                                    strokeWidth={1.75}
                                    color={
                                        active
                                            ? '#3B82F6'
                                            : pathname
                                                ? '#8B939C'
                                                : '#8B939C'
                                    }
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

            <Text className="px-2 text-[11px] text-ink-faint dark:text-inkd-faint">
                本地优先 · 数据不出设备
            </Text>
        </View>
    );
}
