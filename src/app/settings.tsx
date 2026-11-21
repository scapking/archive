import { SettingsScreen } from '@/features/archive';

/**
 * 设置页（新1）：Me 页「我的内容」卡设置行 push 而来（外观 / 安全 / 备份与
 * 恢复三块收口）。route adapter 模式与 search 一致：路由层只做壳，无路径参数。
 */
export default function SettingsRoute() {
    return <SettingsScreen />;
}
