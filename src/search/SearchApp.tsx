import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { searchNotes } from "../shared/api/notes";
import { getSettings } from "../shared/api/settings";
import { openEditor } from "../shared/api/windows";
import { DEFAULT_NOTE_COLOR } from "../shared/constants";
import { DEFAULT_LOCALE, normalizeLocale, t, type Locale } from "../shared/i18n";
import { displayNoteColor } from "../shared/noteColor";
import { displayTitle } from "../shared/noteText";
import type { NoteSummary } from "../shared/types";
import "./SearchApp.css";

/**
 * 全屏居中搜索层：透明输入，命中列表，选中后打开便签窗。
 */
export function SearchApp() {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NoteSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchTimer = useRef<number | null>(null);

  const hideSelf = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
    } catch {
      // ignore
    }
  }, []);

  const runSearch = useCallback(async (value: string) => {
    const q = value.trim();
    if (!q) {
      setHits([]);
      setBusy(false);
      setActiveIndex(0);
      return;
    }
    setBusy(true);
    try {
      const next = await searchNotes(q, 50);
      setHits(next);
      setActiveIndex(0);
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (searchTimer.current != null) window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => {
        void runSearch(value);
      }, 160);
    },
    [runSearch],
  );

  const openHit = useCallback(
    async (id: string) => {
      try {
        await openEditor({ mode: "edit", id });
      } catch {
        // ignore
      }
      setQuery("");
      setHits([]);
      await hideSelf();
    },
    [hideSelf],
  );

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([
          getCurrentWindow().setBackgroundColor("#00000000"),
          getCurrentWebview().setBackgroundColor("#00000000"),
        ]);
      } catch {
        // ignore
      }
      try {
        const settings = await getSettings();
        setLocale(normalizeLocale(settings.locale));
      } catch {
        // ignore
      }
      window.setTimeout(() => inputRef.current?.focus(), 40);
    })();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setQuery("");
        setHits([]);
        setActiveIndex(0);
        window.setTimeout(() => inputRef.current?.focus(), 40);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (searchTimer.current != null) window.clearTimeout(searchTimer.current);
    };
  }, []);

  return (
    <div
      className="search-root"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void hideSelf();
      }}
    >
      <div
        className="search-stage"
        role="dialog"
        aria-label={t(locale, "searchNotes")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-box">
          <svg
            className="search-box-icon"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16.5 16.5 21 21" />
          </svg>
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            value={query}
            placeholder={t(locale, "searchPlaceholder")}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                void hideSelf();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (event.key === "Enter") {
                const hit = hits[activeIndex] ?? hits[0];
                if (hit) void openHit(hit.id);
              }
            }}
          />
        </div>

        <div className="search-hits" role="listbox">
          {!query.trim() ? (
            <div className="search-hint">{t(locale, "searchEmpty")}</div>
          ) : busy ? (
            <div className="search-hint">{t(locale, "loading")}</div>
          ) : hits.length === 0 ? (
            <div className="search-hint">{t(locale, "searchNoHit")}</div>
          ) : (
            hits.map((note, index) => {
              const title = displayTitle(note.title || t(locale, "untitled"), 36);
              const colorDot = displayNoteColor(note.color || DEFAULT_NOTE_COLOR);
              const active = index === activeIndex;
              return (
                <button
                  key={note.id}
                  type="button"
                  className={`search-hit${active ? " active" : ""}`}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    void openHit(note.id);
                  }}
                >
                  <span className="search-hit-dot" style={{ background: colorDot }} aria-hidden />
                  <span className="search-hit-text">
                    <span className="search-hit-title">{title}</span>
                    {note.excerpt ? <span className="search-hit-excerpt">{note.excerpt}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
