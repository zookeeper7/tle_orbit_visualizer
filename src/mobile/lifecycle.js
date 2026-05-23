/**
 * Mobile lifecycle wiring — visibility, WebGL context loss, orientation.
 *
 * `attachMobileLifecycle(viewer)` registers four listeners that protect
 * battery + recover from iOS Safari memory pressure. It returns a
 * `dispose()` callback that detaches everything (handy for hot-reload).
 *
 * Why each listener exists:
 *
 *  - visibilitychange:
 *      iOS/Android keep firing rAF even when the tab is hidden, draining
 *      battery for nothing. When hidden we pause the clock AND lift the
 *      30-FPS render cap to Infinity so Cesium never schedules a frame
 *      while invisible. Restored on visible.
 *
 *  - webglcontextlost:
 *      iOS Safari aggressively reclaims GPU memory when the tab is
 *      backgrounded long enough. preventDefault() is required for the
 *      context to be eligible for restoration.
 *
 *  - webglcontextrestored:
 *      After restore, force one render so the next frame matches the
 *      visible scene state (Cesium rebuilds shaders internally).
 *
 *  - orientationchange:
 *      iOS fires `resize` ~300 ms AFTER the orientation animation, so
 *      we defer the viewer.resize() call to let the toolbar settle.
 */

const DEFAULT_RENDER_TIME_CHANGE = 1 / 30;
const ORIENTATION_RESIZE_DELAY_MS = 500;

/**
 * @param {object} viewer - Cesium.Viewer instance
 * @returns {() => void} dispose callback
 */
export function attachMobileLifecycle(viewer) {
  if (!viewer || !viewer.scene || !viewer.canvas) {
    return () => {};
  }

  const canvas = viewer.canvas;

  function onVisibilityChange() {
    if (document.hidden) {
      viewer.clock.shouldAnimate = false;
      viewer.scene.maximumRenderTimeChange = Infinity;
    } else {
      viewer.clock.shouldAnimate = true;
      viewer.scene.maximumRenderTimeChange = DEFAULT_RENDER_TIME_CHANGE;
      viewer.scene.requestRender();
    }
  }

  function onContextLost(event) {
    event.preventDefault();
    viewer.clock.shouldAnimate = false;
  }

  function onContextRestored() {
    viewer.clock.shouldAnimate = true;
    viewer.scene.requestRender();
  }

  let orientationTimer = null;
  function onOrientationChange() {
    if (orientationTimer != null) clearTimeout(orientationTimer);
    orientationTimer = setTimeout(() => {
      try {
        viewer.resize();
        viewer.scene.requestRender();
      } catch (_) {
        // Viewer might be destroyed mid-rotation — swallow.
      }
    }, ORIENTATION_RESIZE_DELAY_MS);
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('resize', onOrientationChange);

  return function dispose() {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    window.removeEventListener('orientationchange', onOrientationChange);
    window.removeEventListener('resize', onOrientationChange);
    if (orientationTimer != null) clearTimeout(orientationTimer);
  };
}
