import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { imageSrcUrl } from "../shared/api/images";

const MIN_WIDTH = 80;
const MAX_WIDTH = 640;
const DEFAULT_MAX = 360;

type Props = {
  src: string;
  width?: number;
  selected?: boolean;
  ariaLabel: string;
  viewLabel: string;
  closeLabel: string;
  removeLabel: string;
  resizeLabel: string;
  onFocus: () => void;
  onRemove: () => void;
  onResize: (width: number) => void;
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
};

/**
 * 正文内嵌图片：等比缩放展示；右下角拖拽改宽；点击查看原图。
 */
export function NoteImageLine({
  src,
  width,
  selected,
  ariaLabel,
  viewLabel,
  closeLabel,
  removeLabel,
  resizeLabel,
  onFocus,
  onRemove,
  onResize,
  onPaste,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [naturalW, setNaturalW] = useState(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    void imageSrcUrl(src)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLightbox(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightbox]);

  const displayWidth = (() => {
    const raw = dragWidth ?? width;
    if (raw != null && raw > 0) return raw;
    if (naturalW > 0) return Math.min(naturalW, DEFAULT_MAX);
    return DEFAULT_MAX;
  })();

  const handleRemoveKey = (event: React.KeyboardEvent) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    }
  };

  const startResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    const startX = event.clientX;
    const startW = displayWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = Math.round(
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX))),
      );
      setDragWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      const finalW = Math.round(
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX))),
      );
      setDragWidth(null);
      onResize(finalW);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return (
    <>
      <div
        ref={frameRef}
        className={`note-image-line${selected ? " is-line-selected" : ""}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onFocus={onFocus}
        onPaste={onPaste}
        onKeyDown={(event) => {
          handleRemoveKey(event);
          if (event.key === "Enter" && url && !failed) {
            event.preventDefault();
            setLightbox(true);
          }
        }}
      >
        {url && !failed ? (
          <div className="note-image-frame" style={{ width: displayWidth }}>
            <button
              type="button"
              className="note-inline-image-btn"
              title={viewLabel}
              aria-label={viewLabel}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onFocus();
                setLightbox(true);
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={handleRemoveKey}
              onFocus={onFocus}
            >
              <img
                className="note-inline-image"
                src={url}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "auto", maxWidth: "none", maxHeight: "none" }}
                onLoad={(event) => {
                  const w = event.currentTarget.naturalWidth;
                  if (w > 0) setNaturalW(w);
                }}
                onError={() => setFailed(true)}
              />
            </button>
            <button
              type="button"
              className="note-image-remove"
              title={removeLabel}
              aria-label={removeLabel}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove();
              }}
            >
              ×
            </button>
            <span
              className="note-image-resize"
              title={resizeLabel}
              aria-label={resizeLabel}
              role="slider"
              aria-valuenow={displayWidth}
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={MAX_WIDTH}
              onPointerDown={startResize}
            />
          </div>
        ) : (
          <div className="note-image-fallback">{failed ? "…" : ""}</div>
        )}
      </div>

      {lightbox && url
        ? createPortal(
            <div
              className="note-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={viewLabel}
              onClick={() => setLightbox(false)}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="note-image-lightbox-close"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  setLightbox(false);
                }}
              >
                ×
              </button>
              <img
                className="note-image-lightbox-img"
                src={url}
                alt=""
                draggable={false}
                onClick={(event) => event.stopPropagation()}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
