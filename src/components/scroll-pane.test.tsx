// @vitest-environment jsdom
import { act, useRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScrollPane } from "./scroll-pane";

let root: Root;
let host: HTMLDivElement;
let resize: (() => void) | undefined;
let scrollerRef: RefObject<HTMLDivElement | null>;
let unmounted = false;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resize = this.callback;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove();
  unmounted = false;
  resize = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness() {
  scrollerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="sb-host">
      <ScrollPane
        className="reader-scroll"
        id="mail-reader-content"
        scrollerRef={scrollerRef}
      >
        <p>邮件正文</p>
      </ScrollPane>
    </div>
  );
}

function scroller() {
  return host.querySelector(".sb-scroll") as HTMLDivElement;
}

function hostElement() {
  return host.querySelector(".sb-host") as HTMLElement;
}

async function render() {
  await act(async () => root.render(<Harness />));
}

function verticalLayout(el: HTMLDivElement) {
  Object.defineProperty(el, "clientHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
}

it("renders the scroller with the caller className, id and ref plus both thumbs", async () => {
  await render();
  const el = scroller();
  expect(el.classList.contains("reader-scroll")).toBe(true);
  expect(el.id).toBe("mail-reader-content");
  expect(scrollerRef.current).toBe(el);
  expect(host.querySelectorAll(".sb-thumb").length).toBe(2);
  expect(host.querySelector(".sb-thumb-y")).not.toBeNull();
  expect(host.querySelector(".sb-thumb-x")).not.toBeNull();
  expect(hostElement().classList.contains("sb-y")).toBe(false);
  expect(hostElement().classList.contains("sb-x")).toBe(false);
});

it("marks the host and sizes the vertical thumb when content overflows", async () => {
  await render();
  const el = scroller();
  verticalLayout(el);
  el.scrollTop = 250;
  const setProperty = vi.spyOn(hostElement().style, "setProperty");
  await act(async () => {
    resize!();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(hostElement().classList.contains("sb-y")).toBe(true);
  expect(hostElement().classList.contains("sb-x")).toBe(false);
  expect(setProperty).toHaveBeenCalledWith("--sb-y-size", "40px");
  expect(setProperty).toHaveBeenCalledWith("--sb-y-top", "50px");
  expect(hostElement().style.getPropertyValue("--sb-y-size")).toBe("40px");
  expect(hostElement().style.getPropertyValue("--sb-y-top")).toBe("50px");
});

it("repositions the vertical thumb after a scroll event and one animation frame", async () => {
  await render();
  const el = scroller();
  verticalLayout(el);
  el.scrollTop = 500;
  await act(async () => {
    el.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(hostElement().classList.contains("sb-y")).toBe(true);
  expect(hostElement().style.getPropertyValue("--sb-y-top")).toBe("100px");
});

it("drags the vertical thumb to scroll the container", async () => {
  await render();
  const el = scroller();
  verticalLayout(el);
  const thumb = host.querySelector(".sb-thumb-y") as HTMLElement;
  Object.defineProperty(thumb, "offsetHeight", {
    value: 40,
    configurable: true,
  });
  el.scrollTop = 100;
  thumb.dispatchEvent(
    new MouseEvent("pointerdown", { clientY: 100, bubbles: true }),
  );
  window.dispatchEvent(
    new MouseEvent("pointermove", { clientY: 150, bubbles: true }),
  );
  expect(el.scrollTop).toBe(350);
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
});

it("detaches its listeners on unmount", async () => {
  await render();
  const el = scroller();
  unmounted = true;
  await act(async () => root.unmount());
  expect(scrollerRef.current).toBeNull();
  expect(() => el.dispatchEvent(new Event("scroll"))).not.toThrow();
});
