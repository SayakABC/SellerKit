// src/core/services/colorDict.ts
// 颜色字典的**渲染层单一副本** + 唯一新增入口。
//
// 为什么要有这一层（2026-10-30 用户口径「这可以做成通用的页面或方法，可供产品编辑页和
// 归类核对页使用」）：色名从"可手打"改成"只能从常用色里挑"之后，两个页面都需要同一份
// 颜色清单与同一套色块规则。如果各自 `mdColorList()` 一份：
//   ① 在 A 页新增的颜色，B 页要等刷新才看见（同一进程里两份快照互相打架）；
//   ② 色块取值的优先级（字典 hex > 内置词表）会在两个实现里慢慢漂移。
// 因此这里只有**一个模块级 `ref`**，两个页面都读它；新增走 `addColorToDict` 一条路。
//
// 与主数据的边界：本文件**不做业务校验决策**（空名/纯数字/超长的权威判定在
// `md-color-create`），这里只把明显不合法的输入挡在 IPC 前面、把主进程的错误文案交给界面。

import { computed, ref } from 'vue';
import { mdColorCreate, mdColorList } from './ipc';
import { COMMON_COLORS, findSwatch } from '@/lib/colorSwatch';

export interface ColorDictItem {
  /** `md_colors.id` —— SKU 编码里的 `{color}` 用它（色名会被归类改名，id 不会） */
  id: number;
  name: string;
  hex: string;
}

/** 模块级单例：所有页面共享同一份颜色清单 */
const items = ref<ColorDictItem[]>([]);
let loadedOnce = false;
let inflight: Promise<void> | null = null;

/** 只读的字典条目（色点用 `colorSwatchOf`，不要直接读 hex —— 可能为空） */
export function colorDictItems() {
  return items;
}

/**
 * 载入字典（幂等；并发调用共享一个请求）。
 * @param force true = 忽略"已载入"标记重新拉一次（字典在其他页面被改动后对齐用）
 */
export async function loadColorDict(force = false): Promise<void> {
  if (inflight) return inflight;
  if (loadedOnce && !force) return;
  inflight = (async () => {
    try {
      const res = await mdColorList();
      if (!res.success) return;
      const rows = res.data?.colors ?? [];
      items.value = rows
        .map((c) => ({
          id: Number(c.id) || 0,
          name: String(c.name ?? '').trim(),
          hex: String(c.hex ?? '').trim(),
        }))
        .filter((c) => !!c.name);
      loadedOnce = true;
    } catch {
      // 无 Electron / 库被清空：保持空列表，`colorDictNames` 会回落到内置常用色，
      // 界面仍可用（只是色块靠 `findSwatch` 认）。
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 常用色条要展示的色名。
 *
 * 字典为空（首次加载失败 / 没跑 Electron）时回落到 `COMMON_COLORS` —— 不能让色条整排消失：
 * 用户要靠它加色/归类，"空的不如内置的"。
 *
 * ⚠️ 回落表与字典种子**不是同一套写法**（回落是 `黑`/`白`/`灰`，字典种子是 `黑色`/`白色`/`灰色`）。
 *    所以"能不能在这里点一个色**落成款色/SKU**"必须再看 `colorDictLoaded`：
 *    在回落态下点一个「黑」，写进库的就是一个字典里没有的款色 —— 颜色库从此多一份重复。
 */
export const colorDictNames = computed<string[]>(() =>
  items.value.length ? items.value.map((c) => c.name) : [...COMMON_COLORS]
);

/**
 * 字典**真的读到了**（不是回落表）。
 *
 * 给"点了会落库"的界面用：回落表只是"让人看得见颜色长什么样"，拿它当色名写进业务表就是造假数据。
 * 读不到时（接口失败 / 非 Electron）保持 false，界面据此**不给写入口**并说明原因，
 * 而不是拿内置词表顶着 —— 静默造重复比少一个按钮更难查。
 */
export const colorDictLoaded = computed<boolean>(() => items.value.length > 0);

/**
 * 色名 → 字典 id（**0 = 不在字典**：还没归类的异写色，或字典尚未载入）。
 *
 * 唯一读者是 SKU 编码规则：`{color}` 要渲染成**颜色 ID** 而不是色名 ——
 * 色名是标签，会被「归类」改名（`藏蓝` → `藏青`），改名之后编码就跟实际色对不上了；
 * id 是主数据身份，改名不动它。拿不到 id 时由调用方回落到色名（见 `renderSkuCode`）。
 */
export function colorIdOf(color: string): number {
  const name = String(color ?? '').trim();
  if (!name) return 0;
  return items.value.find((c) => c.name === name)?.id ?? 0;
}

/** 色点名 → 色值（字典 hex 优先，其次内置词表；认不出返回 null，界面不画色块） */
export function colorSwatchOf(color: string): string | null {
  const name = String(color ?? '').trim();
  if (!name) return null;
  const hit = items.value.find((c) => c.name === name);
  if (hit?.hex) return hit.hex;
  return findSwatch(name);
}

export interface AddColorResult {
  ok: boolean;
  /** 落进字典后的规范名（成功后可能与输入同形） */
  name: string;
  /** 是否新建（false = 字典里本来就有，幂等） */
  created?: boolean;
  /** 失败原因（直接展示给用户，来自主进程校验） */
  error?: string;
}

/**
 * 新增颜色到字典（「常用色」末尾的「＋ 新增颜色」）。
 *
 * ⚠️ 只写 `md_colors`，**不给当前款/当前行加色**：加完这一色之后用户自己点它（加一行）
 *    或把已有色拖上去（归类）—— "点了新增就偷偷多一色"是更难撤销的意外。
 */
export async function addColorToDict(raw: string, hexHint = ''): Promise<AddColorResult> {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, name, error: '颜色名不能为空' };
  if (name.length > 40) return { ok: false, name, error: '颜色名太长（最多 40 个字）' };
  if (/^\d+$/.test(name)) {
    return { ok: false, name, error: '数字色号不能当颜色名（先对照图认成具体的颜色）' };
  }
  // 调用方显式给了 hex（颜色管理页的取色器）就用它；否则沿用内置词表认一个，认不出留空。
  const hex = String(hexHint ?? '').trim() || findSwatch(name) || '';
  try {
    const res = await mdColorCreate({ name, hex });
    if (!res.success) return { ok: false, name, error: res.error || '新增颜色失败' };
    const color = res.data?.color;
    // 字典此前为空（无 Electron / 被清库）时先把内置常用色铺进本地列表，
    // 否则第一次新增会让色条缩成"只剩新加的这一色"。
    if (!items.value.length) {
      // id = 0：这些是内置兜底色，库里并没有对应的 `md_colors` 行 —— 编码里拿不到 id 就回落色名。
      items.value = COMMON_COLORS.map((n) => ({ id: 0, name: n, hex: findSwatch(n) ?? '' }));
    }
    const finalName = color?.name ? String(color.name).trim() : name;
    const next: ColorDictItem = {
      id: Number(color?.id) || 0,
      name: finalName,
      hex: String(color?.hex ?? ''),
    };
    const at = items.value.findIndex((c) => c.name === finalName);
    if (at >= 0) items.value[at] = next;
    else items.value = [...items.value, next];
    loadedOnce = true;
    return { ok: true, name: finalName, created: res.data?.created !== false };
  } catch (err: any) {
    return { ok: false, name, error: err?.message || '新增颜色失败' };
  }
}
