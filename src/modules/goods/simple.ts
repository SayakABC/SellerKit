// 「简洁模式」—— 面向"不太会电脑的人"的**默认形态**（2026-10-08 报告 P1-1 / 待拍板 UX-G2）。
//
// 默认**开**（报告建议 A）：目标用户就是不会电脑的人，熟练用户可一键关掉。
// 开着的时候**不渲染**：
//   · 左栏每行的勾选框 + 表头全选 + 批量条（"批量编辑 / 删除选中"是一组危险且需要先理解
//     复选框的操作，普通人误勾一次就是不可逆的物理删除）；
//   · 右栏的统计条（`PoolMetrics`：待关联 / 店铺未归一 / 已关联 / 关联率 / 映射记录）——
//     那一排数字是给"要盯指标"的人看的，新手看到的是"五项 0 和 —，这页是不是坏了"。
//
// ⚠️ 两处**刻意不隐藏**（报告原文说隐藏，这里是按本仓已有裁定改的）：
//   ① 左栏的「问题件」下拉 —— 它是「缺克重 / 未关联供应商」两个筛选的**唯一入口**
//      （2026-10-08 撤页级指标条时补进来的）。藏了它，那两个筛选就变成"界面上进不去的死能力"，
//      而这正是本仓 2026-10-08 记过的那条现行犯（"撤入口必须同时补入口"）。
//   ② 右栏队列每行的勾选框 —— 它是**认款这个核心动作**唯一的选择方式（认款 = 勾商品 → 落到款上）。
//      藏了它，简洁模式下就认不了款 —— 那是把主功能藏了，不叫简洁。
//
// ⚠️ 还有一个刻意的边界：**回退形态（`GOODS_LAYOUT='tabs'`）不参与**。那两个组件
//    （`ProductListView` / `SkuMappingView`）的契约是"模板与重构前逐字一致，回退 = 改一个常量"，
//    往里加条件渲染就把这个契约破坏了。页头的开关也只在工作台形态下渲染 ——
//    宁可不给按钮，也不给一个按下去什么都不变的按钮。
//
// 为什么是一个**模块级的共享 ref** 而不是各组件自己一份：同一个开关同时决定左栏（勾选框 / 批量条）
// 与右栏（统计条）的形态，各存一份就是"点了开关只有半页变了"——而那种半变没人会当成 bug。
import { ref, type Ref } from 'vue';

const KEY = 'sk.goods.simple';

/** 默认形态。**改这一行 = 改默认**（报告 UX-G2 的 A 选项）。 */
export const GOODS_SIMPLE_DEFAULT = true;

function read(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    // 无 storage（隐私模式 / 非浏览器环境）：按默认，不抛
  }
  return GOODS_SIMPLE_DEFAULT;
}

/** 当前形态。`true` = 简洁（默认）。 */
export const goodsSimple: Ref<boolean> = ref(read());

export function setGoodsSimple(on: boolean): void {
  goodsSimple.value = on;
  try {
    globalThis.localStorage?.setItem(KEY, on ? '1' : '0');
  } catch {
    // 存不下就只在本次会话生效 —— 不值得为此报错
  }
}
