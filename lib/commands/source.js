import { errors } from 'appium/driver';

const commands = {};
const HANDLE_SCOPED_WINDOW_TOKENS = ['dialog', 'alert', 'modal', 'notification', 'popover', 'popup', 'tooltip'];

function getApis (ctx) {
  if (!ctx?._backendApis) {
    throw new errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}

function shouldPreferHandleScopedHierarchy (ctx) {
  if (ctx?.linuxBackend !== 'wayland') {
    return false;
  }
  const tag = `${ctx?._win?.tag ?? ''}`.toLowerCase();
  const windowType = `${ctx?._win?.windowType ?? ''}`.toLowerCase();
  return HANDLE_SCOPED_WINDOW_TOKENS.some((token) => tag.includes(token) || windowType.includes(token));
}

function getWindowScopedHierarchy (ctx, apis) {
  const {pid, name, wid} = ctx._win;
  let hierarchy = null;
  if (shouldPreferHandleScopedHierarchy(ctx)) {
    // Fast path: try native per-window AT-SPI call first.  This returns fresh
    // element data (~200ms) without needing the full desktop hierarchy.  The
    // handle-scoped fallback uses cached desktop XML which may have stale
    // element states (e.g. Login button disabled before credentials were entered).
    hierarchy = apis.a11y_getWindowUiHierachy(name, pid);
    if ((!hierarchy || !`${hierarchy}`.trim()) && typeof apis.a11y_getWindowUiHierachyByHandle === 'function') {
      hierarchy = apis.a11y_getWindowUiHierachyByHandle(wid, pid, name);
    }
  } else {
    hierarchy = apis.a11y_getWindowUiHierachy(name, pid);
    if ((!hierarchy || !`${hierarchy}`.trim()) && ctx.linuxBackend === 'wayland') {
      if (typeof apis.a11y_getWindowUiHierachyByHandle === 'function') {
        hierarchy = apis.a11y_getWindowUiHierachyByHandle(wid, pid, name);
      }
    }
  }
  // Wayland ultimate fallback: use the full desktop accessibility hierarchy when
  // both window-scoped and handle-scoped lookups return nothing (RHEL/GNOME).
  if ((!hierarchy || !`${hierarchy}`.trim()) && ctx.linuxBackend === 'wayland') {
    if (typeof apis.a11y_getDesktopUiHierachy === 'function') {
      hierarchy = apis.a11y_getDesktopUiHierachy();
    }
  }
  if (!hierarchy || !`${hierarchy}`.trim()) {
    throw new errors.NoSuchWindowError(
      `the selected window doesn't exist (wid=${wid}, pid=${pid}, name=${name})`
    );
  }
  return hierarchy;
}

commands.getPageSource = function getPageSource () {
  const apis = getApis(this);
  // Clear native AT-SPI cache: rate-limited to once per 2s, but forced
  // immediately after UI actions or window switches.
  const now = Date.now();
  const currentWid = this._win?.wid;
  const windowChanged = currentWid && currentWid !== this._lastSourceWid;
  if (windowChanged || !this._lastCacheClearAt || (now - this._lastCacheClearAt) >= 2000) {
    apis.a11y_clear_cache();
    this._lastCacheClearAt = now;
  }
  this._lastSourceWid = currentWid;
  if (!this._validateOrUpdateWinInfo()) {
    throw new errors.NoSuchWindowError(`the selected window doesn't exist`);
  }
  const s = getWindowScopedHierarchy(this, apis);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${s}`;
};

export default commands;
