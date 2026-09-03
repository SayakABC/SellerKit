/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
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
