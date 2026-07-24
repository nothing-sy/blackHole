(function () {
  const warpCanvas = document.getElementById('warp');
  const overlayCanvas = document.getElementById('hole');
  const toastEl = document.getElementById('toast');
  const appEl = document.getElementById('app');
  const dragRegion = document.getElementById('drag-region');

  const hole = new BlackHole(warpCanvas, overlayCanvas);

  let busy = false;
  let toastTimer = null;
  let insideCircle = true;
  let currentSize = 220;
  let dragging = false;
  let dragOffset = null;

  function showToast(message, kind = 'ok', ms = 2800) {
    toastEl.hidden = false;
    toastEl.className = kind;
    toastEl.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, ms);
  }

  function basename(p) {
    if (!p) return '?';
    const parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }

  function collectPaths(dataTransfer) {
    const files = Array.from(dataTransfer?.files || []);
    const paths = [];
    for (const file of files) {
      let p = '';
      if (window.blackhole?.getPathForFile) {
        p = window.blackhole.getPathForFile(file);
      }
      if (!p && file.path) p = file.path;
      if (p) paths.push(p);
    }
    return paths;
  }

  function isOverCircle(clientX, clientY) {
    const rect = appEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const r = Math.min(rect.width, rect.height) / 2 - 2;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }

  async function updateMouseIgnore(clientX, clientY) {
    if (dragging) return;
    const over = isOverCircle(clientX, clientY);
    if (over !== insideCircle) {
      insideCircle = over;
      await window.blackhole?.setIgnoreMouse?.(!over);
    }
  }

  async function refreshMetrics() {
    const m = await window.blackhole.getWindowMetrics();
    if (!m) return;
    // Convert DIP → physical pixels for capture mapping
    const s = m.scaleFactor || 1;
    hole.setMetrics({
      bounds: {
        x: m.bounds.x * s,
        y: m.bounds.y * s,
        width: m.bounds.width * s,
        height: m.bounds.height * s,
      },
      displayBounds: {
        x: m.displayBounds.x * s,
        y: m.displayBounds.y * s,
        width: m.displayBounds.width * s,
        height: m.displayBounds.height * s,
      },
      scaleFactor: s,
    });
  }

  async function syncSizeFromTrash() {
    const info = await window.blackhole.getTrashSize();
    if (!info) return;
    if (info.windowSize !== currentSize) {
      currentSize = info.windowSize;
      await window.blackhole.applyWindowSize(currentSize);
      hole.setSize(currentSize);
      document.documentElement.style.width = currentSize + 'px';
      document.documentElement.style.height = currentSize + 'px';
      document.body.style.width = currentSize + 'px';
      document.body.style.height = currentSize + 'px';
    }
    await refreshMetrics();
  }

  window.addEventListener('mousemove', (e) => {
    updateMouseIgnore(e.clientX, e.clientY);
  });

  // Manual window drag (so dblclick still works)
  dragRegion.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    await window.blackhole.setIgnoreMouse(false);
    const cursor = await window.blackhole.getCursorPoint();
    const metrics = await window.blackhole.getWindowMetrics();
    if (!metrics) return;
    dragging = true;
    dragOffset = {
      dx: cursor.x - metrics.bounds.x,
      dy: cursor.y - metrics.bounds.y,
    };
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    dragOffset = null;
  });

  window.addEventListener('mousemove', async () => {
    if (!dragging || !dragOffset) return;
    const cursor = await window.blackhole.getCursorPoint();
    await window.blackhole.setPosition(cursor.x - dragOffset.dx, cursor.y - dragOffset.dy);
    refreshMetrics();
  });

  dragRegion.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    busy = true;
    try {
      const result = await window.blackhole.emptyTrash();
      if (result?.cancelled) {
        showToast('已取消', 'ok', 1200);
      } else if (result?.ok) {
        currentSize = 220;
        hole.setSize(220);
        document.documentElement.style.width = '220px';
        document.documentElement.style.height = '220px';
        document.body.style.width = '220px';
        document.body.style.height = '220px';
        hole.flashSuccess();
        showToast('回收站已清空', 'ok');
        await refreshMetrics();
      } else {
        hole.flashError();
        showToast(result?.error || '清空失败', 'error');
      }
    } catch (err) {
      hole.flashError();
      showToast(err?.message || '清空失败', 'error');
    } finally {
      busy = false;
    }
  });

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!busy) hole.setState('dragover');
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!busy) hole.setState('dragover');
    window.blackhole?.setIgnoreMouse?.(false);
  });

  document.addEventListener('dragleave', (e) => {
    if (e.target === document || e.target === document.body || e.target === appEl) {
      if (!busy) hole.setState('idle');
    }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (busy) {
      showToast('正在吞噬中…', 'error', 1500);
      return;
    }

    const paths = collectPaths(e.dataTransfer);
    if (!paths.length) {
      hole.setState('idle');
      showToast('未识别到文件', 'error');
      return;
    }

    busy = true;
    const labels = paths.map(basename);
    const queue = paths.slice();
    const simultaneous = queue.splice(0, 8);

    try {
      await hole.swallow(labels.slice(0, 8));
      hole.setState('trashing');
      let allResults = await window.blackhole.trashPaths(simultaneous);

      while (queue.length) {
        const batch = queue.splice(0, 8);
        await hole.swallow(batch.map(basename));
        const more = await window.blackhole.trashPaths(batch);
        allResults = allResults.concat(more);
      }

      const failed = allResults.filter((r) => !r.ok);
      const okCount = allResults.length - failed.length;

      await syncSizeFromTrash();

      if (failed.length === 0) {
        hole.flashSuccess();
        showToast(`已吞噬 ${okCount} 项 → 回收站`, 'ok');
      } else if (okCount === 0) {
        hole.flashError();
        showToast(`失败：${failed[0].error || '无法移入回收站'}`, 'error', 4000);
      } else {
        hole.flashSuccess();
        showToast(
          `成功 ${okCount}，失败 ${failed.length}：${basename(failed[0].path)}`,
          'error',
          4500
        );
      }
    } catch (err) {
      hole.flashError();
      showToast(err?.message || '操作失败', 'error');
    } finally {
      busy = false;
      hole.setState('idle');
    }
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.blackhole?.showContextMenu?.();
  });

  window.blackhole?.onTrashEmptied?.(async (result) => {
    if (result?.ok) {
      currentSize = 220;
      hole.setSize(220);
      document.documentElement.style.width = '220px';
      document.documentElement.style.height = '220px';
      document.body.style.width = '220px';
      document.body.style.height = '220px';
      showToast('回收站已清空', 'ok');
      await refreshMetrics();
    }
  });

  // Keep metrics in sync while moving / resizing
  setInterval(() => {
    refreshMetrics();
  }, 250);

  setInterval(() => {
    if (!busy && !dragging) syncSizeFromTrash();
  }, 2000);

  (async function init() {
    window.blackhole?.setIgnoreMouse?.(false);
    await syncSizeFromTrash();
    hole.setSize(currentSize);
    document.documentElement.style.width = currentSize + 'px';
    document.documentElement.style.height = currentSize + 'px';
    document.body.style.width = currentSize + 'px';
    document.body.style.height = currentSize + 'px';
    await refreshMetrics();

    const ok = await hole.startCapture();
    if (!ok) {
      showToast('屏幕采集失败，仅显示黑洞（可检查权限）', 'error', 5000);
    }

    hole.start();
  })();
})();
