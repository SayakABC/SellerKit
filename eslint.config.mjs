// SellerKit ESLint 配置（ESLint 9 flat config）
//
// 定位：把《AGENTS.md》里的**可机械判定**的红线从"人工记忆"变成"lint 拦截"，
//       首要目标是 §1.6 主题令牌纪律（禁止硬编码色值 / 调色板类）。
//
// 覆盖范围（有意收窄，避免噪声淹没真问题）：
//   ✅ src/**                渲染进程（ESM + Vue）
//   ✅ electron/**           主进程（CommonJS + TS）
//   ✅ scripts/**            构建 / 发布 / 校验脚本
//   ✅ tests/**              单元测试（vitest）
//   ✅ *.config.*            根级构建配置
//   ❌ ui-plugins/**         独立子包（各自 package.json / node_modules / tailwind 配置，
//                           在各自目录内独立构建与发布，不入宿主 bundle，故不并入本 lint 图）
//   ❌ dist / release / market-out 等构建产物
//   ❌ src/registry.generated.ts   由 vite.config.ts 自动生成，禁止手改（AGENTS.md §1.3）
//
// 存量策略（见 docs/plans/REMEDIATION_PLAN.md R2-3「风险」）：原审查报告已把
// 「硬编码色值」类问题在 R1-2 修完，故样式红线按 **error** 落地；其余由推荐规则
// 新引入的存量告警（命名风格、any 等）**降为 warn** 逐步收敛，不制造一次性巨型 diff。
// 因此 `npm run lint` 的通过标准是 **error 数 = 0**（warn 允许存在）。

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import configPrettier from 'eslint-config-prettier';
import globals from 'globals';

// ---------------------------------------------------------------------------
// 样式令牌纪律（AGENTS.md §1.6：禁止在组件中硬编码色值，一律用 var(--wb-*)）
// ---------------------------------------------------------------------------

// 颜色类涉及的工具前缀
const COLOR_UTILITIES = [
  'text',
  'bg',
  'border',
  'ring',
  'divide',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'placeholder',
  'outline',
  'caret',
  'accent',
  'decoration',
];

// Tailwind 默认调色板族（引入任一即意味着绕过了 --wb-* 令牌体系）
const PALETTE_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

const utilityGroup = COLOR_UTILITIES.join('|');
const paletteGroup = PALETTE_FAMILIES.join('|');

// Tailwind 变体前缀（hover: / dark: / sm: / group-hover: …）与 !important 修饰符，
// 二者都可叠加，且能在无令牌的色值类前出现——不先吃掉它们，`hover:text-white`
// 这类写法会整串不匹配而漏检。
const variantPrefix = '(?:!?[a-z][a-z0-9-]*:)*!?';

// 例外（有意保留，需逐处显式 eslint-disable 注释说明理由，不得写入本清单）：
//   - 图片上的半透明遮罩（bg-black/xx + text-white）依赖"黑底白字"的绝对对比，
//     与主题无关，用令牌反而无法表达。见 ProductLibraryView.vue。
const forbiddenClassPatterns = [
  // text-white / bg-black / hover:bg-black/55 / dark:border-white/20 …
  new RegExp(`^${variantPrefix}(?:${utilityGroup})-(?:white|black)(?:/\\d+)?$`),
  // text-gray-500 / hover:bg-blue-600/10 / sm:border-red-300 …
  new RegExp(`^${variantPrefix}(?:${utilityGroup})-(?:${paletteGroup})-\\d{2,3}(?:/\\d+)?$`),
  // text-[#fff] / hover:bg-[rgb(0,0,0)] 形式的任意值色
  new RegExp(`^${variantPrefix}(?:${utilityGroup})-\\[(?:#|rgb|hsl)`),
].map((re) => `/${re.source}/`);

// ⚠️ 已知覆盖边界（eslint-plugin-vue@9 的 no-restricted-class 实现限制，非本配置可解）：
//   该规则只递归解析 **字面量 / 模板字符串静态段 / 字符串拼接 / 对象静态键 / 数组元素**；
//   `ConditionalExpression`（三元）与 `LogicalExpression`（&&/||）里的类名不会被解析，例如
//     :class="ok ? 'text-white' : 'text-[var(--wb-text)]'"   ← 漏检
//   且核心规则（含 no-restricted-syntax）**看不到** `<template>` 内部（vue-eslint-parser
//   的模板 AST 不在核心遍历键内），因此无法用选择器兜底。
//   → 这是一处需要靠 code review 与 AGENTS.md §1.6 人工纪律补位的残余缺口；
//     重构 `no-restricted-class` 上游实现或升到 eslint-plugin-vue v10 前，不要在
//     三元分支里写调色板类名。

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      '.vite/**',
      'market-out/**',
      'ui-plugins/**',
      'src/registry.generated.ts',
      // 与 .gitignore 对齐：本地暂时性文件
      'debug-name.js',
    ],
  },

  // JS 基础推荐规则（配置文件 / 脚本）
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 存量脚本里的空 catch / 未用参数较多，降为 warn 逐步收敛
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // TS 推荐规则（渲染层 / 主进程 / 脚本）
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,cts,mts}'],
  })),

  // 核心 ESLint 推荐规则同样适用于 TS 文件
  // （typescript-eslint 的 recommended 只含 TS 专属规则 + 冲突关闭，不含核心规则集；
  //  不补这一层，`no-control-regex` 之类的核心规则在 .ts 里就是"永不生效"，
  //  写在 .ts 里的 eslint-disable 会退化成空转注释。）
  {
    files: ['**/*.{ts,cts,mts}'],
    rules: {
      ...js.configs.recommended.rules,
      // TS 由类型系统负责符号解析，no-undef 在 TS 上会误报（typescript-eslint 官方建议关闭）
      'no-undef': 'off',
      // 存量为 warn（同 JS 块，避免一次性大 diff）
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-vars': 'off', // 交给 @typescript-eslint/no-unused-vars
      // 与 TS 版本冲突的核心规则（typescript-eslint 推荐集已关闭，这里保持一致）
      'no-redeclare': 'off',
      'no-fallthrough': 'off',
    },
  },

  // Vue（SFC 必需规则 + 样式令牌纪律）
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // ★ 样式令牌纪律：硬编码色值 = error（AGENTS.md §1.6）
      'vue/no-restricted-class': ['error', ...forbiddenClassPatterns],
      // 存量代码中组件名为单词（ToastHost / AppShell 等已合规），降为 warn 不阻塞
      'vue/multi-word-component-names': 'warn',
      // 格式类规则交由 Prettier，此处关闭以避免与编辑器格式化打架
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
    },
  },

  // 渲染层：浏览器环境（插件包 `extensions/**` 已于 2026-09-30 随 C3 删除，留档不再进本 lint 图）
  {
    files: ['src/**/*.{ts,vue}'],
    // 注意：flat config 下 plugins 只在「同一配置对象」内生效（否则报
    // "could not find plugin"）。.vue 文件不被上方 TS 预设匹配，故此处显式注册。
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // 存量噪声降级（R2-3 风险预案：不做一次性大改）
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/ban-ts-comment': 'warn',
      // 渲染进程的 console 属调试残留（主进程/脚本的日志输出另论，不在此列）。
      // 存量 24 处先以 warn 提示；确需保留的诊断输出用
      // `// eslint-disable-next-line no-console` 并注明理由——
      // src/core/plugin 下已有 10 处此类抑制注释，规则启用前一直空转，现起真实生效。
      'no-console': 'warn',
    },
  },

  // 主进程 / 脚本：Node 环境
  {
    files: ['electron/**/*.ts', 'scripts/**/*.{js,cjs,mjs}', '*.config.{js,cjs,mjs,ts}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },

  // 单元测试（tests/）：node 环境，跑在 vitest 里
  //  - 必须显式降级 any：tests/ 不落在下面任何带降级规则的 files 匹配里，
  //    会继承 typescript-eslint recommended 的 error 级 no-explicit-any，
  //    与 src「any 一律 warn」的存量策略自相矛盾（R2-6 实测踩到）。
  //  - mock/替身代码里 any 本就是常态（vi.mock 工厂、假 ipcMain 回调），
  //    与业务代码同等对待即可。
  {
    files: ['tests/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // 插件源码以 `?raw` 注入沙箱，字符串内 eval 属有意设计
  {
    files: ['src/core/plugin/**/*.ts', 'electron/plugin-ui-runtime.js'],
    rules: {
      'no-eval': 'off',
    },
  },

  // 关闭所有与 Prettier 冲突的格式规则（必须放最后）
  configPrettier
);
