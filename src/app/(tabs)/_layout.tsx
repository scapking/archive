import { Tabs } from 'expo-router';
import { NoteIcon } from '@/core/icons';
import { LucideCalendar } from '@/core/icons';

export default function TabLayout() {
    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                sceneStyle: { backgroundColor: '#080A0A' },
                tabBarActiveTintColor: '#10B981',
                tabBarInactiveTintColor: '#5F6664',
                tabBarStyle: {
                    backgroundColor: '#080A0AEE',
                    borderTopColor: '#232626',
                    borderTopWidth: 1,
                },
                tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: '时间线',
                    tabBarIcon: ({ color }) => <NoteIcon size={22} color={color ?? undefined} />,
                }}
            />
            <Tabs.Screen
                name="trips"
                options={{
                    title: '行程',
                    tabBarIcon: ({ color }) => <LucideCalendar size={22} color={color ?? undefined} />,
                }}
            />
        </Tabs>
    );
}
