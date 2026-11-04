# 术语表（Glossary）

本表是全部规范的地基。**每个术语在本项目中只有一个含义**；文档、目录名、代码标识符使用这些术语时，必须与本表一致。两个相近术语的边界一律以本表"判定"一栏为准，不得按个人理解解释。

## 1. 业务域（Business Domain）

业务域按登记制管理：新增域必须先在此表登记，不得未登记先建目录。当前登记一个：

| 域名 | 含义 |
|---|---|
| `archive` | Archive 应用自身（行程 × 日记，local-first 纯前端工具）的全局业务域：app 级配置与编排入口 |

> `almightydb` **不是业务域**：它是本地存储基础设施，见 §3 登记表。
> 模板品牌资产（core 内 `hatch-logo` / `HATCH_PALETTE`）随 mobile 模板原样继承，不构成业务域。

**判定**：`ls src/config` 与 `ls src/features` 出现的目录名 ∈ {archive}。

## 2. 数据形态（Data Kind）

一条数据属于哪种形态，按下表**自上而下首次匹配**判定（先判是不是文件，再判是不是配置，以此类推）：

| 术语 | 唯一定义 | 存放位置 | 技术实现 | 禁止 |
|---|---|---|---|---|
| 用户文件 user file | 运行时产生或下载的**二进制文件内容**（mp4 / jpg / pdf / zip…） | `src/core/file-storage/` | expo-file-system（File/Directory，web=OPFS） | 禁止进 config-store / AsyncStorage / sqlite；禁止 base64 塞进任何键值存储 |
| app 生成数据 generated data | 运行时由 app 产生、**需跨启动保留**的结构化数据（记录、草稿、消息体…） | `src/core/data-store/`（文档型）；确有复杂关系模型时经 `src/core/database/` 自建表 | expo-sqlite | 禁止塞 AsyncStorage；"连哪里、开不开什么"才是 config，两者不得互换 |
| 静态资产 asset | **打包期**随 app 分发的只读文件（字体、图标、启动图） | `src/assets/<kind>/` | expo-asset | 运行时生成的文件不是 asset |
| 配置 config | **标量键值对**（string / number / boolean / 扁平小对象），描述"程序连哪里、开不开什么" | `src/config/<domain>/` | createConfigStore（zustand persist + AsyncStorage） | 禁止存文件内容、业务数据、纯 UI 临时状态 |
| 会话状态 state | 运行时内存中的响应式数据，随会话生命周期存亡 | 所属 feature 内部 zustand store | zustand | 需要跨启动保留的 state 应重新归类为 generated data 或 config |
| 缓存 cache | 可随时丢弃、可从源头重建的派生数据 | 内存 / react-query；需跨启动的落 `src/core/cache-store/` | react-query / cache-store | 禁止把缓存当 config 持久化 |
| 密钥 secret | 属于凭据的配置字段（key / token / password） | 归入 config，但实现**必须**走加密存储 | SecureStore（经 core/config-store 的 `secure` 选项） | web 端回退 localStorage（保密强度有限，已注明） |

**判定示例**（消除"a 理解为 X、b 理解为 Y"）：

- 录制的 mp4 → 是文件内容 → user file → file-storage。**不因"它是录制设置的一部分"而进 config**。
- 聊天草稿、生成的报告记录 → 需跨启动保留的结构化数据 → generated data → data-store。
- `zookeeperUrl`（字符串，指到哪）→ config。
- `zookeeperKey`（凭据）→ config + secret 实现要求。
- 列表页加载的数据 → state / cache，不是 config。

## 3. 基础设施（Infrastructure，`src/core/`）

core 是**通用能力接口层**：把 Expo 提供的三端（iOS/Android/Web）设备与系统能力，按"一个能力一个目录 + `index.ts` 收口"统一封装。选型铁律：**只封装 Expo 官方支持且三端可用的模块**（web 构建文件存在为准）；纯 UI 组件（CameraView/VideoView/Image/WebView 等）不进 core，归 React/features 层。

**命名与后缀**：存储型能力用后缀锁定语义——`-store` = 键值型数据，`-storage` = 二进制文件，两者禁止互换；非存储型能力用单一名词（database / notifications / camera…）。

**基础设施登记表**：core 下目录必须先登记于此再创建。新增 = 修订本文件。

| 目录 | 能力 | 底座 |
|---|---|---|
| `config-store` | 键值配置持久化（`secure` 选项声明凭据字段 → native SecureStore / web localStorage 回退） | zustand persist + AsyncStorage |
| `database` | **通用 SQL 调用接口**（同名库单例、PRAGMA user_version 迁移注册表、类型化查询） | expo-sqlite |
| `data-store` | **通用文档数据接口**（collection put/get/list/remove，app 生成数据） | 经 database |
| `cache-store` | **通用缓存接口**（TTL、前缀清除） | 经 database |
| `file-storage` | **通用文件调用接口**（S3 风格 put/putFromUri/get/stat/list/remove/move/copy/url，key 防路径穿越；checksum=三端统一 SHA-256，元数据在 file_meta 表；底座 native=expo-file-system，web=OPFS 直连——SDK 58 web 变体是纯 stub，见 web-opfs.ts） | expo-file-system（native）/ OPFS（web）+ database |
| `migration` | **通用迁移接口**（单个 zip 打包导出/导入：documents + files + 可选 cache；自研 store 模式 zip，防 zip-slip + CRC 校验，跨设备传输三端可用） | 组合上三者 + zip.ts |
| `notifications` | **通用通知接口**（权限/本地调度/push token/渠道/handler） | expo-notifications |
| `camera` | 相机权限与扫码纯函数（取景拍照走 CameraView 组件） | expo-camera |
| `location` | 前台定位、地理编码（后台定位不支持 web，未纳入） | expo-location |
| `audio` | 音频模式、播放器工厂、录音权限（录制器走 useAudioRecorder hook） | expo-audio |
| `video` | 播放器工厂、缓存管理（画面走 VideoView 组件） | expo-video |
| `image-picker` | 相册/相机选取图片视频 | expo-image-picker |
| `image-manipulator` | 图片变换（resize / 旋转 / 格式压缩）并读取结果字节（三端；变换结果常与 file-storage 配套落盘） | expo-image-manipulator + expo-file-system |
| `clipboard` | 剪贴板文本/URL/图片 | expo-clipboard |
| `crypto` | UUID、随机字节、摘要、**AES-256-GCM 加解密**（encrypt/decrypt/encryptText）、**PBKDF2 密钥派生**（deriveKey）——三端同实现（@noble/ciphers + @noble/hashes，因 Hermes 无完整 WebCrypto） | expo-crypto + @noble/* |
| `sharing` | 系统分享（web 用 isAvailableAsync 判定） | expo-sharing |
| `web-browser` | 应用内浏览器/授权会话 | expo-web-browser |
| `linking` | 深链构造/解析/监听、系统打开 URL | expo-linking + RN Linking |
| `icons` | **自绘 SVG 图标/logo 基础设施**：三层来源——内置手绘（icons.tsx）+ lucide 现成集（per-icon 深路径导入，**禁止桶导入**，实测 +5MB）+ createIcon 自定义；动效（reanimated 弹跳/呼吸）、morphicons 形变（MorphIcon spring）、循环变色渐变 GradientCycle（宿主分层，全 UI 线程） | react-native-svg + lucide + morphicons + reanimated |
| `svg` | **Skia GPU 自定义 SVG 渲染**：任意 SVG 字符串 → Skia.SVG 解析 → GPU 绘制（ImageSVG）；HatchLogoSkia 用 reanimated 派生值驱动 Skia 着色器（GPU 端色彩流动） | @shopify/react-native-skia |

> **almightydb** = 上述存储五件套（config-store / database / data-store / cache-store / file-storage / migration）的**统称**，不是目录。存储位置：文件与迁移包在 `Paths.document/almightydb/`，数据库文件 `almightydb.db`。

**判定**：core 下的目录必须出现在上表；`-store` 与 `-storage` 后缀不得互换使用；新增能力先登记本表并确认三端支持。

## 4. 层（Layer）

| 层 | 目录 | 一句话职责 |
|---|---|---|
| 路由层 | `src/app/` | expo-router 页面壳，只做导航与挂载 |
| 功能层 | `src/features/` | 业务功能（UI + 逻辑 + 对服务层/配置的编排） |
| 服务层 | `src/service/` | **通用网络传输**（post / socket，URL 与鉴权外部注入）；业务域协议客户端归 features |
| 配置层 | `src/config/` | 各业务域的配置声明 |
| 基础设施层 | `src/core/` | 与业务无关的可复用能力 |

依赖方向与判定见 [layering.md](layering.md)。

## 5. 其他锁定用语

| 用语 | 含义 | 使用处 |
|---|---|---|
| `domain` | 专指第 1 节业务域之一 | 目录占位符 `<domain>` |
| `capability` | 专指第 3 节 core 基础设施之一 | 目录占位符 `<capability>` |
| Expo 根 | `src/`（package.json 所在处，不是仓库根） | 所有命令 |
