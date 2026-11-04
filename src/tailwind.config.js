/**
 * 设计令牌（design-linear 派生，Hatch 品牌色注入）：
 * 底色 #080A0A、1px 细边框、圆角 6/8px、唯一强调色 emerald（Hatch 蛋壳）。
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
                hatch: {
                    base: '#080A0A',        // 页面底
                    surface: '#101313',     // 卡片/浮起
                    raised: '#171B1A',      // 按压/高一级
                    border: '#232626',      // 1px 细边
                    text: '#E6E8E7',        // 主文本
                    secondary: '#9BA1A0',   // 次文本
                    muted: '#5F6664',       // 弱文本
                    accent: '#10B981',      // 唯一强调（交互点/品牌）
                    'accent-press': '#34D399',
                },
            },
        },
    },
    plugins: [],
};
