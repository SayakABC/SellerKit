/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // `{}` 表示"该 shim 不约束 props/slots 形状"，是 Vue 官方 SFC 兜底声明写法；
  // vue-tsc 走真实 .vue 解析，不会命中此处（本文件仅为工具兜底）。
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// 自定义环境变量（见 .env.development / .env.production）
interface ImportMetaEnv {
  /** 后端 API 基础地址（axios baseURL 默认值） */
  readonly VITE_API_BASE_URL?: string;
  /** 请求引擎：ipc（默认，Electron net）/ xhr（浏览器调试） */
  readonly VITE_REQUEST_ENGINE?: 'ipc' | 'xhr';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
