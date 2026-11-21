import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SearchResultsScreen, type SearchSpec } from '@/features/archive';

/**
 * 搜索结果路由（/search-results/[spec]）：路径参数传检索规格（web push 丢
 * query，见 AGENTS.md 偏差表——跨屏传参一律路径参数）。spec 段取值二选一：
 *
 * - `all`：全量口径（不限关键词、时间与状态）；
 * - `encodeURIComponent(JSON.stringify({ q, from?, to? }))`：显式检索规格。
 *
 * 解码注记：expo-router 对路径参数自动 decode 一次，这里**不再二次 decode**
 * （规格里含 '%' 字符时二次 decode 会坏数据）；仅当 JSON 直解失败（疑似到达
 * 时仍带编码）才试一次 decode 后再解，仍失败防御性回退全量口径（浏览语义下
 * 无数据完整性风险，不红屏）。
 */
export default function SearchResultsRoute() {
    const { spec } = useLocalSearchParams<{ spec: string }>();
    // 解析结果按 spec 段 memo：段不变则引用稳定，结果屏 effect 不重跑
    const parsed = useMemo(() => parseSearchSpec(spec), [spec]);
    return <SearchResultsScreen spec={parsed} />;
}

/** 字段归一（防御脏值：类型不符/空串一律回退默认，规格损坏不红屏）。 */
function normalizeSpec(value: Partial<SearchSpec> | null): SearchSpec {
    if (!value) return { q: '' };
    return {
        q: typeof value.q === 'string' ? value.q : '',
        from: typeof value.from === 'string' && value.from ? value.from : undefined,
        to: typeof value.to === 'string' && value.to ? value.to : undefined,
    };
}

function parseSearchSpec(raw: string | undefined): SearchSpec {
    if (!raw || raw === 'all') return { q: '' };
    try {
        return normalizeSpec(JSON.parse(raw) as Partial<SearchSpec>);
    } catch {
        try {
            // 到达时仍带编码（router 未 decode 的环境差异兜底）：decode 一次再解
            return normalizeSpec(JSON.parse(decodeURIComponent(raw)) as Partial<SearchSpec>);
        } catch {
            // 防御性回退：损坏的 spec（手工输入 URL / 编码丢失）按全量口径展示
            return { q: '' };
        }
    }
}
