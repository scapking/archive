/**
 * 设计令牌（action panel 纪律 + app-screens 房规）：颜色只上数据、1px 细边分隔、
 * 唯一强调色系 = 冷蓝渐变（不用绿色）。双主题：
 * `ink` = 浅色（灰白，默认类名），`inkd` = 深色（dark: 变体）。
 * hatch 组保留供 core 既有类名编译，业务层统一 ink/inkd。
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
            colors: {
                // 浅色（灰白）：默认类名
                ink: {
                    base: '#FFFFFF',        // 页面底
                    surface: '#F7F8FA',     // 卡片/浮起
                    raised: '#F0F2F5',      // 按压/高一级
                    border: '#E5E8EC',      // 卡片 1px 边
                    rule: '#EEF0F3',        // 行分隔细线
                    control: '#D9DDE2',     // 控件描边
                    text: '#171A1E',        // 主文本
                    secondary: '#5A626B',   // 次文本
                    muted: '#8B939C',       // 弱文本
                    faint: '#B4BAC2',       // 无文字语义标记
                    accent: '#2563EB',      // 唯一强调（渐变蓝深端）
                    'accent-press': '#1D4ED8',
                    'accent-bright': '#3B82F6',
                    'accent-deep': '#1D4ED8',
                    'accent-bg': '#EAF1FE',
                    positive: '#2563EB',
                    'positive-bg': '#EAF1FE',
                    negative: '#DC4A5E',
                    'negative-bg': '#FDECEF',
                    warning: '#B97F24',
                    'warning-bg': '#FBF3E4',
                    grid: '#ECEEF1',
                    'on-accent': '#FFFFFF',
                },
                // 深色：dark: 变体（panel 纪律 + 冷蓝）
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
                    positive: '#7CB5FF',
                    'positive-bg': '#10203A',
                    negative: '#E5566F',
                    'negative-bg': '#2C161C',
                    warning: '#E8B45A',
                    'warning-bg': '#2A2113',
                    grid: '#1B211F',
                    'on-accent': '#080A0A',
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
