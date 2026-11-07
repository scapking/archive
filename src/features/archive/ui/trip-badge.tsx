import { Text, View } from 'react-native';
import { Circle, Path, Rect } from 'react-native-svg';
import { createIcon, LucideCamera, type IconProps } from '@/core/icons';
import { usePalette } from './theme';

/**
 * TripBadge：行程图标的唯一呈现组件（deck 中卡 / detail 头部 / form 选择格三档共用）。
 *
 * 数据契约：`trip.icon` 存 **emoji 字符串**（TEXT 列，保持历史语义不变，零迁移）。
 * 呈现规则（收口在本组件，调用处禁止再散写 `?? '🧭'` 空值兜底）：
 * 1. 已知 emoji → 线性徽标图形（几何固化自 lucide 1.64，stroke 1.9 与全仓图标口径一致，
 *    颜色走 ink/inkd 语义色：常态 secondary、选中 accent——颜色只上数据/状态，不上装饰）；
 * 2. 未知历史值（旧数据如 🐼）→ emoji 原样兜底渲染，绝不丢用户数据；
 * 3. 空值 → 渲染默认图形（TRIP_ICON_DEFAULT 的线性版），新行程的初始图标由此单点决策。
 *
 * 容器口径：rounded-card（16）+ 1px ink-border + ink-surface 底，双主题 token 成对；
 * 禁 shadow（卡片体系无阴影）。按压反馈不由本组件负责（属 BouncyPressable / active: 体系）。
 *
 * ⚠️ deck（archive-screen TripCard）本轮尚未接入：仍裸渲染 `{trip.icon ?? '🧭'}` 文本。
 * 数据仍是 emoji，故 deck 显示正确不回归；接入只需一行——
 * `<TripBadge icon={trip.icon} size="deck" />` 替换 archive-screen.tsx 中的裸 Text。
 */

/** 新行程默认图标（显式具名常量：不再是「空值兜底」或「隐式取第一个」的机制产物）。 */
export const TRIP_ICON_DEFAULT = '🧭';

/** 行程徽标图形的最小契约（createIcon 自定义图标与 lucide 组件都满足）。 */
type TripGlyph = React.ComponentType<IconProps>;

/* ------------------------------------------------------------------ */
/* 图形注册表                                                          */
/* ------------------------------------------------------------------ */
/* 几何固化自 lucide 1.64 同名图标（ISC License），经 createIcon（core/icons
 * 三层来源的「自定义」层）落地——维持 glossary §icons「业务层不直接 import 第三方
 * 图标包」的收口纪律；path 数据体量 ~3KB，无整包引入的 bundle 风险。
 * 增删图标前先查 node_modules/lucide-react-native/dist/esm/icons/<name>.mjs 再回填。 */

const CompassGlyph = createIcon(
    <>
        <Circle cx={12} cy={12} r={10} />
        <Path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
    </>,
);

const MountainGlyph = createIcon(<Path d="m8 3 4 8 5-5 5 15H2L8 3z" />);

const WavesGlyph = createIcon(
    <>
        <Path d="M2 12q2.5 2 5 0t5 0 5 0 5 0" />
        <Path d="M2 19q2.5 2 5 0t5 0 5 0 5 0" />
        <Path d="M2 5q2.5 2 5 0t5 0 5 0 5 0" />
    </>,
);

const LandmarkGlyph = createIcon(
    <>
        <Path d="M10 18v-7" />
        <Path d="M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z" />
        <Path d="M14 18v-7" />
        <Path d="M18 18v-7" />
        <Path d="M3 22h18" />
        <Path d="M6 18v-7" />
    </>,
);

const BuildingGlyph = createIcon(
    <>
        <Path d="M12 10h.01" />
        <Path d="M12 14h.01" />
        <Path d="M12 6h.01" />
        <Path d="M16 10h.01" />
        <Path d="M16 14h.01" />
        <Path d="M16 6h.01" />
        <Path d="M8 10h.01" />
        <Path d="M8 14h.01" />
        <Path d="M8 6h.01" />
        <Path d="M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
        <Rect x={4} y={2} width={16} height={20} rx={2} />
    </>,
);

const CarFrontGlyph = createIcon(
    <>
        <Path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8" />
        <Path d="M7 14h.01" />
        <Path d="M17 14h.01" />
        <Rect width={18} height={8} x={3} y={10} rx={2} />
        <Path d="M5 18v2" />
        <Path d="M19 18v2" />
    </>,
);

const PlaneTakeoffGlyph = createIcon(
    <>
        <Path d="M2 22h20" />
        <Path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z" />
    </>,
);

const TrainFrontGlyph = createIcon(
    <>
        <Path d="M8 3.1V7a4 4 0 0 0 8 0V3.1" />
        <Path d="m9 15-1-1" />
        <Path d="m15 15 1-1" />
        <Path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z" />
        <Path d="m8 19-2 3" />
        <Path d="m16 19 2 3" />
    </>,
);

const TentTreeGlyph = createIcon(
    <>
        <Circle cx={4} cy={4} r={2} />
        <Path d="m14 5 3-3 3 3" />
        <Path d="m14 10 3-3 3 3" />
        <Path d="M17 14V2" />
        <Path d="M17 14H7l-5 8h20Z" />
        <Path d="M8 14v8" />
        <Path d="m9 14 5 8" />
    </>,
);

const UtensilsGlyph = createIcon(
    <>
        <Path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
        <Path d="M7 2v20" />
        <Path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </>,
);

const FerrisWheelGlyph = createIcon(
    <>
        <Circle cx={12} cy={12} r={2} />
        <Path d="M12 2v4" />
        <Path d="m6.8 15-3.5 2" />
        <Path d="m20.7 7-3.5 2" />
        <Path d="M6.8 9 3.3 7" />
        <Path d="m20.7 17-3.5-2" />
        <Path d="m9 22 3-8 3 8" />
        <Path d="M8 22h8" />
        <Path d="M18 18.7a9 9 0 1 0-12 0" />
    </>,
);

const SnowflakeGlyph = createIcon(
    <>
        <Path d="m10 20-1.25-2.5L6 18" />
        <Path d="M10 4 8.75 6.5 6 6" />
        <Path d="m14 20 1.25-2.5L18 18" />
        <Path d="m14 4 1.25 2.5L18 6" />
        <Path d="m17 21-3-6h-4" />
        <Path d="m17 3-3 6 1.5 3" />
        <Path d="M2 12h6.5L10 9" />
        <Path d="m20 10-1.5 2 1.5 2" />
        <Path d="M22 12h-6.5L14 15" />
        <Path d="m4 10 1.5 2L4 14" />
        <Path d="m7 21 3-6-1.5-3" />
        <Path d="m7 3 3 6h4" />
    </>,
);

const TreePalmGlyph = createIcon(
    <>
        <Path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4" />
        <Path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3" />
        <Path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35" />
        <Path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14" />
    </>,
);

const LuggageGlyph = createIcon(
    <>
        <Path d="M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2" />
        <Path d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14" />
        <Path d="M10 20h4" />
        <Circle cx={16} cy={20} r={2} />
        <Circle cx={8} cy={20} r={2} />
    </>,
);

const MapPinnedGlyph = createIcon(
    <>
        <Path d="M18 8c0 3.613-3.869 7.429-5.393 8.795a1 1 0 01-1.214 0C9.87 15.429 6 11.613 6 8a6 6 0 0112 0" />
        <Path d="M4.474 15h-.197a1 1 0 00-.969.753l-1.097 4.35a1.5 1.5 0 001.444 1.898L20.344 22a1.5 1.5 0 001.446-1.897l-1.098-4.35a1 1 0 00-.969-.753h-.197" />
        <Circle cx={12} cy={8} r={2} />
    </>,
);

/** emoji → 线性图形映射（键即 DB 存储值；选择格的候选集见 trip-form-screen 的 ICON_CHOICES）。 */
const TRIP_GLYPHS: Record<string, TripGlyph> = {
    [TRIP_ICON_DEFAULT]: CompassGlyph,
    '⛰️': MountainGlyph,
    '🌊': WavesGlyph,
    '🏛️': LandmarkGlyph,
    '🏙️': BuildingGlyph,
    '🚗': CarFrontGlyph,
    '✈️': PlaneTakeoffGlyph,
    '🚄': TrainFrontGlyph,
    '🏕️': TentTreeGlyph,
    '🍜': UtensilsGlyph,
    '📷': LucideCamera,
    '🎡': FerrisWheelGlyph,
    '⛷️': SnowflakeGlyph,
    '🏝️': TreePalmGlyph,
    '🧳': LuggageGlyph,
    '🗺️': MapPinnedGlyph,
};

/* ------------------------------------------------------------------ */
/* 尺寸分档                                                            */
/* ------------------------------------------------------------------ */

/** 三档尺寸：deck 中卡（56）/ detail 头部（40）/ form 选择格（44，与 h-11 选择格等大）。 */
const BADGE_SIZES = {
    deck: { box: 56, glyph: 28, emoji: 28 },
    detail: { box: 40, glyph: 22, emoji: 22 },
    cell: { box: 44, glyph: 20, emoji: 20 },
} as const;

export type TripBadgeSize = keyof typeof BADGE_SIZES;

export function TripBadge({
    icon,
    size = 'detail',
    selected = false,
}: {
    /** trip.icon 原始值（emoji；null/undefined/'' 走默认图形）。 */
    icon?: string | null;
    size?: TripBadgeSize;
    /** 选择格选中态：accent 框 + accent 底 + accent 图形（条件类两侧变量集恒等）。 */
    selected?: boolean;
}) {
    const palette = usePalette();
    const token = BADGE_SIZES[size];
    const mapped = icon ? TRIP_GLYPHS[icon] : undefined;
    // 空值 → 默认图形（唯一兜底点）；未知历史 emoji → 原样渲染，不丢数据
    const Glyph = mapped ?? TRIP_GLYPHS[TRIP_ICON_DEFAULT];

    return (
        // 条件类铁律：两分支变量集恒等（items/rounded/border/bg × light/dark 同槽位）
        <View
            style={{ width: token.box, height: token.box }}
            className={
                selected
                    ? 'items-center justify-center rounded-card border border-ink-accent bg-ink-accent-bg dark:border-inkd-accent dark:bg-inkd-accent-bg'
                    : 'items-center justify-center rounded-card border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface'
            }
        >
            {icon && !mapped ? (
                // 历史遗留未知 emoji：原样兜底（emoji 自带色；text 色仅为单色呈现环境兜底）
                <Text
                    className="text-ink-text dark:text-inkd-text"
                    style={{ fontSize: token.emoji, lineHeight: token.emoji + 2 }}
                >
                    {icon}
                </Text>
            ) : (
                <Glyph
                    size={token.glyph}
                    strokeWidth={1.9}
                    color={selected ? palette.accent : palette.secondary}
                />
            )}
        </View>
    );
}
