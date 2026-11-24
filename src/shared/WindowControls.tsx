import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, type Locale } from "./i18n";
import { IS_WINDOWS } from "./platform";
import "./WindowControls.css";

type Props = {
  locale: Locale;
  /** 设置窗不可缩放，传 false 隐藏最大化按钮 */
  allowMaximize?: boolean;
};

/**
 * Windows 自绘标题栏按钮（最小化 / 最大化 / 关闭）。
 * macOS 用系统红绿灯，这里直接不渲染。
 */
export function WindowControls({ locale, allowMaximize = true }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_WINDOWS) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch(() => {
          // ignore
        });
    };
    sync();
    let unlisten: (() => void) | undefined;
    void win
      .onResized(sync)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // ignore
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  if (!IS_WINDOWS) return null;

  const run = (action: () => Promise<unknown>) => () => {
    void action().catch(() => {
      // ignore
    });
  };

  return (
    <div
      className="window-controls"
      data-no-drag
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="window-control"
        aria-label={t(locale, "minimizeWindow")}
        title={t(locale, "minimizeWindow")}
        onClick={run(() => getCurrentWindow().minimize())}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      {allowMaximize ? (
        <button
          type="button"
          className="window-control"
          aria-label={t(locale, maximized ? "restoreWindow" : "maximizeWindow")}
          title={t(locale, maximized ? "restoreWindow" : "maximizeWindow")}
          onClick={run(() => getCurrentWindow().toggleMaximize())}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <path
                d="M3 1.5h5.5V7M1.5 3h5.5v5.5H1.5z"
                stroke="currentColor"
                strokeWidth="1"
                fill="none"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
              <rect
                x="2"
                y="2"
                width="6"
                height="6"
                stroke="currentColor"
                strokeWidth="1"
                fill="none"
              />
            </svg>
          )}
        </button>
      ) : null}
      <button
        type="button"
        className="window-control window-control--close"
        aria-label={t(locale, "closeWindow")}
        title={t(locale, "closeWindow")}
        onClick={run(() => getCurrentWindow().close())}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
          <path
            d="M2 2l6 6M8 2l-6 6"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
