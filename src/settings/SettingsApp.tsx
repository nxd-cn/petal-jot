import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, setSettings } from "../shared/api/settings";
import { DEFAULT_NOTE_COLOR, MAX_PETAL_COUNT, MIN_PETAL_COUNT } from "../shared/constants";
import { DEFAULT_LOCALE, normalizeLocale, t, type Locale } from "../shared/i18n";
import { displayNoteColor } from "../shared/noteColor";
import type { AppSettings } from "../shared/types";
import "./SettingsApp.css";

async function applyChromeColor(hex: string) {
  const color = displayNoteColor(hex);
  try {
    await Promise.all([
      getCurrentWindow().setBackgroundColor(color),
      getCurrentWebview().setBackgroundColor(color),
    ]);
  } catch {
    // ignore
  }
}

/**
 * 设置页：与主界面同一纸面风格；花瓣数量与系统语言。
 */
export function SettingsApp() {
  const [settings, setLocal] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState("");
  const locale: Locale = normalizeLocale(settings?.locale ?? DEFAULT_LOCALE);
  const chromeColor = displayNoteColor(DEFAULT_NOTE_COLOR);

  useEffect(() => {
    void applyChromeColor(DEFAULT_NOTE_COLOR);
    void getSettings()
      .then(setLocal)
      .catch(() => {
        setStatus(t(DEFAULT_LOCALE, "loadFailed"));
      });

    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await getCurrentWindow().hide();
      } catch {
        // ignore
      }
    });
    return () => {
      void unlistenClose.then((fn) => fn());
    };
  }, []);

  const save = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    try {
      const next = await setSettings(patch);
      setLocal(next);
      setStatus(t(normalizeLocale(next.locale), "saved"));
      await invoke("emit_settings_updated");
    } catch {
      setStatus(t(locale, "saveFailed"));
    }
  };

  if (!settings) {
    return (
      <div className="settings" style={{ background: chromeColor }}>
        <header className="settings-titlebar" data-tauri-drag-region />
        <div className="settings-body">
          <div className="settings-loading">{t(DEFAULT_LOCALE, "loading")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings" style={{ background: chromeColor }}>
      <header className="settings-titlebar" data-tauri-drag-region>
        <h1 className="settings-title">{t(locale, "settingsTitle")}</h1>
      </header>

      <div className="settings-body">
        <div className="settings-field">
          <label htmlFor="petalCount">
            {t(locale, "petalCount")}（{MIN_PETAL_COUNT}–{MAX_PETAL_COUNT}）
          </label>
          <input
            id="petalCount"
            type="number"
            min={MIN_PETAL_COUNT}
            max={MAX_PETAL_COUNT}
            value={settings.petalCount}
            onChange={(event) => {
              const petalCount = Number(event.target.value);
              setLocal({ ...settings, petalCount });
              void save({ petalCount });
            }}
          />
        </div>

        <div className="settings-field">
          <span className="settings-field-label">{t(locale, "language")}</span>
          <div className="lang-grid" role="listbox" aria-label={t(locale, "language")}>
            {(
              [
                { id: "zh" as const, label: t(locale, "languageZh") },
                { id: "en" as const, label: t(locale, "languageEn") },
              ] as const
            ).map((option) => {
              const active = locale === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`lang-option${active ? " active" : ""}`}
                  aria-selected={active}
                  onClick={() => {
                    setLocal({ ...settings, locale: option.id });
                    void save({ locale: option.id });
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <p className="settings-hint">{t(locale, "settingsHint")}</p>
        <div className="settings-status">{status}</div>
      </div>
    </div>
  );
}
