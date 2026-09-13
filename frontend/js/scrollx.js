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
    let movedAtLastDown = false;
    let clearTimer = null;

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
    // 注意：这里 **不能** 用 el.setPointerCapture()。一旦在 pointerdown 时捕获指针，
    // 浏览器会把后续的 pointerup / click 重定向到捕获元素（也就是这个容器），
    // 分类按钮自己的 click 监听永远收不到事件 —— 表现就是「点分类没反应、不高亮、
    // 也不筛选照片」（2026-09-14 用户反馈的真实 bug）。改用 document 级
    // pointermove/pointerup 监听，效果相同，且不会改事件目标。
    function onDragMove(e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      const dx = e.clientX - dragging.x;
      if (!dragging.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!dragging.moved) {
        dragging.moved = true;
        // 「开始拖拽」才加 .sx-dragging —— 它带有 .tag-pill{pointer-events:none}，
        // 如果在 pointerdown 时就加，鼠标一按下去分类按钮立刻变成「不可点」，
        // 结果 pointerup / click 都落到容器上，按钮的 click 永远收不到
        // （点分类没反应、不高亮、不筛选的另一个原因，2026-09-14 修复）。
        el.classList.add("sx-dragging");
      }
      el.scrollLeft = dragging.sl - dx;
      if (e.cancelable) e.preventDefault();
    }

    function endDrag(e) {
      if (!dragging) return;
      if (e && e.pointerId !== undefined && e.pointerId !== dragging.id) return;
      const moved = dragging.moved;
      dragging = null;
      el.classList.remove("sx-dragging");
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", endDrag);
      document.removeEventListener("pointercancel", endDrag);
      global.removeEventListener("blur", endDrag);
      if (moved) {
        // 拖拽后的这一下 click 吞掉，避免「拖动 = 误点分类」；
        // 同时留一个兜底定时器：若这一下 click 落在容器外（没有命中抑制逻辑），
        // 300ms 后自动解除，免得吞掉用户下一次正常点击。
        movedAtLastDown = true;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(function () { movedAtLastDown = false; }, 300);
      }
      update();
    }

    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;      // 触摸交给浏览器原生滑动
      if (e.button !== 0) return;
      // 新的一次按下 = 新手势，清掉上一次拖拽的「吞 click」标记，
      // 保证紧接着的一次真实点击一定生效（哪怕距上一次拖拽只有几毫秒）
      movedAtLastDown = false;
      clearTimeout(clearTimer);
      dragging = { x: e.clientX, sl: el.scrollLeft, moved: false, id: e.pointerId };
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", endDrag);
      document.addEventListener("pointercancel", endDrag);
      global.addEventListener("blur", endDrag);
    });

    // 拖拽结束的这一下 click 不要触发分类切换
    el.addEventListener("click", function (e) {
      if (!movedAtLastDown) return;
      movedAtLastDown = false;
      clearTimeout(clearTimer);
      e.stopPropagation();
      e.preventDefault();
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
