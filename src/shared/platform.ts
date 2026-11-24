/**
 * 平台分流：Windows WebView2 的窗体外壳/命中行为与 macOS 不同，
 * 统一用 html.os-windows 做局部覆盖，不影响 macOS 默认样式。
 */
export const IS_WINDOWS = /\bWindows\b/i.test(navigator.userAgent);

export function applyPlatformClass(): void {
  if (IS_WINDOWS) {
    document.documentElement.classList.add("os-windows");
  }
}
