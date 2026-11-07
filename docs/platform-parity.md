# 三端差异审计（iOS / Android / Web）

> 审计日期 2026-10-29，基线 = core/ 当前实现 + 依赖版本（见 src/package.json）。
> 目标：core 各能力的**调用接口**三端一致；本表列出残余的平台能力差异、已做的缓解与无法消除的硬限制。
> 新增/修改 core 能力时必须同步更新本表。

## 结论

- **接口层已一致**：同一函数签名、同一类型、同一错误纪律，业务层无需写 `Platform.OS` 分支（个别"能力探测返回值"除外，见下）。
- **能力层差异分三级**：
  - ✅ **已抹平**：代码内已处理，调用方无感；
  - 🟡 **已缓解**：差异仍在但有约定/兜底，调用方需知晓；
  - 🔴 **硬限制**：平台物理限制，无法在客户端消除，设计功能时绕开。

## 差异矩阵

| 能力 | 差异点 | 级别 | 说明 / 缓解 |
|---|---|---|---|
| config-store（secure 字段） | web 无系统级密钥库 | 🟡 | native=Keychain/Keystore（硬件级）。**已用代码弥补**：web 端用 WebCrypto **非导出**（extractable=false）AES-GCM 密钥加密后存 localStorage，密钥只存 IndexedDB——XSS 能"用"钥匙但拿不走钥匙。残余差距：native 有硬件隔离，web 端密钥仍可被页面内代码调用；**web 端仍不要存真正的高危凭据**，高危操作走服务端 |
| database / data-store / cache-store | web = WASM + IndexedDB | 🟡 | SQL 语义三端一致（完整 SQLite）；web 打开库时自动申请 `navigator.storage.persist()`（已做）；残余风险：Safari 配额更保守、隐私模式会拒绝持久化 |
| file-storage | web = OPFS | ✅ | 读写一致；持久化申请（已做）；`url()` web 返回会话级 blob:（revokeUrl 释放）vs native 持久 file://——语义统一为"本会话可用的本地 URL" |
| file-storage（checksum） | MD5 仅 native 提供 | ✅ | **已用代码弥补**：checksum 统一为 **SHA-256 hex**（写入时自算，存 file_meta 表；缺元数据时 stat 懒计算回填），三端一致 |
| migration | web 无跨设备文件通道 | ✅ | **已用代码弥补**：迁移包改为**单个 zip**（store 模式，zip.ts 自研零依赖，防 zip-slip + CRC 校验）；native 走系统分享、web 走 `migration.url()`（blob:）+ sharing 下载回退——三端都能把包带出/带进设备。web 分流判定统一为 `Platform.OS === 'web'`（2026-11-06 起，与 file-storage 同一模式：不用能力嗅探，native 环境带 Blob/URL polyfill 时不再误入 web 分支） |
| notifications | web 依赖 Service Worker + 浏览器推送权限 | 🟡 | 本地通知：web 走 Notification API（iOS Safari 需 PWA 安装）；push token：web 走 PushSubscription，需注册 expo 的 SW（上线前配置，expo 未提供注册 API，属构建配置项）。**已抹平**：createChannel 非 Android 空操作；调度触发器 web 对 calendar 类支持有限，尽量用 timeInterval/date |
| camera | web 取景能力子集 | 🟡 | 权限接口三端一致；实时扫码/闪光灯等高级参数 web 受限（组件层差异，features 处理）；scanFromURLAsync iOS 仅二维码 |
| location | web 无"最近缓存位置"、无后台定位 | ✅/🔴 | `getLastKnownPositionAsync` web 恒返回 null（**已抹平**，语义=null=未知）；后台定位未纳入接口（🔴，硬限制） |
| audio / video | iOS 静音键、后台播放策略 | 🟡 | `setAudioModeAsync` 三端同一调用，参数仅对相应平台生效（标准 Expo 行为）；web 端 VideoView 缓存管理为近似空操作 |
| image-picker | web 走文件选择器/getUserMedia | 🟡 | 返回结构一致；web 端 `assetId` 为 null、部分裁剪/质量控制参数不生效 |
| clipboard | web 需用户手势+浏览器权限 | 🟡 | 读写接口一致；web 端读取可能被浏览器拒绝（抛错而非静默），调用方按错误处理即可 |
| crypto | 无差异 | ✅ | expo-crypto（WebCrypto 语义）+ @noble/*（纯 JS，同一实现），哈希/随机/UUID/AES-GCM/PBKDF2 三端结果一致 |
| sharing | web 依赖 Web Share API | ✅ | **已用代码弥补**：Web Share API 不可用时自动回退浏览器下载（fetch 内容 → anchor download），调用方无需分支 |
| web-browser | web=新标签页 | 🟡 | 打开一致；auth 会话 web 端无跳回捕获，**OAuth 流程 web 需走重定向模式**（features 层决策） |
| linking | web scheme=页面 origin | 🟡 | openURL/canOpenURL/parse 一致；canOpenURL web 恒 true 倾向，深链测试以真机为准 |
| socket（service） | web WebSocket 不允许自定义头 | 🟡 | native 经 options 携带自定义头；web 端 `headers` 被忽略——需要鉴权时调用方把凭据拼入 URL（行为已文档化，调用方无需分支） |

## 维护规则

1. core 模块新增"平台分支"代码时，必须在本表登记为 ✅ 或 🟡（禁止未登记的静默分支）。
2. 🔴 项是产品决策输入：功能设计阶段就要规避（如 web 端不承诺后台定位）。
3. 升级 Expo SDK 后重跑本表（重点：sqlite/notifications/web 三件套的 web 行为）。
