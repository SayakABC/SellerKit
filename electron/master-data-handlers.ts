// electron/master-data-handlers.ts
// 主数据域（S0a / R1）的渲染层 IPC —— 字典面（颜色 / 尺码）。
//
// 为什么单开一段而不是塞进 product-handlers：字典的 owner 是 master-data 域
// （C1 单点写入），产品/订单/归类都只是消费者。通道名以 `md-` 开头，按域可数。
//
// 写入口只有一条 `md-color-create`：用户口径（2026-10-30）「如果不存在颜色，可以在
// 常用色后面新增颜色」—— 新增的是**主数据**（`md_colors`），不是某个款的色卡；
// 加完这一色在任何页面（产品矩阵 / 归类核对）都能选到。
// 其余写入仍由业务写路径调用 `ensureColorId` / `ensureSizeId` / `setColorAlias`
// （建 SKU、认款时顺带补字典）。**不让渲染层随便改名字/禁用色**：那会把大小写变体
// 和"想临时删掉一色"写进主数据，而字典是全局的。
//
//   md-color-list      颜色字典（启用中，按 sort_order；hex 空串 = 没有标准色值）
//   md-color-create    新增颜色（幂等：同名返回既有行；只写字典，不动任何款）
//   md-color-update-hex 更新某个字典色的色块 hex（只改显示，不改名字）
//   md-color-board     颜色板（字典 ∪ 业务表里出现过的色名 + 用量）
//   md-color-merge     颜色合并（源色整体并进保留色；跨域改写见 `color-merge.ts`）
//   md-size-list       尺码字典（启用中，含别名，供"输入 L码 也认成 L"的提示）

export {};

const md = require('./master-data-db') as typeof import('./master-data-db');
const colorMerge = require('./color-merge') as typeof import('./color-merge');
const { handle } = require('./ipc-util') as typeof import('./ipc-util');

// 颜色字典（SKU 矩阵的「颜色工作台」与归类页的色卡都从这里取"现有的颜色"）
handle('md-color-list', () => {
  md.ensureMasterDataSchema();
  return { colors: md.colorList() };
});

/**
 * 新增颜色（「常用色」末尾那个「＋ 新增颜色」）。
 *
 * ⚠️ 只接受**像颜色的名字**：纯数字（平台色号 `1`..`15`）不是颜色，是"还没定色"的证据
 *    —— 与种子口径一致（`COLOR_SEEDS` 刻意不播数字色）。放进来会让"未分类"变成主数据，
 *    下一次再也没法靠数字色辨认"这行还没认"。
 * ⚠️ 幂等：同名已存在时 `ensureColorId` 返回既有行（`created:false`），界面把它当"加好了"
 *    即可 —— 重复点两次不该多出一行，也不该报错。
 */
handle('md-color-create', (payload: any) => {
  md.ensureMasterDataSchema();
  const name = String(payload?.name ?? '').trim();
  const hex = String(payload?.hex ?? '').trim();
  if (!name) throw new Error('颜色名不能为空');
  if (name.length > 40) throw new Error('颜色名太长（最多 40 个字）');
  if (/^\d+$/.test(name)) throw new Error('数字色号不是颜色名（先认成具体的颜色）');
  const res = md.ensureColorId(name, hex);
  // `color` 允许为 null（字典被清空/无 Electron 环境）：界面据此把名字先放进本地列表，
  // 下一次 `md-color-list` 再对齐 id/hex。
  return { color: md.colorById(res.id) ?? null, created: res.created };
});

/**
 * 更新某个字典色的色块 hex。
 *
 * 为什么只开 hex、不开改名：名字是业务身份（SKU 编码 / 款色行 / 别名都引用它），
 * 改错一个字会牵一发动全身；hex 只是"显示成什么颜色"，用户看到色块不对可以单独修。
 * 空 hex 表示"这个色没有标准色值"（`印花多色` 一类）。
 */
handle('md-color-update-hex', (payload: any) => {
  md.ensureMasterDataSchema();
  const id = Number(payload?.id) || 0;
  const hex = String(payload?.hex ?? '').trim();
  const r = md.updateColorHex(id, hex);
  return { color: md.colorById(r.id) ?? null };
});

/**
 * 颜色板：「颜色管理」页签的列表（字典色 + 只在业务表里出现的色）。
 * 编排在 `color-merge.ts`（跨订单域 / 产品域 / 主数据域，不收进任何一个 `-db`）。
 */
handle('md-color-board', () => colorMerge.colorBoard());

/**
 * 颜色合并：把源色整体并进保留色（拖一行到另一行松手）。
 * ⚠️ 这会**真改业务数据**（款色 / 产品 SKU / 别名都归到保留色），不是只记别名。
 * 校验与拒绝路径在主进程（`mergeColors`），渲染层只负责"拖给谁"。
 */
handle('md-color-merge', (payload: any) => {
  const source = String(payload?.source ?? '');
  const target = String(payload?.target ?? '');
  return { result: colorMerge.mergeColors(source, target) };
});

// 尺码字典（含别名；归一仍由主进程 `ensureSizeId` 做，渲染层不自己猜）
handle('md-size-list', () => {
  md.ensureMasterDataSchema();
  return { sizes: md.sizeList() };
});
