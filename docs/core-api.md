# core 接口调用文档

基础设施层，全部 Promise、三端（iOS/Android/Web）一致；错误契约见 [standards/error-handling.md](standards/error-handling.md)。导入一律走目录入口（`@/core/<capability>`）。

## config-store — 键值配置持久化

声明式配置 store，字段级响应式；凭据字段用 `secure` 走系统加密存储（web 为非导出 AES-GCM 信封）。

```ts
import { hatchConfig } from '@/config/hatch';
const { 'zookeeper.key': key } = hatchConfig.use();  // 组件内（响应式）
hatchConfig.update({ 'zookeeper.url': 'https://…' }); // 改（自动持久化）
hatchConfig.get()['gateway.url'];                     // 非组件读
hatchConfig.reset();
```

## database — 通用 SQL 调用接口

expo-sqlite 三端门面：同名库单例、迁移按 version 合并执行、错误统一 `DatabaseError`。

```ts
import { openDatabase } from '@/core/database';
const db = await openDatabase('app.db', { migrations: [{ version: 1, statements: ['CREATE TABLE …'] }] });
await db.run('INSERT INTO t VALUES (?, ?)', [1, 'a']);
const row = await db.getFirst<{ id: number }>('SELECT id FROM t WHERE id = ?', [1]);
const rows = await db.getAll<Row>('SELECT * FROM t');
await db.withTransaction(async () => { /* 多条语句原子执行 */ });
```

## data-store — 通用文档数据

app 生成数据的跨启动存储，一个 collection 一张命名分区（JSON 文档表）。

```ts
import { dataStore } from '@/core/data-store';
const drafts = dataStore.collection<Draft>('drafts');
await drafts.put('d1', draft);                          // { id, value, createdAt, updatedAt }
const entry = await drafts.get('d1');
await drafts.list({ limit: 20, order: 'desc' });
await drafts.remove('d1');
```

## cache-store — 通用缓存

带 TTL 的可丢弃派生数据；过期条目开库时统一清除。

```ts
import { cacheStore } from '@/core/cache-store';
await cacheStore.set('feed:home', data, { ttlMs: 3600_000 });
const cached = await cacheStore.get<Feed>('feed:home');  // 过期/缺失 → null
await cacheStore.remove('feed:home');
await cacheStore.clear('feed:');                          // 按前缀清
```

## file-storage — 通用文件调用接口

二进制/文本文件持久化，S3 风格 key（相对路径，防穿越）；checksum 三端统一 SHA-256。

```ts
import { fileStorage } from '@/core/file-storage';
await fileStorage.put('recordings/2026/a.mp4', uint8);
const bytes = await fileStorage.get('recordings/2026/a.mp4');
await fileStorage.stat('recordings/2026/a.mp4');          // { key, size, checksum, modifiedAt } | null
await fileStorage.list('recordings/');                     // 递归、字典序
const url = await fileStorage.url('recordings/2026/a.mp4');// native file:// / web blob:
fileStorage.revokeUrl(url);
await fileStorage.move('a.mp4', 'b/a.mp4'); await fileStorage.copy(…); await fileStorage.remove(…);
```

## migration — 通用迁移

数据整体打包为单个 zip 导出/导入（dataStore + fileStorage + 可选 cache），跨设备迁移三端可用。

```ts
import { migration } from '@/core/migration';
const bundle = await migration.export();                   // 默认不含缓存
const url = await migration.url(bundle.id);                // 分享/下载用
await migration.import(bundle.id);                         // 也接受 zip 字节或文件 URI
await migration.list(); await migration.remove(bundle.id);
```

## notifications — 通用通知

权限、本地调度、推送 token、Android 渠道（其他平台空操作）、前台展示行为。

```ts
import { notifications } from '@/core/notifications';
await notifications.requestPermission();
const id = await notifications.schedule({ title: '…', body: '…' }, { type: SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 60 });
await notifications.cancel(id);
notifications.setHandler({ handleNotification: async () => ({ shouldAlert: true, shouldPlaySound: false, shouldSetBadge: false }) });
const sub = notifications.onResponse((response) => {…}); sub.remove();
```

## crypto — 加密/随机

哈希、随机、UUID（expo-crypto）+ AES-256-GCM 加解密与 PBKDF2 派生（@noble/*，三端密文互解）。

```ts
import { crypto } from '@/core/crypto';
crypto.randomUUID(); const bytes = await crypto.getRandomBytesAsync(32);
await crypto.digestStringAsync(CryptoDigestAlgorithm.SHA256, text);
const key = await crypto.generateKey();                     // 32B AES-256
const sealed = await crypto.encryptText(key, '机密');        // base64 信封，可存 config/dataStore
const plain  = await crypto.decryptText(key, sealed);
```

## icons — 图标/logo 基础设施

三层来源统一基座：**内置手绘**（8 个线性图标）、**lucide 现成集**（per-icon 深路径，2000+ 可选）、**createIcon 自定义**；动效三件套：BouncyPressable 弹跳、GradientCycle 循环变色渐变、MorphIcon spring 形变（lucide 节点间变形）。

```ts
import { NoteIcon, LucideCalendar, createIcon, MorphIcon, homeNode, searchNode, BouncyPressable, GradientCycle, HatchLogo } from '@/core/icons';
<NoteIcon size={24} color="#10b981" />                    // 内置手绘
<LucideCalendar size={24} color="#10b981" />              // lucide 现成（size/color/strokeWidth 同契约）
<MorphIcon icon={homeNode} size={48} spring="snappy" />   // 形变：icon 换成 searchNode 即 spring 变形
const MyIcon = createIcon(<Path d="…" />);                 // 自定义 SVG
<BouncyPressable onPress={…}><MyIcon /></BouncyPressable>  // 弹跳按压
<GradientCycle width={320} height={8} borderRadius={4} />  // 流动 6 色渐变
<HatchLogo size={112} />                                   // 启动 Logo（手绘蛋 + GPU 外流动渐变）
```

> 加新 lucide 图标：确认 `lucide-react-native/dist/esm/icons/<name>.mjs` 存在后，在 `core/icons/lucide.tsx` 加一条深路径导入（禁桶导入，实测 +5MB）。

## camera / location / audio / video / image-picker / clipboard / sharing / web-browser / linking

Expo 设备能力薄封装（透传 expo 错误，不吞错）；取景/画面等 UI 组件归 features 层。

```ts
import { camera, location, imagePicker, clipboard, sharing, webBrowser, linking, audio, video } from '@/core/*';
(await camera.requestPermissionAsync()).granted;
await location.getCurrentPositionAsync({});                 // getLastKnownPositionAsync web 恒 null
await imagePicker.launchImageLibraryAsync({ quality: 0.8 });// { canceled, assets }
await clipboard.setStringAsync('text');
await audio.setAudioModeAsync({ playsInSilentMode: false });
video.createVideoPlayer(source);
const result = await imagePicker.launchCameraAsync({});
if (await sharing.isAvailableAsync()) await sharing.shareAsync(uri);  // web 自动回退下载
await webBrowser.openBrowserAsync('https://…');
linking.createURL('path', { queryParams: { a: '1' } }); await linking.openURL(url);
```
