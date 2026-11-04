/**
 * lucide / morphicons 适配层：现成图标集归拢到本基座，业务层不直接 import 第三方图标包。
 *
 * ⚠️ 一律用 per-icon 深路径（`lucide-react-native/icons/<name>`）：
 * 每个文件同时导出 `default`（静态组件）与 `__iconData.node`（morphicons 形变所需
 * 的 [tag, attrs] 节点）。整包桶导入会把全部 2000 个图标拖进 bundle（实测 +5MB），
 * sideEffects:false 也没能被 Metro 摇掉——禁止改回桶导入。
 *
 * 1.64 命名注意：House（原 Home）、Trash（原 Trash-2）。新图标先确认
 * `node_modules/lucide-react-native/dist/esm/icons/<name>.mjs` 存在再加。
 */
import House from 'lucide-react-native/icons/house';
import Search from 'lucide-react-native/icons/search';
import Trash from 'lucide-react-native/icons/trash';
import Plus from 'lucide-react-native/icons/plus';
import Pencil from 'lucide-react-native/icons/pencil';
import Check from 'lucide-react-native/icons/check';
import X from 'lucide-react-native/icons/x';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import Settings from 'lucide-react-native/icons/settings';
import User from 'lucide-react-native/icons/user';
import Bell from 'lucide-react-native/icons/bell';
import Calendar from 'lucide-react-native/icons/calendar';
import Camera from 'lucide-react-native/icons/camera';
import Image from 'lucide-react-native/icons/image';
import Mic from 'lucide-react-native/icons/mic';
import Send from 'lucide-react-native/icons/send';
import FlaskConical from 'lucide-react-native/icons/flask-conical';
import Dices from 'lucide-react-native/icons/dices';
import Shapes from 'lucide-react-native/icons/shapes';
import Sparkles from 'lucide-react-native/icons/sparkles';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Video from 'lucide-react-native/icons/video';
import Play from 'lucide-react-native/icons/play';
import BookOpen from 'lucide-react-native/icons/book-open';
import TrendingUp from 'lucide-react-native/icons/trending-up';
import Clock from 'lucide-react-native/icons/clock';

import {
    __iconData as houseData,
} from 'lucide-react-native/icons/house';
import {
    __iconData as searchData,
} from 'lucide-react-native/icons/search';
import {
    __iconData as videoData,
} from 'lucide-react-native/icons/video';
import {
    __iconData as playData,
} from 'lucide-react-native/icons/play';
import {
    __iconData as bookOpenData,
} from 'lucide-react-native/icons/book-open';
import {
    __iconData as trendingUpData,
} from 'lucide-react-native/icons/trending-up';
import {
    __iconData as clockData,
} from 'lucide-react-native/icons/clock';
import {
    __iconData as bellData,
} from 'lucide-react-native/icons/bell';
import {
    __iconData as trashData,
} from 'lucide-react-native/icons/trash';
import {
    __iconData as plusData,
} from 'lucide-react-native/icons/plus';
import {
    __iconData as pencilData,
} from 'lucide-react-native/icons/pencil';

export {
    House as LucideHome,
    Search as LucideSearch,
    Trash as LucideTrash,
    Plus as LucidePlus,
    Pencil as LucidePencil,
    Check as LucideCheck,
    X as LucideClose,
    ChevronLeft as LucideBack,
    Settings as LucideSettings,
    User as LucideUser,
    Bell as LucideBell,
    Calendar as LucideCalendar,
    Camera as LucideCamera,
    Image as LucideImage,
    Mic as LucideMic,
    Send as LucideSend,
    FlaskConical as LucideFlaskConical,
    Dices as LucideDices,
    Shapes as LucideShapes,
    Sparkles as LucideSparkles,
    ChevronRight as LucideChevronRight,
    Video as LucideVideo,
    Play as LucidePlay,
    BookOpen as LucideBookOpen,
    TrendingUp as LucideTrendingUp,
    Clock as LucideClock,};

export { MorphIcon, type MorphIconProps, type MorphHandle } from 'morphicons/react-native';

/** morphicons 的 IconNode：[tag, attrs] 二元组（lucide 节点可能带第三个 children 元素，剥掉）。 */
type MorphNode = [string, Record<string, string | number | undefined>][];
/** 结构化最小类型：不引 lucide 的类型（根包与深路径两套实例会冲突）。 */
type LucideIconData = { node: ReadonlyArray<readonly [string, ...unknown[]]> };

function toMorphNode(data: LucideIconData): MorphNode {
    return data.node.map(([tag, attrs]) => [
        tag,
        (attrs ?? {}) as Record<string, string | number | undefined>,
    ]);
}

/** 形变用节点数据（lucide 节点归一化为 morphicons 的二元组形态）。 */
const homeNode = toMorphNode(houseData);
const searchNode = toMorphNode(searchData);
const bellNode = toMorphNode(bellData);
const trashNode = toMorphNode(trashData);
const plusNode = toMorphNode(plusData);
const pencilNode = toMorphNode(pencilData);

export { homeNode, searchNode, bellNode, trashNode, plusNode, pencilNode };
