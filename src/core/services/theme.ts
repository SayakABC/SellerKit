/**
 * 主题服务 —— 统一管理「外观」设置（浅色 / 深色 / 跟随系统）
 * 通过 <html data-theme> 切换 CSS 令牌，持久化到 app-shell 命名空间。
 */
import { ref } from 'vue';
import { useModuleStorage } from './storage';

export type ThemeMode = 'light' | 'dark' | 'system';

const storage = useModuleStorage<{ theme?: ThemeMode }>('appearance');

const mode = ref<ThemeMode>('system');
let mediaQuery: MediaQueryList | null = null;
let systemHandler: ((e: MediaQueryListEvent) => void) | null = null;
let initialized = false;

function resolveApplied(m: ThemeMode): 'light' | 'dark' {
  if (m === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return m;
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolveApplied(mode.value));
}

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

export async function initTheme(): Promise<void> {
  const saved = await storage.load();
  // 防御：持久化数据可能为脏值（旧版本 / 手改），非法则忽略
  if (saved?.theme && THEME_MODES.includes(saved.theme)) {
    mode.value = saved.theme;
  }
  applyTheme();

  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  systemHandler = () => {
    if (mode.value === 'system') applyTheme();
  };
  mediaQuery.addEventListener('change', systemHandler);
  initialized = true;
}

export function useTheme() {
  if (!initialized) {
    // 兜底：未调用 initTheme 时也能即时生效（极少路径）
    applyTheme();
  }

  async function setTheme(next: ThemeMode) {
    mode.value = next;
    applyTheme();
    await storage.save({ theme: next });
  }

  return { mode, setTheme };
}
