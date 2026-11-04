import { Path } from 'react-native-svg';
import { createIcon } from './icon-base';

/**
 * 内置线性图标集：24 网格 / 2px 描边 / 圆角端点。
 * 每个都是 createIcon 的产物，支持 IconProps（size/color/strokeWidth）。
 */
export const HomeIcon = createIcon(
    <Path d="M4 11 L12 4 L20 11 V19 A1 1 0 0 1 19 20 H15 V15 H9 V20 H5 A1 1 0 0 1 4 19 Z" />,
);

export const NoteIcon = createIcon(
    <>
        <Path d="M6 3 H14 L18 7 V20 A1 1 0 0 1 17 21 H6 A1 1 0 0 1 5 20 V4 A1 1 0 0 1 6 3 Z" />
        <Path d="M14 3 V7 H18" />
        <Path d="M9 12 H15" />
        <Path d="M9 16 H13" />
    </>,
);

export const PlusIcon = createIcon(<Path d="M12 5 V19 M5 12 H19" />);

export const SearchIcon = createIcon(
    <>
        <Path d="M11 5 A6 6 0 1 0 11 17 A6 6 0 1 0 11 5 Z" />
        <Path d="M15.5 15.5 L20 20" />
    </>,
);

export const TrashIcon = createIcon(
    <>
        <Path d="M4 7 H20" />
        <Path d="M9 7 V4 H15 V7" />
        <Path d="M6 7 L7 20 H17 L18 7" />
        <Path d="M10 11 V16" />
        <Path d="M14 11 V16" />
    </>,
);

export const BackIcon = createIcon(<Path d="M14 6 L8 12 L14 18" />);

export const CheckIcon = createIcon(<Path d="M5 12 L10 17 L19 7" />);

export const CloseIcon = createIcon(<Path d="M6 6 L18 18 M18 6 L6 18" />);
