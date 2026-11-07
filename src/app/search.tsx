import { SearchScreen } from '@/features/archive';

/**
 * 独立搜索页（DEV.md #5）：me 页入口卡 push 而来。
 * route adapter 模式与 trip/[id] 等一致：路由层只做壳，屏 props 由屏组件自理
 * （搜索页无路径参数）。
 */
export default function SearchRoute() {
    return <SearchScreen />;
}
