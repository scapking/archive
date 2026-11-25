import type { ViewStyle } from 'react-native';

/**
 * 纸面光影令牌（v0.4.6 方向文档 §1「层次靠光影不靠色块」的 C 侧落点）：
 *
 * 方向令废掉灰底相进的语言后，纸面之间的区分只剩两件事——位移与柔和投影。
 * shadow* + elevation 是 RN 官方跨端属性：iOS 走原生阴影，Android 走
 * elevation，RNW 编译为 box-shadow（正是方向文档第二节点名的内联 style
 * 通道；css-interop 无 shadow 类，一律走 style）。深浅两档共用一组值：
 * 浅色下黑投影拉开纸面，深色夜读面（inkd）上近黑投影只压卡缘、层次退回
 * tone 差，双主题不串色。
 *
 * 三档语义（禁止再散写第四组阴影参数）：
 * - PAPER_CARD：落在页面底上的静止内容卡（设置卡 / 日历卡 / 空态卡）；
 * - PAPER_FLOAT：真正悬浮的层（弹窗族 chooser / 菜单 / 设置卡——taste 房规
 *   「静止面无影，只有悬浮物有影」在此保留：scrim 之下的卡才用这档）；
 * - PAPER_PILL：分段控件的选中滑块（微位移，一档就够）。
 */

/** 静止内容卡：6dp 软环境影，浅档几乎不可闻、深档只收卡缘。 */
export const PAPER_CARD_SHADOW: ViewStyle = {
    shadowColor: '#000000',
    shadowOpacity: 0.07,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 16,
    elevation: 2,
};

/** 悬浮层（弹窗族）：低透明大半径远投影，在压暗 scrim 上把卡推离纸面。 */
export const PAPER_FLOAT_SHADOW: ViewStyle = {
    shadowColor: '#000000',
    shadowOpacity: 0.28,
    shadowOffset: { width: 0, height: 18 },
    shadowRadius: 36,
    elevation: 24,
};

/** 分段滑块：1dp 近距投影，白块从轨道里浮起半毫米。 */
export const PAPER_PILL_SHADOW: ViewStyle = {
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    elevation: 1,
};
