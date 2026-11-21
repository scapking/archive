/**
 * archive 域 UI 层入口（域内模块收口；域外一律走 features/archive/index.ts，
 * 不得从这里的深路径 import——R6 同款纪律在域内执行）。
 */
export { BlockEditor, EditorToolbar } from './editor';
// PENDING_MEDIA_ID 的事实源在 db/schema.ts：editor 与本 barrel 都只是 re-export
// （v5 require cycle 修复终态），ui 层不再有任何自定义字面量定义点。
export { PENDING_MEDIA_ID } from '../db';
// ActionMenuCard：长按操作菜单卡共享组件（首页行程卡/笔记卡菜单、Me 导出菜单
// 同语言收口；DayActionCard/chooser 的通用化）。依赖面 = react-native +
// core/icons + ./close-button + ./editor-icons + ./theme，不回头依赖 store/ui，无环。
export { ActionMenuCard, type ActionMenuRow } from './action-menu-card';
export { AudioBlock, formatAudioTime } from './audio-player';
export {
    CameraCaptureOverlay,
    isVideoCaptureSupported,
    type CameraCapture,
} from './camera-overlay';
export { CardDeck, type DeckItem } from './deck';
// CloseButton：全部卡片浮层/全屏层的统一关闭钮（journal-edit / archive 等多屏
// 此前按域内深取纪律直连 ./ui/close-button，出口扩充后收口）。依赖面 =
// react-native + core/icons + ./theme，均为 ui 内既有依赖，无环。
export { CloseButton } from './close-button';
export { ComposeFab } from './compose-fab';
export { DateInput, isDateInputComplete } from './date-input';
export { EmptyState } from './empty-state';
export {
    FullscreenImageViewer,
    FullscreenVideoViewer,
    FullscreenLayer,
} from './fullscreen-viewer';
export { InsertMenu, type InsertAction } from './insert-menu';
export { LineChart } from './line-chart';
export { LoadingView } from './loading-view';
// useBlockActionGestures：长按/双击消歧手势解析（媒体块与首页笔记卡共用，
// prefersDoubleClickActions 是它的 pointer: fine 探测口径）
export {
    MediaImage,
    MediaVideo,
    MediaBlock,
    MediaThumb,
    TripCoverVideo,
    useBlockActionGestures,
} from './media-view';
export { PrimaryButton } from './primary-button';
export { ProgressBar, ProgressLabel } from './progress';
export { RecordingOverlay, isRecordingSupported, type RecordingResult } from './recorder-overlay';
// RenameCard：日记标题重命名卡共享组件（journal-edit 屏头编辑钮 / archive 首页
// 笔记卡长按两入口收口）。依赖面 = react-native + core/icons + ./close-button +
// ./theme + ../journal-logic（JOURNAL_TITLE_MAX，纯逻辑叶模块），均不回头依赖
// store/ui，无环。
export { RenameCard } from './rename-card';
export { ScreenHeader } from './screen-header';
export { safeBack } from './safe-back';
export { Sidebar } from './sidebar';
export { StatusChip } from './status-chip';
export { TripBadge, TRIP_ICON_DEFAULT, type TripBadgeSize } from './trip-badge';
// useFileUrlState：三态（loading/ready/missing）版 file URL 解析 hook，deck 封面
// 缺失态等场景用；use-file-url 只依赖 db + data-revision，不引回 store（无环）。
export {
    useFileUrl,
    useFileUrlState,
    useJournalMedia,
    type FileUrlState,
    type FileUrlStatus,
} from './use-file-url';
export {
    applyThemePref,
    useEffectiveTheme,
    getPalette,
    usePalette,
    useThemePref,
    type Palette,
    type ThemePref,
} from './theme';
