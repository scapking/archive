/**
 * features 层入口——按业务域组织（每域一目录，如 `features/hatch/`）。
 *
 * 结构约定（directory-structure.md R8）：
 * - 每个业务域一个目录，域入口 `index.ts`；域间禁止互相 import；
 * - 域内纯逻辑文件以 `-logic.ts` 结尾，禁止 import react / react-native /
 *   任何 .tsx 组件（保证可独立单测）；
 * - 本文件是对外收口：app 层需要的跨域公共导出从这里出。
 */
export {};
