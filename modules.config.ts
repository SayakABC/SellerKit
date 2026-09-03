// 业务模块启用清单 —— 单一事实源
//
// - profile:        默认构建预设；可由构建时的 MODULE_PROFILE 环境变量覆盖
// - profiles:       预设名 → 模块 ID 列表 的映射；决定「打哪些模块进包」
// - enabledModules: 兜底列表，当 profile 不在 profiles 中时使用
//
// 新增业务模块：1) 在 src/modules/<id>/ 下实现 meta.ts + index.ts
//               2) 在对应 profile 的数组中加入 '<id>'
// 切换打包范围：
//   - 预设：MODULE_PROFILE=minimal npm run build （或 build:minimal 脚本）
//   - 自定义清单：MODULE_IDS=excel-copy,quick-note npm run build（优先级最高）
//   - 交互式勾选：npm run dist:select（可视化选择，见 scripts/select-build.js）

export interface BuildConfig {
  profile: string;
  profiles: Record<string, string[]>;
  enabledModules: string[];
}

export const buildConfig: BuildConfig = {
  profile: 'standard',
  profiles: {
    // 最小包：仅核心 Excel 复制
    minimal: ['excel-copy'],
    // 标准包：核心 + 便签 + 订单归类（拿货对账已并入 order-insight 同页 Tab，非独立模块）
    standard: ['excel-copy', 'quick-note', 'order-insight'],
    // 完整包：全部模块
    pro: ['excel-copy', 'quick-note', 'order-insight'],
  },
  // 兜底（当 profile 未在 profiles 中匹配时使用）
  enabledModules: ['excel-copy'],
};
