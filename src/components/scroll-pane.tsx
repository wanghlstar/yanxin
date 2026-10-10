import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/** 细滚动面板：隐藏原生滚动条，用 3px 自定义拇指替代（原生 thin 已是最细且控制不了按下态颜色） */
export function ScrollPane({
  className,
  id,
  scrollerRef,
  children,
}: {
  className?: string;
  id?: string;
  scrollerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const local = useRef<HTMLDivElement>(null);
  const ref = scrollerRef ?? local;
  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const yOver = el.scrollHeight - el.clientHeight;
      const xOver = el.scrollWidth - el.clientWidth;
      host.classList.toggle("sb-y", yOver > 1);
      host.classList.toggle("sb-x", xOver > 1);
      if (yOver > 1) {
        const size = Math.min(
          Math.max(28, (el.clientHeight * el.clientHeight) / el.scrollHeight),
          el.clientHeight,
        );
        host.style.setProperty("--sb-y-size", `${size}px`);
        host.style.setProperty(
          "--sb-y-top",
          `${(el.scrollTop / yOver) * (el.clientHeight - size)}px`,
        );
      }
      if (xOver > 1) {
        const size = Math.min(
          Math.max(28, (el.clientWidth * el.clientWidth) / el.scrollWidth),
          el.clientWidth,
        );
        host.style.setProperty("--sb-x-size", `${size}px`);
        host.style.setProperty(
          "--sb-x-left",
          `${(el.scrollLeft / xOver) * (el.clientWidth - size)}px`,
        );
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(el);
    const changes = new MutationObserver(() => {
      if (el.firstElementChild) sizes.observe(el.firstElementChild);
      schedule();
    });
    changes.observe(el, { childList: true });
    const drag = (thumb: Element, vertical: boolean) => {
      thumb.addEventListener("pointerdown", (event) => {
        const pointer = event as PointerEvent;
        pointer.preventDefault();
        const track = vertical ? el.clientHeight : el.clientWidth;
        const thumbSize = vertical
          ? (thumb as HTMLElement).offsetHeight
          : (thumb as HTMLElement).offsetWidth;
        const maxScroll = (vertical ? el.scrollHeight : el.scrollWidth) - track;
        const maxThumb = track - thumbSize;
        if (maxScroll <= 0 || maxThumb <= 0) return;
        const start = vertical ? pointer.clientY : pointer.clientX;
        const from = vertical ? el.scrollTop : el.scrollLeft;
        const move = (moveEvent: Event) => {
          const at = moveEvent as PointerEvent;
          const delta = (vertical ? at.clientY : at.clientX) - start;
          const next = from + (delta / maxThumb) * maxScroll;
          if (vertical) el.scrollTop = next;
          else el.scrollLeft = next;
        };
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
      });
    };
    host
      .querySelectorAll(".sb-thumb")
      .forEach((thumb) => drag(thumb, thumb.classList.contains("sb-thumb-y")));
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      sizes.disconnect();
      changes.disconnect();
    };
  }, [ref]);
  return (
    <>
      <div className={`sb-scroll ${className ?? ""}`} id={id} ref={ref}>
        {children}
      </div>
      <div className="sb-thumb sb-thumb-y" aria-hidden="true" />
      <div className="sb-thumb sb-thumb-x" aria-hidden="true" />
    </>
  );
}
