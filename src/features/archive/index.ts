/**
 * archive 业务域入口（R8）：app 路由层从这里取屏与 hook。
 * 域内文件不对外暴露深路径；db / logic / store 的细节留在域内。
 */
export { ArchiveScreen } from './archive-screen';
export { MeScreen } from './me-screen';
export { SearchScreen } from './search-screen';
export { JournalEditScreen } from './journal-edit-screen';
export { TripFormScreen } from './trip-form-screen';
export { TripDetailScreen } from './trip-detail-screen';
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
