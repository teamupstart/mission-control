import { useCallback, useEffect, useRef, useState } from "react";

interface DividerMetrics {
  width: number;
  max: number;
}

/**
 * A shared vertical divider for list-and-reader surfaces.
 *
 * Pointer movement and keyboard movement both write the same CSS custom property on the
 * containing split. The parent keeps ownership of its layout and default width, while this
 * component owns the interaction, bounds, and accessible value in one place.
 */
export function ResizablePaneDivider({
  containerRef,
  leadingPaneRef,
  label,
  widthProperty,
  minLeadingWidth = 140,
  minTrailingWidth = 320,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  leadingPaneRef: React.RefObject<HTMLElement | null>;
  label: string;
  widthProperty: `--${string}`;
  minLeadingWidth?: number;
  minTrailingWidth?: number;
}): React.JSX.Element {
  const dividerRef = useRef<HTMLDivElement>(null);
  const appliedWidth = useRef<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState<DividerMetrics>({
    width: minLeadingWidth,
    max: minLeadingWidth,
  });

  const bounds = useCallback((): { min: number; max: number } => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    const dividerWidth = dividerRef.current?.getBoundingClientRect().width ?? 0;
    const max = Math.max(0, containerWidth - minTrailingWidth - dividerWidth);
    return { min: Math.min(minLeadingWidth, max), max };
  }, [containerRef, minLeadingWidth, minTrailingWidth]);

  const applyWidth = useCallback((requested: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const { min, max } = bounds();
    const width = Math.round(Math.min(max, Math.max(min, requested)));
    container.style.setProperty(widthProperty, `${width}px`);
    appliedWidth.current = width;
    setMetrics({ width, max: Math.round(max) });
  }, [bounds, containerRef, widthProperty]);

  useEffect(() => {
    const container = containerRef.current;
    const leadingPane = leadingPaneRef.current;
    if (!container || !leadingPane) return;
    const measure = (): void => {
      if (appliedWidth.current !== null) {
        applyWidth(appliedWidth.current);
        return;
      }
      const { max } = bounds();
      setMetrics({
        width: Math.round(leadingPane.getBoundingClientRect().width),
        max: Math.round(max),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyWidth, bounds, containerRef, leadingPaneRef]);

  useEffect(() => () => document.body.classList.remove("is-pane-resizing"), []);

  const finishDrag = useCallback((pointerId: number): void => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-pane-resizing");
  }, []);

  return (
    <div
      ref={dividerRef}
      className={`pane-divider${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.min(minLeadingWidth, metrics.max)}
      aria-valuemax={metrics.max}
      aria-valuenow={metrics.width}
      tabIndex={0}
      title="Drag to resize. Use Left and Right arrows for precise adjustments. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: leadingPaneRef.current?.getBoundingClientRect().width ?? metrics.width,
        };
        setDragging(true);
        document.body.classList.add("is-pane-resizing");
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        applyWidth(drag.current.startWidth + event.clientX - drag.current.startX);
      }}
      onPointerUp={(event) => finishDrag(event.pointerId)}
      onPointerCancel={(event) => finishDrag(event.pointerId)}
      onLostPointerCapture={(event) => finishDrag(event.pointerId)}
      onDoubleClick={() => {
        containerRef.current?.style.removeProperty(widthProperty);
        appliedWidth.current = null;
        const leadingPane = leadingPaneRef.current;
        const { max } = bounds();
        if (leadingPane) {
          requestAnimationFrame(() => setMetrics({
            width: Math.round(leadingPane.getBoundingClientRect().width),
            max: Math.round(max),
          }));
        }
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const { min, max } = bounds();
        const next = event.key === "ArrowLeft"
          ? metrics.width - step
          : event.key === "ArrowRight"
            ? metrics.width + step
            : event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        applyWidth(next);
      }}
    />
  );
}
