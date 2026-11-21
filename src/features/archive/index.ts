/**
 * archive 业务域入口（R8）：app 路由层从这里取屏与 hook。
 * 域内文件不对外暴露深路径；db / logic / store 的细节留在域内。
 */
export { ArchiveScreen } from './archive-screen';
export { MeScreen } from './me-screen';
export { SearchScreen } from './search-screen';
// 搜索结果屏（2026-11-19 搜索拆分：app/search-results/[spec] 路由壳消费；
// SearchSpec 随屏出口供路由层解析规格）
export { SearchResultsScreen, type SearchSpec } from './search-results-screen';
// 设置页（新1：外观/安全/备份与恢复收口；app/settings.tsx 路由壳消费）
export { SettingsScreen } from './settings-screen';
// 独立笔记（v8）：新建表单 + 笔记与行程堆叠库（app/note/new.tsx、
// app/library.tsx 路由壳消费；编辑器复用 JournalEditScreen，不设独立屏）
export { NoteFormScreen } from './note-form-screen';
export { LibraryScreen } from './library-screen';
export { JournalEditScreen } from './journal-edit-screen';
export { TripFormScreen } from './trip-form-screen';
export { TripDetailScreen } from './trip-detail-screen';
// 事件实体（v6，工单式）：列表 / 创建 / 详情编辑三屏（app/events*.tsx 路由壳消费）
export { EventsScreen } from './events-screen';
export { EventFormScreen } from './event-form-screen';
export { EventDetailScreen } from './event-detail-screen';
export { useArchiveStore, useArchiveRevision, type TripCard } from './store';
// 全屏查看器请求通道（中立层，app/viewer 路由屏消费；模式同 data-revision）
export {
    requestViewer,
    useViewerRequest,
    notifyViewerMounted,
    type ViewerRequest,
    type ViewerRequestPayload,
} from './viewer-request';
export {
    LoadingView,
    Sidebar,
    // app/viewer.tsx 路由屏渲染的全屏媒体查看器本体 + 守卫式返回（空请求回退）
    FullscreenImageViewer,
    FullscreenVideoViewer,
    safeBack,
    applyThemePref,
    useEffectiveTheme,
    getPalette,
    usePalette,
    useThemePref,
    type ThemePref,
} from './ui';
