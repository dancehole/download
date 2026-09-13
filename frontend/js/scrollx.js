// 横向滚动增强：PC 端鼠标拖拽、滚轮横向滚动、左右箭头与渐隐提示
// 用法：ScrollX.enable(innerEl, { wrap: barEl, prev: btnEl, next: btnEl, step: 0.7 })
//   - 触摸端保持浏览器原生滑动，不做任何拦截
//   - 拖拽后会吞掉一次 click，避免「拖动 = 误点分类」
//   - 滚轮滚动到两端后不再拦截，页面可继续正常滚动
(function (global) {
  "use strict";

  function enable(el, opts) {
    if (!el) return function () {};
    opts = opts || {};
    const wrap = opts.wrap || el.parentElement;
    const prev = opts.prev || null;
    const next = opts.next || null;
    const step = opts.step || 0.7;
    const minOverflow = opts.minOverflow || 4;
    const DRAG_THRESHOLD = opts.dragThreshold || 6;

    let dragging = null;
    let suppressClick = false;

    // 判断「鼠标设备」：优先看媒体查询，(hover:none/pointer:coarse) 的环境
    // （部分内嵌浏览器、无鼠标设备上报异常的桌面环境）再用 maxTouchPoints 兜底，
    // 避免箭头按钮在真正的 PC 上不显示。
    function isMouseDevice() {
      try {
        if (global.matchMedia && global.matchMedia("(hover: hover) and (pointer: fine)").matches) return true;
      } catch (_) {}
      return (navigator.maxTouchPoints || 0) === 0;
    }

    function maxScroll() { return Math.max(0, el.scrollWidth - el.clientWidth); }

    function update() {
      const max = maxScroll();
      const overflow = max > minOverflow;
      const atLeft = el.scrollLeft <= 1;
      const atRight = el.scrollLeft >= max - 1;
      if (wrap) {
        wrap.classList.toggle("sx-overflow", overflow);
        wrap.classList.toggle("sx-can-left", overflow && !atLeft);
        wrap.classList.toggle("sx-can-right", overflow && !atRight);
        wrap.classList.toggle("sx-fine", isMouseDevice());
      }
      if (prev) prev.disabled = !(overflow && !atLeft);
      if (next) next.disabled = !(overflow && !atRight);
    }

    function stepBy(dir) {
      const amount = Math.max(140, el.clientWidth * step);
      el.scrollBy({ left: dir * amount, behavior: "smooth" });
    }

    if (prev) prev.addEventListener("click", function () { stepBy(-1); });
    if (next) next.addEventListener("click", function () { stepBy(1); });

    // ── 鼠标拖拽 ──
    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;      // 触摸交给浏览器原生滑动
      if (e.button !== 0) return;
      dragging = { x: e.clientX, sl: el.scrollLeft, moved: false, id: e.pointerId };
      el.classList.add("sx-dragging");
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });

    el.addEventListener("pointermove", function (e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      const dx = e.clientX - dragging.x;
      if (!dragging.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      dragging.moved = true;
      el.scrollLeft = dragging.sl - dx;
      if (e.cancelable) e.preventDefault();
    });

    function endDrag(e) {
      if (!dragging) return;
      if (e && e.pointerId !== undefined && e.pointerId !== dragging.id) return;
      if (dragging.moved) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
      }
      dragging = null;
      el.classList.remove("sx-dragging");
      update();
    }
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("lostpointercapture", endDrag);

    // 拖拽结束的这一下 click 不要触发分类切换
    el.addEventListener("click", function (e) {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // ── 滚轮横向 ──
    el.addEventListener("wheel", function (e) {
      const max = maxScroll();
      if (max <= 1) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      if ((d < 0 && el.scrollLeft <= 0) || (d > 0 && el.scrollLeft >= max - 1)) return;
      el.scrollLeft = el.scrollLeft + d;
      if (e.cancelable) e.preventDefault();
      update();
    }, { passive: false });

    el.addEventListener("scroll", update, { passive: true });
    if (global.ResizeObserver) {
      try { new ResizeObserver(update).observe(el); } catch (_) {}
    }
    global.addEventListener("resize", update);
    update();

    return update;
  }

  global.ScrollX = { enable: enable };
})(window);
