/**
 * 设计令牌 v2（系统极简 / Apple Journal 口径，app-screens 房规）：
 *
 * - 颜色只上数据（v0.4.9 收窄口径）：蓝色（accent）只允许控件级小面积（开关轨道、
 *   描边、状态圆点、进度条），禁做卡面底色/整面渐变场；主行动一律近黑
 *   （primary-btn）；深色为真中性黑阶。
 * - 半径体系（房规「双峰取一支」，全仓只用这几档）：卡片 16 / 控件与输入 10 /
 *   缩略图 8 / 状态徽章与药丸 rounded-full；纵深靠 paper-shadow 柔影档
 *   （PAPER_CARD/FLOAT/PILL，见 ui/paper-shadow.ts），不用灰井灰块、散写裸 shadow。
 * - 字号阶（下限 11）：30 报头（编辑器日期，唯一签名元素）/ 20 屏题 / 15 正文 /
 *   14 辅文 / 12 meta / 11 角注；一切数字位配 tabular-nums。
 * - 双主题：`ink` = 浅色（默认类名），`inkd` = 深色（dark: 变体）。
 *   hatch 组保留供 core 既有类名编译，业务层统一 ink/inkd。
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
    // class 模式：css-interop 运行时据此允许 colorScheme.set（media 模式下 observer
    // 触发 set 会抛错，见 nativewind#1489）。与 +html.tsx 的 --css-interop-darkMode 同步。
    darkMode: 'class',
    content: [
        "./App.tsx",
        "./app/**/*.{js,jsx,ts,tsx}",
        "./core/**/*.{js,jsx,ts,tsx}",
        "./features/**/*.{js,jsx,ts,tsx}",
    ],
    presets: [require('nativewind/preset')],
    theme: {
        extend: {
            // 半径令牌：rounded-card（16，卡片）/ rounded-control（10，按钮与输入）/
            // rounded-thumb（8，缩略图）；状态徽章与药丸用 rounded-full。禁用其余档位。
            borderRadius: {
                card: '16px',
                control: '10px',
                thumb: '8px',
            },
            colors: {
                // 浅色（灰白）：默认类名
                ink: {
                    base: '#FFFFFF',        // 页面底
                    surface: '#F7F8FA',     // 卡片/浮起
                    raised: '#F0F2F5',      // 按压/高一级
                    border: '#E5E8EC',      // 卡片 1px 边
                    rule: '#EEF0F3',        // 行分隔细线
                    control: '#D9DDE2',     // 控件描边
                    text: '#171A1E',        // 主文本（近黑，兼主行动底色）
                    secondary: '#5A626B',   // 次文本
                    muted: '#8B939C',       // 弱文本
                    faint: '#B4BAC2',       // 无文字语义标记
                    accent: '#2563EB',      // 数据强调（进度/进行中），禁上 chrome
                    'accent-press': '#1D4ED8',
                    'accent-bright': '#3B82F6',
                    'accent-deep': '#1D4ED8',
                    'accent-bg': '#EAF1FE',
                    'primary-btn': '#171A1E',     // 主行动底（近黑，房规：主按钮不用强调色）
                    'on-primary-btn': '#FFFFFF',
                    positive: '#2563EB',
                    'positive-bg': '#EAF1FE',
                    negative: '#DC4A5E',
                    'negative-bg': '#FDECEF',
                    warning: '#B97F24',
                    'warning-bg': '#FBF3E4',
                    grid: '#ECEEF1',
                    'on-accent': '#FFFFFF',
                    scrim: 'rgba(0,0,0,0.5)',   // 全屏遮罩（弹层压暗），深浅两档同值
                },
                // 深色：dark: 变体（真中性黑阶，无海军蓝偏移；提亮即激活，不上彩）
                inkd: {
                    base: '#080A0A',
                    surface: '#0E1111',
                    raised: '#161B1A',
                    border: '#1E2422',
                    rule: '#181D1C',
                    control: '#2E3533',
                    text: '#E7EAE9',
                    secondary: '#9CA3A1',
                    muted: '#7A827F',
                    faint: '#525A57',
                    accent: '#5B9DFF',
                    'accent-press': '#8FBDFF',
                    'accent-bright': '#8FBDFF',
                    'accent-deep': '#2E6FD9',
                    'accent-bg': '#0E1B2E',
                    'primary-btn': '#E7EAE9',     // 深色主行动 = 反白近白
                    'on-primary-btn': '#101314',
                    positive: '#7CB5FF',
                    'positive-bg': '#10203A',
                    negative: '#E5566F',
                    'negative-bg': '#2C161C',
                    warning: '#E8B45A',
                    'warning-bg': '#2A2113',
                    grid: '#1B211F',
                    'on-accent': '#080A0A',
                    scrim: 'rgba(0,0,0,0.5)',   // 全屏遮罩（弹层压暗），深浅两档同值
                },
                hatch: {
                    base: '#080A0A',        // 页面底
                    surface: '#101313',     // 卡片/浮起
                    raised: '#171B1A',      // 按压/高一级
                    border: '#232626',      // 1px 细边
                    text: '#E6E8E7',        // 主文本
                    secondary: '#9BA1A0',   // 次文本
                    muted: '#5F6664',       // 弱文本
                    accent: '#10B981',      // 唯一强调（core 兼容保留，业务层禁用）
                    'accent-press': '#34D399',
                },
            },
        },
    },
    plugins: [],
};
