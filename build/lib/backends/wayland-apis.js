"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
require("source-map-support/register");
var _fs = _interopRequireDefault(require("fs"));
var _path = _interopRequireDefault(require("path"));
var _crypto = _interopRequireDefault(require("crypto"));
var _child_process = require("child_process");
var _bluebird = require("bluebird");
var _dbusNext = _interopRequireDefault(require("dbus-next"));
var _sharp = _interopRequireDefault(require("sharp"));
var _tokenStore = require("./token-store");
var _linuxPlatform = require("./linux-platform.js");
var _waylandPermissionUtils = require("./wayland-permission-utils.js");
var _waylandScreenshotUtils = require("./wayland-screenshot-utils.js");
var _waylandWindowUtils = require("./wayland-window-utils.js");
const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const DBUS_PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const PORTAL_REQUEST_IFACE = 'org.freedesktop.portal.Request';
const PORTAL_RD_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const PORTAL_SC_IFACE = 'org.freedesktop.portal.ScreenCast';
const PORTAL_SS_IFACE = 'org.freedesktop.portal.Screenshot';
const PORTAL_REGISTRY_IFACE = 'org.freedesktop.host.portal.Registry';
const DESKTOP_ENTRY_DIRS = Object.freeze(['/usr/share/applications', '/usr/local/share/applications', _path.default.join(process.env.HOME || '', '.local/share/applications')]);
let loadedNativeApis = null;
function loadNativeApis() {
  if (!loadedNativeApis) {
    const nativeModule = require('@stdspa/stdspalinux_temp/dist/privateapis');
    loadedNativeApis = nativeModule.default || nativeModule;
  }
  return loadedNativeApis;
}
const POINTER_LEFT = 272;
const POINTER_RIGHT = 273;
const POINTER_MIDDLE = 274;
const DEFAULT_AUTO_SHARE_TIMEOUT_MS = 15000;
const POINTER_PERMISSION_ERROR_TOKENS = ['notifypointer', 'pointer methods', 'pointer access', 'without pointer', 'not allowed to call'];
const AUTO_SHARE_HELPER_SCRIPT = `
import pyatspi
import sys
import time

BUTTON_ROLE = pyatspi.ROLE_PUSH_BUTTON
CHECKBOX_ROLE = getattr(pyatspi, 'ROLE_CHECK_BOX', None)
TOGGLE_ROLE = getattr(pyatspi, 'ROLE_TOGGLE_BUTTON', None)
CHECKABLE_ROLES = {r for r in (CHECKBOX_ROLE, TOGGLE_ROLE) if r is not None}
REMOTE_CONTROL_ROLES = CHECKABLE_ROLES | {BUTTON_ROLE}
STATE_CHECKED = getattr(pyatspi, 'STATE_CHECKED', None)
REMOTE_CONTROL_KEYWORDS = ('remote', 'control', 'keyboard', 'mouse', 'input', 'interaction')
REMEMBER_KEYWORDS = ('remember', 'selection')
APPROVE_KEYWORDS = ('share', 'allow', 'grant')
CAPTURE_APPROVE_KEYWORDS = ('capture', 'screenshot')
REJECT_KEYWORDS = ('cancel', 'deny', 'stop')
PORTAL_CONTEXT_KEYWORDS = (
    'remote desktop',
    'share your screen',
    'allow remote interaction',
    'unknown display',
    'remember this selection',
    'allow access',
    'screen sharing',
    'allow control',
    'remote control',
    'share this screenshot',
    'requesting application',
)
CAPTURE_PORTAL_CONTEXT_KEYWORDS = (
    'screen selection',
    'window selection',
    'area selection',
    'record screen',
    'show pointer',
    'take screenshot',
    'capture',
    'screencast',
)
TIMEOUT_SECONDS = __TIMEOUT_SECONDS__

def iter_nodes(node):
    yield node
    try:
        count = node.childCount
    except Exception:
        return
    for idx in range(count):
        try:
            child = node[idx]
        except Exception:
            continue
        for nested in iter_nodes(child):
            yield nested

def atspi_click_at(node):
    """Click at the centre of a node using pyatspi.Registry.generateMouseEvent.
    Works on Wayland where xdotool does not."""
    try:
        comp = node.queryComponent()
        rect = comp.getExtents(pyatspi.DESKTOP_COORDS)
        cx = rect.x + rect.width // 2
        cy = rect.y + rect.height // 2
        if cx <= 0 or cy <= 0:
            return False
        pyatspi.Registry.generateMouseEvent(cx, cy, 'b1c')
        return True
    except Exception:
        return False

def invoke_action(node):
    # First try AT-SPI doAction (works on GTK3 / some toolkits)
    candidates = []
    current = node
    while current is not None and len(candidates) < 3:
        candidates.append(current)
        try:
            current = current.parent
        except Exception:
            current = None
    for candidate in candidates:
        try:
            action = candidate.queryAction()
        except Exception:
            continue
        try:
            total = action.nActions
        except Exception:
            total = 0
        for idx in range(total):
            try:
                action_name = (action.getName(idx) or '').strip().lower()
            except Exception:
                action_name = ''
            if action_name in ('click', 'press', 'activate', 'toggle', 'check', ''):
                try:
                    if action.doAction(idx):
                        return True
                except Exception:
                    continue
    # Fallback: coordinate click via AT-SPI generateMouseEvent (needed on
    # GNOME 46 / RHEL 10 where doAction on libadwaita switches is a no-op).
    return atspi_click_at(node)

def safe_name(node):
    try:
        return (getattr(node, 'name', '') or '').strip()
    except Exception:
        return ''

def nearby_labels(node):
    labels = []
    seen = set()

    def add(candidate):
        if candidate is None:
            return
        key = id(candidate)
        if key in seen:
            return
        seen.add(key)
        name = safe_name(candidate)
        if name:
            labels.append(name)

    add(node)
    try:
        parent = node.parent
    except Exception:
        parent = None
    add(parent)
    try:
        grandparent = parent.parent if parent is not None else None
    except Exception:
        grandparent = None
    add(grandparent)
    try:
        great_grandparent = grandparent.parent if grandparent is not None else None
    except Exception:
        great_grandparent = None
    add(great_grandparent)

    for candidate in (node, parent, grandparent, great_grandparent):
        if candidate is None:
            continue
        try:
            count = candidate.childCount
        except Exception:
            count = 0
        for idx in range(count):
            try:
                child = candidate[idx]
            except Exception:
                continue
            add(child)
            try:
                grandchild_count = child.childCount
            except Exception:
                grandchild_count = 0
            for child_idx in range(grandchild_count):
                try:
                    add(child[child_idx])
                except Exception:
                    continue
    return labels

def looks_like_portal_context(node):
    labels = nearby_labels(node)
    lowered = ' '.join(label.lower() for label in labels)
    return (
        any(keyword in lowered for keyword in PORTAL_CONTEXT_KEYWORDS) or
        any(keyword in lowered for keyword in CAPTURE_PORTAL_CONTEXT_KEYWORDS)
    )

def looks_like_capture_context(lowered_context):
    return any(keyword in lowered_context for keyword in CAPTURE_PORTAL_CONTEXT_KEYWORDS)

def is_approve_candidate(button_name, nearby, lowered_context):
    lower_name = button_name.lower()
    lowered_primary = ' '.join(label.lower() for label in nearby[:4])
    if any(keyword in lower_name for keyword in REJECT_KEYWORDS):
        return False
    if any(keyword in lower_name for keyword in APPROVE_KEYWORDS):
        return True
    if not looks_like_capture_context(lowered_context):
        return False
    return any(keyword in lower_name for keyword in CAPTURE_APPROVE_KEYWORDS)

def classify_checkable(node):
    labels = nearby_labels(node)
    lowered = ' '.join(label.lower() for label in labels)
    is_remote = any(keyword in lowered for keyword in REMOTE_CONTROL_KEYWORDS)
    is_remember = any(keyword in lowered for keyword in REMEMBER_KEYWORDS)
    primary = labels[0] if labels else 'unnamed-checkable'
    return is_remote, is_remember, primary

def maybe_enable_remote_controls(app):
    remote_control_present = False
    remote_control_enabled = False
    toggled_any = False
    for node in iter_nodes(app):
        try:
            role = node.getRole()
        except Exception:
            continue
        if role not in REMOTE_CONTROL_ROLES:
            continue
        direct_name = safe_name(node).lower()
        if role == BUTTON_ROLE:
            if direct_name in ('cancel', 'share', 'allow', 'grant'):
                continue
            if direct_name and not any(keyword in direct_name for keyword in REMOTE_CONTROL_KEYWORDS + REMEMBER_KEYWORDS):
                continue
        try:
            is_remote, is_remember, label = classify_checkable(node)
        except Exception:
            continue
        if not is_remote and not is_remember:
            continue
        if is_remote:
            remote_control_present = True
        if is_checked(node):
            if is_remote:
                remote_control_enabled = True
            continue
        if invoke_action(node):
            time.sleep(0.5)
            # Verify the toggle actually flipped (GNOME/RHEL may ignore doAction
            # on libadwaita switches).  If it didn't, retry with coordinate click.
            if not is_checked(node):
                print('auto-share-retry-click:' + label, flush=True)
                atspi_click_at(node)
                time.sleep(0.5)
            toggled_any = True
            if is_remote:
                remote_control_enabled = True
            print('auto-share-enabled:' + label, flush=True)
    return remote_control_present, remote_control_enabled, toggled_any

def is_checked(node):
    if STATE_CHECKED is None:
        return False
    try:
        state_set = node.getState()
    except Exception:
        return False
    try:
        return state_set.contains(STATE_CHECKED)
    except Exception:
        return False

deadline = time.time() + TIMEOUT_SECONDS
while time.time() < deadline:
    try:
        desktop = pyatspi.Registry.getDesktop(0)
        app_count = desktop.childCount
    except Exception:
        time.sleep(0.15)
        continue
    for app_idx in range(app_count):
        try:
            app = desktop[app_idx]
        except Exception:
            continue
        try:
            app_name = safe_name(app).lower()
            is_portal_app = any(name in app_name for name in ('portal', 'gnome-remote-desktop', 'gnome remote desktop', 'mutter'))
            has_portal_context = looks_like_portal_context(app)
            if not has_portal_context:
                matched_descendant = None
                for node in iter_nodes(app):
                    if looks_like_portal_context(node):
                        matched_descendant = node
                        break
                has_portal_context = matched_descendant is not None
            if not has_portal_context and not is_portal_app:
                continue
            # Keep traversing the application root. GNOME screenshot portals
            # expose the approval text and Share button as sibling subtrees.
            remote_control_present, remote_control_enabled, toggled_any = maybe_enable_remote_controls(app)
            if remote_control_present and not remote_control_enabled:
                if toggled_any:
                    # Successfully invoked the toggle but AT-SPI still reports not enabled
                    # (RHEL/GNOME state-change lag). Give it a moment then fall through to
                    # click the Share button rather than looping indefinitely.
                    time.sleep(0.3)
                else:
                    time.sleep(0.15)
                    continue
            for node in iter_nodes(app):
                try:
                    if node.getRole() != BUTTON_ROLE:
                        continue
                    button_name = safe_name(node)
                except Exception:
                    continue
                nearby = nearby_labels(node)
                lower_name = button_name.lower()
                lowered_context = ' '.join(label.lower() for label in nearby)
                if not is_approve_candidate(button_name, nearby, lowered_context):
                    continue
                if invoke_action(node):
                    button_label = button_name or (nearby[0] if nearby else 'unnamed-approve')
                    print('auto-share-clicked:' + button_label, flush=True)
                    sys.exit(0)
        except Exception:
            continue
    time.sleep(0.15)
print('auto-share-timeout', file=sys.stderr, flush=True)
sys.exit(2)
`;
const A11Y_POINT_ACTION_SCRIPT = `
import pyatspi
import sys
import time

ACTION_NAMES = ('click', 'press', 'activate', 'open', 'default', '')
MAX_DESCENT = 4

def iter_nodes(node, depth=0):
    yield node
    if depth >= MAX_DESCENT:
        return
    try:
        count = node.childCount
    except Exception:
        return
    for idx in range(count):
        try:
            child = node[idx]
        except Exception:
            continue
        for nested in iter_nodes(child, depth + 1):
            yield nested

def invoke_action(node):
    try:
        action = node.queryAction()
    except Exception:
        return False
    try:
        total = action.nActions
    except Exception:
        total = 0
    for idx in range(total):
        try:
            action_name = (action.getName(idx) or '').strip().lower()
        except Exception:
            action_name = ''
        if action_name not in ACTION_NAMES:
            continue
        try:
            if action.doAction(idx):
                return True
        except Exception:
            continue
    return False

def node_at_point(x, y):
    try:
        desktop = pyatspi.Registry.getDesktop(0)
        app_count = desktop.childCount
    except Exception:
        return None
    for app_idx in range(app_count):
        try:
            app = desktop[app_idx]
            comp = app.queryComponent()
            node = comp.getAccessibleAtPoint(int(x), int(y), pyatspi.DESKTOP_COORDS)
            if node is not None:
                return node
        except Exception:
            continue
    return None

def candidate_nodes(seed):
    ordered = []
    seen = set()

    def push(node):
        if node is None:
            return
        key = id(node)
        if key in seen:
            return
        seen.add(key)
        ordered.append(node)

    current = seed
    while current is not None:
        push(current)
        try:
            current = current.parent
        except Exception:
            break

    for base in list(ordered):
        for nested in iter_nodes(base):
            push(nested)
    return ordered

def main():
    if len(sys.argv) < 3:
        print('missing-coordinate-args', file=sys.stderr, flush=True)
        return 2
    x = float(sys.argv[1])
    y = float(sys.argv[2])
    mode = (sys.argv[3] if len(sys.argv) > 3 else 'click').strip().lower()
    iterations = 2 if mode == 'double' else 1

    node = node_at_point(x, y)
    if node is None:
        print('a11y-point-miss', file=sys.stderr, flush=True)
        return 3
    candidates = candidate_nodes(node)
    if not candidates:
        print('a11y-candidates-empty', file=sys.stderr, flush=True)
        return 4

    for idx in range(iterations):
        clicked = False
        for candidate in candidates:
            if invoke_action(candidate):
                clicked = True
                break
        if not clicked:
            print('a11y-action-failed', file=sys.stderr, flush=True)
            return 5
        if idx + 1 < iterations:
            time.sleep(0.06)

    print('a11y-point-action-ok', flush=True)
    return 0

raise SystemExit(main())
`;
let _cachedPortalSession = null;
function sleep(ms) {
  return new _bluebird.Promise(resolve => setTimeout(resolve, ms));
}
function esc(value) {
  return `${value !== null && value !== void 0 ? value : ''}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hasCommand(command) {
  if (command === 'python3-pyatspi') {
    const res = (0, _child_process.spawnSync)('python3', ['-c', 'import pyatspi'], {
      stdio: 'ignore'
    });
    return res.status === 0;
  }
  const res = (0, _child_process.spawnSync)('which', [command], {
    stdio: 'ignore'
  });
  return res.status === 0;
}
function safeSpawn(command, args, opts = {}) {
  const res = (0, _child_process.spawnSync)(command, args, {
    encoding: 'utf8',
    ...opts
  });
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}
function parseKeyValueOutput(output) {
  const result = {};
  for (const rawLine of `${output !== null && output !== void 0 ? output : ''}`.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const idx = line.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
function unbox(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'signature') && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return unbox(value.value);
  }
  if (Array.isArray(value)) {
    return value.map(item => unbox(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = unbox(v);
    }
    return out;
  }
  return value;
}
function normalizeToken(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return `${value}`;
}
function createSessionHandleCandidatesFromRequestPath(requestPath, sessionHandleToken) {
  const match = /^\/org\/freedesktop\/portal\/desktop\/request\/([^/]+)\/[^/]+$/.exec(`${requestPath !== null && requestPath !== void 0 ? requestPath : ''}`);
  if (!match) {
    return [];
  }
  const senderSegment = match[1];
  const requestToken = `${requestPath !== null && requestPath !== void 0 ? requestPath : ''}`.split('/').pop();
  const candidates = [];
  if (requestToken) {
    candidates.push(`/org/freedesktop/portal/desktop/session/${senderSegment}/${requestToken}`);
  }
  const token = normalizeToken(sessionHandleToken);
  if (token) {
    const explicitTokenPath = `/org/freedesktop/portal/desktop/session/${senderSegment}/${token}`;
    if (!candidates.includes(explicitTokenPath)) {
      candidates.push(explicitTokenPath);
    }
  }
  return candidates;
}
function coerceBoolean(value, defaultValue = false) {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = `${value}`.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) {
    return false;
  }
  return defaultValue;
}
function firstExecToken(execLine) {
  const text = `${execLine !== null && execLine !== void 0 ? execLine : ''}`.trim();
  if (!text) {
    return '';
  }
  const match = /^"([^"]+)"|'([^']+)'|(\S+)/.exec(text);
  return match ? match[1] || match[2] || match[3] || '' : '';
}
function desktopEntryIdForFile(filePath) {
  return _path.default.basename(`${filePath !== null && filePath !== void 0 ? filePath : ''}`, '.desktop');
}
function findDesktopEntryIdsForApp(appName) {
  const appText = `${appName !== null && appName !== void 0 ? appName : ''}`.trim();
  if (!appText) {
    return [];
  }
  const appBaseName = _path.default.basename(appText).toLowerCase();
  const appPath = _path.default.isAbsolute(appText) ? appText : '';
  const matches = [];
  for (const dir of DESKTOP_ENTRY_DIRS) {
    if (!dir || !_fs.default.existsSync(dir)) {
      continue;
    }
    let entries = [];
    try {
      entries = _fs.default.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.desktop')) {
        continue;
      }
      const entryPath = _path.default.join(dir, entry);
      let content = '';
      try {
        content = _fs.default.readFileSync(entryPath, 'utf8');
      } catch {
        continue;
      }
      const execCommands = content.split('\n').map(line => line.trim()).filter(line => line.startsWith('Exec=')).map(line => firstExecToken(line.slice('Exec='.length))).filter(Boolean);
      const isMatch = execCommands.some(command => {
        const commandText = `${command !== null && command !== void 0 ? command : ''}`.trim();
        return commandText === appPath || _path.default.basename(commandText).toLowerCase() === appBaseName;
      });
      if (isMatch) {
        matches.push(desktopEntryIdForFile(entryPath));
      }
    }
  }
  return Array.from(new Set(matches));
}
class WaylandApis {
  constructor({
    appName,
    logger,
    waylandRestoreToken,
    waylandTokenStorePath,
    waylandAutoShare,
    nativeApis
  } = {}) {
    this.appName = appName;
    this._logger = logger;
    this._nativeApis = nativeApis || null;
    this._distroInfo = (0, _linuxPlatform.detectLinuxDistroInfo)();
    this._tokenStorePath = (0, _tokenStore.normalizeStorePath)(waylandTokenStorePath);
    this._restoreTokenFromCaps = waylandRestoreToken || null;
    this._restoreToken = null;
    this._waylandAutoShare = coerceBoolean(waylandAutoShare, true);
    this._waylandAutoShareTimeoutMs = DEFAULT_AUTO_SHARE_TIMEOUT_MS;
    this._portalAutoShareProc = null;
    this._portalAutoShareRestartTimer = null;
    this._portalAutoShareStopped = false;
    this._windowMap = new Map();
    this._windowList = [];
    this._desktopHierarchyCache = '';
    this._desktopHierarchyCacheAt = 0;
    this._desktopHierarchyCacheTtlMs = 30000;
    this._portal = {
      bus: null,
      remoteDesktop: null,
      screenCast: null,
      screenshot: null,
      registry: null,
      registeredAppId: null,
      sessionHandle: null,
      streamNodeId: null,
      logicalSize: null,
      grantedDevices: null,
      pointerAllowed: null,
      keyboardAllowed: null,
      remoteDesktopVersion: 0,
      screenCastVersion: 0,
      screenshotVersion: 0
    };
    this._hasWlCopy = hasCommand('wl-copy');
    this._hasWlPaste = hasCommand('wl-paste');
    this._hasGnomeScreenshot = hasCommand('gnome-screenshot');
    this._hasGrim = hasCommand('grim');
    this._compositorSettleMs = this._distroInfo.isRhelLike ? 10 : this._distroInfo.isUbuntu ? 5 : 0;
    this._buttonPressReleaseGapMs = this._distroInfo.isRhelLike ? 5 : this._distroInfo.isUbuntu ? 2 : 0;
    this._doubleClickIntervalMs = this._distroInfo.isRhelLike ? 80 : this._distroInfo.isUbuntu ? 70 : 60;
    this._keyTapInterDelayMs = 10;
  }
  _logInfo(msg) {
    var _this$_logger;
    if ((_this$_logger = this._logger) !== null && _this$_logger !== void 0 && _this$_logger.info) {
      this._logger.info(msg);
    }
  }
  _getNativeApis() {
    if (!this._nativeApis) {
      this._nativeApis = loadNativeApis();
    }
    return this._nativeApis;
  }
  _logWarn(msg) {
    var _this$_logger2;
    if ((_this$_logger2 = this._logger) !== null && _this$_logger2 !== void 0 && _this$_logger2.warn) {
      this._logger.warn(msg);
    }
  }
  _invalidateDesktopHierarchyCache() {
    this._desktopHierarchyCache = '';
    this._desktopHierarchyCacheAt = 0;
  }
  _invalidateWindowHierarchyXmlCache() {
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
  }
  _getDesktopHierarchy({
    force = false
  } = {}) {
    const now = Date.now();
    if (!force && this._desktopHierarchyCache && now - this._desktopHierarchyCacheAt <= this._desktopHierarchyCacheTtlMs) {
      return this._desktopHierarchyCache;
    }
    let desktop = '';
    try {
      desktop = this._getNativeApis().a11y_getDesktopUiHierachy();
    } catch {
      desktop = '';
    }
    if (desktop) {
      this._desktopHierarchyCache = desktop;
      this._desktopHierarchyCacheAt = now;
      return desktop;
    }
    return this._desktopHierarchyCache || '';
  }
  _startPortalAutoShareHelper() {
    if (!this._waylandAutoShare || this._portalAutoShareProc) {
      return;
    }
    if (this._portalAutoShareRestartTimer) {
      clearTimeout(this._portalAutoShareRestartTimer);
      this._portalAutoShareRestartTimer = null;
    }
    this._portalAutoShareStopped = false;
    const timeoutSeconds = Math.max(1, Math.ceil(this._waylandAutoShareTimeoutMs / 1000));
    const script = AUTO_SHARE_HELPER_SCRIPT.replace('__TIMEOUT_SECONDS__', `${timeoutSeconds}`);
    try {
      const proc = (0, _child_process.spawn)('python3', ['-c', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        }
      });
      this._portalAutoShareProc = proc;
      proc.stdout.on('data', chunk => {
        const msg = `${chunk !== null && chunk !== void 0 ? chunk : ''}`.trim();
        if (msg) {
          this._logInfo(`Wayland portal auto-share: ${msg}`);
        }
      });
      proc.stderr.on('data', chunk => {
        const msg = `${chunk !== null && chunk !== void 0 ? chunk : ''}`.trim();
        if (msg) {
          this._logWarn(`Wayland portal auto-share: ${msg}`);
        }
      });
      proc.on('error', error => {
        this._logWarn(`Wayland portal auto-share helper failed: ${error.message}`);
      });
      proc.on('exit', (code, signal) => {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        this._logInfo(`Wayland portal auto-share helper exited with ${status}`);
        if (this._portalAutoShareProc === proc) {
          this._portalAutoShareProc = null;
        }
        if (!signal && (code === 0 || code === 2) && !this._portalAutoShareStopped) {
          const reason = code === 0 ? 'handled a portal prompt' : 'timed out before the portal session was ready';
          this._logInfo(`Wayland portal auto-share helper ${reason}; restarting helper`);
          this._portalAutoShareRestartTimer = setTimeout(() => {
            this._portalAutoShareRestartTimer = null;
            this._startPortalAutoShareHelper();
          }, 250);
        }
      });
      this._logInfo(`Wayland portal auto-share helper started (timeout ${timeoutSeconds}s)`);
    } catch (error) {
      this._logWarn(`Failed to start Wayland portal auto-share helper: ${error.message}`);
    }
  }
  async _stopPortalAutoShareHelper() {
    this._portalAutoShareStopped = true;
    if (this._portalAutoShareRestartTimer) {
      clearTimeout(this._portalAutoShareRestartTimer);
      this._portalAutoShareRestartTimer = null;
    }
    const proc = this._portalAutoShareProc;
    this._portalAutoShareProc = null;
    if (!proc) {
      return;
    }
    if (proc.exitCode !== null || proc.signalCode) {
      return;
    }
    try {
      proc.kill('SIGTERM');
      await _bluebird.Promise.race([new _bluebird.Promise(resolve => proc.once('exit', resolve)), sleep(600)]);
      if (proc.exitCode === null && !proc.signalCode) {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
  async _runWithPortalAutoShare(fn) {
    const shouldSettleHelper = this._waylandAutoShare;
    this._startPortalAutoShareHelper();
    try {
      return await fn();
    } finally {
      if (shouldSettleHelper) {
        await sleep(1000);
      }
      await this._stopPortalAutoShareHelper();
    }
  }
  _isPersistUnsupportedError(error) {
    var _error$message;
    const message = `${(_error$message = error === null || error === void 0 ? void 0 : error.message) !== null && _error$message !== void 0 ? _error$message : ''}`.toLowerCase();
    return message.includes('cannot persist') || message.includes('sessions cannot persist');
  }
  _isPointerPermissionError(error) {
    var _error$message2;
    const message = `${(_error$message2 = error === null || error === void 0 ? void 0 : error.message) !== null && _error$message2 !== void 0 ? _error$message2 : ''}`.toLowerCase();
    return POINTER_PERMISSION_ERROR_TOKENS.some(token => message.includes(token));
  }
  _canContinueWithoutPortalPointerGrant(grantInfo) {
    return (grantInfo === null || grantInfo === void 0 ? void 0 : grantInfo.grantedDevices) === 0;
  }
  _runA11yPointAction(x, y, mode = 'click') {
    const _x = Number(x);
    const _y = Number(y);
    if (!Number.isFinite(_x) || !Number.isFinite(_y)) {
      return false;
    }
    const result = safeSpawn('python3', ['-c', A11Y_POINT_ACTION_SCRIPT, `${_x}`, `${_y}`, mode], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      }
    });
    if (result.ok) {
      const output = `${result.stdout || ''}`.trim();
      if (output) {
        this._logInfo(`Wayland a11y input fallback: ${output}`);
      }
      return true;
    }
    const details = [`${result.stdout || ''}`.trim(), `${result.stderr || ''}`.trim()].filter(Boolean).join(' | ');
    if (details) {
      this._logWarn(`Wayland a11y input fallback failed: ${details}`);
    }
    return false;
  }
  _clickViaA11yPointFallback(x, y, mode = 'click') {
    const _x = Number(x);
    const _y = Number(y);
    if (!Number.isFinite(_x) || !Number.isFinite(_y)) {
      return false;
    }
    const points = [[_x, _y], [_x - 3, _y], [_x + 3, _y], [_x, _y - 3], [_x, _y + 3]];
    for (const [px, py] of points) {
      if (this._runA11yPointAction(px, py, mode)) {
        return true;
      }
    }
    return false;
  }
  _getActiveUserSessionState() {
    var _process$getuid, _process$getuid2, _process, _details$LockedHint;
    const uid = `${(_process$getuid = (_process$getuid2 = (_process = process).getuid) === null || _process$getuid2 === void 0 ? void 0 : _process$getuid2.call(_process)) !== null && _process$getuid !== void 0 ? _process$getuid : ''}`;
    if (!uid) {
      return null;
    }
    const sessionsRes = safeSpawn('loginctl', ['list-sessions', '--no-legend']);
    if (!sessionsRes.ok || !sessionsRes.stdout) {
      return null;
    }
    const candidates = [];
    for (const rawLine of sessionsRes.stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 8) {
        continue;
      }
      const [id, rowUid, userName, seat, leader, klass, tty, active] = parts;
      if (rowUid !== uid) {
        continue;
      }
      candidates.push({
        id,
        uid: rowUid,
        userName,
        seat,
        leader,
        class: klass,
        tty,
        active
      });
    }
    if (candidates.length === 0) {
      return null;
    }
    const activeCandidates = candidates.filter(item => item.active === 'yes');
    const preferred = activeCandidates.find(item => item.seat !== '-') || activeCandidates[0] || candidates.find(item => item.seat !== '-') || candidates[0];
    if (!(preferred !== null && preferred !== void 0 && preferred.id)) {
      return null;
    }
    const showRes = safeSpawn('loginctl', ['show-session', preferred.id, '-p', 'LockedHint', '-p', 'Active', '-p', 'State', '-p', 'Type', '-p', 'Remote', '-p', 'Name']);
    if (!showRes.ok) {
      return {
        ...preferred,
        details: {},
        locked: null
      };
    }
    const details = parseKeyValueOutput(showRes.stdout);
    const lockedHint = `${(_details$LockedHint = details.LockedHint) !== null && _details$LockedHint !== void 0 ? _details$LockedHint : ''}`.toLowerCase();
    return {
      ...preferred,
      details,
      locked: lockedHint === 'yes'
    };
  }
  _mustUseWaylandSession() {
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
    if (sessionType !== 'wayland' && !process.env.WAYLAND_DISPLAY) {
      throw new Error('Wayland backend requested, but this process is not in a Wayland session. Set appium:linuxBackend to x11 or run under Wayland.');
    }
  }
  _runPreflightChecks() {
    const result = (0, _linuxPlatform.evaluateWaylandPreflight)({
      hasCommand,
      autoShareEnabled: this._waylandAutoShare,
      distroInfo: this._distroInfo
    });
    for (const warning of result.warnings) {
      this._logWarn(warning);
    }
    if (result.errors.length > 0) {
      const distro = (0, _linuxPlatform.formatDistroLabel)(this._distroInfo);
      throw new Error(`Wayland preflight failed on ${distro}:\n- ${result.errors.join('\n- ')}`);
    }
    const sessionState = this._getActiveUserSessionState();
    if ((sessionState === null || sessionState === void 0 ? void 0 : sessionState.locked) === true) {
      const sessionId = sessionState.id || 'unknown';
      throw new Error(`Wayland desktop session '${sessionId}' is locked. ` + `Unlock the GUI session (for example: loginctl unlock-session ${sessionId}) and retry.`);
    }
  }
  _nextToken(prefix) {
    const random = _crypto.default.randomBytes(8).toString('hex');
    return `${prefix}_${Date.now()}_${random}`;
  }
  async _getPortalInterfaceVersion(desktopObj, ifaceName) {
    try {
      const props = desktopObj.getInterface(DBUS_PROPS_IFACE);
      const result = await props.Get(ifaceName, 'version');
      const version = Number.parseInt(`${unbox(result)}`, 10);
      if (Number.isFinite(version) && version > 0) {
        return version;
      }
    } catch {}
    return 0;
  }
  async _registerPortalAppId() {
    if (!this._portal.registry) {
      return;
    }
    const candidates = findDesktopEntryIdsForApp(this.appName);
    if (candidates.length === 0) {
      this._logInfo(`Wayland portal app registration skipped; no desktop entry matched app '${this.appName || ''}'`);
      return;
    }
    for (const appId of candidates) {
      try {
        await this._portal.registry.Register(appId, {});
        this._portal.registeredAppId = appId;
        this._logInfo(`Wayland portal registered host app id '${appId}'`);
        return;
      } catch (error) {
        var _error$message3;
        const message = `${(_error$message3 = error === null || error === void 0 ? void 0 : error.message) !== null && _error$message3 !== void 0 ? _error$message3 : ''}`;
        if (message.toLowerCase().includes('connection already associated')) {
          this._portal.registeredAppId = appId;
          this._logInfo(`Wayland portal host app id was already registered (${appId})`);
          return;
        }
        this._logWarn(`Wayland portal app registration failed for '${appId}': ${message}`);
      }
    }
  }
  async _awaitPortalResponse(requestPath) {
    const obj = await this._portal.bus.getProxyObject(PORTAL_DEST, requestPath);
    const iface = obj.getInterface(PORTAL_REQUEST_IFACE);
    return await new _bluebird.Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        iface.removeListener('Response', onResponse);
        reject(new Error(`Portal request timed out for ${requestPath}`));
      }, 180000);
      const onResponse = (responseCode, results) => {
        clearTimeout(timeout);
        iface.removeListener('Response', onResponse);
        resolve({
          responseCode,
          results: unbox(results)
        });
      };
      iface.on('Response', onResponse);
    });
  }
  async _portalRequest(iface, methodName, ...args) {
    const requestPath = await iface[methodName](...args);
    let response = null;
    try {
      response = await this._awaitPortalResponse(requestPath);
    } catch (error) {
      var _error$message4;
      const message = `${(_error$message4 = error === null || error === void 0 ? void 0 : error.message) !== null && _error$message4 !== void 0 ? _error$message4 : ''}`;
      if (message.includes('interface not found in proxy object: org.freedesktop.portal.Request')) {
        this._logWarn(`Portal ${methodName} did not expose Request interface at '${requestPath}'. Falling back to immediate-result mode.`);
        if (methodName === 'CreateSession' && `${requestPath}`.includes('/session/')) {
          return {
            session_handle: `${requestPath}`
          };
        }
        if (methodName === 'CreateSession') {
          const createOptions = args[0] || {};
          const sessionHandleToken = unbox(createOptions === null || createOptions === void 0 ? void 0 : createOptions.session_handle_token);
          const synthesizedHandles = createSessionHandleCandidatesFromRequestPath(requestPath, sessionHandleToken);
          if (synthesizedHandles.length > 0) {
            const synthesizedHandle = synthesizedHandles[0];
            const altHandles = synthesizedHandles.slice(1);
            this._logWarn(`Portal CreateSession returned request path without Request interface. ` + `Synthesizing session handle '${synthesizedHandle}'` + (altHandles.length > 0 ? ` (alternates: ${altHandles.join(', ')})` : '') + '.');
            return {
              session_handle: synthesizedHandle
            };
          }
        }
        return {};
      }
      throw error;
    }
    const {
      responseCode,
      results
    } = response;
    if (responseCode !== 0) {
      const unboxedResults = results || {};
      const sessionState = methodName === 'CreateSession' ? this._getActiveUserSessionState() : null;
      if (methodName === 'CreateSession' && (sessionState === null || sessionState === void 0 ? void 0 : sessionState.locked) === true) {
        throw new Error(`Portal CreateSession failed with response code ${responseCode}: ` + `desktop session '${sessionState.id || 'unknown'}' is locked`);
      }
      const hasResultKeys = Object.keys(unboxedResults).length > 0;
      const details = hasResultKeys ? ` (details: ${JSON.stringify(unboxedResults)})` : '';
      throw new Error(`Portal ${methodName} failed with response code ${responseCode}${details}`);
    }
    return results || {};
  }
  async _openPortalSession() {
    const {
      Variant
    } = _dbusNext.default;
    this._portal.bus = _dbusNext.default.sessionBus();
    if (!this._portal.bus) {
      throw new Error('Could not connect to DBus session bus for xdg-desktop-portal');
    }
    const desktopObj = await this._portal.bus.getProxyObject(PORTAL_DEST, PORTAL_PATH);
    this._portal.remoteDesktop = desktopObj.getInterface(PORTAL_RD_IFACE);
    this._portal.screenCast = desktopObj.getInterface(PORTAL_SC_IFACE);
    try {
      this._portal.registry = desktopObj.getInterface(PORTAL_REGISTRY_IFACE);
    } catch {
      this._portal.registry = null;
    }
    await this._registerPortalAppId();
    try {
      this._portal.screenshot = desktopObj.getInterface(PORTAL_SS_IFACE);
    } catch {
      this._portal.screenshot = null;
    }
    this._portal.remoteDesktopVersion = await this._getPortalInterfaceVersion(desktopObj, PORTAL_RD_IFACE);
    this._portal.screenCastVersion = await this._getPortalInterfaceVersion(desktopObj, PORTAL_SC_IFACE);
    this._portal.screenshotVersion = await this._getPortalInterfaceVersion(desktopObj, PORTAL_SS_IFACE);
    if (this._portal.remoteDesktopVersion > 0 || this._portal.screenCastVersion > 0 || this._portal.screenshotVersion > 0) {
      this._logInfo(`Wayland portal interface versions: RemoteDesktop=${this._portal.remoteDesktopVersion || 'unknown'}, ` + `ScreenCast=${this._portal.screenCastVersion || 'unknown'}, ` + `Screenshot=${this._portal.screenshotVersion || 'unknown'}`);
    }
    const createOptions = {
      handle_token: new Variant('s', this._nextToken('rd_create')),
      session_handle_token: new Variant('s', this._nextToken('rd_session'))
    };
    const createResult = await this._portalRequest(this._portal.remoteDesktop, 'CreateSession', createOptions);
    const sessionHandle = createResult.session_handle;
    if (!sessionHandle) {
      throw new Error('Portal CreateSession succeeded but did not return session_handle');
    }
    this._portal.sessionHandle = sessionHandle;
    const supportsScreenCastPersist = this._portal.screenCastVersion >= 2;
    const supportsRemoteDesktopPersist = this._portal.remoteDesktopVersion >= 2;
    if (!supportsRemoteDesktopPersist) {
      this._logWarn(`RemoteDesktop portal v${this._portal.remoteDesktopVersion || 'unknown'} does not support persist_mode/restore_token. ` + 'Wayland share consent cannot be fully bypassed on this desktop backend.');
    }
    const sourceAttempts = [];
    if (this._restoreToken && supportsScreenCastPersist) {
      sourceAttempts.push({
        usePersist: true,
        useRestoreToken: true
      });
    } else if (this._restoreToken && !supportsScreenCastPersist) {
      this._logWarn(`ScreenCast portal v${this._portal.screenCastVersion || 'unknown'} does not support restore tokens. ` + 'Ignoring provided Wayland restore token.');
    }
    if (supportsScreenCastPersist) {
      sourceAttempts.push({
        usePersist: true,
        useRestoreToken: false
      });
    }
    sourceAttempts.push({
      usePersist: false,
      useRestoreToken: false
    });
    let selectedSources = false;
    let selectSourcesError = null;
    let persistActuallySupported = true;
    for (const attempt of sourceAttempts) {
      if (attempt.usePersist && !persistActuallySupported) {
        continue;
      }
      const sourceOptions = {
        handle_token: new Variant('s', this._nextToken('sc_sources')),
        types: new Variant('u', 1),
        multiple: new Variant('b', false),
        cursor_mode: new Variant('u', 2)
      };
      if (attempt.usePersist) {
        sourceOptions.persist_mode = new Variant('u', 2);
      }
      if (attempt.useRestoreToken && this._restoreToken) {
        sourceOptions.restore_token = new Variant('s', this._restoreToken);
      }
      try {
        await this._runWithPortalAutoShare(() => this._portalRequest(this._portal.screenCast, 'SelectSources', sessionHandle, sourceOptions));
        selectedSources = true;
        break;
      } catch (err) {
        if (attempt.usePersist && this._isPersistUnsupportedError(err)) {
          persistActuallySupported = false;
          this._logWarn('Portal does not support persisted screencast sessions. Retrying without persist_mode.');
        }
        selectSourcesError = err;
      }
    }
    if (!selectedSources && selectSourcesError) {
      throw selectSourcesError;
    }
    let selectedDevices = false;
    let selectDevicesError = null;
    const devicePersistModes = supportsRemoteDesktopPersist && persistActuallySupported ? [true, false] : [false];
    for (const usePersist of devicePersistModes) {
      const deviceOptions = {
        handle_token: new Variant('s', this._nextToken('rd_devices')),
        types: new Variant('u', _waylandPermissionUtils.DEVICE_TYPE_KEYBOARD | _waylandPermissionUtils.DEVICE_TYPE_POINTER)
      };
      if (usePersist) {
        deviceOptions.persist_mode = new Variant('u', 2);
      }
      try {
        await this._runWithPortalAutoShare(() => this._portalRequest(this._portal.remoteDesktop, 'SelectDevices', sessionHandle, deviceOptions));
        selectedDevices = true;
        break;
      } catch (err) {
        if (usePersist && this._isPersistUnsupportedError(err)) {
          this._logWarn('Portal does not support persisted remote-desktop sessions. Retrying without persist_mode.');
        }
        selectDevicesError = err;
      }
    }
    if (!selectedDevices && selectDevicesError) {
      throw selectDevicesError;
    }
    const startOptions = {
      handle_token: new Variant('s', this._nextToken('rd_start'))
    };
    let startResults = await this._runWithPortalAutoShare(() => this._portalRequest(this._portal.remoteDesktop, 'Start', sessionHandle, '', startOptions));
    startResults = startResults || {};
    const grantInfo = (0, _waylandPermissionUtils.parseWaylandGrantedDevices)(startResults.devices);
    if (grantInfo.grantedDevices !== null) {
      this._portal.grantedDevices = grantInfo.grantedDevices;
      this._portal.pointerAllowed = grantInfo.pointerAllowed;
      this._portal.keyboardAllowed = grantInfo.keyboardAllowed;
      this._logInfo(`Wayland portal granted devices=${grantInfo.grantedDevices} ` + `(keyboard=${this._portal.keyboardAllowed}, pointer=${this._portal.pointerAllowed}, ` + `touch=${grantInfo.touchAllowed})`);
    } else {
      this._portal.grantedDevices = null;
      this._portal.pointerAllowed = null;
      this._portal.keyboardAllowed = null;
      this._logWarn('Wayland portal Start did not report granted devices; pointer entitlement is unknown.');
    }
    try {
      (0, _waylandPermissionUtils.ensureWaylandPointerPermission)(grantInfo);
    } catch (error) {
      if (!this._canContinueWithoutPortalPointerGrant(grantInfo)) {
        throw error;
      }
      this._logWarn(`${error.message} Continuing with AT-SPI pointer fallback; ` + 'portal-only pointer, keyboard, swipe, and scroll actions may be unavailable.');
    }
    const streams = Array.isArray(startResults.streams) ? startResults.streams : [];
    if (streams.length > 0) {
      const firstStream = streams[0];
      let rawNodeId = null;
      let rawMeta = null;
      if (Array.isArray(firstStream) && firstStream.length > 0) {
        rawNodeId = firstStream[0];
        rawMeta = firstStream[1];
      } else if (firstStream !== null && typeof firstStream === 'object') {
        var _firstStream$, _firstStream$2;
        rawNodeId = (_firstStream$ = firstStream['0']) !== null && _firstStream$ !== void 0 ? _firstStream$ : firstStream[0];
        rawMeta = (_firstStream$2 = firstStream['1']) !== null && _firstStream$2 !== void 0 ? _firstStream$2 : firstStream[1];
      }
      const parsedNodeId = Number.parseInt(`${rawNodeId}`, 10);
      if (Number.isFinite(parsedNodeId)) {
        var _rawMeta;
        this._portal.streamNodeId = parsedNodeId;
        const size = (_rawMeta = rawMeta) === null || _rawMeta === void 0 ? void 0 : _rawMeta.size;
        if (Array.isArray(size) && size.length === 2) {
          this._portal.logicalSize = {
            width: Number.parseInt(`${size[0]}`, 10),
            height: Number.parseInt(`${size[1]}`, 10)
          };
        }
      } else {
        this._logWarn(`Wayland portal Start returned ${streams.length} stream(s) but stream node id could not be parsed ` + `(firstStream type=${Array.isArray(firstStream) ? 'array' : typeof firstStream}, ` + `rawNodeId=${JSON.stringify(rawNodeId)}). ` + 'Pointer absolute events will fall back to AT-SPI.');
      }
    }
    const rotatedToken = normalizeToken(startResults.restore_token || startResults.restore_data || null);
    if (rotatedToken) {
      this._restoreToken = rotatedToken;
      (0, _tokenStore.writeWaylandToken)(this._tokenStorePath, this.appName, rotatedToken);
      this._logInfo(`Wayland restore token updated at ${this._tokenStorePath}`);
    }
    this._logInfo('Wayland RemoteDesktop portal session is ready');
  }
  async initialize() {
    this._logInfo(`Wayland backend distro context: ${(0, _linuxPlatform.formatDistroLabel)(this._distroInfo)}`);
    this._runPreflightChecks();
    this._mustUseWaylandSession();
    _fs.default.mkdirSync('/tmp/.stdspa', {
      recursive: true
    });
    if (this._waylandAutoShare) {
      const timeoutSeconds = Math.max(1, Math.ceil(this._waylandAutoShareTimeoutMs / 1000));
      this._logInfo(`Wayland portal auto-share is enabled (timeout ${timeoutSeconds}s)`);
    } else {
      this._logInfo('Wayland portal auto-share is disabled');
    }
    if (this._restoreTokenFromCaps) {
      this._restoreToken = this._restoreTokenFromCaps;
    } else {
      const {
        token
      } = (0, _tokenStore.readWaylandToken)(this._tokenStorePath, this.appName);
      this._restoreToken = token;
    }
    if (_cachedPortalSession && _cachedPortalSession.bus && _cachedPortalSession.sessionHandle) {
      try {
        const desktopObj = await _cachedPortalSession.bus.getProxyObject(PORTAL_DEST, PORTAL_PATH);
        desktopObj.getInterface(PORTAL_RD_IFACE);
        Object.assign(this._portal, _cachedPortalSession);
        this._logInfo('Wayland portal session reused from cache (skipping portal setup)');
      } catch {
        this._logWarn('Cached portal session is stale; creating a new one');
        _cachedPortalSession = null;
        await this._openPortalSession();
      }
    } else {
      await this._openPortalSession();
    }
    _cachedPortalSession = {
      ...this._portal
    };
    this._refreshWindowCache();
    const screenshotFailure = (0, _waylandScreenshotUtils.getWaylandScreenshotFailureMessage)({
      portalAvailable: Boolean(this._portal.screenshot),
      hasGnomeScreenshot: this._hasGnomeScreenshot,
      hasGrim: this._hasGrim
    });
    if (screenshotFailure) {
      this._logWarn(screenshotFailure);
    }
    if (!this._hasWlCopy || !this._hasWlPaste) {
      this._logWarn('wl-copy / wl-paste not found. Clipboard commands will fallback to stdspa native APIs.');
    }
  }
  async dispose() {
    await this._stopPortalAutoShareHelper();
    this._windowList = [];
    this._windowMap.clear();
    this._desktopHierarchyCache = '';
    this._desktopHierarchyCacheAt = 0;
  }
  _refreshWindowCache(desktopXml = null) {
    var _desktop;
    let pids = this._getNativeApis().app_running(this.appName) || [];
    if (!pids || pids.length === 0) {
      const now = Date.now();
      if (this._pgrepPids && now - this._pgrepPidsAt < 3000) {
        pids = this._pgrepPids;
      } else {
        try {
          const baseName = (this.appName || '').split('/').pop();
          if (baseName) {
            const res = (0, _child_process.spawnSync)('pgrep', ['-f', baseName], {
              encoding: 'utf8',
              timeout: 3000
            });
            if (res.status === 0 && res.stdout) {
              pids = res.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
              this._pgrepPids = pids;
              this._pgrepPidsAt = now;
            }
          }
        } catch {}
      }
    }
    if (!pids || pids.length === 0) {
      this._windowList = [];
      this._windowMap.clear();
      return [];
    }
    let desktop = desktopXml;
    if (`${(_desktop = desktop) !== null && _desktop !== void 0 ? _desktop : ''}`.trim()) {
      this._desktopHierarchyCache = desktop;
      this._desktopHierarchyCacheAt = Date.now();
    } else {
      desktop = this._getDesktopHierarchy();
    }
    if (!desktop) {
      this._windowList = [];
      this._windowMap.clear();
      return [];
    }
    const previousWidByIdentity = new Map((this._windowList || []).map(window => [window.identityKey, window.wid]));
    const candidates = (0, _waylandWindowUtils.extractWaylandWindowCandidates)(desktop, pids);
    const {
      windows
    } = (0, _waylandWindowUtils.materializeWaylandWindows)(candidates, previousWidByIdentity);
    this._windowList = windows;
    this._windowMap.clear();
    for (const w of windows) {
      this._windowMap.set(w.wid, w);
    }
    return windows;
  }
  app_getWindowHierachy() {
    const now = Date.now();
    if (this._windowHierarchyXmlCache && now - this._windowHierarchyXmlCacheAt <= 2000) {
      return this._windowHierarchyXmlCache;
    }
    const windows = this._refreshWindowCache();
    const xml = windows.map(w => {
      const rect = `[${w.rect.x},${w.rect.y},${w.rect.width},${w.rect.height}]`;
      return `<window pid="${w.pid}" wid="${w.wid}" InputOutput="${w.inputOutput}" ` + `name="${esc(w.name)}" class="${esc(w.className)}" rect="${rect}" ` + `states="${esc(w.states)}" tag="${esc(w.nodeTag)}" ` + `window-type="${esc(w.windowType)}" identity="${esc(w.identityKey)}"/>`;
    }).join('');
    const result = `<windows>${xml}</windows>`;
    this._windowHierarchyXmlCache = result;
    this._windowHierarchyXmlCacheAt = now;
    return result;
  }
  app_getWinRect(wid) {
    const parsedWid = Number.parseInt(`${wid}`, 10);
    let win = this._windowMap.get(parsedWid);
    if (!win) {
      this._refreshWindowCache();
      win = this._windowMap.get(parsedWid);
    }
    if (!win) {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0
      };
    }
    return {
      x: win.rect.x,
      y: win.rect.y,
      width: win.rect.width,
      height: win.rect.height
    };
  }
  app_running(appPath) {
    return this._getNativeApis().app_running(appPath);
  }
  app_launch(appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._getNativeApis().app_launch(appPath);
  }
  app_kill(appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._getNativeApis().app_kill(appPath);
  }
  a11y_clear_cache() {
    return this._getNativeApis().a11y_clear_cache();
  }
  a11y_getWindowUiHierachy(windowName, pid) {
    return this._getNativeApis().a11y_getWindowUiHierachy(windowName, pid);
  }
  a11y_getWindowUiHierachyByHandle(wid, pid, windowName) {
    const parsedWid = Number.parseInt(`${wid}`, 10);
    let targetWindow = this._windowMap.get(parsedWid);
    const desktop = this._getDesktopHierarchy();
    if (!desktop) {
      throw new Error(`Wayland scoped window tree could not be resolved for wid=${wid}, name=${windowName}, pid=${pid}: desktop hierarchy is unavailable`);
    }
    if (!targetWindow) {
      this._refreshWindowCache(desktop);
      targetWindow = this._windowMap.get(parsedWid);
    }
    if (!targetWindow) {
      throw new Error(`Wayland scoped window tree could not be resolved for wid=${wid}, name=${windowName}, pid=${pid}: window handle is no longer present`);
    }
    const pids = this._getNativeApis().app_running(this.appName) || [];
    const resolved = (0, _waylandWindowUtils.resolveWaylandScopedWindowXml)(desktop, pids, targetWindow, {
      allowTransientOverlay: true
    });
    if (resolved.xml) {
      return resolved.xml;
    }
    const reason = resolved.reason === 'ambiguous' ? 'multiple matching window subtrees were found' : 'no matching window subtree was found';
    throw new Error(`Wayland scoped window tree could not be resolved for wid=${targetWindow.wid}, name=${targetWindow.name || windowName}, pid=${targetWindow.pid || pid}: ${reason}`);
  }
  a11y_getDesktopUiHierachy() {
    return this._getDesktopHierarchy();
  }
  a11y_checkWindowExists(windowName, pid) {
    try {
      if (this._getNativeApis().a11y_checkWindowExists(windowName, pid)) {
        return true;
      }
    } catch {}
    this._refreshWindowCache();
    const target = `${windowName !== null && windowName !== void 0 ? windowName : ''}`.trim();
    return this._windowList.some(w => {
      var _w$className;
      if (w.pid !== Number.parseInt(`${pid}`, 10)) {
        return false;
      }
      if (w.name === target) {
        return true;
      }
      const classes = `${(_w$className = w.className) !== null && _w$className !== void 0 ? _w$className : ''}`.split(/\s+/).filter(Boolean);
      return classes.includes(target);
    });
  }
  c_getMainDisplaySize() {
    var _this$_portal$logical, _this$_portal$logical2;
    if (((_this$_portal$logical = this._portal.logicalSize) === null || _this$_portal$logical === void 0 ? void 0 : _this$_portal$logical.width) > 0 && ((_this$_portal$logical2 = this._portal.logicalSize) === null || _this$_portal$logical2 === void 0 ? void 0 : _this$_portal$logical2.height) > 0) {
      return this._portal.logicalSize;
    }
    try {
      const nativeSize = this._getNativeApis().c_getMainDisplaySize();
      if ((nativeSize === null || nativeSize === void 0 ? void 0 : nativeSize.width) > 0 && (nativeSize === null || nativeSize === void 0 ? void 0 : nativeSize.height) > 0) {
        return nativeSize;
      }
    } catch {}
    this._refreshWindowCache();
    let width = 0;
    let height = 0;
    for (const w of this._windowList) {
      width = Math.max(width, w.rect.x + w.rect.width);
      height = Math.max(height, w.rect.y + w.rect.height);
    }
    return {
      width,
      height
    };
  }
  _ensurePortalReadyForPointer() {
    if (!this._portal.remoteDesktop || !this._portal.sessionHandle) {
      throw new Error('Wayland portal session is not ready for pointer events');
    }
    if (!Number.isFinite(this._portal.streamNodeId)) {
      throw new Error('Wayland portal did not provide a stream node id. Pointer absolute events are unavailable.');
    }
  }
  _isPortalReadyForPointer() {
    return Boolean(this._portal.remoteDesktop && this._portal.sessionHandle && Number.isFinite(this._portal.streamNodeId));
  }
  _buttonCode(button) {
    if (button === 3) {
      return POINTER_RIGHT;
    }
    if (button === 2) {
      return POINTER_MIDDLE;
    }
    return POINTER_LEFT;
  }
  async mouse_move(x, y) {
    if (this._portal.pointerAllowed === false) {
      throw new Error('Wayland portal session has no POINTER permission. Re-run and grant remote control access.');
    }
    this._ensurePortalReadyForPointer();
    try {
      await this._portal.remoteDesktop.NotifyPointerMotionAbsolute(this._portal.sessionHandle, {}, this._portal.streamNodeId, Number(x), Number(y));
    } catch (error) {
      if (this._isPointerPermissionError(error)) {
        this._portal.pointerAllowed = false;
        throw new Error('Wayland portal denied pointer motion events. ' + 'Re-run and ensure remote control/pointer access is granted in the share dialog.');
      }
      throw error;
    }
  }
  async mouse_click(x, y, button) {
    const buttonCode = this._buttonCode(button);
    if (this._isPortalReadyForPointer() && this._portal.pointerAllowed !== false) {
      try {
        await this.mouse_move(x, y);
        if (this._compositorSettleMs > 0) {
          await sleep(this._compositorSettleMs);
        }
        await this._portal.remoteDesktop.NotifyPointerButton(this._portal.sessionHandle, {}, buttonCode, 1);
        if (this._buttonPressReleaseGapMs > 0) {
          await sleep(this._buttonPressReleaseGapMs);
        }
        await this._portal.remoteDesktop.NotifyPointerButton(this._portal.sessionHandle, {}, buttonCode, 0);
        return;
      } catch (error) {
        if (this._isPointerPermissionError(error)) {
          this._portal.pointerAllowed = false;
          throw new Error('Wayland portal denied pointer button events. ' + 'Re-run and ensure remote control/pointer access is granted in the share dialog.');
        }
        this._logWarn(`Wayland portal click failed (${error.message}); trying AT-SPI fallback`);
      }
    }
    if ((button === 1 || button === undefined) && this._clickViaA11yPointFallback(x, y, 'click')) {
      this._logInfo(`Wayland click at (${x}, ${y}) succeeded via AT-SPI fallback`);
      return;
    }
    this._ensurePortalReadyForPointer();
  }
  async mouse_doubleClick(x, y, button) {
    if (!this._isPortalReadyForPointer() || this._portal.pointerAllowed === false) {
      if ((button === 1 || button === undefined) && this._clickViaA11yPointFallback(x, y, 'double')) {
        return;
      }
    }
    await this.mouse_click(x, y, button);
    await sleep(this._doubleClickIntervalMs);
    await this.mouse_click(x, y, button);
  }
  async mouse_swipe(sx, sy, ex, ey) {
    if (this._portal.pointerAllowed === false) {
      throw new Error('Wayland portal session has no POINTER permission. Re-run and grant remote control access.');
    }
    this._ensurePortalReadyForPointer();
    const steps = 18;
    try {
      await this.mouse_move(sx, sy);
      if (this._compositorSettleMs > 0) {
        await sleep(this._compositorSettleMs);
      }
      await this._portal.remoteDesktop.NotifyPointerButton(this._portal.sessionHandle, {}, POINTER_LEFT, 1);
      for (let i = 1; i <= steps; i++) {
        const x = sx + (ex - sx) * i / steps;
        const y = sy + (ey - sy) * i / steps;
        await this.mouse_move(x, y);
        await sleep(8);
      }
      await this._portal.remoteDesktop.NotifyPointerButton(this._portal.sessionHandle, {}, POINTER_LEFT, 0);
    } catch (error) {
      if (this._isPointerPermissionError(error)) {
        this._portal.pointerAllowed = false;
        throw new Error('Wayland portal denied pointer swipe events. ' + 'Re-run and ensure remote control/pointer access is granted in the share dialog.');
      }
      throw error;
    }
  }
  async mouse_scroll_x_y(x, y) {
    if (this._portal.pointerAllowed === false) {
      throw new Error('Wayland portal session has no POINTER permission. Re-run and grant remote control access.');
    }
    this._ensurePortalReadyForPointer();
    const horizontalSteps = Number.parseInt(`${x}`, 10) || 0;
    const verticalSteps = Number.parseInt(`${y}`, 10) || 0;
    const applyDiscrete = async (axis, steps) => {
      const count = Math.abs(steps);
      const direction = steps > 0 ? 1 : -1;
      for (let i = 0; i < count; i++) {
        await this._portal.remoteDesktop.NotifyPointerAxisDiscrete(this._portal.sessionHandle, {}, axis, direction);
      }
    };
    if (horizontalSteps !== 0) {
      try {
        await applyDiscrete(1, horizontalSteps);
      } catch (error) {
        if (this._isPointerPermissionError(error)) {
          this._portal.pointerAllowed = false;
          throw new Error('Wayland portal denied pointer scroll events. ' + 'Re-run and ensure remote control/pointer access is granted in the share dialog.');
        }
        throw error;
      }
    }
    if (verticalSteps !== 0) {
      try {
        await applyDiscrete(0, verticalSteps);
      } catch (error) {
        if (this._isPointerPermissionError(error)) {
          this._portal.pointerAllowed = false;
          throw new Error('Wayland portal denied pointer scroll events. ' + 'Re-run and ensure remote control/pointer access is granted in the share dialog.');
        }
        throw error;
      }
    }
  }
  _charToEvdevKeySpec(char) {
    const raw = `${char !== null && char !== void 0 ? char : ''}`;
    if (!raw) {
      return null;
    }
    const first = raw[0];
    const lower = first.toLowerCase();
    const baseMap = {
      a: 30,
      b: 48,
      c: 46,
      d: 32,
      e: 18,
      f: 33,
      g: 34,
      h: 35,
      i: 23,
      j: 36,
      k: 37,
      l: 38,
      m: 50,
      n: 49,
      o: 24,
      p: 25,
      q: 16,
      r: 19,
      s: 31,
      t: 20,
      u: 22,
      v: 47,
      w: 17,
      x: 45,
      y: 21,
      z: 44,
      1: 2,
      2: 3,
      3: 4,
      4: 5,
      5: 6,
      6: 7,
      7: 8,
      8: 9,
      9: 10,
      0: 11,
      ' ': 57,
      '-': 12,
      '=': 13,
      '[': 26,
      ']': 27,
      ';': 39,
      '\'': 40,
      ',': 51,
      '.': 52,
      '/': 53,
      '\\': 43,
      '`': 41
    };
    const shiftedMap = {
      '!': 2,
      '@': 3,
      '#': 4,
      '$': 5,
      '%': 6,
      '^': 7,
      '&': 8,
      '*': 9,
      '(': 10,
      ')': 11,
      _: 12,
      '+': 13,
      '{': 26,
      '}': 27,
      ':': 39,
      '"': 40,
      '<': 51,
      '>': 52,
      '?': 53,
      '|': 43,
      '~': 41
    };
    if (Object.prototype.hasOwnProperty.call(shiftedMap, first)) {
      return {
        evdev: shiftedMap[first],
        shift: true
      };
    }
    if (Object.prototype.hasOwnProperty.call(baseMap, lower)) {
      return {
        evdev: baseMap[lower],
        shift: first !== lower
      };
    }
    return null;
  }
  _charToEvdevKeycode(char) {
    var _this$_charToEvdevKey, _this$_charToEvdevKey2;
    return (_this$_charToEvdevKey = (_this$_charToEvdevKey2 = this._charToEvdevKeySpec(char)) === null || _this$_charToEvdevKey2 === void 0 ? void 0 : _this$_charToEvdevKey2.evdev) !== null && _this$_charToEvdevKey !== void 0 ? _this$_charToEvdevKey : null;
  }
  _keysymToEvdev(keysym) {
    var _map$keysym;
    const map = {
      65288: 14,
      65535: 111,
      65293: 28,
      65289: 15,
      65307: 1,
      65362: 103,
      65364: 108,
      65361: 105,
      65363: 106,
      65360: 102,
      65367: 107,
      65365: 104,
      65366: 109,
      65470: 59,
      65471: 60,
      65472: 61,
      65473: 62,
      65474: 63,
      65475: 64,
      65476: 65,
      65477: 66,
      65478: 67,
      65479: 68,
      65480: 87,
      65481: 88,
      65507: 29,
      65508: 97,
      65513: 56,
      65514: 100,
      65505: 42,
      65506: 54,
      65515: 125,
      65516: 126,
      32: 57
    };
    return (_map$keysym = map[keysym]) !== null && _map$keysym !== void 0 ? _map$keysym : null;
  }
  _modsFromFlags(flags) {
    const modCodes = [];
    const f = Number.parseInt(`${flags}`, 10) || 0;
    if (f & 1) {
      modCodes.push(42);
    }
    if (f & 4) {
      modCodes.push(29);
    }
    if (f & 8) {
      modCodes.push(56);
    }
    if (f & 64) {
      modCodes.push(125);
    }
    return modCodes;
  }
  async _notifyKeycode(keycode, state) {
    if (this._portal.keyboardAllowed === false) {
      throw new Error('Wayland portal session has no KEYBOARD permission. Re-run and grant remote control access.');
    }
    if (!this._portal.remoteDesktop || !this._portal.sessionHandle) {
      throw new Error('Wayland portal session is not ready for keyboard events');
    }
    await this._portal.remoteDesktop.NotifyKeyboardKeycode(this._portal.sessionHandle, {}, Number(keycode), Number(state));
  }
  async _tapEvdevWithMods(evdevCode, mods = []) {
    for (const mod of mods) {
      await this._notifyKeycode(mod, 1);
    }
    await this._notifyKeycode(evdevCode, 1);
    await this._notifyKeycode(evdevCode, 0);
    for (let i = mods.length - 1; i >= 0; i--) {
      await this._notifyKeycode(mods[i], 0);
    }
  }
  async keyboard_tapKeyCode(keycode, flags) {
    const evdev = this._keysymToEvdev(Number.parseInt(`${keycode}`, 10));
    if (!evdev) {
      throw new Error(`Unsupported keycode for Wayland backend: ${keycode}`);
    }
    await this._tapEvdevWithMods(evdev, this._modsFromFlags(flags));
  }
  async keyboard_toggleKeyCode(keycode, down, flags) {
    const evdev = this._keysymToEvdev(Number.parseInt(`${keycode}`, 10));
    if (!evdev) {
      throw new Error(`Unsupported keycode for Wayland backend: ${keycode}`);
    }
    const mods = this._modsFromFlags(flags);
    if (down) {
      for (const mod of mods) {
        await this._notifyKeycode(mod, 1);
      }
      await this._notifyKeycode(evdev, 1);
      return;
    }
    await this._notifyKeycode(evdev, 0);
    for (let i = mods.length - 1; i >= 0; i--) {
      await this._notifyKeycode(mods[i], 0);
    }
  }
  async keyboard_tapKey(c, flags) {
    const raw = `${c !== null && c !== void 0 ? c : ''}`;
    if (!raw) {
      return;
    }
    const spec = this._charToEvdevKeySpec(raw[0]);
    if (!spec) {
      throw new Error(`Unsupported key '${c}' for Wayland backend`);
    }
    const mods = this._modsFromFlags(flags);
    if (spec.shift && !mods.includes(42)) {
      mods.unshift(42);
    }
    await this._tapEvdevWithMods(spec.evdev, mods);
  }
  async keyboard_toggleKey(c, down, flags) {
    const raw = `${c !== null && c !== void 0 ? c : ''}`;
    if (!raw) {
      return;
    }
    const spec = this._charToEvdevKeySpec(raw[0]);
    if (!spec) {
      throw new Error(`Unsupported key '${c}' for Wayland backend`);
    }
    const mods = this._modsFromFlags(flags);
    if (spec.shift && !mods.includes(42)) {
      mods.unshift(42);
    }
    if (down) {
      for (const mod of mods) {
        await this._notifyKeycode(mod, 1);
      }
      await this._notifyKeycode(spec.evdev, 1);
      return;
    }
    await this._notifyKeycode(spec.evdev, 0);
    for (let i = mods.length - 1; i >= 0; i--) {
      await this._notifyKeycode(mods[i], 0);
    }
  }
  keyboard_copy(str) {
    if (this._hasWlCopy) {
      const result = safeSpawn('wl-copy', [], {
        input: `${str !== null && str !== void 0 ? str : ''}`
      });
      if (result.ok) {
        return;
      }
    }
    this._getNativeApis().keyboard_copy(str);
  }
  keyboard_getClipboardContent() {
    if (this._hasWlPaste) {
      const result = safeSpawn('wl-paste', ['-n']);
      if (result.ok) {
        return result.stdout;
      }
    }
    return this._getNativeApis().keyboard_getClipboardContent();
  }
  _canTypeStringDirectly(str) {
    return Array.from(`${str !== null && str !== void 0 ? str : ''}`).every(char => {
      if (!`${char !== null && char !== void 0 ? char : ''}`) {
        return true;
      }
      return Boolean(this._charToEvdevKeySpec(char));
    });
  }
  async keyboard_typeStringCopyPaste(str) {
    const text = `${str !== null && str !== void 0 ? str : ''}`;
    if (!text) {
      return;
    }
    if (this._canTypeStringDirectly(text)) {
      for (const char of Array.from(text)) {
        await this.keyboard_tapKey(char, 0);
        await sleep(this._keyTapInterDelayMs);
      }
      return;
    }
    this.keyboard_copy(text);
    await sleep(this._distroInfo.isRhelLike ? 120 : this._distroInfo.isUbuntu ? 100 : 80);
    await this.keyboard_tapKey('v', 4);
  }
  _resolveFileUriPath(uri) {
    const raw = `${uri !== null && uri !== void 0 ? uri : ''}`.trim();
    if (!raw) {
      return null;
    }
    if (raw.startsWith('/')) {
      return raw;
    }
    if (!raw.startsWith('file://')) {
      return null;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'file:') {
        return null;
      }
      return decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  async _captureByPortalScreenshot(outputPath) {
    if (!this._portal.screenshot) {
      return false;
    }
    const {
      Variant
    } = _dbusNext.default;
    const options = {
      handle_token: new Variant('s', this._nextToken('sshot')),
      interactive: new Variant('b', false),
      modal: new Variant('b', false)
    };
    this._startPortalAutoShareHelper();
    try {
      const screenshotResult = await this._portalRequest(this._portal.screenshot, 'Screenshot', '', options);
      const sourcePath = this._resolveFileUriPath(screenshotResult === null || screenshotResult === void 0 ? void 0 : screenshotResult.uri);
      if (!sourcePath || !_fs.default.existsSync(sourcePath)) {
        this._logWarn('Wayland portal screenshot returned no readable URI; falling back to CLI capture tools.');
        return false;
      }
      _fs.default.copyFileSync(sourcePath, outputPath);
      return true;
    } catch (error) {
      this._logWarn(`Wayland portal screenshot failed (${error.message}); falling back to CLI capture tools.`);
      return false;
    } finally {
      await this._stopPortalAutoShareHelper();
    }
  }
  async c_winscreenshot(wid, name) {
    const outputName = `${name || 'appiumdriver'}.png`;
    const outputPath = _path.default.join('/tmp/.stdspa', outputName);
    _fs.default.mkdirSync('/tmp/.stdspa', {
      recursive: true
    });
    const strategies = (0, _waylandScreenshotUtils.getWaylandScreenshotStrategies)({
      portalAvailable: Boolean(this._portal.screenshot),
      hasGnomeScreenshot: this._hasGnomeScreenshot,
      hasGrim: this._hasGrim
    });
    let captureOk = false;
    for (const strategy of strategies) {
      if (strategy === 'portal') {
        captureOk = await this._captureByPortalScreenshot(outputPath);
      } else if (strategy === 'gnome-screenshot') {
        captureOk = safeSpawn('gnome-screenshot', ['-f', outputPath]).ok;
      } else if (strategy === 'grim') {
        captureOk = safeSpawn('grim', [outputPath]).ok;
      }
      if (captureOk) {
        break;
      }
    }
    if (!captureOk || !_fs.default.existsSync(outputPath)) {
      return false;
    }
    const rect = this.app_getWinRect(wid);
    if (rect.width > 0 && rect.height > 0) {
      const left = Math.max(0, rect.x);
      const top = Math.max(0, rect.y);
      const tmpPath = `${outputPath}.tmp`;
      try {
        await (0, _sharp.default)(outputPath).extract({
          left,
          top,
          width: rect.width,
          height: rect.height
        }).png().toFile(tmpPath);
        _fs.default.renameSync(tmpPath, outputPath);
      } catch {
        if (_fs.default.existsSync(tmpPath)) {
          _fs.default.unlinkSync(tmpPath);
        }
      }
    }
    return true;
  }
}
var _default = exports.default = WaylandApis;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2JhY2tlbmRzL3dheWxhbmQtYXBpcy5qcyIsIm5hbWVzIjpbIl9mcyIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3BhdGgiLCJfY3J5cHRvIiwiX2NoaWxkX3Byb2Nlc3MiLCJfYmx1ZWJpcmQiLCJfZGJ1c05leHQiLCJfc2hhcnAiLCJfdG9rZW5TdG9yZSIsIl9saW51eFBsYXRmb3JtIiwiX3dheWxhbmRQZXJtaXNzaW9uVXRpbHMiLCJfd2F5bGFuZFNjcmVlbnNob3RVdGlscyIsIl93YXlsYW5kV2luZG93VXRpbHMiLCJQT1JUQUxfREVTVCIsIlBPUlRBTF9QQVRIIiwiREJVU19QUk9QU19JRkFDRSIsIlBPUlRBTF9SRVFVRVNUX0lGQUNFIiwiUE9SVEFMX1JEX0lGQUNFIiwiUE9SVEFMX1NDX0lGQUNFIiwiUE9SVEFMX1NTX0lGQUNFIiwiUE9SVEFMX1JFR0lTVFJZX0lGQUNFIiwiREVTS1RPUF9FTlRSWV9ESVJTIiwiT2JqZWN0IiwiZnJlZXplIiwicGF0aCIsImpvaW4iLCJwcm9jZXNzIiwiZW52IiwiSE9NRSIsImxvYWRlZE5hdGl2ZUFwaXMiLCJsb2FkTmF0aXZlQXBpcyIsIm5hdGl2ZU1vZHVsZSIsImRlZmF1bHQiLCJQT0lOVEVSX0xFRlQiLCJQT0lOVEVSX1JJR0hUIiwiUE9JTlRFUl9NSURETEUiLCJERUZBVUxUX0FVVE9fU0hBUkVfVElNRU9VVF9NUyIsIlBPSU5URVJfUEVSTUlTU0lPTl9FUlJPUl9UT0tFTlMiLCJBVVRPX1NIQVJFX0hFTFBFUl9TQ1JJUFQiLCJBMTFZX1BPSU5UX0FDVElPTl9TQ1JJUFQiLCJfY2FjaGVkUG9ydGFsU2Vzc2lvbiIsInNsZWVwIiwibXMiLCJQcm9taXNlIiwicmVzb2x2ZSIsInNldFRpbWVvdXQiLCJlc2MiLCJ2YWx1ZSIsInJlcGxhY2UiLCJoYXNDb21tYW5kIiwiY29tbWFuZCIsInJlcyIsInNwYXduU3luYyIsInN0ZGlvIiwic3RhdHVzIiwic2FmZVNwYXduIiwiYXJncyIsIm9wdHMiLCJlbmNvZGluZyIsIm9rIiwiY29kZSIsInN0ZG91dCIsInN0ZGVyciIsInBhcnNlS2V5VmFsdWVPdXRwdXQiLCJvdXRwdXQiLCJyZXN1bHQiLCJyYXdMaW5lIiwic3BsaXQiLCJsaW5lIiwidHJpbSIsImlkeCIsImluZGV4T2YiLCJrZXkiLCJzbGljZSIsInVuYm94IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiQXJyYXkiLCJpc0FycmF5IiwibWFwIiwiaXRlbSIsIm91dCIsImsiLCJ2IiwiZW50cmllcyIsIm5vcm1hbGl6ZVRva2VuIiwiSlNPTiIsInN0cmluZ2lmeSIsImNyZWF0ZVNlc3Npb25IYW5kbGVDYW5kaWRhdGVzRnJvbVJlcXVlc3RQYXRoIiwicmVxdWVzdFBhdGgiLCJzZXNzaW9uSGFuZGxlVG9rZW4iLCJtYXRjaCIsImV4ZWMiLCJzZW5kZXJTZWdtZW50IiwicmVxdWVzdFRva2VuIiwicG9wIiwiY2FuZGlkYXRlcyIsInB1c2giLCJ0b2tlbiIsImV4cGxpY2l0VG9rZW5QYXRoIiwiaW5jbHVkZXMiLCJjb2VyY2VCb29sZWFuIiwiZGVmYXVsdFZhbHVlIiwidW5kZWZpbmVkIiwidGV4dCIsInRvTG93ZXJDYXNlIiwiZmlyc3RFeGVjVG9rZW4iLCJleGVjTGluZSIsImRlc2t0b3BFbnRyeUlkRm9yRmlsZSIsImZpbGVQYXRoIiwiYmFzZW5hbWUiLCJmaW5kRGVza3RvcEVudHJ5SWRzRm9yQXBwIiwiYXBwTmFtZSIsImFwcFRleHQiLCJhcHBCYXNlTmFtZSIsImFwcFBhdGgiLCJpc0Fic29sdXRlIiwibWF0Y2hlcyIsImRpciIsImZzIiwiZXhpc3RzU3luYyIsInJlYWRkaXJTeW5jIiwiZW50cnkiLCJlbmRzV2l0aCIsImVudHJ5UGF0aCIsImNvbnRlbnQiLCJyZWFkRmlsZVN5bmMiLCJleGVjQ29tbWFuZHMiLCJmaWx0ZXIiLCJzdGFydHNXaXRoIiwibGVuZ3RoIiwiQm9vbGVhbiIsImlzTWF0Y2giLCJzb21lIiwiY29tbWFuZFRleHQiLCJmcm9tIiwiU2V0IiwiV2F5bGFuZEFwaXMiLCJjb25zdHJ1Y3RvciIsImxvZ2dlciIsIndheWxhbmRSZXN0b3JlVG9rZW4iLCJ3YXlsYW5kVG9rZW5TdG9yZVBhdGgiLCJ3YXlsYW5kQXV0b1NoYXJlIiwibmF0aXZlQXBpcyIsIl9sb2dnZXIiLCJfbmF0aXZlQXBpcyIsIl9kaXN0cm9JbmZvIiwiZGV0ZWN0TGludXhEaXN0cm9JbmZvIiwiX3Rva2VuU3RvcmVQYXRoIiwibm9ybWFsaXplU3RvcmVQYXRoIiwiX3Jlc3RvcmVUb2tlbkZyb21DYXBzIiwiX3Jlc3RvcmVUb2tlbiIsIl93YXlsYW5kQXV0b1NoYXJlIiwiX3dheWxhbmRBdXRvU2hhcmVUaW1lb3V0TXMiLCJfcG9ydGFsQXV0b1NoYXJlUHJvYyIsIl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIiLCJfcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCIsIl93aW5kb3dNYXAiLCJNYXAiLCJfd2luZG93TGlzdCIsIl9kZXNrdG9wSGllcmFyY2h5Q2FjaGUiLCJfZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQiLCJfZGVza3RvcEhpZXJhcmNoeUNhY2hlVHRsTXMiLCJfcG9ydGFsIiwiYnVzIiwicmVtb3RlRGVza3RvcCIsInNjcmVlbkNhc3QiLCJzY3JlZW5zaG90IiwicmVnaXN0cnkiLCJyZWdpc3RlcmVkQXBwSWQiLCJzZXNzaW9uSGFuZGxlIiwic3RyZWFtTm9kZUlkIiwibG9naWNhbFNpemUiLCJncmFudGVkRGV2aWNlcyIsInBvaW50ZXJBbGxvd2VkIiwia2V5Ym9hcmRBbGxvd2VkIiwicmVtb3RlRGVza3RvcFZlcnNpb24iLCJzY3JlZW5DYXN0VmVyc2lvbiIsInNjcmVlbnNob3RWZXJzaW9uIiwiX2hhc1dsQ29weSIsIl9oYXNXbFBhc3RlIiwiX2hhc0dub21lU2NyZWVuc2hvdCIsIl9oYXNHcmltIiwiX2NvbXBvc2l0b3JTZXR0bGVNcyIsImlzUmhlbExpa2UiLCJpc1VidW50dSIsIl9idXR0b25QcmVzc1JlbGVhc2VHYXBNcyIsIl9kb3VibGVDbGlja0ludGVydmFsTXMiLCJfa2V5VGFwSW50ZXJEZWxheU1zIiwiX2xvZ0luZm8iLCJtc2ciLCJfdGhpcyRfbG9nZ2VyIiwiaW5mbyIsIl9nZXROYXRpdmVBcGlzIiwiX2xvZ1dhcm4iLCJfdGhpcyRfbG9nZ2VyMiIsIndhcm4iLCJfaW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSIsIl9pbnZhbGlkYXRlV2luZG93SGllcmFyY2h5WG1sQ2FjaGUiLCJfd2luZG93SGllcmFyY2h5WG1sQ2FjaGUiLCJfd2luZG93SGllcmFyY2h5WG1sQ2FjaGVBdCIsIl9nZXREZXNrdG9wSGllcmFyY2h5IiwiZm9yY2UiLCJub3ciLCJEYXRlIiwiZGVza3RvcCIsImExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkiLCJfc3RhcnRQb3J0YWxBdXRvU2hhcmVIZWxwZXIiLCJjbGVhclRpbWVvdXQiLCJ0aW1lb3V0U2Vjb25kcyIsIk1hdGgiLCJtYXgiLCJjZWlsIiwic2NyaXB0IiwicHJvYyIsInNwYXduIiwiUFlUSE9OVU5CVUZGRVJFRCIsIm9uIiwiY2h1bmsiLCJlcnJvciIsIm1lc3NhZ2UiLCJzaWduYWwiLCJyZWFzb24iLCJfc3RvcFBvcnRhbEF1dG9TaGFyZUhlbHBlciIsImV4aXRDb2RlIiwic2lnbmFsQ29kZSIsImtpbGwiLCJyYWNlIiwib25jZSIsIl9ydW5XaXRoUG9ydGFsQXV0b1NoYXJlIiwiZm4iLCJzaG91bGRTZXR0bGVIZWxwZXIiLCJfaXNQZXJzaXN0VW5zdXBwb3J0ZWRFcnJvciIsIl9lcnJvciRtZXNzYWdlIiwiX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvciIsIl9lcnJvciRtZXNzYWdlMiIsIl9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQiLCJncmFudEluZm8iLCJfcnVuQTExeVBvaW50QWN0aW9uIiwieCIsInkiLCJtb2RlIiwiX3giLCJOdW1iZXIiLCJfeSIsImlzRmluaXRlIiwiZGV0YWlscyIsIl9jbGlja1ZpYUExMXlQb2ludEZhbGxiYWNrIiwicG9pbnRzIiwicHgiLCJweSIsIl9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlIiwiX3Byb2Nlc3MkZ2V0dWlkIiwiX3Byb2Nlc3MkZ2V0dWlkMiIsIl9wcm9jZXNzIiwiX2RldGFpbHMkTG9ja2VkSGludCIsInVpZCIsImdldHVpZCIsInNlc3Npb25zUmVzIiwicGFydHMiLCJpZCIsInJvd1VpZCIsInVzZXJOYW1lIiwic2VhdCIsImxlYWRlciIsImtsYXNzIiwidHR5IiwiYWN0aXZlIiwiY2xhc3MiLCJhY3RpdmVDYW5kaWRhdGVzIiwicHJlZmVycmVkIiwiZmluZCIsInNob3dSZXMiLCJsb2NrZWQiLCJsb2NrZWRIaW50IiwiTG9ja2VkSGludCIsIl9tdXN0VXNlV2F5bGFuZFNlc3Npb24iLCJzZXNzaW9uVHlwZSIsIlhER19TRVNTSU9OX1RZUEUiLCJXQVlMQU5EX0RJU1BMQVkiLCJFcnJvciIsIl9ydW5QcmVmbGlnaHRDaGVja3MiLCJldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQiLCJhdXRvU2hhcmVFbmFibGVkIiwiZGlzdHJvSW5mbyIsIndhcm5pbmciLCJ3YXJuaW5ncyIsImVycm9ycyIsImRpc3RybyIsImZvcm1hdERpc3Ryb0xhYmVsIiwic2Vzc2lvblN0YXRlIiwic2Vzc2lvbklkIiwiX25leHRUb2tlbiIsInByZWZpeCIsInJhbmRvbSIsImNyeXB0byIsInJhbmRvbUJ5dGVzIiwidG9TdHJpbmciLCJfZ2V0UG9ydGFsSW50ZXJmYWNlVmVyc2lvbiIsImRlc2t0b3BPYmoiLCJpZmFjZU5hbWUiLCJwcm9wcyIsImdldEludGVyZmFjZSIsIkdldCIsInZlcnNpb24iLCJwYXJzZUludCIsIl9yZWdpc3RlclBvcnRhbEFwcElkIiwiYXBwSWQiLCJSZWdpc3RlciIsIl9lcnJvciRtZXNzYWdlMyIsIl9hd2FpdFBvcnRhbFJlc3BvbnNlIiwib2JqIiwiZ2V0UHJveHlPYmplY3QiLCJpZmFjZSIsInJlamVjdCIsInRpbWVvdXQiLCJyZW1vdmVMaXN0ZW5lciIsIm9uUmVzcG9uc2UiLCJyZXNwb25zZUNvZGUiLCJyZXN1bHRzIiwiX3BvcnRhbFJlcXVlc3QiLCJtZXRob2ROYW1lIiwicmVzcG9uc2UiLCJfZXJyb3IkbWVzc2FnZTQiLCJzZXNzaW9uX2hhbmRsZSIsImNyZWF0ZU9wdGlvbnMiLCJzZXNzaW9uX2hhbmRsZV90b2tlbiIsInN5bnRoZXNpemVkSGFuZGxlcyIsInN5bnRoZXNpemVkSGFuZGxlIiwiYWx0SGFuZGxlcyIsInVuYm94ZWRSZXN1bHRzIiwiaGFzUmVzdWx0S2V5cyIsImtleXMiLCJfb3BlblBvcnRhbFNlc3Npb24iLCJWYXJpYW50IiwiZGJ1cyIsInNlc3Npb25CdXMiLCJoYW5kbGVfdG9rZW4iLCJjcmVhdGVSZXN1bHQiLCJzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0Iiwic3VwcG9ydHNSZW1vdGVEZXNrdG9wUGVyc2lzdCIsInNvdXJjZUF0dGVtcHRzIiwidXNlUGVyc2lzdCIsInVzZVJlc3RvcmVUb2tlbiIsInNlbGVjdGVkU291cmNlcyIsInNlbGVjdFNvdXJjZXNFcnJvciIsInBlcnNpc3RBY3R1YWxseVN1cHBvcnRlZCIsImF0dGVtcHQiLCJzb3VyY2VPcHRpb25zIiwidHlwZXMiLCJtdWx0aXBsZSIsImN1cnNvcl9tb2RlIiwicGVyc2lzdF9tb2RlIiwicmVzdG9yZV90b2tlbiIsImVyciIsInNlbGVjdGVkRGV2aWNlcyIsInNlbGVjdERldmljZXNFcnJvciIsImRldmljZVBlcnNpc3RNb2RlcyIsImRldmljZU9wdGlvbnMiLCJERVZJQ0VfVFlQRV9LRVlCT0FSRCIsIkRFVklDRV9UWVBFX1BPSU5URVIiLCJzdGFydE9wdGlvbnMiLCJzdGFydFJlc3VsdHMiLCJwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlcyIsImRldmljZXMiLCJ0b3VjaEFsbG93ZWQiLCJlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24iLCJzdHJlYW1zIiwiZmlyc3RTdHJlYW0iLCJyYXdOb2RlSWQiLCJyYXdNZXRhIiwiX2ZpcnN0U3RyZWFtJCIsIl9maXJzdFN0cmVhbSQyIiwicGFyc2VkTm9kZUlkIiwiX3Jhd01ldGEiLCJzaXplIiwid2lkdGgiLCJoZWlnaHQiLCJyb3RhdGVkVG9rZW4iLCJyZXN0b3JlX2RhdGEiLCJ3cml0ZVdheWxhbmRUb2tlbiIsImluaXRpYWxpemUiLCJta2RpclN5bmMiLCJyZWN1cnNpdmUiLCJyZWFkV2F5bGFuZFRva2VuIiwiYXNzaWduIiwiX3JlZnJlc2hXaW5kb3dDYWNoZSIsInNjcmVlbnNob3RGYWlsdXJlIiwiZ2V0V2F5bGFuZFNjcmVlbnNob3RGYWlsdXJlTWVzc2FnZSIsInBvcnRhbEF2YWlsYWJsZSIsImhhc0dub21lU2NyZWVuc2hvdCIsImhhc0dyaW0iLCJkaXNwb3NlIiwiY2xlYXIiLCJkZXNrdG9wWG1sIiwiX2Rlc2t0b3AiLCJwaWRzIiwiYXBwX3J1bm5pbmciLCJfcGdyZXBQaWRzIiwiX3BncmVwUGlkc0F0IiwiYmFzZU5hbWUiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJ3aW5kb3ciLCJpZGVudGl0eUtleSIsIndpZCIsImV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyIsIndpbmRvd3MiLCJtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzIiwidyIsInNldCIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsInhtbCIsInJlY3QiLCJwaWQiLCJpbnB1dE91dHB1dCIsIm5hbWUiLCJjbGFzc05hbWUiLCJzdGF0ZXMiLCJub2RlVGFnIiwid2luZG93VHlwZSIsImFwcF9nZXRXaW5SZWN0IiwicGFyc2VkV2lkIiwid2luIiwiZ2V0IiwiYXBwX2xhdW5jaCIsImFwcF9raWxsIiwiYTExeV9jbGVhcl9jYWNoZSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeSIsIndpbmRvd05hbWUiLCJhMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSIsInRhcmdldFdpbmRvdyIsInJlc29sdmVkIiwicmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwiLCJhbGxvd1RyYW5zaWVudE92ZXJsYXkiLCJhMTF5X2NoZWNrV2luZG93RXhpc3RzIiwidGFyZ2V0IiwiX3ckY2xhc3NOYW1lIiwiY2xhc3NlcyIsImNfZ2V0TWFpbkRpc3BsYXlTaXplIiwiX3RoaXMkX3BvcnRhbCRsb2dpY2FsIiwiX3RoaXMkX3BvcnRhbCRsb2dpY2FsMiIsIm5hdGl2ZVNpemUiLCJfZW5zdXJlUG9ydGFsUmVhZHlGb3JQb2ludGVyIiwiX2lzUG9ydGFsUmVhZHlGb3JQb2ludGVyIiwiX2J1dHRvbkNvZGUiLCJidXR0b24iLCJtb3VzZV9tb3ZlIiwiTm90aWZ5UG9pbnRlck1vdGlvbkFic29sdXRlIiwibW91c2VfY2xpY2siLCJidXR0b25Db2RlIiwiTm90aWZ5UG9pbnRlckJ1dHRvbiIsIm1vdXNlX2RvdWJsZUNsaWNrIiwibW91c2Vfc3dpcGUiLCJzeCIsInN5IiwiZXgiLCJleSIsInN0ZXBzIiwiaSIsIm1vdXNlX3Njcm9sbF94X3kiLCJob3Jpem9udGFsU3RlcHMiLCJ2ZXJ0aWNhbFN0ZXBzIiwiYXBwbHlEaXNjcmV0ZSIsImF4aXMiLCJjb3VudCIsImFicyIsImRpcmVjdGlvbiIsIk5vdGlmeVBvaW50ZXJBeGlzRGlzY3JldGUiLCJfY2hhclRvRXZkZXZLZXlTcGVjIiwiY2hhciIsInJhdyIsImZpcnN0IiwibG93ZXIiLCJiYXNlTWFwIiwiYSIsImIiLCJjIiwiZCIsImUiLCJmIiwiZyIsImgiLCJqIiwibCIsIm0iLCJuIiwibyIsInAiLCJxIiwiciIsInMiLCJ0IiwidSIsInoiLCJzaGlmdGVkTWFwIiwiXyIsImV2ZGV2Iiwic2hpZnQiLCJfY2hhclRvRXZkZXZLZXljb2RlIiwiX3RoaXMkX2NoYXJUb0V2ZGV2S2V5IiwiX3RoaXMkX2NoYXJUb0V2ZGV2S2V5MiIsIl9rZXlzeW1Ub0V2ZGV2Iiwia2V5c3ltIiwiX21hcCRrZXlzeW0iLCJfbW9kc0Zyb21GbGFncyIsImZsYWdzIiwibW9kQ29kZXMiLCJfbm90aWZ5S2V5Y29kZSIsImtleWNvZGUiLCJzdGF0ZSIsIk5vdGlmeUtleWJvYXJkS2V5Y29kZSIsIl90YXBFdmRldldpdGhNb2RzIiwiZXZkZXZDb2RlIiwibW9kcyIsIm1vZCIsImtleWJvYXJkX3RhcEtleUNvZGUiLCJrZXlib2FyZF90b2dnbGVLZXlDb2RlIiwiZG93biIsImtleWJvYXJkX3RhcEtleSIsInNwZWMiLCJ1bnNoaWZ0Iiwia2V5Ym9hcmRfdG9nZ2xlS2V5Iiwia2V5Ym9hcmRfY29weSIsInN0ciIsImlucHV0Iiwia2V5Ym9hcmRfZ2V0Q2xpcGJvYXJkQ29udGVudCIsIl9jYW5UeXBlU3RyaW5nRGlyZWN0bHkiLCJldmVyeSIsImtleWJvYXJkX3R5cGVTdHJpbmdDb3B5UGFzdGUiLCJfcmVzb2x2ZUZpbGVVcmlQYXRoIiwidXJpIiwicGFyc2VkIiwiVVJMIiwicHJvdG9jb2wiLCJkZWNvZGVVUklDb21wb25lbnQiLCJwYXRobmFtZSIsIl9jYXB0dXJlQnlQb3J0YWxTY3JlZW5zaG90Iiwib3V0cHV0UGF0aCIsIm9wdGlvbnMiLCJpbnRlcmFjdGl2ZSIsIm1vZGFsIiwic2NyZWVuc2hvdFJlc3VsdCIsInNvdXJjZVBhdGgiLCJjb3B5RmlsZVN5bmMiLCJjX3dpbnNjcmVlbnNob3QiLCJvdXRwdXROYW1lIiwic3RyYXRlZ2llcyIsImdldFdheWxhbmRTY3JlZW5zaG90U3RyYXRlZ2llcyIsImNhcHR1cmVPayIsInN0cmF0ZWd5IiwibGVmdCIsInRvcCIsInRtcFBhdGgiLCJzaGFycCIsImV4dHJhY3QiLCJwbmciLCJ0b0ZpbGUiLCJyZW5hbWVTeW5jIiwidW5saW5rU3luYyIsIl9kZWZhdWx0IiwiZXhwb3J0cyJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9iYWNrZW5kcy93YXlsYW5kLWFwaXMuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZzIGZyb20gJ2ZzJztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IGNyeXB0byBmcm9tICdjcnlwdG8nO1xuaW1wb3J0IHtzcGF3biwgc3Bhd25TeW5jfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7UHJvbWlzZX0gZnJvbSAnYmx1ZWJpcmQnO1xuaW1wb3J0IGRidXMgZnJvbSAnZGJ1cy1uZXh0JztcbmltcG9ydCBzaGFycCBmcm9tICdzaGFycCc7XG5pbXBvcnQge3JlYWRXYXlsYW5kVG9rZW4sIHdyaXRlV2F5bGFuZFRva2VuLCBub3JtYWxpemVTdG9yZVBhdGh9IGZyb20gJy4vdG9rZW4tc3RvcmUnO1xuaW1wb3J0IHtkZXRlY3RMaW51eERpc3Ryb0luZm8sIGV2YWx1YXRlV2F5bGFuZFByZWZsaWdodCwgZm9ybWF0RGlzdHJvTGFiZWx9IGZyb20gJy4vbGludXgtcGxhdGZvcm0uanMnO1xuaW1wb3J0IHtcbiAgREVWSUNFX1RZUEVfS0VZQk9BUkQsXG4gIERFVklDRV9UWVBFX1BPSU5URVIsXG4gIGVuc3VyZVdheWxhbmRQb2ludGVyUGVybWlzc2lvbixcbiAgcGFyc2VXYXlsYW5kR3JhbnRlZERldmljZXMsXG59IGZyb20gJy4vd2F5bGFuZC1wZXJtaXNzaW9uLXV0aWxzLmpzJztcbmltcG9ydCB7Z2V0V2F5bGFuZFNjcmVlbnNob3RTdHJhdGVnaWVzLCBnZXRXYXlsYW5kU2NyZWVuc2hvdEZhaWx1cmVNZXNzYWdlfSBmcm9tICcuL3dheWxhbmQtc2NyZWVuc2hvdC11dGlscy5qcyc7XG5pbXBvcnQge1xuICBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMsXG4gIG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MsXG4gIHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sLFxufSBmcm9tICcuL3dheWxhbmQtd2luZG93LXV0aWxzLmpzJztcblxuY29uc3QgUE9SVEFMX0RFU1QgPSAnb3JnLmZyZWVkZXNrdG9wLnBvcnRhbC5EZXNrdG9wJztcbmNvbnN0IFBPUlRBTF9QQVRIID0gJy9vcmcvZnJlZWRlc2t0b3AvcG9ydGFsL2Rlc2t0b3AnO1xuY29uc3QgREJVU19QUk9QU19JRkFDRSA9ICdvcmcuZnJlZWRlc2t0b3AuREJ1cy5Qcm9wZXJ0aWVzJztcbmNvbnN0IFBPUlRBTF9SRVFVRVNUX0lGQUNFID0gJ29yZy5mcmVlZGVza3RvcC5wb3J0YWwuUmVxdWVzdCc7XG5jb25zdCBQT1JUQUxfUkRfSUZBQ0UgPSAnb3JnLmZyZWVkZXNrdG9wLnBvcnRhbC5SZW1vdGVEZXNrdG9wJztcbmNvbnN0IFBPUlRBTF9TQ19JRkFDRSA9ICdvcmcuZnJlZWRlc2t0b3AucG9ydGFsLlNjcmVlbkNhc3QnO1xuY29uc3QgUE9SVEFMX1NTX0lGQUNFID0gJ29yZy5mcmVlZGVza3RvcC5wb3J0YWwuU2NyZWVuc2hvdCc7XG5jb25zdCBQT1JUQUxfUkVHSVNUUllfSUZBQ0UgPSAnb3JnLmZyZWVkZXNrdG9wLmhvc3QucG9ydGFsLlJlZ2lzdHJ5JztcbmNvbnN0IERFU0tUT1BfRU5UUllfRElSUyA9IE9iamVjdC5mcmVlemUoW1xuICAnL3Vzci9zaGFyZS9hcHBsaWNhdGlvbnMnLFxuICAnL3Vzci9sb2NhbC9zaGFyZS9hcHBsaWNhdGlvbnMnLFxuICBwYXRoLmpvaW4ocHJvY2Vzcy5lbnYuSE9NRSB8fCAnJywgJy5sb2NhbC9zaGFyZS9hcHBsaWNhdGlvbnMnKSxcbl0pO1xuXG5sZXQgbG9hZGVkTmF0aXZlQXBpcyA9IG51bGw7XG5cbmZ1bmN0aW9uIGxvYWROYXRpdmVBcGlzICgpIHtcbiAgaWYgKCFsb2FkZWROYXRpdmVBcGlzKSB7XG4gICAgY29uc3QgbmF0aXZlTW9kdWxlID0gcmVxdWlyZSgnQHN0ZHNwYS9zdGRzcGFsaW51eF90ZW1wL2Rpc3QvcHJpdmF0ZWFwaXMnKTtcbiAgICBsb2FkZWROYXRpdmVBcGlzID0gbmF0aXZlTW9kdWxlLmRlZmF1bHQgfHwgbmF0aXZlTW9kdWxlO1xuICB9XG4gIHJldHVybiBsb2FkZWROYXRpdmVBcGlzO1xufVxuXG5jb25zdCBQT0lOVEVSX0xFRlQgPSAyNzI7XG5jb25zdCBQT0lOVEVSX1JJR0hUID0gMjczO1xuY29uc3QgUE9JTlRFUl9NSURETEUgPSAyNzQ7XG4vLyAxNXMgaW5pdGlhbCB0aW1lb3V0IOKAlCB0aGUgaGVscGVyIGF1dG8tcmVzdGFydHMgb24gdGltZW91dCAoZXhpdCBjb2RlIDIpLFxuLy8gc28gaWYgR05PTUUgdGFrZXMgbG9uZ2VyIHRvIHNob3cgdGhlIGNvbnNlbnQgZGlhbG9nIGl0IHdpbGwgYmUgY2F1Z2h0IG9uXG4vLyB0aGUgbmV4dCBjeWNsZS4gIEEgc2hvcnRlciBmaXJzdCBjeWNsZSBtZWFucyB3ZSByZXN0YXJ0IGFuZCByZS1wb2xsIHNvb25lclxuLy8gd2hlbiB0aGUgZGlhbG9nIGFwcGVhcnMgaW4gdGhlIDE1LTMwcyB3aW5kb3cgKG9ic2VydmVkIG9uIFJIRUwgMTApLlxuY29uc3QgREVGQVVMVF9BVVRPX1NIQVJFX1RJTUVPVVRfTVMgPSAxNTAwMDtcbmNvbnN0IFBPSU5URVJfUEVSTUlTU0lPTl9FUlJPUl9UT0tFTlMgPSBbXG4gICdub3RpZnlwb2ludGVyJyxcbiAgJ3BvaW50ZXIgbWV0aG9kcycsXG4gICdwb2ludGVyIGFjY2VzcycsXG4gICd3aXRob3V0IHBvaW50ZXInLFxuICAnbm90IGFsbG93ZWQgdG8gY2FsbCcsXG5dO1xuY29uc3QgQVVUT19TSEFSRV9IRUxQRVJfU0NSSVBUID0gYFxuaW1wb3J0IHB5YXRzcGlcbmltcG9ydCBzeXNcbmltcG9ydCB0aW1lXG5cbkJVVFRPTl9ST0xFID0gcHlhdHNwaS5ST0xFX1BVU0hfQlVUVE9OXG5DSEVDS0JPWF9ST0xFID0gZ2V0YXR0cihweWF0c3BpLCAnUk9MRV9DSEVDS19CT1gnLCBOb25lKVxuVE9HR0xFX1JPTEUgPSBnZXRhdHRyKHB5YXRzcGksICdST0xFX1RPR0dMRV9CVVRUT04nLCBOb25lKVxuQ0hFQ0tBQkxFX1JPTEVTID0ge3IgZm9yIHIgaW4gKENIRUNLQk9YX1JPTEUsIFRPR0dMRV9ST0xFKSBpZiByIGlzIG5vdCBOb25lfVxuUkVNT1RFX0NPTlRST0xfUk9MRVMgPSBDSEVDS0FCTEVfUk9MRVMgfCB7QlVUVE9OX1JPTEV9XG5TVEFURV9DSEVDS0VEID0gZ2V0YXR0cihweWF0c3BpLCAnU1RBVEVfQ0hFQ0tFRCcsIE5vbmUpXG5SRU1PVEVfQ09OVFJPTF9LRVlXT1JEUyA9ICgncmVtb3RlJywgJ2NvbnRyb2wnLCAna2V5Ym9hcmQnLCAnbW91c2UnLCAnaW5wdXQnLCAnaW50ZXJhY3Rpb24nKVxuUkVNRU1CRVJfS0VZV09SRFMgPSAoJ3JlbWVtYmVyJywgJ3NlbGVjdGlvbicpXG5BUFBST1ZFX0tFWVdPUkRTID0gKCdzaGFyZScsICdhbGxvdycsICdncmFudCcpXG5DQVBUVVJFX0FQUFJPVkVfS0VZV09SRFMgPSAoJ2NhcHR1cmUnLCAnc2NyZWVuc2hvdCcpXG5SRUpFQ1RfS0VZV09SRFMgPSAoJ2NhbmNlbCcsICdkZW55JywgJ3N0b3AnKVxuUE9SVEFMX0NPTlRFWFRfS0VZV09SRFMgPSAoXG4gICAgJ3JlbW90ZSBkZXNrdG9wJyxcbiAgICAnc2hhcmUgeW91ciBzY3JlZW4nLFxuICAgICdhbGxvdyByZW1vdGUgaW50ZXJhY3Rpb24nLFxuICAgICd1bmtub3duIGRpc3BsYXknLFxuICAgICdyZW1lbWJlciB0aGlzIHNlbGVjdGlvbicsXG4gICAgJ2FsbG93IGFjY2VzcycsXG4gICAgJ3NjcmVlbiBzaGFyaW5nJyxcbiAgICAnYWxsb3cgY29udHJvbCcsXG4gICAgJ3JlbW90ZSBjb250cm9sJyxcbiAgICAnc2hhcmUgdGhpcyBzY3JlZW5zaG90JyxcbiAgICAncmVxdWVzdGluZyBhcHBsaWNhdGlvbicsXG4pXG5DQVBUVVJFX1BPUlRBTF9DT05URVhUX0tFWVdPUkRTID0gKFxuICAgICdzY3JlZW4gc2VsZWN0aW9uJyxcbiAgICAnd2luZG93IHNlbGVjdGlvbicsXG4gICAgJ2FyZWEgc2VsZWN0aW9uJyxcbiAgICAncmVjb3JkIHNjcmVlbicsXG4gICAgJ3Nob3cgcG9pbnRlcicsXG4gICAgJ3Rha2Ugc2NyZWVuc2hvdCcsXG4gICAgJ2NhcHR1cmUnLFxuICAgICdzY3JlZW5jYXN0JyxcbilcblRJTUVPVVRfU0VDT05EUyA9IF9fVElNRU9VVF9TRUNPTkRTX19cblxuZGVmIGl0ZXJfbm9kZXMobm9kZSk6XG4gICAgeWllbGQgbm9kZVxuICAgIHRyeTpcbiAgICAgICAgY291bnQgPSBub2RlLmNoaWxkQ291bnRcbiAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICByZXR1cm5cbiAgICBmb3IgaWR4IGluIHJhbmdlKGNvdW50KTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY2hpbGQgPSBub2RlW2lkeF1cbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGZvciBuZXN0ZWQgaW4gaXRlcl9ub2RlcyhjaGlsZCk6XG4gICAgICAgICAgICB5aWVsZCBuZXN0ZWRcblxuZGVmIGF0c3BpX2NsaWNrX2F0KG5vZGUpOlxuICAgIFwiXCJcIkNsaWNrIGF0IHRoZSBjZW50cmUgb2YgYSBub2RlIHVzaW5nIHB5YXRzcGkuUmVnaXN0cnkuZ2VuZXJhdGVNb3VzZUV2ZW50LlxuICAgIFdvcmtzIG9uIFdheWxhbmQgd2hlcmUgeGRvdG9vbCBkb2VzIG5vdC5cIlwiXCJcbiAgICB0cnk6XG4gICAgICAgIGNvbXAgPSBub2RlLnF1ZXJ5Q29tcG9uZW50KClcbiAgICAgICAgcmVjdCA9IGNvbXAuZ2V0RXh0ZW50cyhweWF0c3BpLkRFU0tUT1BfQ09PUkRTKVxuICAgICAgICBjeCA9IHJlY3QueCArIHJlY3Qud2lkdGggLy8gMlxuICAgICAgICBjeSA9IHJlY3QueSArIHJlY3QuaGVpZ2h0IC8vIDJcbiAgICAgICAgaWYgY3ggPD0gMCBvciBjeSA8PSAwOlxuICAgICAgICAgICAgcmV0dXJuIEZhbHNlXG4gICAgICAgIHB5YXRzcGkuUmVnaXN0cnkuZ2VuZXJhdGVNb3VzZUV2ZW50KGN4LCBjeSwgJ2IxYycpXG4gICAgICAgIHJldHVybiBUcnVlXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG5cbmRlZiBpbnZva2VfYWN0aW9uKG5vZGUpOlxuICAgICMgRmlyc3QgdHJ5IEFULVNQSSBkb0FjdGlvbiAod29ya3Mgb24gR1RLMyAvIHNvbWUgdG9vbGtpdHMpXG4gICAgY2FuZGlkYXRlcyA9IFtdXG4gICAgY3VycmVudCA9IG5vZGVcbiAgICB3aGlsZSBjdXJyZW50IGlzIG5vdCBOb25lIGFuZCBsZW4oY2FuZGlkYXRlcykgPCAzOlxuICAgICAgICBjYW5kaWRhdGVzLmFwcGVuZChjdXJyZW50KVxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnRcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGN1cnJlbnQgPSBOb25lXG4gICAgZm9yIGNhbmRpZGF0ZSBpbiBjYW5kaWRhdGVzOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBhY3Rpb24gPSBjYW5kaWRhdGUucXVlcnlBY3Rpb24oKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgdG90YWwgPSBhY3Rpb24ubkFjdGlvbnNcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIHRvdGFsID0gMFxuICAgICAgICBmb3IgaWR4IGluIHJhbmdlKHRvdGFsKTpcbiAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICBhY3Rpb25fbmFtZSA9IChhY3Rpb24uZ2V0TmFtZShpZHgpIG9yICcnKS5zdHJpcCgpLmxvd2VyKClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICAgICAgYWN0aW9uX25hbWUgPSAnJ1xuICAgICAgICAgICAgaWYgYWN0aW9uX25hbWUgaW4gKCdjbGljaycsICdwcmVzcycsICdhY3RpdmF0ZScsICd0b2dnbGUnLCAnY2hlY2snLCAnJyk6XG4gICAgICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgICAgICBpZiBhY3Rpb24uZG9BY3Rpb24oaWR4KTpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBUcnVlXG4gICAgICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICAjIEZhbGxiYWNrOiBjb29yZGluYXRlIGNsaWNrIHZpYSBBVC1TUEkgZ2VuZXJhdGVNb3VzZUV2ZW50IChuZWVkZWQgb25cbiAgICAjIEdOT01FIDQ2IC8gUkhFTCAxMCB3aGVyZSBkb0FjdGlvbiBvbiBsaWJhZHdhaXRhIHN3aXRjaGVzIGlzIGEgbm8tb3ApLlxuICAgIHJldHVybiBhdHNwaV9jbGlja19hdChub2RlKVxuXG5kZWYgc2FmZV9uYW1lKG5vZGUpOlxuICAgIHRyeTpcbiAgICAgICAgcmV0dXJuIChnZXRhdHRyKG5vZGUsICduYW1lJywgJycpIG9yICcnKS5zdHJpcCgpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuICcnXG5cbmRlZiBuZWFyYnlfbGFiZWxzKG5vZGUpOlxuICAgIGxhYmVscyA9IFtdXG4gICAgc2VlbiA9IHNldCgpXG5cbiAgICBkZWYgYWRkKGNhbmRpZGF0ZSk6XG4gICAgICAgIGlmIGNhbmRpZGF0ZSBpcyBOb25lOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGtleSA9IGlkKGNhbmRpZGF0ZSlcbiAgICAgICAgaWYga2V5IGluIHNlZW46XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgc2Vlbi5hZGQoa2V5KVxuICAgICAgICBuYW1lID0gc2FmZV9uYW1lKGNhbmRpZGF0ZSlcbiAgICAgICAgaWYgbmFtZTpcbiAgICAgICAgICAgIGxhYmVscy5hcHBlbmQobmFtZSlcblxuICAgIGFkZChub2RlKVxuICAgIHRyeTpcbiAgICAgICAgcGFyZW50ID0gbm9kZS5wYXJlbnRcbiAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICBwYXJlbnQgPSBOb25lXG4gICAgYWRkKHBhcmVudClcbiAgICB0cnk6XG4gICAgICAgIGdyYW5kcGFyZW50ID0gcGFyZW50LnBhcmVudCBpZiBwYXJlbnQgaXMgbm90IE5vbmUgZWxzZSBOb25lXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgZ3JhbmRwYXJlbnQgPSBOb25lXG4gICAgYWRkKGdyYW5kcGFyZW50KVxuICAgIHRyeTpcbiAgICAgICAgZ3JlYXRfZ3JhbmRwYXJlbnQgPSBncmFuZHBhcmVudC5wYXJlbnQgaWYgZ3JhbmRwYXJlbnQgaXMgbm90IE5vbmUgZWxzZSBOb25lXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgZ3JlYXRfZ3JhbmRwYXJlbnQgPSBOb25lXG4gICAgYWRkKGdyZWF0X2dyYW5kcGFyZW50KVxuXG4gICAgZm9yIGNhbmRpZGF0ZSBpbiAobm9kZSwgcGFyZW50LCBncmFuZHBhcmVudCwgZ3JlYXRfZ3JhbmRwYXJlbnQpOlxuICAgICAgICBpZiBjYW5kaWRhdGUgaXMgTm9uZTpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIGNvdW50ID0gY2FuZGlkYXRlLmNoaWxkQ291bnRcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvdW50ID0gMFxuICAgICAgICBmb3IgaWR4IGluIHJhbmdlKGNvdW50KTpcbiAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICBjaGlsZCA9IGNhbmRpZGF0ZVtpZHhdXG4gICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICBhZGQoY2hpbGQpXG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgZ3JhbmRjaGlsZF9jb3VudCA9IGNoaWxkLmNoaWxkQ291bnRcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICAgICAgZ3JhbmRjaGlsZF9jb3VudCA9IDBcbiAgICAgICAgICAgIGZvciBjaGlsZF9pZHggaW4gcmFuZ2UoZ3JhbmRjaGlsZF9jb3VudCk6XG4gICAgICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgICAgICBhZGQoY2hpbGRbY2hpbGRfaWR4XSlcbiAgICAgICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgIHJldHVybiBsYWJlbHNcblxuZGVmIGxvb2tzX2xpa2VfcG9ydGFsX2NvbnRleHQobm9kZSk6XG4gICAgbGFiZWxzID0gbmVhcmJ5X2xhYmVscyhub2RlKVxuICAgIGxvd2VyZWQgPSAnICcuam9pbihsYWJlbC5sb3dlcigpIGZvciBsYWJlbCBpbiBsYWJlbHMpXG4gICAgcmV0dXJuIChcbiAgICAgICAgYW55KGtleXdvcmQgaW4gbG93ZXJlZCBmb3Iga2V5d29yZCBpbiBQT1JUQUxfQ09OVEVYVF9LRVlXT1JEUykgb3JcbiAgICAgICAgYW55KGtleXdvcmQgaW4gbG93ZXJlZCBmb3Iga2V5d29yZCBpbiBDQVBUVVJFX1BPUlRBTF9DT05URVhUX0tFWVdPUkRTKVxuICAgIClcblxuZGVmIGxvb2tzX2xpa2VfY2FwdHVyZV9jb250ZXh0KGxvd2VyZWRfY29udGV4dCk6XG4gICAgcmV0dXJuIGFueShrZXl3b3JkIGluIGxvd2VyZWRfY29udGV4dCBmb3Iga2V5d29yZCBpbiBDQVBUVVJFX1BPUlRBTF9DT05URVhUX0tFWVdPUkRTKVxuXG5kZWYgaXNfYXBwcm92ZV9jYW5kaWRhdGUoYnV0dG9uX25hbWUsIG5lYXJieSwgbG93ZXJlZF9jb250ZXh0KTpcbiAgICBsb3dlcl9uYW1lID0gYnV0dG9uX25hbWUubG93ZXIoKVxuICAgIGxvd2VyZWRfcHJpbWFyeSA9ICcgJy5qb2luKGxhYmVsLmxvd2VyKCkgZm9yIGxhYmVsIGluIG5lYXJieVs6NF0pXG4gICAgaWYgYW55KGtleXdvcmQgaW4gbG93ZXJfbmFtZSBmb3Iga2V5d29yZCBpbiBSRUpFQ1RfS0VZV09SRFMpOlxuICAgICAgICByZXR1cm4gRmFsc2VcbiAgICBpZiBhbnkoa2V5d29yZCBpbiBsb3dlcl9uYW1lIGZvciBrZXl3b3JkIGluIEFQUFJPVkVfS0VZV09SRFMpOlxuICAgICAgICByZXR1cm4gVHJ1ZVxuICAgIGlmIG5vdCBsb29rc19saWtlX2NhcHR1cmVfY29udGV4dChsb3dlcmVkX2NvbnRleHQpOlxuICAgICAgICByZXR1cm4gRmFsc2VcbiAgICByZXR1cm4gYW55KGtleXdvcmQgaW4gbG93ZXJfbmFtZSBmb3Iga2V5d29yZCBpbiBDQVBUVVJFX0FQUFJPVkVfS0VZV09SRFMpXG5cbmRlZiBjbGFzc2lmeV9jaGVja2FibGUobm9kZSk6XG4gICAgbGFiZWxzID0gbmVhcmJ5X2xhYmVscyhub2RlKVxuICAgIGxvd2VyZWQgPSAnICcuam9pbihsYWJlbC5sb3dlcigpIGZvciBsYWJlbCBpbiBsYWJlbHMpXG4gICAgaXNfcmVtb3RlID0gYW55KGtleXdvcmQgaW4gbG93ZXJlZCBmb3Iga2V5d29yZCBpbiBSRU1PVEVfQ09OVFJPTF9LRVlXT1JEUylcbiAgICBpc19yZW1lbWJlciA9IGFueShrZXl3b3JkIGluIGxvd2VyZWQgZm9yIGtleXdvcmQgaW4gUkVNRU1CRVJfS0VZV09SRFMpXG4gICAgcHJpbWFyeSA9IGxhYmVsc1swXSBpZiBsYWJlbHMgZWxzZSAndW5uYW1lZC1jaGVja2FibGUnXG4gICAgcmV0dXJuIGlzX3JlbW90ZSwgaXNfcmVtZW1iZXIsIHByaW1hcnlcblxuZGVmIG1heWJlX2VuYWJsZV9yZW1vdGVfY29udHJvbHMoYXBwKTpcbiAgICByZW1vdGVfY29udHJvbF9wcmVzZW50ID0gRmFsc2VcbiAgICByZW1vdGVfY29udHJvbF9lbmFibGVkID0gRmFsc2VcbiAgICB0b2dnbGVkX2FueSA9IEZhbHNlXG4gICAgZm9yIG5vZGUgaW4gaXRlcl9ub2RlcyhhcHApOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICByb2xlID0gbm9kZS5nZXRSb2xlKClcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGlmIHJvbGUgbm90IGluIFJFTU9URV9DT05UUk9MX1JPTEVTOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgZGlyZWN0X25hbWUgPSBzYWZlX25hbWUobm9kZSkubG93ZXIoKVxuICAgICAgICBpZiByb2xlID09IEJVVFRPTl9ST0xFOlxuICAgICAgICAgICAgaWYgZGlyZWN0X25hbWUgaW4gKCdjYW5jZWwnLCAnc2hhcmUnLCAnYWxsb3cnLCAnZ3JhbnQnKTpcbiAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgICAgICAgICAgaWYgZGlyZWN0X25hbWUgYW5kIG5vdCBhbnkoa2V5d29yZCBpbiBkaXJlY3RfbmFtZSBmb3Iga2V5d29yZCBpbiBSRU1PVEVfQ09OVFJPTF9LRVlXT1JEUyArIFJFTUVNQkVSX0tFWVdPUkRTKTpcbiAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBpc19yZW1vdGUsIGlzX3JlbWVtYmVyLCBsYWJlbCA9IGNsYXNzaWZ5X2NoZWNrYWJsZShub2RlKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgaWYgbm90IGlzX3JlbW90ZSBhbmQgbm90IGlzX3JlbWVtYmVyOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgaWYgaXNfcmVtb3RlOlxuICAgICAgICAgICAgcmVtb3RlX2NvbnRyb2xfcHJlc2VudCA9IFRydWVcbiAgICAgICAgaWYgaXNfY2hlY2tlZChub2RlKTpcbiAgICAgICAgICAgIGlmIGlzX3JlbW90ZTpcbiAgICAgICAgICAgICAgICByZW1vdGVfY29udHJvbF9lbmFibGVkID0gVHJ1ZVxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgaWYgaW52b2tlX2FjdGlvbihub2RlKTpcbiAgICAgICAgICAgIHRpbWUuc2xlZXAoMC41KVxuICAgICAgICAgICAgIyBWZXJpZnkgdGhlIHRvZ2dsZSBhY3R1YWxseSBmbGlwcGVkIChHTk9NRS9SSEVMIG1heSBpZ25vcmUgZG9BY3Rpb25cbiAgICAgICAgICAgICMgb24gbGliYWR3YWl0YSBzd2l0Y2hlcykuICBJZiBpdCBkaWRuJ3QsIHJldHJ5IHdpdGggY29vcmRpbmF0ZSBjbGljay5cbiAgICAgICAgICAgIGlmIG5vdCBpc19jaGVja2VkKG5vZGUpOlxuICAgICAgICAgICAgICAgIHByaW50KCdhdXRvLXNoYXJlLXJldHJ5LWNsaWNrOicgKyBsYWJlbCwgZmx1c2g9VHJ1ZSlcbiAgICAgICAgICAgICAgICBhdHNwaV9jbGlja19hdChub2RlKVxuICAgICAgICAgICAgICAgIHRpbWUuc2xlZXAoMC41KVxuICAgICAgICAgICAgdG9nZ2xlZF9hbnkgPSBUcnVlXG4gICAgICAgICAgICBpZiBpc19yZW1vdGU6XG4gICAgICAgICAgICAgICAgcmVtb3RlX2NvbnRyb2xfZW5hYmxlZCA9IFRydWVcbiAgICAgICAgICAgIHByaW50KCdhdXRvLXNoYXJlLWVuYWJsZWQ6JyArIGxhYmVsLCBmbHVzaD1UcnVlKVxuICAgIHJldHVybiByZW1vdGVfY29udHJvbF9wcmVzZW50LCByZW1vdGVfY29udHJvbF9lbmFibGVkLCB0b2dnbGVkX2FueVxuXG5kZWYgaXNfY2hlY2tlZChub2RlKTpcbiAgICBpZiBTVEFURV9DSEVDS0VEIGlzIE5vbmU6XG4gICAgICAgIHJldHVybiBGYWxzZVxuICAgIHRyeTpcbiAgICAgICAgc3RhdGVfc2V0ID0gbm9kZS5nZXRTdGF0ZSgpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG4gICAgdHJ5OlxuICAgICAgICByZXR1cm4gc3RhdGVfc2V0LmNvbnRhaW5zKFNUQVRFX0NIRUNLRUQpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG5cbmRlYWRsaW5lID0gdGltZS50aW1lKCkgKyBUSU1FT1VUX1NFQ09ORFNcbndoaWxlIHRpbWUudGltZSgpIDwgZGVhZGxpbmU6XG4gICAgdHJ5OlxuICAgICAgICBkZXNrdG9wID0gcHlhdHNwaS5SZWdpc3RyeS5nZXREZXNrdG9wKDApXG4gICAgICAgIGFwcF9jb3VudCA9IGRlc2t0b3AuY2hpbGRDb3VudFxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHRpbWUuc2xlZXAoMC4xNSlcbiAgICAgICAgY29udGludWVcbiAgICBmb3IgYXBwX2lkeCBpbiByYW5nZShhcHBfY291bnQpOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBhcHAgPSBkZXNrdG9wW2FwcF9pZHhdXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBhcHBfbmFtZSA9IHNhZmVfbmFtZShhcHApLmxvd2VyKClcbiAgICAgICAgICAgIGlzX3BvcnRhbF9hcHAgPSBhbnkobmFtZSBpbiBhcHBfbmFtZSBmb3IgbmFtZSBpbiAoJ3BvcnRhbCcsICdnbm9tZS1yZW1vdGUtZGVza3RvcCcsICdnbm9tZSByZW1vdGUgZGVza3RvcCcsICdtdXR0ZXInKSlcbiAgICAgICAgICAgIGhhc19wb3J0YWxfY29udGV4dCA9IGxvb2tzX2xpa2VfcG9ydGFsX2NvbnRleHQoYXBwKVxuICAgICAgICAgICAgaWYgbm90IGhhc19wb3J0YWxfY29udGV4dDpcbiAgICAgICAgICAgICAgICBtYXRjaGVkX2Rlc2NlbmRhbnQgPSBOb25lXG4gICAgICAgICAgICAgICAgZm9yIG5vZGUgaW4gaXRlcl9ub2RlcyhhcHApOlxuICAgICAgICAgICAgICAgICAgICBpZiBsb29rc19saWtlX3BvcnRhbF9jb250ZXh0KG5vZGUpOlxuICAgICAgICAgICAgICAgICAgICAgICAgbWF0Y2hlZF9kZXNjZW5kYW50ID0gbm9kZVxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAgICAgICBoYXNfcG9ydGFsX2NvbnRleHQgPSBtYXRjaGVkX2Rlc2NlbmRhbnQgaXMgbm90IE5vbmVcbiAgICAgICAgICAgIGlmIG5vdCBoYXNfcG9ydGFsX2NvbnRleHQgYW5kIG5vdCBpc19wb3J0YWxfYXBwOlxuICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICAjIEtlZXAgdHJhdmVyc2luZyB0aGUgYXBwbGljYXRpb24gcm9vdC4gR05PTUUgc2NyZWVuc2hvdCBwb3J0YWxzXG4gICAgICAgICAgICAjIGV4cG9zZSB0aGUgYXBwcm92YWwgdGV4dCBhbmQgU2hhcmUgYnV0dG9uIGFzIHNpYmxpbmcgc3VidHJlZXMuXG4gICAgICAgICAgICByZW1vdGVfY29udHJvbF9wcmVzZW50LCByZW1vdGVfY29udHJvbF9lbmFibGVkLCB0b2dnbGVkX2FueSA9IG1heWJlX2VuYWJsZV9yZW1vdGVfY29udHJvbHMoYXBwKVxuICAgICAgICAgICAgaWYgcmVtb3RlX2NvbnRyb2xfcHJlc2VudCBhbmQgbm90IHJlbW90ZV9jb250cm9sX2VuYWJsZWQ6XG4gICAgICAgICAgICAgICAgaWYgdG9nZ2xlZF9hbnk6XG4gICAgICAgICAgICAgICAgICAgICMgU3VjY2Vzc2Z1bGx5IGludm9rZWQgdGhlIHRvZ2dsZSBidXQgQVQtU1BJIHN0aWxsIHJlcG9ydHMgbm90IGVuYWJsZWRcbiAgICAgICAgICAgICAgICAgICAgIyAoUkhFTC9HTk9NRSBzdGF0ZS1jaGFuZ2UgbGFnKS4gR2l2ZSBpdCBhIG1vbWVudCB0aGVuIGZhbGwgdGhyb3VnaCB0b1xuICAgICAgICAgICAgICAgICAgICAjIGNsaWNrIHRoZSBTaGFyZSBidXR0b24gcmF0aGVyIHRoYW4gbG9vcGluZyBpbmRlZmluaXRlbHkuXG4gICAgICAgICAgICAgICAgICAgIHRpbWUuc2xlZXAoMC4zKVxuICAgICAgICAgICAgICAgIGVsc2U6XG4gICAgICAgICAgICAgICAgICAgIHRpbWUuc2xlZXAoMC4xNSlcbiAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgIGZvciBub2RlIGluIGl0ZXJfbm9kZXMoYXBwKTpcbiAgICAgICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgICAgIGlmIG5vZGUuZ2V0Um9sZSgpICE9IEJVVFRPTl9ST0xFOlxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgICAgICAgICAgYnV0dG9uX25hbWUgPSBzYWZlX25hbWUobm9kZSlcbiAgICAgICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgICAgICAgICAgICAgIG5lYXJieSA9IG5lYXJieV9sYWJlbHMobm9kZSlcbiAgICAgICAgICAgICAgICBsb3dlcl9uYW1lID0gYnV0dG9uX25hbWUubG93ZXIoKVxuICAgICAgICAgICAgICAgIGxvd2VyZWRfY29udGV4dCA9ICcgJy5qb2luKGxhYmVsLmxvd2VyKCkgZm9yIGxhYmVsIGluIG5lYXJieSlcbiAgICAgICAgICAgICAgICBpZiBub3QgaXNfYXBwcm92ZV9jYW5kaWRhdGUoYnV0dG9uX25hbWUsIG5lYXJieSwgbG93ZXJlZF9jb250ZXh0KTpcbiAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgICAgICBpZiBpbnZva2VfYWN0aW9uKG5vZGUpOlxuICAgICAgICAgICAgICAgICAgICBidXR0b25fbGFiZWwgPSBidXR0b25fbmFtZSBvciAobmVhcmJ5WzBdIGlmIG5lYXJieSBlbHNlICd1bm5hbWVkLWFwcHJvdmUnKVxuICAgICAgICAgICAgICAgICAgICBwcmludCgnYXV0by1zaGFyZS1jbGlja2VkOicgKyBidXR0b25fbGFiZWwsIGZsdXNoPVRydWUpXG4gICAgICAgICAgICAgICAgICAgIHN5cy5leGl0KDApXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb250aW51ZVxuICAgIHRpbWUuc2xlZXAoMC4xNSlcbnByaW50KCdhdXRvLXNoYXJlLXRpbWVvdXQnLCBmaWxlPXN5cy5zdGRlcnIsIGZsdXNoPVRydWUpXG5zeXMuZXhpdCgyKVxuYDtcbmNvbnN0IEExMVlfUE9JTlRfQUNUSU9OX1NDUklQVCA9IGBcbmltcG9ydCBweWF0c3BpXG5pbXBvcnQgc3lzXG5pbXBvcnQgdGltZVxuXG5BQ1RJT05fTkFNRVMgPSAoJ2NsaWNrJywgJ3ByZXNzJywgJ2FjdGl2YXRlJywgJ29wZW4nLCAnZGVmYXVsdCcsICcnKVxuTUFYX0RFU0NFTlQgPSA0XG5cbmRlZiBpdGVyX25vZGVzKG5vZGUsIGRlcHRoPTApOlxuICAgIHlpZWxkIG5vZGVcbiAgICBpZiBkZXB0aCA+PSBNQVhfREVTQ0VOVDpcbiAgICAgICAgcmV0dXJuXG4gICAgdHJ5OlxuICAgICAgICBjb3VudCA9IG5vZGUuY2hpbGRDb3VudFxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVyblxuICAgIGZvciBpZHggaW4gcmFuZ2UoY291bnQpOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBjaGlsZCA9IG5vZGVbaWR4XVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgZm9yIG5lc3RlZCBpbiBpdGVyX25vZGVzKGNoaWxkLCBkZXB0aCArIDEpOlxuICAgICAgICAgICAgeWllbGQgbmVzdGVkXG5cbmRlZiBpbnZva2VfYWN0aW9uKG5vZGUpOlxuICAgIHRyeTpcbiAgICAgICAgYWN0aW9uID0gbm9kZS5xdWVyeUFjdGlvbigpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG4gICAgdHJ5OlxuICAgICAgICB0b3RhbCA9IGFjdGlvbi5uQWN0aW9uc1xuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHRvdGFsID0gMFxuICAgIGZvciBpZHggaW4gcmFuZ2UodG90YWwpOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBhY3Rpb25fbmFtZSA9IChhY3Rpb24uZ2V0TmFtZShpZHgpIG9yICcnKS5zdHJpcCgpLmxvd2VyKClcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGFjdGlvbl9uYW1lID0gJydcbiAgICAgICAgaWYgYWN0aW9uX25hbWUgbm90IGluIEFDVElPTl9OQU1FUzpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIGlmIGFjdGlvbi5kb0FjdGlvbihpZHgpOlxuICAgICAgICAgICAgICAgIHJldHVybiBUcnVlXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb250aW51ZVxuICAgIHJldHVybiBGYWxzZVxuXG5kZWYgbm9kZV9hdF9wb2ludCh4LCB5KTpcbiAgICB0cnk6XG4gICAgICAgIGRlc2t0b3AgPSBweWF0c3BpLlJlZ2lzdHJ5LmdldERlc2t0b3AoMClcbiAgICAgICAgYXBwX2NvdW50ID0gZGVza3RvcC5jaGlsZENvdW50XG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuIE5vbmVcbiAgICBmb3IgYXBwX2lkeCBpbiByYW5nZShhcHBfY291bnQpOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBhcHAgPSBkZXNrdG9wW2FwcF9pZHhdXG4gICAgICAgICAgICBjb21wID0gYXBwLnF1ZXJ5Q29tcG9uZW50KClcbiAgICAgICAgICAgIG5vZGUgPSBjb21wLmdldEFjY2Vzc2libGVBdFBvaW50KGludCh4KSwgaW50KHkpLCBweWF0c3BpLkRFU0tUT1BfQ09PUkRTKVxuICAgICAgICAgICAgaWYgbm9kZSBpcyBub3QgTm9uZTpcbiAgICAgICAgICAgICAgICByZXR1cm4gbm9kZVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICByZXR1cm4gTm9uZVxuXG5kZWYgY2FuZGlkYXRlX25vZGVzKHNlZWQpOlxuICAgIG9yZGVyZWQgPSBbXVxuICAgIHNlZW4gPSBzZXQoKVxuXG4gICAgZGVmIHB1c2gobm9kZSk6XG4gICAgICAgIGlmIG5vZGUgaXMgTm9uZTpcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBrZXkgPSBpZChub2RlKVxuICAgICAgICBpZiBrZXkgaW4gc2VlbjpcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBzZWVuLmFkZChrZXkpXG4gICAgICAgIG9yZGVyZWQuYXBwZW5kKG5vZGUpXG5cbiAgICBjdXJyZW50ID0gc2VlZFxuICAgIHdoaWxlIGN1cnJlbnQgaXMgbm90IE5vbmU6XG4gICAgICAgIHB1c2goY3VycmVudClcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50XG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBicmVha1xuXG4gICAgZm9yIGJhc2UgaW4gbGlzdChvcmRlcmVkKTpcbiAgICAgICAgZm9yIG5lc3RlZCBpbiBpdGVyX25vZGVzKGJhc2UpOlxuICAgICAgICAgICAgcHVzaChuZXN0ZWQpXG4gICAgcmV0dXJuIG9yZGVyZWRcblxuZGVmIG1haW4oKTpcbiAgICBpZiBsZW4oc3lzLmFyZ3YpIDwgMzpcbiAgICAgICAgcHJpbnQoJ21pc3NpbmctY29vcmRpbmF0ZS1hcmdzJywgZmlsZT1zeXMuc3RkZXJyLCBmbHVzaD1UcnVlKVxuICAgICAgICByZXR1cm4gMlxuICAgIHggPSBmbG9hdChzeXMuYXJndlsxXSlcbiAgICB5ID0gZmxvYXQoc3lzLmFyZ3ZbMl0pXG4gICAgbW9kZSA9IChzeXMuYXJndlszXSBpZiBsZW4oc3lzLmFyZ3YpID4gMyBlbHNlICdjbGljaycpLnN0cmlwKCkubG93ZXIoKVxuICAgIGl0ZXJhdGlvbnMgPSAyIGlmIG1vZGUgPT0gJ2RvdWJsZScgZWxzZSAxXG5cbiAgICBub2RlID0gbm9kZV9hdF9wb2ludCh4LCB5KVxuICAgIGlmIG5vZGUgaXMgTm9uZTpcbiAgICAgICAgcHJpbnQoJ2ExMXktcG9pbnQtbWlzcycsIGZpbGU9c3lzLnN0ZGVyciwgZmx1c2g9VHJ1ZSlcbiAgICAgICAgcmV0dXJuIDNcbiAgICBjYW5kaWRhdGVzID0gY2FuZGlkYXRlX25vZGVzKG5vZGUpXG4gICAgaWYgbm90IGNhbmRpZGF0ZXM6XG4gICAgICAgIHByaW50KCdhMTF5LWNhbmRpZGF0ZXMtZW1wdHknLCBmaWxlPXN5cy5zdGRlcnIsIGZsdXNoPVRydWUpXG4gICAgICAgIHJldHVybiA0XG5cbiAgICBmb3IgaWR4IGluIHJhbmdlKGl0ZXJhdGlvbnMpOlxuICAgICAgICBjbGlja2VkID0gRmFsc2VcbiAgICAgICAgZm9yIGNhbmRpZGF0ZSBpbiBjYW5kaWRhdGVzOlxuICAgICAgICAgICAgaWYgaW52b2tlX2FjdGlvbihjYW5kaWRhdGUpOlxuICAgICAgICAgICAgICAgIGNsaWNrZWQgPSBUcnVlXG4gICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgaWYgbm90IGNsaWNrZWQ6XG4gICAgICAgICAgICBwcmludCgnYTExeS1hY3Rpb24tZmFpbGVkJywgZmlsZT1zeXMuc3RkZXJyLCBmbHVzaD1UcnVlKVxuICAgICAgICAgICAgcmV0dXJuIDVcbiAgICAgICAgaWYgaWR4ICsgMSA8IGl0ZXJhdGlvbnM6XG4gICAgICAgICAgICB0aW1lLnNsZWVwKDAuMDYpXG5cbiAgICBwcmludCgnYTExeS1wb2ludC1hY3Rpb24tb2snLCBmbHVzaD1UcnVlKVxuICAgIHJldHVybiAwXG5cbnJhaXNlIFN5c3RlbUV4aXQobWFpbigpKVxuYDtcblxuLy8gTW9kdWxlLWxldmVsIGNhY2hlIGZvciB0aGUgV2F5bGFuZCBwb3J0YWwgc2Vzc2lvbi4gIENyZWF0aW5nIGEgcG9ydGFsXG4vLyBzZXNzaW9uIGludm9sdmVzIEQtQnVzIHJvdW5kLXRyaXBzIGFuZCwgb24gUkhFTC9HTk9NRSwgYSBjb25zZW50IGRpYWxvZ1xuLy8gdGhhdCBtdXN0IGJlIGFwcHJvdmVkIGJ5IHRoZSBhdXRvLXNoYXJlIGhlbHBlci4gIEJ5IGNhY2hpbmcgdGhlIHNlc3Npb25cbi8vIGF0IG1vZHVsZSBzY29wZSB3ZSBjYW4gcmV1c2UgaXQgYWNyb3NzIHN1Y2Nlc3NpdmUgQXBwaXVtIHNlc3Npb25zIGluIHRoZVxuLy8gc2FtZSBzZXJ2ZXIgcHJvY2VzcywgZWxpbWluYXRpbmcgfjQwIHMgb2Ygb3ZlcmhlYWQgcGVyIHRlc3QuXG5sZXQgX2NhY2hlZFBvcnRhbFNlc3Npb24gPSBudWxsO1xuXG5mdW5jdGlvbiBzbGVlcCAobXMpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIGVzYyAodmFsdWUpIHtcbiAgcmV0dXJuIGAke3ZhbHVlID8/ICcnfWBcbiAgICAucmVwbGFjZSgvJi9nLCAnJmFtcDsnKVxuICAgIC5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JylcbiAgICAucmVwbGFjZSgvPC9nLCAnJmx0OycpXG4gICAgLnJlcGxhY2UoLz4vZywgJyZndDsnKTtcbn1cblxuZnVuY3Rpb24gaGFzQ29tbWFuZCAoY29tbWFuZCkge1xuICBpZiAoY29tbWFuZCA9PT0gJ3B5dGhvbjMtcHlhdHNwaScpIHtcbiAgICBjb25zdCByZXMgPSBzcGF3blN5bmMoJ3B5dGhvbjMnLCBbJy1jJywgJ2ltcG9ydCBweWF0c3BpJ10sIHtzdGRpbzogJ2lnbm9yZSd9KTtcbiAgICByZXR1cm4gcmVzLnN0YXR1cyA9PT0gMDtcbiAgfVxuICBjb25zdCByZXMgPSBzcGF3blN5bmMoJ3doaWNoJywgW2NvbW1hbmRdLCB7c3RkaW86ICdpZ25vcmUnfSk7XG4gIHJldHVybiByZXMuc3RhdHVzID09PSAwO1xufVxuXG5mdW5jdGlvbiBzYWZlU3Bhd24gKGNvbW1hbmQsIGFyZ3MsIG9wdHMgPSB7fSkge1xuICBjb25zdCByZXMgPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgIGVuY29kaW5nOiAndXRmOCcsXG4gICAgLi4ub3B0cyxcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgb2s6IHJlcy5zdGF0dXMgPT09IDAsXG4gICAgY29kZTogcmVzLnN0YXR1cyxcbiAgICBzdGRvdXQ6IHJlcy5zdGRvdXQgfHwgJycsXG4gICAgc3RkZXJyOiByZXMuc3RkZXJyIHx8ICcnLFxuICB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUtleVZhbHVlT3V0cHV0IChvdXRwdXQpIHtcbiAgY29uc3QgcmVzdWx0ID0ge307XG4gIGZvciAoY29uc3QgcmF3TGluZSBvZiBgJHtvdXRwdXQgPz8gJyd9YC5zcGxpdCgnXFxuJykpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3TGluZS50cmltKCk7XG4gICAgaWYgKCFsaW5lKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgaWR4ID0gbGluZS5pbmRleE9mKCc9Jyk7XG4gICAgaWYgKGlkeCA8PSAwKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gbGluZS5zbGljZSgwLCBpZHgpLnRyaW0oKTtcbiAgICBjb25zdCB2YWx1ZSA9IGxpbmUuc2xpY2UoaWR4ICsgMSkudHJpbSgpO1xuICAgIGlmICgha2V5KSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcmVzdWx0W2tleV0gPSB2YWx1ZTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiB1bmJveCAodmFsdWUpIHtcbiAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCAnc2lnbmF0dXJlJykgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCAndmFsdWUnKSkge1xuICAgIHJldHVybiB1bmJveCh2YWx1ZS52YWx1ZSk7XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlLm1hcCgoaXRlbSkgPT4gdW5ib3goaXRlbSkpO1xuICB9XG4gIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3Qgb3V0ID0ge307XG4gICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSB7XG4gICAgICBvdXRba10gPSB1bmJveCh2KTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRva2VuICh2YWx1ZSkge1xuICBpZiAoIXZhbHVlKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gIH1cbiAgcmV0dXJuIGAke3ZhbHVlfWA7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVNlc3Npb25IYW5kbGVDYW5kaWRhdGVzRnJvbVJlcXVlc3RQYXRoIChyZXF1ZXN0UGF0aCwgc2Vzc2lvbkhhbmRsZVRva2VuKSB7XG4gIGNvbnN0IG1hdGNoID0gL15cXC9vcmdcXC9mcmVlZGVza3RvcFxcL3BvcnRhbFxcL2Rlc2t0b3BcXC9yZXF1ZXN0XFwvKFteL10rKVxcL1teL10rJC8uZXhlYyhgJHtyZXF1ZXN0UGF0aCA/PyAnJ31gKTtcbiAgaWYgKCFtYXRjaCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBzZW5kZXJTZWdtZW50ID0gbWF0Y2hbMV07XG4gIGNvbnN0IHJlcXVlc3RUb2tlbiA9IGAke3JlcXVlc3RQYXRoID8/ICcnfWAuc3BsaXQoJy8nKS5wb3AoKTtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtdO1xuICBpZiAocmVxdWVzdFRva2VuKSB7XG4gICAgY2FuZGlkYXRlcy5wdXNoKGAvb3JnL2ZyZWVkZXNrdG9wL3BvcnRhbC9kZXNrdG9wL3Nlc3Npb24vJHtzZW5kZXJTZWdtZW50fS8ke3JlcXVlc3RUb2tlbn1gKTtcbiAgfVxuICBjb25zdCB0b2tlbiA9IG5vcm1hbGl6ZVRva2VuKHNlc3Npb25IYW5kbGVUb2tlbik7XG4gIGlmICh0b2tlbikge1xuICAgIGNvbnN0IGV4cGxpY2l0VG9rZW5QYXRoID0gYC9vcmcvZnJlZWRlc2t0b3AvcG9ydGFsL2Rlc2t0b3Avc2Vzc2lvbi8ke3NlbmRlclNlZ21lbnR9LyR7dG9rZW59YDtcbiAgICBpZiAoIWNhbmRpZGF0ZXMuaW5jbHVkZXMoZXhwbGljaXRUb2tlblBhdGgpKSB7XG4gICAgICBjYW5kaWRhdGVzLnB1c2goZXhwbGljaXRUb2tlblBhdGgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlcztcbn1cblxuZnVuY3Rpb24gY29lcmNlQm9vbGVhbiAodmFsdWUsIGRlZmF1bHRWYWx1ZSA9IGZhbHNlKSB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIGRlZmF1bHRWYWx1ZTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgY29uc3QgdGV4dCA9IGAke3ZhbHVlfWAudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChbJzEnLCAndHJ1ZScsICd5ZXMnLCAneScsICdvbiddLmluY2x1ZGVzKHRleHQpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKFsnMCcsICdmYWxzZScsICdubycsICduJywgJ29mZiddLmluY2x1ZGVzKHRleHQpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBkZWZhdWx0VmFsdWU7XG59XG5cbmZ1bmN0aW9uIGZpcnN0RXhlY1Rva2VuIChleGVjTGluZSkge1xuICBjb25zdCB0ZXh0ID0gYCR7ZXhlY0xpbmUgPz8gJyd9YC50cmltKCk7XG4gIGlmICghdGV4dCkge1xuICAgIHJldHVybiAnJztcbiAgfVxuICBjb25zdCBtYXRjaCA9IC9eXCIoW15cIl0rKVwifCcoW14nXSspJ3woXFxTKykvLmV4ZWModGV4dCk7XG4gIHJldHVybiBtYXRjaCA/IChtYXRjaFsxXSB8fCBtYXRjaFsyXSB8fCBtYXRjaFszXSB8fCAnJykgOiAnJztcbn1cblxuZnVuY3Rpb24gZGVza3RvcEVudHJ5SWRGb3JGaWxlIChmaWxlUGF0aCkge1xuICByZXR1cm4gcGF0aC5iYXNlbmFtZShgJHtmaWxlUGF0aCA/PyAnJ31gLCAnLmRlc2t0b3AnKTtcbn1cblxuZnVuY3Rpb24gZmluZERlc2t0b3BFbnRyeUlkc0ZvckFwcCAoYXBwTmFtZSkge1xuICBjb25zdCBhcHBUZXh0ID0gYCR7YXBwTmFtZSA/PyAnJ31gLnRyaW0oKTtcbiAgaWYgKCFhcHBUZXh0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGNvbnN0IGFwcEJhc2VOYW1lID0gcGF0aC5iYXNlbmFtZShhcHBUZXh0KS50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBhcHBQYXRoID0gcGF0aC5pc0Fic29sdXRlKGFwcFRleHQpID8gYXBwVGV4dCA6ICcnO1xuICBjb25zdCBtYXRjaGVzID0gW107XG4gIGZvciAoY29uc3QgZGlyIG9mIERFU0tUT1BfRU5UUllfRElSUykge1xuICAgIGlmICghZGlyIHx8ICFmcy5leGlzdHNTeW5jKGRpcikpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBsZXQgZW50cmllcyA9IFtdO1xuICAgIHRyeSB7XG4gICAgICBlbnRyaWVzID0gZnMucmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGlmICghZW50cnkuZW5kc1dpdGgoJy5kZXNrdG9wJykpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBlbnRyeVBhdGggPSBwYXRoLmpvaW4oZGlyLCBlbnRyeSk7XG4gICAgICBsZXQgY29udGVudCA9ICcnO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhlbnRyeVBhdGgsICd1dGY4Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGVjQ29tbWFuZHMgPSBjb250ZW50XG4gICAgICAgIC5zcGxpdCgnXFxuJylcbiAgICAgICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aCgnRXhlYz0nKSlcbiAgICAgICAgLm1hcCgobGluZSkgPT4gZmlyc3RFeGVjVG9rZW4obGluZS5zbGljZSgnRXhlYz0nLmxlbmd0aCkpKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgY29uc3QgaXNNYXRjaCA9IGV4ZWNDb21tYW5kcy5zb21lKChjb21tYW5kKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbW1hbmRUZXh0ID0gYCR7Y29tbWFuZCA/PyAnJ31gLnRyaW0oKTtcbiAgICAgICAgcmV0dXJuIGNvbW1hbmRUZXh0ID09PSBhcHBQYXRoIHx8IHBhdGguYmFzZW5hbWUoY29tbWFuZFRleHQpLnRvTG93ZXJDYXNlKCkgPT09IGFwcEJhc2VOYW1lO1xuICAgICAgfSk7XG4gICAgICBpZiAoaXNNYXRjaCkge1xuICAgICAgICBtYXRjaGVzLnB1c2goZGVza3RvcEVudHJ5SWRGb3JGaWxlKGVudHJ5UGF0aCkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gQXJyYXkuZnJvbShuZXcgU2V0KG1hdGNoZXMpKTtcbn1cblxuY2xhc3MgV2F5bGFuZEFwaXMge1xuICBjb25zdHJ1Y3RvciAoe2FwcE5hbWUsIGxvZ2dlciwgd2F5bGFuZFJlc3RvcmVUb2tlbiwgd2F5bGFuZFRva2VuU3RvcmVQYXRoLCB3YXlsYW5kQXV0b1NoYXJlLCBuYXRpdmVBcGlzfSA9IHt9KSB7XG4gICAgdGhpcy5hcHBOYW1lID0gYXBwTmFtZTtcbiAgICB0aGlzLl9sb2dnZXIgPSBsb2dnZXI7XG4gICAgdGhpcy5fbmF0aXZlQXBpcyA9IG5hdGl2ZUFwaXMgfHwgbnVsbDtcbiAgICB0aGlzLl9kaXN0cm9JbmZvID0gZGV0ZWN0TGludXhEaXN0cm9JbmZvKCk7XG4gICAgdGhpcy5fdG9rZW5TdG9yZVBhdGggPSBub3JtYWxpemVTdG9yZVBhdGgod2F5bGFuZFRva2VuU3RvcmVQYXRoKTtcbiAgICB0aGlzLl9yZXN0b3JlVG9rZW5Gcm9tQ2FwcyA9IHdheWxhbmRSZXN0b3JlVG9rZW4gfHwgbnVsbDtcbiAgICB0aGlzLl9yZXN0b3JlVG9rZW4gPSBudWxsO1xuICAgIHRoaXMuX3dheWxhbmRBdXRvU2hhcmUgPSBjb2VyY2VCb29sZWFuKHdheWxhbmRBdXRvU2hhcmUsIHRydWUpO1xuICAgIHRoaXMuX3dheWxhbmRBdXRvU2hhcmVUaW1lb3V0TXMgPSBERUZBVUxUX0FVVE9fU0hBUkVfVElNRU9VVF9NUztcbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVQcm9jID0gbnVsbDtcbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgIHRoaXMuX3BvcnRhbEF1dG9TaGFyZVN0b3BwZWQgPSBmYWxzZTtcblxuICAgIHRoaXMuX3dpbmRvd01hcCA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLl93aW5kb3dMaXN0ID0gW107XG4gICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlID0gJyc7XG4gICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQgPSAwO1xuICAgIC8vIDMwcyBUVEwg4oCUIHRoZSBjYWNoZSBpcyBleHBsaWNpdGx5IGludmFsaWRhdGVkIGJ5IGdldFdpbmRvd0hhbmRsZXMoKSxcbiAgICAvLyBhcHBfbGF1bmNoKCksIGFuZCBhcHBfa2lsbCgpIHdoZW4gZnJlc2ggZGF0YSBpcyBuZWVkZWQuICBBIHNob3J0IFRUTFxuICAgIC8vIChlLmcuIDJzKSBjYXVzZWQgZXhwZW5zaXZlIG5hdGl2ZSBBVC1TUEkgZGVza3RvcCByZS1zY2FucyBvbiBldmVyeVxuICAgIC8vIGZpbmRFbGVtZW50IGZvciBkaWFsb2cgd2luZG93cyBvbiBSSEVML1dheWxhbmQuXG4gICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlVHRsTXMgPSAzMDAwMDtcblxuICAgIHRoaXMuX3BvcnRhbCA9IHtcbiAgICAgIGJ1czogbnVsbCxcbiAgICAgIHJlbW90ZURlc2t0b3A6IG51bGwsXG4gICAgICBzY3JlZW5DYXN0OiBudWxsLFxuICAgICAgc2NyZWVuc2hvdDogbnVsbCxcbiAgICAgIHJlZ2lzdHJ5OiBudWxsLFxuICAgICAgcmVnaXN0ZXJlZEFwcElkOiBudWxsLFxuICAgICAgc2Vzc2lvbkhhbmRsZTogbnVsbCxcbiAgICAgIHN0cmVhbU5vZGVJZDogbnVsbCxcbiAgICAgIGxvZ2ljYWxTaXplOiBudWxsLFxuICAgICAgZ3JhbnRlZERldmljZXM6IG51bGwsXG4gICAgICBwb2ludGVyQWxsb3dlZDogbnVsbCxcbiAgICAgIGtleWJvYXJkQWxsb3dlZDogbnVsbCxcbiAgICAgIHJlbW90ZURlc2t0b3BWZXJzaW9uOiAwLFxuICAgICAgc2NyZWVuQ2FzdFZlcnNpb246IDAsXG4gICAgICBzY3JlZW5zaG90VmVyc2lvbjogMCxcbiAgICB9O1xuXG4gICAgdGhpcy5faGFzV2xDb3B5ID0gaGFzQ29tbWFuZCgnd2wtY29weScpO1xuICAgIHRoaXMuX2hhc1dsUGFzdGUgPSBoYXNDb21tYW5kKCd3bC1wYXN0ZScpO1xuICAgIHRoaXMuX2hhc0dub21lU2NyZWVuc2hvdCA9IGhhc0NvbW1hbmQoJ2dub21lLXNjcmVlbnNob3QnKTtcbiAgICB0aGlzLl9oYXNHcmltID0gaGFzQ29tbWFuZCgnZ3JpbScpO1xuXG4gICAgLy8gUkhFTCBHTk9NRSBjb21wb3NpdG9yIG5lZWRzIHNtYWxsIHNldHRsaW5nIGRlbGF5cyBiZXR3ZWVuIHBvaW50ZXIgbW90aW9uXG4gICAgLy8gYW5kIGJ1dHRvbiBldmVudHMuIFdpdGhvdXQgdGhlc2UsIGNsaWNrcyBjYW4gbGFuZCBhdCB0aGUgd3JvbmcgY29vcmRpbmF0ZXNcbiAgICAvLyBiZWNhdXNlIHRoZSBjb21wb3NpdG9yIGhhc24ndCBmaW5pc2hlZCBwcm9jZXNzaW5nIHRoZSBtb3Rpb24gZXZlbnQuXG4gICAgdGhpcy5fY29tcG9zaXRvclNldHRsZU1zID0gdGhpcy5fZGlzdHJvSW5mby5pc1JoZWxMaWtlID8gMTAgOiAodGhpcy5fZGlzdHJvSW5mby5pc1VidW50dSA/IDUgOiAwKTtcbiAgICB0aGlzLl9idXR0b25QcmVzc1JlbGVhc2VHYXBNcyA9IHRoaXMuX2Rpc3Ryb0luZm8uaXNSaGVsTGlrZSA/IDUgOiAodGhpcy5fZGlzdHJvSW5mby5pc1VidW50dSA/IDIgOiAwKTtcbiAgICB0aGlzLl9kb3VibGVDbGlja0ludGVydmFsTXMgPSB0aGlzLl9kaXN0cm9JbmZvLmlzUmhlbExpa2UgPyA4MCA6ICh0aGlzLl9kaXN0cm9JbmZvLmlzVWJ1bnR1ID8gNzAgOiA2MCk7XG4gICAgdGhpcy5fa2V5VGFwSW50ZXJEZWxheU1zID0gMTA7XG4gIH1cblxuICBfbG9nSW5mbyAobXNnKSB7XG4gICAgaWYgKHRoaXMuX2xvZ2dlcj8uaW5mbykge1xuICAgICAgdGhpcy5fbG9nZ2VyLmluZm8obXNnKTtcbiAgICB9XG4gIH1cblxuICBfZ2V0TmF0aXZlQXBpcyAoKSB7XG4gICAgaWYgKCF0aGlzLl9uYXRpdmVBcGlzKSB7XG4gICAgICB0aGlzLl9uYXRpdmVBcGlzID0gbG9hZE5hdGl2ZUFwaXMoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX25hdGl2ZUFwaXM7XG4gIH1cblxuICBfbG9nV2FybiAobXNnKSB7XG4gICAgaWYgKHRoaXMuX2xvZ2dlcj8ud2Fybikge1xuICAgICAgdGhpcy5fbG9nZ2VyLndhcm4obXNnKTtcbiAgICB9XG4gIH1cblxuICBfaW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSAoKSB7XG4gICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlID0gJyc7XG4gICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQgPSAwO1xuICB9XG5cbiAgX2ludmFsaWRhdGVXaW5kb3dIaWVyYXJjaHlYbWxDYWNoZSAoKSB7XG4gICAgdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGUgPSBudWxsO1xuICAgIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlQXQgPSAwO1xuICB9XG5cbiAgX2dldERlc2t0b3BIaWVyYXJjaHkgKHtmb3JjZSA9IGZhbHNlfSA9IHt9KSB7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBpZiAoXG4gICAgICAhZm9yY2VcbiAgICAgICYmIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZVxuICAgICAgJiYgKG5vdyAtIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0KSA8PSB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVUdGxNc1xuICAgICkge1xuICAgICAgcmV0dXJuIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZTtcbiAgICB9XG5cbiAgICBsZXQgZGVza3RvcCA9ICcnO1xuICAgIHRyeSB7XG4gICAgICBkZXNrdG9wID0gdGhpcy5fZ2V0TmF0aXZlQXBpcygpLmExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRlc2t0b3AgPSAnJztcbiAgICB9XG5cbiAgICBpZiAoZGVza3RvcCkge1xuICAgICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlID0gZGVza3RvcDtcbiAgICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0ID0gbm93O1xuICAgICAgcmV0dXJuIGRlc2t0b3A7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSB8fCAnJztcbiAgfVxuXG4gIF9zdGFydFBvcnRhbEF1dG9TaGFyZUhlbHBlciAoKSB7XG4gICAgaWYgKCF0aGlzLl93YXlsYW5kQXV0b1NoYXJlIHx8IHRoaXMuX3BvcnRhbEF1dG9TaGFyZVByb2MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcik7XG4gICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVTdG9wcGVkID0gZmFsc2U7XG4gICAgY29uc3QgdGltZW91dFNlY29uZHMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwodGhpcy5fd2F5bGFuZEF1dG9TaGFyZVRpbWVvdXRNcyAvIDEwMDApKTtcbiAgICBjb25zdCBzY3JpcHQgPSBBVVRPX1NIQVJFX0hFTFBFUl9TQ1JJUFQucmVwbGFjZSgnX19USU1FT1VUX1NFQ09ORFNfXycsIGAke3RpbWVvdXRTZWNvbmRzfWApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9jID0gc3Bhd24oJ3B5dGhvbjMnLCBbJy1jJywgc2NyaXB0XSwge1xuICAgICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFBZVEhPTlVOQlVGRkVSRUQ6ICcxJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlUHJvYyA9IHByb2M7XG4gICAgICBwcm9jLnN0ZG91dC5vbignZGF0YScsIChjaHVuaykgPT4ge1xuICAgICAgICBjb25zdCBtc2cgPSBgJHtjaHVuayA/PyAnJ31gLnRyaW0oKTtcbiAgICAgICAgaWYgKG1zZykge1xuICAgICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGF1dG8tc2hhcmU6ICR7bXNnfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHByb2Muc3RkZXJyLm9uKCdkYXRhJywgKGNodW5rKSA9PiB7XG4gICAgICAgIGNvbnN0IG1zZyA9IGAke2NodW5rID8/ICcnfWAudHJpbSgpO1xuICAgICAgICBpZiAobXNnKSB7XG4gICAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZTogJHttc2d9YCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgcHJvYy5vbignZXJyb3InLCAoZXJyb3IpID0+IHtcbiAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBoZWxwZXIgZmFpbGVkOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICB9KTtcbiAgICAgIHByb2Mub24oJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IHNpZ25hbCA/IGBzaWduYWwgJHtzaWduYWx9YCA6IGBjb2RlICR7Y29kZX1gO1xuICAgICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHBvcnRhbCBhdXRvLXNoYXJlIGhlbHBlciBleGl0ZWQgd2l0aCAke3N0YXR1c31gKTtcbiAgICAgICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVByb2MgPT09IHByb2MpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVQcm9jID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXNpZ25hbCAmJiAoY29kZSA9PT0gMCB8fCBjb2RlID09PSAyKSAmJiAhdGhpcy5fcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCkge1xuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGNvZGUgPT09IDBcbiAgICAgICAgICAgID8gJ2hhbmRsZWQgYSBwb3J0YWwgcHJvbXB0J1xuICAgICAgICAgICAgOiAndGltZWQgb3V0IGJlZm9yZSB0aGUgcG9ydGFsIHNlc3Npb24gd2FzIHJlYWR5JztcbiAgICAgICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHBvcnRhbCBhdXRvLXNoYXJlIGhlbHBlciAke3JlYXNvbn07IHJlc3RhcnRpbmcgaGVscGVyYCk7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlUmVzdGFydFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5fc3RhcnRQb3J0YWxBdXRvU2hhcmVIZWxwZXIoKTtcbiAgICAgICAgICB9LCAyNTApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGF1dG8tc2hhcmUgaGVscGVyIHN0YXJ0ZWQgKHRpbWVvdXQgJHt0aW1lb3V0U2Vjb25kc31zKWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKGBGYWlsZWQgdG8gc3RhcnQgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBoZWxwZXI6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBfc3RvcFBvcnRhbEF1dG9TaGFyZUhlbHBlciAoKSB7XG4gICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcik7XG4gICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgIH1cbiAgICBjb25zdCBwcm9jID0gdGhpcy5fcG9ydGFsQXV0b1NoYXJlUHJvYztcbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVQcm9jID0gbnVsbDtcbiAgICBpZiAoIXByb2MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHByb2MuZXhpdENvZGUgIT09IG51bGwgfHwgcHJvYy5zaWduYWxDb2RlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBwcm9jLmtpbGwoJ1NJR1RFUk0nKTtcbiAgICAgIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBwcm9jLm9uY2UoJ2V4aXQnLCByZXNvbHZlKSksXG4gICAgICAgIHNsZWVwKDYwMCksXG4gICAgICBdKTtcbiAgICAgIGlmIChwcm9jLmV4aXRDb2RlID09PSBudWxsICYmICFwcm9jLnNpZ25hbENvZGUpIHtcbiAgICAgICAgcHJvYy5raWxsKCdTSUdLSUxMJyk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBJZ25vcmUgdGVhcmRvd24gZXJyb3JzXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUgKGZuKSB7XG4gICAgY29uc3Qgc2hvdWxkU2V0dGxlSGVscGVyID0gdGhpcy5fd2F5bGFuZEF1dG9TaGFyZTtcbiAgICB0aGlzLl9zdGFydFBvcnRhbEF1dG9TaGFyZUhlbHBlcigpO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHNob3VsZFNldHRsZUhlbHBlcikge1xuICAgICAgICBhd2FpdCBzbGVlcCgxMDAwKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX3N0b3BQb3J0YWxBdXRvU2hhcmVIZWxwZXIoKTtcbiAgICB9XG4gIH1cblxuICBfaXNQZXJzaXN0VW5zdXBwb3J0ZWRFcnJvciAoZXJyb3IpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gYCR7ZXJyb3I/Lm1lc3NhZ2UgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiBtZXNzYWdlLmluY2x1ZGVzKCdjYW5ub3QgcGVyc2lzdCcpIHx8IG1lc3NhZ2UuaW5jbHVkZXMoJ3Nlc3Npb25zIGNhbm5vdCBwZXJzaXN0Jyk7XG4gIH1cblxuICBfaXNQb2ludGVyUGVybWlzc2lvbkVycm9yIChlcnJvcikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBgJHtlcnJvcj8ubWVzc2FnZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIFBPSU5URVJfUEVSTUlTU0lPTl9FUlJPUl9UT0tFTlMuc29tZSgodG9rZW4pID0+IG1lc3NhZ2UuaW5jbHVkZXModG9rZW4pKTtcbiAgfVxuXG4gIF9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQgKGdyYW50SW5mbykge1xuICAgIHJldHVybiBncmFudEluZm8/LmdyYW50ZWREZXZpY2VzID09PSAwO1xuICB9XG5cbiAgX3J1bkExMXlQb2ludEFjdGlvbiAoeCwgeSwgbW9kZSA9ICdjbGljaycpIHtcbiAgICBjb25zdCBfeCA9IE51bWJlcih4KTtcbiAgICBjb25zdCBfeSA9IE51bWJlcih5KTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShfeCkgfHwgIU51bWJlci5pc0Zpbml0ZShfeSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZVNwYXduKFxuICAgICAgJ3B5dGhvbjMnLFxuICAgICAgWyctYycsIEExMVlfUE9JTlRfQUNUSU9OX1NDUklQVCwgYCR7X3h9YCwgYCR7X3l9YCwgbW9kZV0sXG4gICAgICB7XG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFBZVEhPTlVOQlVGRkVSRUQ6ICcxJyxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICApO1xuICAgIGlmIChyZXN1bHQub2spIHtcbiAgICAgIGNvbnN0IG91dHB1dCA9IGAke3Jlc3VsdC5zdGRvdXQgfHwgJyd9YC50cmltKCk7XG4gICAgICBpZiAob3V0cHV0KSB7XG4gICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgYTExeSBpbnB1dCBmYWxsYmFjazogJHtvdXRwdXR9YCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3QgZGV0YWlscyA9IFtgJHtyZXN1bHQuc3Rkb3V0IHx8ICcnfWAudHJpbSgpLCBgJHtyZXN1bHQuc3RkZXJyIHx8ICcnfWAudHJpbSgpXVxuICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgLmpvaW4oJyB8ICcpO1xuICAgIGlmIChkZXRhaWxzKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKGBXYXlsYW5kIGExMXkgaW5wdXQgZmFsbGJhY2sgZmFpbGVkOiAke2RldGFpbHN9YCk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIF9jbGlja1ZpYUExMXlQb2ludEZhbGxiYWNrICh4LCB5LCBtb2RlID0gJ2NsaWNrJykge1xuICAgIGNvbnN0IF94ID0gTnVtYmVyKHgpO1xuICAgIGNvbnN0IF95ID0gTnVtYmVyKHkpO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKF94KSB8fCAhTnVtYmVyLmlzRmluaXRlKF95KSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBwb2ludHMgPSBbXG4gICAgICBbX3gsIF95XSxcbiAgICAgIFtfeCAtIDMsIF95XSxcbiAgICAgIFtfeCArIDMsIF95XSxcbiAgICAgIFtfeCwgX3kgLSAzXSxcbiAgICAgIFtfeCwgX3kgKyAzXSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgW3B4LCBweV0gb2YgcG9pbnRzKSB7XG4gICAgICBpZiAodGhpcy5fcnVuQTExeVBvaW50QWN0aW9uKHB4LCBweSwgbW9kZSkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIF9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlICgpIHtcbiAgICBjb25zdCB1aWQgPSBgJHtwcm9jZXNzLmdldHVpZD8uKCkgPz8gJyd9YDtcbiAgICBpZiAoIXVpZCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvbnNSZXMgPSBzYWZlU3Bhd24oJ2xvZ2luY3RsJywgWydsaXN0LXNlc3Npb25zJywgJy0tbm8tbGVnZW5kJ10pO1xuICAgIGlmICghc2Vzc2lvbnNSZXMub2sgfHwgIXNlc3Npb25zUmVzLnN0ZG91dCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IFtdO1xuICAgIGZvciAoY29uc3QgcmF3TGluZSBvZiBzZXNzaW9uc1Jlcy5zdGRvdXQuc3BsaXQoJ1xcbicpKSB7XG4gICAgICBjb25zdCBsaW5lID0gcmF3TGluZS50cmltKCk7XG4gICAgICBpZiAoIWxpbmUpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBwYXJ0cyA9IGxpbmUuc3BsaXQoL1xccysvKTtcbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPCA4KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgW2lkLCByb3dVaWQsIHVzZXJOYW1lLCBzZWF0LCBsZWFkZXIsIGtsYXNzLCB0dHksIGFjdGl2ZV0gPSBwYXJ0cztcbiAgICAgIGlmIChyb3dVaWQgIT09IHVpZCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICAgIGlkLFxuICAgICAgICB1aWQ6IHJvd1VpZCxcbiAgICAgICAgdXNlck5hbWUsXG4gICAgICAgIHNlYXQsXG4gICAgICAgIGxlYWRlcixcbiAgICAgICAgY2xhc3M6IGtsYXNzLFxuICAgICAgICB0dHksXG4gICAgICAgIGFjdGl2ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGFjdGl2ZUNhbmRpZGF0ZXMgPSBjYW5kaWRhdGVzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5hY3RpdmUgPT09ICd5ZXMnKTtcbiAgICBjb25zdCBwcmVmZXJyZWQgPSBhY3RpdmVDYW5kaWRhdGVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uc2VhdCAhPT0gJy0nKVxuICAgICAgfHwgYWN0aXZlQ2FuZGlkYXRlc1swXVxuICAgICAgfHwgY2FuZGlkYXRlcy5maW5kKChpdGVtKSA9PiBpdGVtLnNlYXQgIT09ICctJylcbiAgICAgIHx8IGNhbmRpZGF0ZXNbMF07XG4gICAgaWYgKCFwcmVmZXJyZWQ/LmlkKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBzaG93UmVzID0gc2FmZVNwYXduKCdsb2dpbmN0bCcsIFtcbiAgICAgICdzaG93LXNlc3Npb24nLFxuICAgICAgcHJlZmVycmVkLmlkLFxuICAgICAgJy1wJywgJ0xvY2tlZEhpbnQnLFxuICAgICAgJy1wJywgJ0FjdGl2ZScsXG4gICAgICAnLXAnLCAnU3RhdGUnLFxuICAgICAgJy1wJywgJ1R5cGUnLFxuICAgICAgJy1wJywgJ1JlbW90ZScsXG4gICAgICAnLXAnLCAnTmFtZScsXG4gICAgXSk7XG4gICAgaWYgKCFzaG93UmVzLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5wcmVmZXJyZWQsXG4gICAgICAgIGRldGFpbHM6IHt9LFxuICAgICAgICBsb2NrZWQ6IG51bGwsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBkZXRhaWxzID0gcGFyc2VLZXlWYWx1ZU91dHB1dChzaG93UmVzLnN0ZG91dCk7XG4gICAgY29uc3QgbG9ja2VkSGludCA9IGAke2RldGFpbHMuTG9ja2VkSGludCA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLnByZWZlcnJlZCxcbiAgICAgIGRldGFpbHMsXG4gICAgICBsb2NrZWQ6IGxvY2tlZEhpbnQgPT09ICd5ZXMnLFxuICAgIH07XG4gIH1cblxuICBfbXVzdFVzZVdheWxhbmRTZXNzaW9uICgpIHtcbiAgICBjb25zdCBzZXNzaW9uVHlwZSA9IChwcm9jZXNzLmVudi5YREdfU0VTU0lPTl9UWVBFIHx8ICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChzZXNzaW9uVHlwZSAhPT0gJ3dheWxhbmQnICYmICFwcm9jZXNzLmVudi5XQVlMQU5EX0RJU1BMQVkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignV2F5bGFuZCBiYWNrZW5kIHJlcXVlc3RlZCwgYnV0IHRoaXMgcHJvY2VzcyBpcyBub3QgaW4gYSBXYXlsYW5kIHNlc3Npb24uIFNldCBhcHBpdW06bGludXhCYWNrZW5kIHRvIHgxMSBvciBydW4gdW5kZXIgV2F5bGFuZC4nKTtcbiAgICB9XG4gIH1cblxuICBfcnVuUHJlZmxpZ2h0Q2hlY2tzICgpIHtcbiAgICBjb25zdCByZXN1bHQgPSBldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQoe1xuICAgICAgaGFzQ29tbWFuZCxcbiAgICAgIGF1dG9TaGFyZUVuYWJsZWQ6IHRoaXMuX3dheWxhbmRBdXRvU2hhcmUsXG4gICAgICBkaXN0cm9JbmZvOiB0aGlzLl9kaXN0cm9JbmZvLFxuICAgIH0pO1xuICAgIGZvciAoY29uc3Qgd2FybmluZyBvZiByZXN1bHQud2FybmluZ3MpIHtcbiAgICAgIHRoaXMuX2xvZ1dhcm4od2FybmluZyk7XG4gICAgfVxuICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGRpc3RybyA9IGZvcm1hdERpc3Ryb0xhYmVsKHRoaXMuX2Rpc3Ryb0luZm8pO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBXYXlsYW5kIHByZWZsaWdodCBmYWlsZWQgb24gJHtkaXN0cm99Olxcbi0gJHtyZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbi0gJyl9YCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gdGhpcy5fZ2V0QWN0aXZlVXNlclNlc3Npb25TdGF0ZSgpO1xuICAgIGlmIChzZXNzaW9uU3RhdGU/LmxvY2tlZCA9PT0gdHJ1ZSkge1xuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvblN0YXRlLmlkIHx8ICd1bmtub3duJztcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFdheWxhbmQgZGVza3RvcCBzZXNzaW9uICcke3Nlc3Npb25JZH0nIGlzIGxvY2tlZC4gYCArXG4gICAgICAgIGBVbmxvY2sgdGhlIEdVSSBzZXNzaW9uIChmb3IgZXhhbXBsZTogbG9naW5jdGwgdW5sb2NrLXNlc3Npb24gJHtzZXNzaW9uSWR9KSBhbmQgcmV0cnkuYFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBfbmV4dFRva2VuIChwcmVmaXgpIHtcbiAgICBjb25zdCByYW5kb20gPSBjcnlwdG8ucmFuZG9tQnl0ZXMoOCkudG9TdHJpbmcoJ2hleCcpO1xuICAgIHJldHVybiBgJHtwcmVmaXh9XyR7RGF0ZS5ub3coKX1fJHtyYW5kb219YDtcbiAgfVxuXG4gIGFzeW5jIF9nZXRQb3J0YWxJbnRlcmZhY2VWZXJzaW9uIChkZXNrdG9wT2JqLCBpZmFjZU5hbWUpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvcHMgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShEQlVTX1BST1BTX0lGQUNFKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb3BzLkdldChpZmFjZU5hbWUsICd2ZXJzaW9uJyk7XG4gICAgICBjb25zdCB2ZXJzaW9uID0gTnVtYmVyLnBhcnNlSW50KGAke3VuYm94KHJlc3VsdCl9YCwgMTApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZSh2ZXJzaW9uKSAmJiB2ZXJzaW9uID4gMCkge1xuICAgICAgICByZXR1cm4gdmVyc2lvbjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGZhbGwgdGhyb3VnaFxuICAgIH1cbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGFzeW5jIF9yZWdpc3RlclBvcnRhbEFwcElkICgpIHtcbiAgICBpZiAoIXRoaXMuX3BvcnRhbC5yZWdpc3RyeSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjYW5kaWRhdGVzID0gZmluZERlc2t0b3BFbnRyeUlkc0ZvckFwcCh0aGlzLmFwcE5hbWUpO1xuICAgIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgYXBwIHJlZ2lzdHJhdGlvbiBza2lwcGVkOyBubyBkZXNrdG9wIGVudHJ5IG1hdGNoZWQgYXBwICcke3RoaXMuYXBwTmFtZSB8fCAnJ30nYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgYXBwSWQgb2YgY2FuZGlkYXRlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlZ2lzdHJ5LlJlZ2lzdGVyKGFwcElkLCB7fSk7XG4gICAgICAgIHRoaXMuX3BvcnRhbC5yZWdpc3RlcmVkQXBwSWQgPSBhcHBJZDtcbiAgICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgcmVnaXN0ZXJlZCBob3N0IGFwcCBpZCAnJHthcHBJZH0nYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgJHtlcnJvcj8ubWVzc2FnZSA/PyAnJ31gO1xuICAgICAgICBpZiAobWVzc2FnZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdjb25uZWN0aW9uIGFscmVhZHkgYXNzb2NpYXRlZCcpKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnJlZ2lzdGVyZWRBcHBJZCA9IGFwcElkO1xuICAgICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGhvc3QgYXBwIGlkIHdhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgKCR7YXBwSWR9KWApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9sb2dXYXJuKGBXYXlsYW5kIHBvcnRhbCBhcHAgcmVnaXN0cmF0aW9uIGZhaWxlZCBmb3IgJyR7YXBwSWR9JzogJHttZXNzYWdlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIF9hd2FpdFBvcnRhbFJlc3BvbnNlIChyZXF1ZXN0UGF0aCkge1xuICAgIGNvbnN0IG9iaiA9IGF3YWl0IHRoaXMuX3BvcnRhbC5idXMuZ2V0UHJveHlPYmplY3QoUE9SVEFMX0RFU1QsIHJlcXVlc3RQYXRoKTtcbiAgICBjb25zdCBpZmFjZSA9IG9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1JFUVVFU1RfSUZBQ0UpO1xuICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmYWNlLnJlbW92ZUxpc3RlbmVyKCdSZXNwb25zZScsIG9uUmVzcG9uc2UpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKGBQb3J0YWwgcmVxdWVzdCB0aW1lZCBvdXQgZm9yICR7cmVxdWVzdFBhdGh9YCkpO1xuICAgICAgfSwgMTgwMDAwKTtcblxuICAgICAgY29uc3Qgb25SZXNwb25zZSA9IChyZXNwb25zZUNvZGUsIHJlc3VsdHMpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICBpZmFjZS5yZW1vdmVMaXN0ZW5lcignUmVzcG9uc2UnLCBvblJlc3BvbnNlKTtcbiAgICAgICAgcmVzb2x2ZSh7XG4gICAgICAgICAgcmVzcG9uc2VDb2RlLFxuICAgICAgICAgIHJlc3VsdHM6IHVuYm94KHJlc3VsdHMpLFxuICAgICAgICB9KTtcbiAgICAgIH07XG5cbiAgICAgIGlmYWNlLm9uKCdSZXNwb25zZScsIG9uUmVzcG9uc2UpO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgX3BvcnRhbFJlcXVlc3QgKGlmYWNlLCBtZXRob2ROYW1lLCAuLi5hcmdzKSB7XG4gICAgY29uc3QgcmVxdWVzdFBhdGggPSBhd2FpdCBpZmFjZVttZXRob2ROYW1lXSguLi5hcmdzKTtcbiAgICBsZXQgcmVzcG9uc2UgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMuX2F3YWl0UG9ydGFsUmVzcG9uc2UocmVxdWVzdFBhdGgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYCR7ZXJyb3I/Lm1lc3NhZ2UgPz8gJyd9YDtcbiAgICAgIGlmIChtZXNzYWdlLmluY2x1ZGVzKCdpbnRlcmZhY2Ugbm90IGZvdW5kIGluIHByb3h5IG9iamVjdDogb3JnLmZyZWVkZXNrdG9wLnBvcnRhbC5SZXF1ZXN0JykpIHtcbiAgICAgICAgdGhpcy5fbG9nV2FybihgUG9ydGFsICR7bWV0aG9kTmFtZX0gZGlkIG5vdCBleHBvc2UgUmVxdWVzdCBpbnRlcmZhY2UgYXQgJyR7cmVxdWVzdFBhdGh9Jy4gRmFsbGluZyBiYWNrIHRvIGltbWVkaWF0ZS1yZXN1bHQgbW9kZS5gKTtcbiAgICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdDcmVhdGVTZXNzaW9uJyAmJiBgJHtyZXF1ZXN0UGF0aH1gLmluY2x1ZGVzKCcvc2Vzc2lvbi8nKSkge1xuICAgICAgICAgIHJldHVybiB7c2Vzc2lvbl9oYW5kbGU6IGAke3JlcXVlc3RQYXRofWB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXRob2ROYW1lID09PSAnQ3JlYXRlU2Vzc2lvbicpIHtcbiAgICAgICAgICBjb25zdCBjcmVhdGVPcHRpb25zID0gYXJnc1swXSB8fCB7fTtcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSGFuZGxlVG9rZW4gPSB1bmJveChjcmVhdGVPcHRpb25zPy5zZXNzaW9uX2hhbmRsZV90b2tlbik7XG4gICAgICAgICAgY29uc3Qgc3ludGhlc2l6ZWRIYW5kbGVzID0gY3JlYXRlU2Vzc2lvbkhhbmRsZUNhbmRpZGF0ZXNGcm9tUmVxdWVzdFBhdGgocmVxdWVzdFBhdGgsIHNlc3Npb25IYW5kbGVUb2tlbik7XG4gICAgICAgICAgaWYgKHN5bnRoZXNpemVkSGFuZGxlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBzeW50aGVzaXplZEhhbmRsZSA9IHN5bnRoZXNpemVkSGFuZGxlc1swXTtcbiAgICAgICAgICAgIGNvbnN0IGFsdEhhbmRsZXMgPSBzeW50aGVzaXplZEhhbmRsZXMuc2xpY2UoMSk7XG4gICAgICAgICAgICB0aGlzLl9sb2dXYXJuKFxuICAgICAgICAgICAgICBgUG9ydGFsIENyZWF0ZVNlc3Npb24gcmV0dXJuZWQgcmVxdWVzdCBwYXRoIHdpdGhvdXQgUmVxdWVzdCBpbnRlcmZhY2UuIGAgK1xuICAgICAgICAgICAgICBgU3ludGhlc2l6aW5nIHNlc3Npb24gaGFuZGxlICcke3N5bnRoZXNpemVkSGFuZGxlfSdgICtcbiAgICAgICAgICAgICAgKGFsdEhhbmRsZXMubGVuZ3RoID4gMCA/IGAgKGFsdGVybmF0ZXM6ICR7YWx0SGFuZGxlcy5qb2luKCcsICcpfSlgIDogJycpICtcbiAgICAgICAgICAgICAgJy4nXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuIHtzZXNzaW9uX2hhbmRsZTogc3ludGhlc2l6ZWRIYW5kbGV9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge307XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gICAgY29uc3Qge3Jlc3BvbnNlQ29kZSwgcmVzdWx0c30gPSByZXNwb25zZTtcbiAgICBpZiAocmVzcG9uc2VDb2RlICE9PSAwKSB7XG4gICAgICBjb25zdCB1bmJveGVkUmVzdWx0cyA9IHJlc3VsdHMgfHwge307XG4gICAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBtZXRob2ROYW1lID09PSAnQ3JlYXRlU2Vzc2lvbicgPyB0aGlzLl9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlKCkgOiBudWxsO1xuICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdDcmVhdGVTZXNzaW9uJyAmJiBzZXNzaW9uU3RhdGU/LmxvY2tlZCA9PT0gdHJ1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFBvcnRhbCBDcmVhdGVTZXNzaW9uIGZhaWxlZCB3aXRoIHJlc3BvbnNlIGNvZGUgJHtyZXNwb25zZUNvZGV9OiBgICtcbiAgICAgICAgICBgZGVza3RvcCBzZXNzaW9uICcke3Nlc3Npb25TdGF0ZS5pZCB8fCAndW5rbm93bid9JyBpcyBsb2NrZWRgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBoYXNSZXN1bHRLZXlzID0gT2JqZWN0LmtleXModW5ib3hlZFJlc3VsdHMpLmxlbmd0aCA+IDA7XG4gICAgICBjb25zdCBkZXRhaWxzID0gaGFzUmVzdWx0S2V5cyA/IGAgKGRldGFpbHM6ICR7SlNPTi5zdHJpbmdpZnkodW5ib3hlZFJlc3VsdHMpfSlgIDogJyc7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFBvcnRhbCAke21ldGhvZE5hbWV9IGZhaWxlZCB3aXRoIHJlc3BvbnNlIGNvZGUgJHtyZXNwb25zZUNvZGV9JHtkZXRhaWxzfWApO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cyB8fCB7fTtcbiAgfVxuXG4gIGFzeW5jIF9vcGVuUG9ydGFsU2Vzc2lvbiAoKSB7XG4gICAgY29uc3Qge1ZhcmlhbnR9ID0gZGJ1cztcbiAgICB0aGlzLl9wb3J0YWwuYnVzID0gZGJ1cy5zZXNzaW9uQnVzKCk7XG4gICAgaWYgKCF0aGlzLl9wb3J0YWwuYnVzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBjb25uZWN0IHRvIERCdXMgc2Vzc2lvbiBidXMgZm9yIHhkZy1kZXNrdG9wLXBvcnRhbCcpO1xuICAgIH1cblxuICAgIGNvbnN0IGRlc2t0b3BPYmogPSBhd2FpdCB0aGlzLl9wb3J0YWwuYnVzLmdldFByb3h5T2JqZWN0KFBPUlRBTF9ERVNULCBQT1JUQUxfUEFUSCk7XG4gICAgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfUkRfSUZBQ0UpO1xuICAgIHRoaXMuX3BvcnRhbC5zY3JlZW5DYXN0ID0gZGVza3RvcE9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1NDX0lGQUNFKTtcbiAgICB0cnkge1xuICAgICAgdGhpcy5fcG9ydGFsLnJlZ2lzdHJ5ID0gZGVza3RvcE9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1JFR0lTVFJZX0lGQUNFKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRoaXMuX3BvcnRhbC5yZWdpc3RyeSA9IG51bGw7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3JlZ2lzdGVyUG9ydGFsQXBwSWQoKTtcbiAgICB0cnkge1xuICAgICAgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3QgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfU1NfSUZBQ0UpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3QgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcFZlcnNpb24gPSBhd2FpdCB0aGlzLl9nZXRQb3J0YWxJbnRlcmZhY2VWZXJzaW9uKGRlc2t0b3BPYmosIFBPUlRBTF9SRF9JRkFDRSk7XG4gICAgdGhpcy5fcG9ydGFsLnNjcmVlbkNhc3RWZXJzaW9uID0gYXdhaXQgdGhpcy5fZ2V0UG9ydGFsSW50ZXJmYWNlVmVyc2lvbihkZXNrdG9wT2JqLCBQT1JUQUxfU0NfSUZBQ0UpO1xuICAgIHRoaXMuX3BvcnRhbC5zY3JlZW5zaG90VmVyc2lvbiA9IGF3YWl0IHRoaXMuX2dldFBvcnRhbEludGVyZmFjZVZlcnNpb24oZGVza3RvcE9iaiwgUE9SVEFMX1NTX0lGQUNFKTtcblxuICAgIGlmICh0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcFZlcnNpb24gPiAwIHx8IHRoaXMuX3BvcnRhbC5zY3JlZW5DYXN0VmVyc2lvbiA+IDAgfHwgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3RWZXJzaW9uID4gMCkge1xuICAgICAgdGhpcy5fbG9nSW5mbyhcbiAgICAgICAgYFdheWxhbmQgcG9ydGFsIGludGVyZmFjZSB2ZXJzaW9uczogUmVtb3RlRGVza3RvcD0ke3RoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wVmVyc2lvbiB8fCAndW5rbm93bid9LCBgICtcbiAgICAgICAgYFNjcmVlbkNhc3Q9JHt0aGlzLl9wb3J0YWwuc2NyZWVuQ2FzdFZlcnNpb24gfHwgJ3Vua25vd24nfSwgYCArXG4gICAgICAgIGBTY3JlZW5zaG90PSR7dGhpcy5fcG9ydGFsLnNjcmVlbnNob3RWZXJzaW9uIHx8ICd1bmtub3duJ31gXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNyZWF0ZU9wdGlvbnMgPSB7XG4gICAgICBoYW5kbGVfdG9rZW46IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fbmV4dFRva2VuKCdyZF9jcmVhdGUnKSksXG4gICAgICBzZXNzaW9uX2hhbmRsZV90b2tlbjogbmV3IFZhcmlhbnQoJ3MnLCB0aGlzLl9uZXh0VG9rZW4oJ3JkX3Nlc3Npb24nKSksXG4gICAgfTtcblxuICAgIGNvbnN0IGNyZWF0ZVJlc3VsdCA9IGF3YWl0IHRoaXMuX3BvcnRhbFJlcXVlc3QodGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AsICdDcmVhdGVTZXNzaW9uJywgY3JlYXRlT3B0aW9ucyk7XG4gICAgY29uc3Qgc2Vzc2lvbkhhbmRsZSA9IGNyZWF0ZVJlc3VsdC5zZXNzaW9uX2hhbmRsZTtcbiAgICBpZiAoIXNlc3Npb25IYW5kbGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignUG9ydGFsIENyZWF0ZVNlc3Npb24gc3VjY2VlZGVkIGJ1dCBkaWQgbm90IHJldHVybiBzZXNzaW9uX2hhbmRsZScpO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSA9IHNlc3Npb25IYW5kbGU7XG5cbiAgICBjb25zdCBzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0ID0gdGhpcy5fcG9ydGFsLnNjcmVlbkNhc3RWZXJzaW9uID49IDI7XG4gICAgY29uc3Qgc3VwcG9ydHNSZW1vdGVEZXNrdG9wUGVyc2lzdCA9IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wVmVyc2lvbiA+PSAyO1xuXG4gICAgaWYgKCFzdXBwb3J0c1JlbW90ZURlc2t0b3BQZXJzaXN0KSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKFxuICAgICAgICBgUmVtb3RlRGVza3RvcCBwb3J0YWwgdiR7dGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3BWZXJzaW9uIHx8ICd1bmtub3duJ30gZG9lcyBub3Qgc3VwcG9ydCBwZXJzaXN0X21vZGUvcmVzdG9yZV90b2tlbi4gYCArXG4gICAgICAgICdXYXlsYW5kIHNoYXJlIGNvbnNlbnQgY2Fubm90IGJlIGZ1bGx5IGJ5cGFzc2VkIG9uIHRoaXMgZGVza3RvcCBiYWNrZW5kLidcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc291cmNlQXR0ZW1wdHMgPSBbXTtcbiAgICBpZiAodGhpcy5fcmVzdG9yZVRva2VuICYmIHN1cHBvcnRzU2NyZWVuQ2FzdFBlcnNpc3QpIHtcbiAgICAgIHNvdXJjZUF0dGVtcHRzLnB1c2goe1xuICAgICAgICB1c2VQZXJzaXN0OiB0cnVlLFxuICAgICAgICB1c2VSZXN0b3JlVG9rZW46IHRydWUsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuX3Jlc3RvcmVUb2tlbiAmJiAhc3VwcG9ydHNTY3JlZW5DYXN0UGVyc2lzdCkge1xuICAgICAgdGhpcy5fbG9nV2FybihcbiAgICAgICAgYFNjcmVlbkNhc3QgcG9ydGFsIHYke3RoaXMuX3BvcnRhbC5zY3JlZW5DYXN0VmVyc2lvbiB8fCAndW5rbm93bid9IGRvZXMgbm90IHN1cHBvcnQgcmVzdG9yZSB0b2tlbnMuIGAgK1xuICAgICAgICAnSWdub3JpbmcgcHJvdmlkZWQgV2F5bGFuZCByZXN0b3JlIHRva2VuLidcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0KSB7XG4gICAgICBzb3VyY2VBdHRlbXB0cy5wdXNoKHtcbiAgICAgICAgdXNlUGVyc2lzdDogdHJ1ZSxcbiAgICAgICAgdXNlUmVzdG9yZVRva2VuOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBzb3VyY2VBdHRlbXB0cy5wdXNoKHtcbiAgICAgIHVzZVBlcnNpc3Q6IGZhbHNlLFxuICAgICAgdXNlUmVzdG9yZVRva2VuOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGxldCBzZWxlY3RlZFNvdXJjZXMgPSBmYWxzZTtcbiAgICBsZXQgc2VsZWN0U291cmNlc0Vycm9yID0gbnVsbDtcbiAgICBsZXQgcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkID0gdHJ1ZTtcbiAgICBmb3IgKGNvbnN0IGF0dGVtcHQgb2Ygc291cmNlQXR0ZW1wdHMpIHtcbiAgICAgIC8vIE9uY2UgcGVyc2lzdF9tb2RlIGlzIGtub3duIHRvIGJlIHVuc3VwcG9ydGVkLCBza2lwIHJlbWFpbmluZyBwZXJzaXN0IGF0dGVtcHRzLlxuICAgICAgaWYgKGF0dGVtcHQudXNlUGVyc2lzdCAmJiAhcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3Qgc291cmNlT3B0aW9ucyA9IHtcbiAgICAgICAgaGFuZGxlX3Rva2VuOiBuZXcgVmFyaWFudCgncycsIHRoaXMuX25leHRUb2tlbignc2Nfc291cmNlcycpKSxcbiAgICAgICAgdHlwZXM6IG5ldyBWYXJpYW50KCd1JywgMSksXG4gICAgICAgIG11bHRpcGxlOiBuZXcgVmFyaWFudCgnYicsIGZhbHNlKSxcbiAgICAgICAgY3Vyc29yX21vZGU6IG5ldyBWYXJpYW50KCd1JywgMiksXG4gICAgICB9O1xuICAgICAgaWYgKGF0dGVtcHQudXNlUGVyc2lzdCkge1xuICAgICAgICBzb3VyY2VPcHRpb25zLnBlcnNpc3RfbW9kZSA9IG5ldyBWYXJpYW50KCd1JywgMik7XG4gICAgICB9XG4gICAgICBpZiAoYXR0ZW1wdC51c2VSZXN0b3JlVG9rZW4gJiYgdGhpcy5fcmVzdG9yZVRva2VuKSB7XG4gICAgICAgIHNvdXJjZU9wdGlvbnMucmVzdG9yZV90b2tlbiA9IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fcmVzdG9yZVRva2VuKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUoKCkgPT4gdGhpcy5fcG9ydGFsUmVxdWVzdChcbiAgICAgICAgICB0aGlzLl9wb3J0YWwuc2NyZWVuQ2FzdCxcbiAgICAgICAgICAnU2VsZWN0U291cmNlcycsXG4gICAgICAgICAgc2Vzc2lvbkhhbmRsZSxcbiAgICAgICAgICBzb3VyY2VPcHRpb25zXG4gICAgICAgICkpO1xuICAgICAgICBzZWxlY3RlZFNvdXJjZXMgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoYXR0ZW1wdC51c2VQZXJzaXN0ICYmIHRoaXMuX2lzUGVyc2lzdFVuc3VwcG9ydGVkRXJyb3IoZXJyKSkge1xuICAgICAgICAgIHBlcnNpc3RBY3R1YWxseVN1cHBvcnRlZCA9IGZhbHNlO1xuICAgICAgICAgIHRoaXMuX2xvZ1dhcm4oJ1BvcnRhbCBkb2VzIG5vdCBzdXBwb3J0IHBlcnNpc3RlZCBzY3JlZW5jYXN0IHNlc3Npb25zLiBSZXRyeWluZyB3aXRob3V0IHBlcnNpc3RfbW9kZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBzZWxlY3RTb3VyY2VzRXJyb3IgPSBlcnI7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghc2VsZWN0ZWRTb3VyY2VzICYmIHNlbGVjdFNvdXJjZXNFcnJvcikge1xuICAgICAgdGhyb3cgc2VsZWN0U291cmNlc0Vycm9yO1xuICAgIH1cblxuICAgIGxldCBzZWxlY3RlZERldmljZXMgPSBmYWxzZTtcbiAgICBsZXQgc2VsZWN0RGV2aWNlc0Vycm9yID0gbnVsbDtcbiAgICAvLyBTa2lwIHBlcnNpc3RfbW9kZSBmb3IgU2VsZWN0RGV2aWNlcyB3aGVuIFNlbGVjdFNvdXJjZXMgYWxyZWFkeSBwcm92ZWQgaXQgdW5zdXBwb3J0ZWQuXG4gICAgY29uc3QgZGV2aWNlUGVyc2lzdE1vZGVzID0gKHN1cHBvcnRzUmVtb3RlRGVza3RvcFBlcnNpc3QgJiYgcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkKSA/IFt0cnVlLCBmYWxzZV0gOiBbZmFsc2VdO1xuICAgIGZvciAoY29uc3QgdXNlUGVyc2lzdCBvZiBkZXZpY2VQZXJzaXN0TW9kZXMpIHtcbiAgICAgIGNvbnN0IGRldmljZU9wdGlvbnMgPSB7XG4gICAgICAgIGhhbmRsZV90b2tlbjogbmV3IFZhcmlhbnQoJ3MnLCB0aGlzLl9uZXh0VG9rZW4oJ3JkX2RldmljZXMnKSksXG4gICAgICAgIHR5cGVzOiBuZXcgVmFyaWFudCgndScsIERFVklDRV9UWVBFX0tFWUJPQVJEIHwgREVWSUNFX1RZUEVfUE9JTlRFUiksXG4gICAgICB9O1xuICAgICAgaWYgKHVzZVBlcnNpc3QpIHtcbiAgICAgICAgZGV2aWNlT3B0aW9ucy5wZXJzaXN0X21vZGUgPSBuZXcgVmFyaWFudCgndScsIDIpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fcnVuV2l0aFBvcnRhbEF1dG9TaGFyZSgoKSA9PiB0aGlzLl9wb3J0YWxSZXF1ZXN0KFxuICAgICAgICAgIHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLFxuICAgICAgICAgICdTZWxlY3REZXZpY2VzJyxcbiAgICAgICAgICBzZXNzaW9uSGFuZGxlLFxuICAgICAgICAgIGRldmljZU9wdGlvbnNcbiAgICAgICAgKSk7XG4gICAgICAgIHNlbGVjdGVkRGV2aWNlcyA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmICh1c2VQZXJzaXN0ICYmIHRoaXMuX2lzUGVyc2lzdFVuc3VwcG9ydGVkRXJyb3IoZXJyKSkge1xuICAgICAgICAgIHRoaXMuX2xvZ1dhcm4oJ1BvcnRhbCBkb2VzIG5vdCBzdXBwb3J0IHBlcnNpc3RlZCByZW1vdGUtZGVza3RvcCBzZXNzaW9ucy4gUmV0cnlpbmcgd2l0aG91dCBwZXJzaXN0X21vZGUuJyk7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZWN0RGV2aWNlc0Vycm9yID0gZXJyO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIXNlbGVjdGVkRGV2aWNlcyAmJiBzZWxlY3REZXZpY2VzRXJyb3IpIHtcbiAgICAgIHRocm93IHNlbGVjdERldmljZXNFcnJvcjtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFydE9wdGlvbnMgPSB7XG4gICAgICBoYW5kbGVfdG9rZW46IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fbmV4dFRva2VuKCdyZF9zdGFydCcpKSxcbiAgICB9O1xuXG4gICAgbGV0IHN0YXJ0UmVzdWx0cyA9IGF3YWl0IHRoaXMuX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUoKCkgPT4gdGhpcy5fcG9ydGFsUmVxdWVzdChcbiAgICAgIHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLFxuICAgICAgJ1N0YXJ0JyxcbiAgICAgIHNlc3Npb25IYW5kbGUsXG4gICAgICAnJyxcbiAgICAgIHN0YXJ0T3B0aW9uc1xuICAgICkpO1xuICAgIHN0YXJ0UmVzdWx0cyA9IHN0YXJ0UmVzdWx0cyB8fCB7fTtcblxuICAgIGNvbnN0IGdyYW50SW5mbyA9IHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzKHN0YXJ0UmVzdWx0cy5kZXZpY2VzKTtcbiAgICBpZiAoZ3JhbnRJbmZvLmdyYW50ZWREZXZpY2VzICE9PSBudWxsKSB7XG4gICAgICB0aGlzLl9wb3J0YWwuZ3JhbnRlZERldmljZXMgPSBncmFudEluZm8uZ3JhbnRlZERldmljZXM7XG4gICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBncmFudEluZm8ucG9pbnRlckFsbG93ZWQ7XG4gICAgICB0aGlzLl9wb3J0YWwua2V5Ym9hcmRBbGxvd2VkID0gZ3JhbnRJbmZvLmtleWJvYXJkQWxsb3dlZDtcbiAgICAgIHRoaXMuX2xvZ0luZm8oXG4gICAgICAgIGBXYXlsYW5kIHBvcnRhbCBncmFudGVkIGRldmljZXM9JHtncmFudEluZm8uZ3JhbnRlZERldmljZXN9IGAgK1xuICAgICAgICBgKGtleWJvYXJkPSR7dGhpcy5fcG9ydGFsLmtleWJvYXJkQWxsb3dlZH0sIHBvaW50ZXI9JHt0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWR9LCBgICtcbiAgICAgICAgYHRvdWNoPSR7Z3JhbnRJbmZvLnRvdWNoQWxsb3dlZH0pYFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fcG9ydGFsLmdyYW50ZWREZXZpY2VzID0gbnVsbDtcbiAgICAgIHRoaXMuX3BvcnRhbC5wb2ludGVyQWxsb3dlZCA9IG51bGw7XG4gICAgICB0aGlzLl9wb3J0YWwua2V5Ym9hcmRBbGxvd2VkID0gbnVsbDtcbiAgICAgIHRoaXMuX2xvZ1dhcm4oJ1dheWxhbmQgcG9ydGFsIFN0YXJ0IGRpZCBub3QgcmVwb3J0IGdyYW50ZWQgZGV2aWNlczsgcG9pbnRlciBlbnRpdGxlbWVudCBpcyB1bmtub3duLicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24oZ3JhbnRJbmZvKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCF0aGlzLl9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQoZ3JhbnRJbmZvKSkge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2xvZ1dhcm4oXG4gICAgICAgIGAke2Vycm9yLm1lc3NhZ2V9IENvbnRpbnVpbmcgd2l0aCBBVC1TUEkgcG9pbnRlciBmYWxsYmFjazsgYCArXG4gICAgICAgICdwb3J0YWwtb25seSBwb2ludGVyLCBrZXlib2FyZCwgc3dpcGUsIGFuZCBzY3JvbGwgYWN0aW9ucyBtYXkgYmUgdW5hdmFpbGFibGUuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdHJlYW1zID0gQXJyYXkuaXNBcnJheShzdGFydFJlc3VsdHMuc3RyZWFtcykgPyBzdGFydFJlc3VsdHMuc3RyZWFtcyA6IFtdO1xuICAgIGlmIChzdHJlYW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGZpcnN0U3RyZWFtID0gc3RyZWFtc1swXTtcbiAgICAgIGxldCByYXdOb2RlSWQgPSBudWxsO1xuICAgICAgbGV0IHJhd01ldGEgPSBudWxsO1xuXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShmaXJzdFN0cmVhbSkgJiYgZmlyc3RTdHJlYW0ubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBTdGFuZGFyZCBkYnVzLW5leHQgZm9ybWF0OiBbbm9kZUlkLCB7c2l6ZTogW3csIGhdLCAuLi59XVxuICAgICAgICByYXdOb2RlSWQgPSBmaXJzdFN0cmVhbVswXTtcbiAgICAgICAgcmF3TWV0YSA9IGZpcnN0U3RyZWFtWzFdO1xuICAgICAgfSBlbHNlIGlmIChmaXJzdFN0cmVhbSAhPT0gbnVsbCAmJiB0eXBlb2YgZmlyc3RTdHJlYW0gPT09ICdvYmplY3QnKSB7XG4gICAgICAgIC8vIE9iamVjdC1rZXllZCBzdHJ1Y3QgZm9ybWF0IHNlZW4gb24gUkhFTCAxMCB3aXRoIHNvbWUgZGJ1cy1uZXh0IHZlcnNpb25zOlxuICAgICAgICAvLyB7ICcwJzogbm9kZUlkLCAnMSc6IHsgc2l6ZTogW3csIGhdIH0gfVxuICAgICAgICByYXdOb2RlSWQgPSBmaXJzdFN0cmVhbVsnMCddID8/IGZpcnN0U3RyZWFtWzBdO1xuICAgICAgICByYXdNZXRhID0gZmlyc3RTdHJlYW1bJzEnXSA/PyBmaXJzdFN0cmVhbVsxXTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGFyc2VkTm9kZUlkID0gTnVtYmVyLnBhcnNlSW50KGAke3Jhd05vZGVJZH1gLCAxMCk7XG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHBhcnNlZE5vZGVJZCkpIHtcbiAgICAgICAgdGhpcy5fcG9ydGFsLnN0cmVhbU5vZGVJZCA9IHBhcnNlZE5vZGVJZDtcbiAgICAgICAgY29uc3Qgc2l6ZSA9IHJhd01ldGE/LnNpemU7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHNpemUpICYmIHNpemUubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLmxvZ2ljYWxTaXplID0ge1xuICAgICAgICAgICAgd2lkdGg6IE51bWJlci5wYXJzZUludChgJHtzaXplWzBdfWAsIDEwKSxcbiAgICAgICAgICAgIGhlaWdodDogTnVtYmVyLnBhcnNlSW50KGAke3NpemVbMV19YCwgMTApLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX2xvZ1dhcm4oXG4gICAgICAgICAgYFdheWxhbmQgcG9ydGFsIFN0YXJ0IHJldHVybmVkICR7c3RyZWFtcy5sZW5ndGh9IHN0cmVhbShzKSBidXQgc3RyZWFtIG5vZGUgaWQgY291bGQgbm90IGJlIHBhcnNlZCBgICtcbiAgICAgICAgICBgKGZpcnN0U3RyZWFtIHR5cGU9JHtBcnJheS5pc0FycmF5KGZpcnN0U3RyZWFtKSA/ICdhcnJheScgOiB0eXBlb2YgZmlyc3RTdHJlYW19LCBgICtcbiAgICAgICAgICBgcmF3Tm9kZUlkPSR7SlNPTi5zdHJpbmdpZnkocmF3Tm9kZUlkKX0pLiBgICtcbiAgICAgICAgICAnUG9pbnRlciBhYnNvbHV0ZSBldmVudHMgd2lsbCBmYWxsIGJhY2sgdG8gQVQtU1BJLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByb3RhdGVkVG9rZW4gPSBub3JtYWxpemVUb2tlbihzdGFydFJlc3VsdHMucmVzdG9yZV90b2tlbiB8fCBzdGFydFJlc3VsdHMucmVzdG9yZV9kYXRhIHx8IG51bGwpO1xuICAgIGlmIChyb3RhdGVkVG9rZW4pIHtcbiAgICAgIHRoaXMuX3Jlc3RvcmVUb2tlbiA9IHJvdGF0ZWRUb2tlbjtcbiAgICAgIHdyaXRlV2F5bGFuZFRva2VuKHRoaXMuX3Rva2VuU3RvcmVQYXRoLCB0aGlzLmFwcE5hbWUsIHJvdGF0ZWRUb2tlbik7XG4gICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHJlc3RvcmUgdG9rZW4gdXBkYXRlZCBhdCAke3RoaXMuX3Rva2VuU3RvcmVQYXRofWApO1xuICAgIH1cblxuICAgIHRoaXMuX2xvZ0luZm8oJ1dheWxhbmQgUmVtb3RlRGVza3RvcCBwb3J0YWwgc2Vzc2lvbiBpcyByZWFkeScpO1xuICB9XG5cbiAgYXN5bmMgaW5pdGlhbGl6ZSAoKSB7XG4gICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBiYWNrZW5kIGRpc3RybyBjb250ZXh0OiAke2Zvcm1hdERpc3Ryb0xhYmVsKHRoaXMuX2Rpc3Ryb0luZm8pfWApO1xuICAgIHRoaXMuX3J1blByZWZsaWdodENoZWNrcygpO1xuICAgIHRoaXMuX211c3RVc2VXYXlsYW5kU2Vzc2lvbigpO1xuICAgIGZzLm1rZGlyU3luYygnL3RtcC8uc3Rkc3BhJywge3JlY3Vyc2l2ZTogdHJ1ZX0pO1xuICAgIGlmICh0aGlzLl93YXlsYW5kQXV0b1NoYXJlKSB7XG4gICAgICBjb25zdCB0aW1lb3V0U2Vjb25kcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbCh0aGlzLl93YXlsYW5kQXV0b1NoYXJlVGltZW91dE1zIC8gMTAwMCkpO1xuICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBpcyBlbmFibGVkICh0aW1lb3V0ICR7dGltZW91dFNlY29uZHN9cylgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fbG9nSW5mbygnV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBpcyBkaXNhYmxlZCcpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9yZXN0b3JlVG9rZW5Gcm9tQ2Fwcykge1xuICAgICAgdGhpcy5fcmVzdG9yZVRva2VuID0gdGhpcy5fcmVzdG9yZVRva2VuRnJvbUNhcHM7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHt0b2tlbn0gPSByZWFkV2F5bGFuZFRva2VuKHRoaXMuX3Rva2VuU3RvcmVQYXRoLCB0aGlzLmFwcE5hbWUpO1xuICAgICAgdGhpcy5fcmVzdG9yZVRva2VuID0gdG9rZW47XG4gICAgfVxuXG4gICAgLy8gUmV1c2UgdGhlIGNhY2hlZCBwb3J0YWwgc2Vzc2lvbiBmcm9tIGEgcHJldmlvdXMgQXBwaXVtIHNlc3Npb24gaW5cbiAgICAvLyB0aGUgc2FtZSBzZXJ2ZXIgcHJvY2Vzcy4gIFRoaXMgYXZvaWRzIHJlLW9wZW5pbmcgdGhlIEQtQnVzIHBvcnRhbFxuICAgIC8vIGFuZCByZS1ydW5uaW5nIHRoZSBhdXRvLXNoYXJlIGNvbnNlbnQgZmxvdyBvbiBldmVyeSB0ZXN0LlxuICAgIGlmIChfY2FjaGVkUG9ydGFsU2Vzc2lvbiAmJiBfY2FjaGVkUG9ydGFsU2Vzc2lvbi5idXMgJiYgX2NhY2hlZFBvcnRhbFNlc3Npb24uc2Vzc2lvbkhhbmRsZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gUXVpY2sgaGVhbHRoLWNoZWNrOiByZWFkIGEgcG9ydGFsIHByb3BlcnR5IHRvIGNvbmZpcm0gdGhlIGJ1cyBpcyBhbGl2ZS5cbiAgICAgICAgY29uc3QgZGVza3RvcE9iaiA9IGF3YWl0IF9jYWNoZWRQb3J0YWxTZXNzaW9uLmJ1cy5nZXRQcm94eU9iamVjdChQT1JUQUxfREVTVCwgUE9SVEFMX1BBVEgpO1xuICAgICAgICBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfUkRfSUZBQ0UpO1xuICAgICAgICAvLyBTZXNzaW9uIGlzIHN0aWxsIHZhbGlkIOKAlCBhZG9wdCBpdC5cbiAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLl9wb3J0YWwsIF9jYWNoZWRQb3J0YWxTZXNzaW9uKTtcbiAgICAgICAgdGhpcy5fbG9nSW5mbygnV2F5bGFuZCBwb3J0YWwgc2Vzc2lvbiByZXVzZWQgZnJvbSBjYWNoZSAoc2tpcHBpbmcgcG9ydGFsIHNldHVwKScpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHRoaXMuX2xvZ1dhcm4oJ0NhY2hlZCBwb3J0YWwgc2Vzc2lvbiBpcyBzdGFsZTsgY3JlYXRpbmcgYSBuZXcgb25lJyk7XG4gICAgICAgIF9jYWNoZWRQb3J0YWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgYXdhaXQgdGhpcy5fb3BlblBvcnRhbFNlc3Npb24oKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQgdGhpcy5fb3BlblBvcnRhbFNlc3Npb24oKTtcbiAgICB9XG5cbiAgICAvLyBDYWNoZSB0aGUgcG9ydGFsIHN0YXRlIGZvciBmdXR1cmUgc2Vzc2lvbnMuXG4gICAgX2NhY2hlZFBvcnRhbFNlc3Npb24gPSB7Li4udGhpcy5fcG9ydGFsfTtcblxuICAgIHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuXG4gICAgY29uc3Qgc2NyZWVuc2hvdEZhaWx1cmUgPSBnZXRXYXlsYW5kU2NyZWVuc2hvdEZhaWx1cmVNZXNzYWdlKHtcbiAgICAgIHBvcnRhbEF2YWlsYWJsZTogQm9vbGVhbih0aGlzLl9wb3J0YWwuc2NyZWVuc2hvdCksXG4gICAgICBoYXNHbm9tZVNjcmVlbnNob3Q6IHRoaXMuX2hhc0dub21lU2NyZWVuc2hvdCxcbiAgICAgIGhhc0dyaW06IHRoaXMuX2hhc0dyaW0sXG4gICAgfSk7XG4gICAgaWYgKHNjcmVlbnNob3RGYWlsdXJlKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKHNjcmVlbnNob3RGYWlsdXJlKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLl9oYXNXbENvcHkgfHwgIXRoaXMuX2hhc1dsUGFzdGUpIHtcbiAgICAgIHRoaXMuX2xvZ1dhcm4oJ3dsLWNvcHkgLyB3bC1wYXN0ZSBub3QgZm91bmQuIENsaXBib2FyZCBjb21tYW5kcyB3aWxsIGZhbGxiYWNrIHRvIHN0ZHNwYSBuYXRpdmUgQVBJcy4nKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBkaXNwb3NlICgpIHtcbiAgICBhd2FpdCB0aGlzLl9zdG9wUG9ydGFsQXV0b1NoYXJlSGVscGVyKCk7XG4gICAgLy8gS2VlcCB0aGUgcG9ydGFsIHNlc3Npb24gYWxpdmUgaW4gdGhlIG1vZHVsZSBjYWNoZSBzbyB0aGUgbmV4dCBBcHBpdW1cbiAgICAvLyBzZXNzaW9uIGluIHRoZSBzYW1lIHByb2Nlc3MgY2FuIHJldXNlIGl0LiAgVGhlIHBvcnRhbCBELUJ1cyBjb25uZWN0aW9uXG4gICAgLy8gYW5kIHNlc3Npb24gaGFuZGxlIHJlbWFpbiB2YWxpZCBhY3Jvc3MgQXBwaXVtIGRyaXZlciBzZXNzaW9ucy5cbiAgICAvLyBPbmx5IGNsZWFyIGluc3RhbmNlLWxldmVsIHJlZmVyZW5jZXMgc28gdGhpcyBXYXlsYW5kQXBpcyBvYmplY3QgY2FuXG4gICAgLy8gYmUgZ2FyYmFnZS1jb2xsZWN0ZWQuXG4gICAgdGhpcy5fd2luZG93TGlzdCA9IFtdO1xuICAgIHRoaXMuX3dpbmRvd01hcC5jbGVhcigpO1xuICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSA9ICcnO1xuICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0ID0gMDtcbiAgfVxuXG4gIF9yZWZyZXNoV2luZG93Q2FjaGUgKGRlc2t0b3BYbWwgPSBudWxsKSB7XG4gICAgbGV0IHBpZHMgPSB0aGlzLl9nZXROYXRpdmVBcGlzKCkuYXBwX3J1bm5pbmcodGhpcy5hcHBOYW1lKSB8fCBbXTtcbiAgICAvLyBGYWxsYmFjayB3aXRoIHNob3J0LWxpdmVkIGNhY2hlIHRvIGF2b2lkIHNwYXduaW5nIHBncmVwIG9uIGV2ZXJ5IGNhbGxcbiAgICBpZiAoIXBpZHMgfHwgcGlkcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICBpZiAodGhpcy5fcGdyZXBQaWRzICYmIChub3cgLSB0aGlzLl9wZ3JlcFBpZHNBdCkgPCAzMDAwKSB7XG4gICAgICAgIHBpZHMgPSB0aGlzLl9wZ3JlcFBpZHM7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJhc2VOYW1lID0gKHRoaXMuYXBwTmFtZSB8fCAnJykuc3BsaXQoJy8nKS5wb3AoKTtcbiAgICAgICAgICBpZiAoYmFzZU5hbWUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IHNwYXduU3luYygncGdyZXAnLCBbJy1mJywgYmFzZU5hbWVdLCB7ZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogMzAwMH0pO1xuICAgICAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDAgJiYgcmVzLnN0ZG91dCkge1xuICAgICAgICAgICAgICBwaWRzID0gcmVzLnN0ZG91dC50cmltKCkuc3BsaXQoL1xccysvKS5tYXAoTnVtYmVyKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtcbiAgICAgICAgICAgICAgdGhpcy5fcGdyZXBQaWRzID0gcGlkcztcbiAgICAgICAgICAgICAgdGhpcy5fcGdyZXBQaWRzQXQgPSBub3c7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aGlzLl93aW5kb3dMaXN0ID0gW107XG4gICAgICB0aGlzLl93aW5kb3dNYXAuY2xlYXIoKTtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICBsZXQgZGVza3RvcCA9IGRlc2t0b3BYbWw7XG4gICAgaWYgKGAke2Rlc2t0b3AgPz8gJyd9YC50cmltKCkpIHtcbiAgICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSA9IGRlc2t0b3A7XG4gICAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVBdCA9IERhdGUubm93KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlc2t0b3AgPSB0aGlzLl9nZXREZXNrdG9wSGllcmFyY2h5KCk7XG4gICAgfVxuICAgIGlmICghZGVza3RvcCkge1xuICAgICAgdGhpcy5fd2luZG93TGlzdCA9IFtdO1xuICAgICAgdGhpcy5fd2luZG93TWFwLmNsZWFyKCk7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuXG4gICAgY29uc3QgcHJldmlvdXNXaWRCeUlkZW50aXR5ID0gbmV3IE1hcChcbiAgICAgICh0aGlzLl93aW5kb3dMaXN0IHx8IFtdKS5tYXAoKHdpbmRvdykgPT4gW3dpbmRvdy5pZGVudGl0eUtleSwgd2luZG93LndpZF0pXG4gICAgKTtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKGRlc2t0b3AsIHBpZHMpO1xuICAgIGNvbnN0IHt3aW5kb3dzfSA9IG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MoY2FuZGlkYXRlcywgcHJldmlvdXNXaWRCeUlkZW50aXR5KTtcblxuICAgIHRoaXMuX3dpbmRvd0xpc3QgPSB3aW5kb3dzO1xuICAgIHRoaXMuX3dpbmRvd01hcC5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgdyBvZiB3aW5kb3dzKSB7XG4gICAgICB0aGlzLl93aW5kb3dNYXAuc2V0KHcud2lkLCB3KTtcbiAgICB9XG5cbiAgICByZXR1cm4gd2luZG93cztcbiAgfVxuXG4gIGFwcF9nZXRXaW5kb3dIaWVyYWNoeSAoKSB7XG4gICAgLy8gQ2FjaGUgdGhlIGJ1aWx0IFhNTCBmb3IgMiBzZWNvbmRzIHRvIGF2b2lkIHJlZHVuZGFudCBfcmVmcmVzaFdpbmRvd0NhY2hlXG4gICAgLy8gY2FsbHMgZHVyaW5nIHJhcGlkIGdldFdpbmRvd0hhbmRsZS9nZXRXaW5kb3dIYW5kbGVzIHBvbGxpbmcuXG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBpZiAodGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGUgJiYgKG5vdyAtIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlQXQpIDw9IDIwMDApIHtcbiAgICAgIHJldHVybiB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZTtcbiAgICB9XG4gICAgY29uc3Qgd2luZG93cyA9IHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuICAgIGNvbnN0IHhtbCA9IHdpbmRvd3MubWFwKCh3KSA9PiB7XG4gICAgICBjb25zdCByZWN0ID0gYFske3cucmVjdC54fSwke3cucmVjdC55fSwke3cucmVjdC53aWR0aH0sJHt3LnJlY3QuaGVpZ2h0fV1gO1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgYDx3aW5kb3cgcGlkPVwiJHt3LnBpZH1cIiB3aWQ9XCIke3cud2lkfVwiIElucHV0T3V0cHV0PVwiJHt3LmlucHV0T3V0cHV0fVwiIGAgK1xuICAgICAgICBgbmFtZT1cIiR7ZXNjKHcubmFtZSl9XCIgY2xhc3M9XCIke2VzYyh3LmNsYXNzTmFtZSl9XCIgcmVjdD1cIiR7cmVjdH1cIiBgICtcbiAgICAgICAgYHN0YXRlcz1cIiR7ZXNjKHcuc3RhdGVzKX1cIiB0YWc9XCIke2VzYyh3Lm5vZGVUYWcpfVwiIGAgK1xuICAgICAgICBgd2luZG93LXR5cGU9XCIke2VzYyh3LndpbmRvd1R5cGUpfVwiIGlkZW50aXR5PVwiJHtlc2Mody5pZGVudGl0eUtleSl9XCIvPmBcbiAgICAgICk7XG4gICAgfSkuam9pbignJyk7XG4gICAgY29uc3QgcmVzdWx0ID0gYDx3aW5kb3dzPiR7eG1sfTwvd2luZG93cz5gO1xuICAgIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlID0gcmVzdWx0O1xuICAgIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlQXQgPSBub3c7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGFwcF9nZXRXaW5SZWN0ICh3aWQpIHtcbiAgICBjb25zdCBwYXJzZWRXaWQgPSBOdW1iZXIucGFyc2VJbnQoYCR7d2lkfWAsIDEwKTtcbiAgICBsZXQgd2luID0gdGhpcy5fd2luZG93TWFwLmdldChwYXJzZWRXaWQpO1xuICAgIGlmICghd2luKSB7XG4gICAgICB0aGlzLl9yZWZyZXNoV2luZG93Q2FjaGUoKTtcbiAgICAgIHdpbiA9IHRoaXMuX3dpbmRvd01hcC5nZXQocGFyc2VkV2lkKTtcbiAgICB9XG4gICAgaWYgKCF3aW4pIHtcbiAgICAgIHJldHVybiB7eDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICB4OiB3aW4ucmVjdC54LFxuICAgICAgeTogd2luLnJlY3QueSxcbiAgICAgIHdpZHRoOiB3aW4ucmVjdC53aWR0aCxcbiAgICAgIGhlaWdodDogd2luLnJlY3QuaGVpZ2h0LFxuICAgIH07XG4gIH1cblxuICBhcHBfcnVubmluZyAoYXBwUGF0aCkge1xuICAgIHJldHVybiB0aGlzLl9nZXROYXRpdmVBcGlzKCkuYXBwX3J1bm5pbmcoYXBwUGF0aCk7XG4gIH1cblxuICBhcHBfbGF1bmNoIChhcHBQYXRoKSB7XG4gICAgdGhpcy5faW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSgpO1xuICAgIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlID0gbnVsbDtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZUF0ID0gMDtcbiAgICByZXR1cm4gdGhpcy5fZ2V0TmF0aXZlQXBpcygpLmFwcF9sYXVuY2goYXBwUGF0aCk7XG4gIH1cblxuICBhcHBfa2lsbCAoYXBwUGF0aCkge1xuICAgIHRoaXMuX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUoKTtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZSA9IG51bGw7XG4gICAgdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGVBdCA9IDA7XG4gICAgcmV0dXJuIHRoaXMuX2dldE5hdGl2ZUFwaXMoKS5hcHBfa2lsbChhcHBQYXRoKTtcbiAgfVxuXG4gIGExMXlfY2xlYXJfY2FjaGUgKCkge1xuICAgIC8vIE9ubHkgY2xlYXIgdGhlIG5hdGl2ZSBBVC1TUEkgY2FjaGUuICBOZWl0aGVyIHRoZSBKUyBkZXNrdG9wIGhpZXJhcmNoeVxuICAgIC8vIGNhY2hlIG5vciB0aGUgd2luZG93IGhpZXJhcmNoeSBYTUwgY2FjaGUgaXMgaW52YWxpZGF0ZWQgaGVyZS5cbiAgICAvLyBUaGUgWE1MIGNhY2hlIGhvbGRzIHdpbmRvdy1sZXZlbCBtZXRhZGF0YSAocGlkL3dpZC9uYW1lKSB3aGljaCBkb2VzXG4gICAgLy8gbm90IGNoYW5nZSBiZXR3ZWVuIGZpbmRFbGVtZW50IGNhbGxzIOKAlCBpdCBpcyBleHBsaWNpdGx5IGludmFsaWRhdGVkXG4gICAgLy8gYnkgZ2V0V2luZG93SGFuZGxlcygpLCBhcHBfbGF1bmNoKCksIGFuZCBhcHBfa2lsbCgpLlxuICAgIC8vIENsZWFyaW5nIGl0IGhlcmUgZm9yY2VkIF92YWxpZGF0ZU9yVXBkYXRlV2luSW5mbyB0byByZWJ1aWxkIHRoZVxuICAgIC8vIHdpbmRvdyBsaXN0IGZyb20gdGhlIGRlc2t0b3AgaGllcmFyY2h5IG9uIGV2ZXJ5IGZpbmRFbGVtZW50LCB3aGljaFxuICAgIC8vIG9uIFJIRUwgV2F5bGFuZCB0cmlnZ2VyZWQgZXhwZW5zaXZlIDItOHMgbmF0aXZlIEFULVNQSSBkZXNrdG9wIHNjYW5zXG4gICAgLy8gd2hlbmV2ZXIgdGhlIGRlc2t0b3AgY2FjaGUgVFRMIGhhZCBhbHNvIGV4cGlyZWQuXG4gICAgcmV0dXJuIHRoaXMuX2dldE5hdGl2ZUFwaXMoKS5hMTF5X2NsZWFyX2NhY2hlKCk7XG4gIH1cblxuICBhMTF5X2dldFdpbmRvd1VpSGllcmFjaHkgKHdpbmRvd05hbWUsIHBpZCkge1xuICAgIHJldHVybiB0aGlzLl9nZXROYXRpdmVBcGlzKCkuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5KHdpbmRvd05hbWUsIHBpZCk7XG4gIH1cblxuICBhMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSAod2lkLCBwaWQsIHdpbmRvd05hbWUpIHtcbiAgICBjb25zdCBwYXJzZWRXaWQgPSBOdW1iZXIucGFyc2VJbnQoYCR7d2lkfWAsIDEwKTtcbiAgICBsZXQgdGFyZ2V0V2luZG93ID0gdGhpcy5fd2luZG93TWFwLmdldChwYXJzZWRXaWQpO1xuXG4gICAgY29uc3QgZGVza3RvcCA9IHRoaXMuX2dldERlc2t0b3BIaWVyYXJjaHkoKTtcbiAgICBpZiAoIWRlc2t0b3ApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFdheWxhbmQgc2NvcGVkIHdpbmRvdyB0cmVlIGNvdWxkIG5vdCBiZSByZXNvbHZlZCBmb3Igd2lkPSR7d2lkfSwgbmFtZT0ke3dpbmRvd05hbWV9LCBwaWQ9JHtwaWR9OiBkZXNrdG9wIGhpZXJhcmNoeSBpcyB1bmF2YWlsYWJsZWBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gT25seSByZWJ1aWxkIHRoZSB3aW5kb3cgbGlzdCBpZiB0aGUgdGFyZ2V0IHdpbmRvdyBpcyBub3QgYWxyZWFkeSBrbm93bi5cbiAgICAvLyBTa2lwcGluZyB0aGUgcmVkdW5kYW50IF9yZWZyZXNoV2luZG93Q2FjaGUgYXZvaWRzIHJlLXBhcnNpbmcgdGhlIGRlc2t0b3BcbiAgICAvLyBYTUwgKERPTSArIFhQYXRoIG92ZXIgYWxsIG5vZGVzKSBvbiBldmVyeSBmaW5kRWxlbWVudCBjYWxsLlxuICAgIGlmICghdGFyZ2V0V2luZG93KSB7XG4gICAgICB0aGlzLl9yZWZyZXNoV2luZG93Q2FjaGUoZGVza3RvcCk7XG4gICAgICB0YXJnZXRXaW5kb3cgPSB0aGlzLl93aW5kb3dNYXAuZ2V0KHBhcnNlZFdpZCk7XG4gICAgfVxuICAgIGlmICghdGFyZ2V0V2luZG93KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBXYXlsYW5kIHNjb3BlZCB3aW5kb3cgdHJlZSBjb3VsZCBub3QgYmUgcmVzb2x2ZWQgZm9yIHdpZD0ke3dpZH0sIG5hbWU9JHt3aW5kb3dOYW1lfSwgcGlkPSR7cGlkfTogd2luZG93IGhhbmRsZSBpcyBubyBsb25nZXIgcHJlc2VudGBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcGlkcyA9IHRoaXMuX2dldE5hdGl2ZUFwaXMoKS5hcHBfcnVubmluZyh0aGlzLmFwcE5hbWUpIHx8IFtdO1xuICAgIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwoZGVza3RvcCwgcGlkcywgdGFyZ2V0V2luZG93LCB7YWxsb3dUcmFuc2llbnRPdmVybGF5OiB0cnVlfSk7XG4gICAgaWYgKHJlc29sdmVkLnhtbCkge1xuICAgICAgcmV0dXJuIHJlc29sdmVkLnhtbDtcbiAgICB9XG5cbiAgICBjb25zdCByZWFzb24gPSByZXNvbHZlZC5yZWFzb24gPT09ICdhbWJpZ3VvdXMnXG4gICAgICA/ICdtdWx0aXBsZSBtYXRjaGluZyB3aW5kb3cgc3VidHJlZXMgd2VyZSBmb3VuZCdcbiAgICAgIDogJ25vIG1hdGNoaW5nIHdpbmRvdyBzdWJ0cmVlIHdhcyBmb3VuZCc7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFdheWxhbmQgc2NvcGVkIHdpbmRvdyB0cmVlIGNvdWxkIG5vdCBiZSByZXNvbHZlZCBmb3Igd2lkPSR7dGFyZ2V0V2luZG93LndpZH0sIG5hbWU9JHt0YXJnZXRXaW5kb3cubmFtZSB8fCB3aW5kb3dOYW1lfSwgcGlkPSR7dGFyZ2V0V2luZG93LnBpZCB8fCBwaWR9OiAke3JlYXNvbn1gXG4gICAgKTtcbiAgfVxuXG4gIGExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkgKCkge1xuICAgIHJldHVybiB0aGlzLl9nZXREZXNrdG9wSGllcmFyY2h5KCk7XG4gIH1cblxuICBhMTF5X2NoZWNrV2luZG93RXhpc3RzICh3aW5kb3dOYW1lLCBwaWQpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHRoaXMuX2dldE5hdGl2ZUFwaXMoKS5hMTF5X2NoZWNrV2luZG93RXhpc3RzKHdpbmRvd05hbWUsIHBpZCkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBmYWxsIHRocm91Z2hcbiAgICB9XG5cbiAgICB0aGlzLl9yZWZyZXNoV2luZG93Q2FjaGUoKTtcbiAgICBjb25zdCB0YXJnZXQgPSBgJHt3aW5kb3dOYW1lID8/ICcnfWAudHJpbSgpO1xuICAgIHJldHVybiB0aGlzLl93aW5kb3dMaXN0LnNvbWUoKHcpID0+IHtcbiAgICAgIGlmICh3LnBpZCAhPT0gTnVtYmVyLnBhcnNlSW50KGAke3BpZH1gLCAxMCkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgaWYgKHcubmFtZSA9PT0gdGFyZ2V0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgY2xhc3NlcyA9IGAke3cuY2xhc3NOYW1lID8/ICcnfWAuc3BsaXQoL1xccysvKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICByZXR1cm4gY2xhc3Nlcy5pbmNsdWRlcyh0YXJnZXQpO1xuICAgIH0pO1xuICB9XG5cbiAgY19nZXRNYWluRGlzcGxheVNpemUgKCkge1xuICAgIGlmICh0aGlzLl9wb3J0YWwubG9naWNhbFNpemU/LndpZHRoID4gMCAmJiB0aGlzLl9wb3J0YWwubG9naWNhbFNpemU/LmhlaWdodCA+IDApIHtcbiAgICAgIHJldHVybiB0aGlzLl9wb3J0YWwubG9naWNhbFNpemU7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG5hdGl2ZVNpemUgPSB0aGlzLl9nZXROYXRpdmVBcGlzKCkuY19nZXRNYWluRGlzcGxheVNpemUoKTtcbiAgICAgIGlmIChuYXRpdmVTaXplPy53aWR0aCA+IDAgJiYgbmF0aXZlU2l6ZT8uaGVpZ2h0ID4gMCkge1xuICAgICAgICByZXR1cm4gbmF0aXZlU2l6ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGZhbGwgdGhyb3VnaFxuICAgIH1cblxuICAgIHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuICAgIGxldCB3aWR0aCA9IDA7XG4gICAgbGV0IGhlaWdodCA9IDA7XG4gICAgZm9yIChjb25zdCB3IG9mIHRoaXMuX3dpbmRvd0xpc3QpIHtcbiAgICAgIHdpZHRoID0gTWF0aC5tYXgod2lkdGgsIHcucmVjdC54ICsgdy5yZWN0LndpZHRoKTtcbiAgICAgIGhlaWdodCA9IE1hdGgubWF4KGhlaWdodCwgdy5yZWN0LnkgKyB3LnJlY3QuaGVpZ2h0KTtcbiAgICB9XG4gICAgcmV0dXJuIHt3aWR0aCwgaGVpZ2h0fTtcbiAgfVxuXG4gIF9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIgKCkge1xuICAgIGlmICghdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AgfHwgIXRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaXMgbm90IHJlYWR5IGZvciBwb2ludGVyIGV2ZW50cycpO1xuICAgIH1cbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh0aGlzLl9wb3J0YWwuc3RyZWFtTm9kZUlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBkaWQgbm90IHByb3ZpZGUgYSBzdHJlYW0gbm9kZSBpZC4gUG9pbnRlciBhYnNvbHV0ZSBldmVudHMgYXJlIHVuYXZhaWxhYmxlLicpO1xuICAgIH1cbiAgfVxuXG4gIF9pc1BvcnRhbFJlYWR5Rm9yUG9pbnRlciAoKSB7XG4gICAgcmV0dXJuIEJvb2xlYW4oXG4gICAgICB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcCAmJlxuICAgICAgdGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUgJiZcbiAgICAgIE51bWJlci5pc0Zpbml0ZSh0aGlzLl9wb3J0YWwuc3RyZWFtTm9kZUlkKVxuICAgICk7XG4gIH1cblxuICBfYnV0dG9uQ29kZSAoYnV0dG9uKSB7XG4gICAgaWYgKGJ1dHRvbiA9PT0gMykge1xuICAgICAgcmV0dXJuIFBPSU5URVJfUklHSFQ7XG4gICAgfVxuICAgIGlmIChidXR0b24gPT09IDIpIHtcbiAgICAgIHJldHVybiBQT0lOVEVSX01JRERMRTtcbiAgICB9XG4gICAgcmV0dXJuIFBPSU5URVJfTEVGVDtcbiAgfVxuXG4gIGFzeW5jIG1vdXNlX21vdmUgKHgsIHkpIHtcbiAgICBpZiAodGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGhhcyBubyBQT0lOVEVSIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICB0aGlzLl9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIoKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AuTm90aWZ5UG9pbnRlck1vdGlvbkFic29sdXRlKFxuICAgICAgICB0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSxcbiAgICAgICAge30sXG4gICAgICAgIHRoaXMuX3BvcnRhbC5zdHJlYW1Ob2RlSWQsXG4gICAgICAgIE51bWJlcih4KSxcbiAgICAgICAgTnVtYmVyKHkpXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAodGhpcy5faXNQb2ludGVyUGVybWlzc2lvbkVycm9yKGVycm9yKSkge1xuICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICdXYXlsYW5kIHBvcnRhbCBkZW5pZWQgcG9pbnRlciBtb3Rpb24gZXZlbnRzLiAnICtcbiAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1vdXNlX2NsaWNrICh4LCB5LCBidXR0b24pIHtcbiAgICBjb25zdCBidXR0b25Db2RlID0gdGhpcy5fYnV0dG9uQ29kZShidXR0b24pO1xuXG4gICAgLy8gRmFzdCBwYXRoOiBwb3J0YWwgaXMgZnVsbHkgcmVhZHkgKGhhcyBzdHJlYW1Ob2RlSWQpLiBVc2VkIG9uIFVidW50dSBhbmQgUkhFTCB3aGVuXG4gICAgLy8gc3RyZWFtIHBhcnNpbmcgc3VjY2VlZHMuXG4gICAgaWYgKHRoaXMuX2lzUG9ydGFsUmVhZHlGb3JQb2ludGVyKCkgJiYgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkICE9PSBmYWxzZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5tb3VzZV9tb3ZlKHgsIHkpO1xuICAgICAgICBpZiAodGhpcy5fY29tcG9zaXRvclNldHRsZU1zID4gMCkge1xuICAgICAgICAgIGF3YWl0IHNsZWVwKHRoaXMuX2NvbXBvc2l0b3JTZXR0bGVNcyk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AuTm90aWZ5UG9pbnRlckJ1dHRvbih0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSwge30sIGJ1dHRvbkNvZGUsIDEpO1xuICAgICAgICBpZiAodGhpcy5fYnV0dG9uUHJlc3NSZWxlYXNlR2FwTXMgPiAwKSB7XG4gICAgICAgICAgYXdhaXQgc2xlZXAodGhpcy5fYnV0dG9uUHJlc3NSZWxlYXNlR2FwTXMpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJCdXR0b24odGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsIHt9LCBidXR0b25Db2RlLCAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgYnV0dG9uIGV2ZW50cy4gJyArXG4gICAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5vbi1wZXJtaXNzaW9uIHBvcnRhbCBlcnJvcjogZmFsbCB0aHJvdWdoIHRvIEFULVNQSSBmYWxsYmFjay5cbiAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgY2xpY2sgZmFpbGVkICgke2Vycm9yLm1lc3NhZ2V9KTsgdHJ5aW5nIEFULVNQSSBmYWxsYmFja2ApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEFULVNQSSBmYWxsYmFjazogdmFsaWQgZm9yIHByaW1hcnkgYnV0dG9uIG9ubHkgKEFULVNQSSAnY2xpY2snIGlzIGxlZnQtYnV0dG9uIHNlbWFudGljcykuXG4gICAgaWYgKChidXR0b24gPT09IDEgfHwgYnV0dG9uID09PSB1bmRlZmluZWQpICYmIHRoaXMuX2NsaWNrVmlhQTExeVBvaW50RmFsbGJhY2soeCwgeSwgJ2NsaWNrJykpIHtcbiAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgY2xpY2sgYXQgKCR7eH0sICR7eX0pIHN1Y2NlZWRlZCB2aWEgQVQtU1BJIGZhbGxiYWNrYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU3VyZmFjZSBhIGNsZWFyIGVycm9yIGlmIG5vdGhpbmcgd29ya2VkLlxuICAgIHRoaXMuX2Vuc3VyZVBvcnRhbFJlYWR5Rm9yUG9pbnRlcigpO1xuICB9XG5cbiAgYXN5bmMgbW91c2VfZG91YmxlQ2xpY2sgKHgsIHksIGJ1dHRvbikge1xuICAgIC8vIFdoZW4gcG9ydGFsIHN0cmVhbSBpcyB1bmF2YWlsYWJsZSwgdXNlIEFULVNQSSBuYXRpdmUgZG91YmxlLWNsaWNrIChzaW5nbGUgYXRvbWljIGFjdGlvbixcbiAgICAvLyBtb3JlIHJlbGlhYmxlIHRoYW4gdHdvIHNlcGFyYXRlIHBvcnRhbCBjbGlja3Mgd2l0aCBhIG1pc3Npbmcgc3RyZWFtIG5vZGUgaWQpLlxuICAgIGlmICghdGhpcy5faXNQb3J0YWxSZWFkeUZvclBvaW50ZXIoKSB8fCB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICBpZiAoKGJ1dHRvbiA9PT0gMSB8fCBidXR0b24gPT09IHVuZGVmaW5lZCkgJiYgdGhpcy5fY2xpY2tWaWFBMTF5UG9pbnRGYWxsYmFjayh4LCB5LCAnZG91YmxlJykpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBTdGFuZGFyZCBwYXRoOiB0d28gcG9ydGFsIGNsaWNrcyAodW5jaGFuZ2VkIGJlaGF2aW9yIGZvciBVYnVudHUpLlxuICAgIGF3YWl0IHRoaXMubW91c2VfY2xpY2soeCwgeSwgYnV0dG9uKTtcbiAgICBhd2FpdCBzbGVlcCh0aGlzLl9kb3VibGVDbGlja0ludGVydmFsTXMpO1xuICAgIGF3YWl0IHRoaXMubW91c2VfY2xpY2soeCwgeSwgYnV0dG9uKTtcbiAgfVxuXG4gIGFzeW5jIG1vdXNlX3N3aXBlIChzeCwgc3ksIGV4LCBleSkge1xuICAgIGlmICh0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaGFzIG5vIFBPSU5URVIgcGVybWlzc2lvbi4gUmUtcnVuIGFuZCBncmFudCByZW1vdGUgY29udHJvbCBhY2Nlc3MuJyk7XG4gICAgfVxuICAgIHRoaXMuX2Vuc3VyZVBvcnRhbFJlYWR5Rm9yUG9pbnRlcigpO1xuICAgIGNvbnN0IHN0ZXBzID0gMTg7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMubW91c2VfbW92ZShzeCwgc3kpO1xuICAgICAgaWYgKHRoaXMuX2NvbXBvc2l0b3JTZXR0bGVNcyA+IDApIHtcbiAgICAgICAgYXdhaXQgc2xlZXAodGhpcy5fY29tcG9zaXRvclNldHRsZU1zKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJCdXR0b24odGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsIHt9LCBQT0lOVEVSX0xFRlQsIDEpO1xuICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPD0gc3RlcHM7IGkrKykge1xuICAgICAgICBjb25zdCB4ID0gc3ggKyAoKGV4IC0gc3gpICogaSkgLyBzdGVwcztcbiAgICAgICAgY29uc3QgeSA9IHN5ICsgKChleSAtIHN5KSAqIGkpIC8gc3RlcHM7XG4gICAgICAgIGF3YWl0IHRoaXMubW91c2VfbW92ZSh4LCB5KTtcbiAgICAgICAgYXdhaXQgc2xlZXAoOCk7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcC5Ob3RpZnlQb2ludGVyQnV0dG9uKHRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlLCB7fSwgUE9JTlRFUl9MRUZULCAwKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID0gZmFsc2U7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgc3dpcGUgZXZlbnRzLiAnICtcbiAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1vdXNlX3Njcm9sbF94X3kgKHgsIHkpIHtcbiAgICBpZiAodGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGhhcyBubyBQT0lOVEVSIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICB0aGlzLl9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIoKTtcblxuICAgIGNvbnN0IGhvcml6b250YWxTdGVwcyA9IE51bWJlci5wYXJzZUludChgJHt4fWAsIDEwKSB8fCAwO1xuICAgIGNvbnN0IHZlcnRpY2FsU3RlcHMgPSBOdW1iZXIucGFyc2VJbnQoYCR7eX1gLCAxMCkgfHwgMDtcblxuICAgIGNvbnN0IGFwcGx5RGlzY3JldGUgPSBhc3luYyAoYXhpcywgc3RlcHMpID0+IHtcbiAgICAgIGNvbnN0IGNvdW50ID0gTWF0aC5hYnMoc3RlcHMpO1xuICAgICAgY29uc3QgZGlyZWN0aW9uID0gc3RlcHMgPiAwID8gMSA6IC0xO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjb3VudDsgaSsrKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJBeGlzRGlzY3JldGUoXG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsXG4gICAgICAgICAge30sXG4gICAgICAgICAgYXhpcyxcbiAgICAgICAgICBkaXJlY3Rpb25cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgaWYgKGhvcml6b250YWxTdGVwcyAhPT0gMCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXBwbHlEaXNjcmV0ZSgxLCBob3Jpem9udGFsU3RlcHMpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgc2Nyb2xsIGV2ZW50cy4gJyArXG4gICAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodmVydGljYWxTdGVwcyAhPT0gMCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXBwbHlEaXNjcmV0ZSgwLCB2ZXJ0aWNhbFN0ZXBzKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICh0aGlzLl9pc1BvaW50ZXJQZXJtaXNzaW9uRXJyb3IoZXJyb3IpKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID0gZmFsc2U7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ1dheWxhbmQgcG9ydGFsIGRlbmllZCBwb2ludGVyIHNjcm9sbCBldmVudHMuICcgK1xuICAgICAgICAgICAgJ1JlLXJ1biBhbmQgZW5zdXJlIHJlbW90ZSBjb250cm9sL3BvaW50ZXIgYWNjZXNzIGlzIGdyYW50ZWQgaW4gdGhlIHNoYXJlIGRpYWxvZy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBfY2hhclRvRXZkZXZLZXlTcGVjIChjaGFyKSB7XG4gICAgY29uc3QgcmF3ID0gYCR7Y2hhciA/PyAnJ31gO1xuICAgIGlmICghcmF3KSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgZmlyc3QgPSByYXdbMF07XG4gICAgY29uc3QgbG93ZXIgPSBmaXJzdC50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IGJhc2VNYXAgPSB7XG4gICAgICBhOiAzMCwgYjogNDgsIGM6IDQ2LCBkOiAzMiwgZTogMTgsIGY6IDMzLCBnOiAzNCwgaDogMzUsIGk6IDIzLFxuICAgICAgajogMzYsIGs6IDM3LCBsOiAzOCwgbTogNTAsIG46IDQ5LCBvOiAyNCwgcDogMjUsIHE6IDE2LCByOiAxOSxcbiAgICAgIHM6IDMxLCB0OiAyMCwgdTogMjIsIHY6IDQ3LCB3OiAxNywgeDogNDUsIHk6IDIxLCB6OiA0NCxcbiAgICAgIDE6IDIsIDI6IDMsIDM6IDQsIDQ6IDUsIDU6IDYsIDY6IDcsIDc6IDgsIDg6IDksIDk6IDEwLCAwOiAxMSxcbiAgICAgICcgJzogNTcsXG4gICAgICAnLSc6IDEyLFxuICAgICAgJz0nOiAxMyxcbiAgICAgICdbJzogMjYsXG4gICAgICAnXSc6IDI3LFxuICAgICAgJzsnOiAzOSxcbiAgICAgICdcXCcnOiA0MCxcbiAgICAgICcsJzogNTEsXG4gICAgICAnLic6IDUyLFxuICAgICAgJy8nOiA1MyxcbiAgICAgICdcXFxcJzogNDMsXG4gICAgICAnYCc6IDQxLFxuICAgIH07XG4gICAgY29uc3Qgc2hpZnRlZE1hcCA9IHtcbiAgICAgICchJzogMixcbiAgICAgICdAJzogMyxcbiAgICAgICcjJzogNCxcbiAgICAgICckJzogNSxcbiAgICAgICclJzogNixcbiAgICAgICdeJzogNyxcbiAgICAgICcmJzogOCxcbiAgICAgICcqJzogOSxcbiAgICAgICcoJzogMTAsXG4gICAgICAnKSc6IDExLFxuICAgICAgXzogMTIsXG4gICAgICAnKyc6IDEzLFxuICAgICAgJ3snOiAyNixcbiAgICAgICd9JzogMjcsXG4gICAgICAnOic6IDM5LFxuICAgICAgJ1wiJzogNDAsXG4gICAgICAnPCc6IDUxLFxuICAgICAgJz4nOiA1MixcbiAgICAgICc/JzogNTMsXG4gICAgICAnfCc6IDQzLFxuICAgICAgJ34nOiA0MSxcbiAgICB9O1xuXG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzaGlmdGVkTWFwLCBmaXJzdCkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGV2ZGV2OiBzaGlmdGVkTWFwW2ZpcnN0XSxcbiAgICAgICAgc2hpZnQ6IHRydWUsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoYmFzZU1hcCwgbG93ZXIpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBldmRldjogYmFzZU1hcFtsb3dlcl0sXG4gICAgICAgIHNoaWZ0OiBmaXJzdCAhPT0gbG93ZXIsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgX2NoYXJUb0V2ZGV2S2V5Y29kZSAoY2hhcikge1xuICAgIHJldHVybiB0aGlzLl9jaGFyVG9FdmRldktleVNwZWMoY2hhcik/LmV2ZGV2ID8/IG51bGw7XG4gIH1cblxuICBfa2V5c3ltVG9FdmRldiAoa2V5c3ltKSB7XG4gICAgY29uc3QgbWFwID0ge1xuICAgICAgNjUyODg6IDE0LFxuICAgICAgNjU1MzU6IDExMSxcbiAgICAgIDY1MjkzOiAyOCxcbiAgICAgIDY1Mjg5OiAxNSxcbiAgICAgIDY1MzA3OiAxLFxuICAgICAgNjUzNjI6IDEwMyxcbiAgICAgIDY1MzY0OiAxMDgsXG4gICAgICA2NTM2MTogMTA1LFxuICAgICAgNjUzNjM6IDEwNixcbiAgICAgIDY1MzYwOiAxMDIsXG4gICAgICA2NTM2NzogMTA3LFxuICAgICAgNjUzNjU6IDEwNCxcbiAgICAgIDY1MzY2OiAxMDksXG4gICAgICA2NTQ3MDogNTksXG4gICAgICA2NTQ3MTogNjAsXG4gICAgICA2NTQ3MjogNjEsXG4gICAgICA2NTQ3MzogNjIsXG4gICAgICA2NTQ3NDogNjMsXG4gICAgICA2NTQ3NTogNjQsXG4gICAgICA2NTQ3NjogNjUsXG4gICAgICA2NTQ3NzogNjYsXG4gICAgICA2NTQ3ODogNjcsXG4gICAgICA2NTQ3OTogNjgsXG4gICAgICA2NTQ4MDogODcsXG4gICAgICA2NTQ4MTogODgsXG4gICAgICA2NTUwNzogMjksXG4gICAgICA2NTUwODogOTcsXG4gICAgICA2NTUxMzogNTYsXG4gICAgICA2NTUxNDogMTAwLFxuICAgICAgNjU1MDU6IDQyLFxuICAgICAgNjU1MDY6IDU0LFxuICAgICAgNjU1MTU6IDEyNSxcbiAgICAgIDY1NTE2OiAxMjYsXG4gICAgICAzMjogNTcsXG4gICAgfTtcbiAgICByZXR1cm4gbWFwW2tleXN5bV0gPz8gbnVsbDtcbiAgfVxuXG4gIF9tb2RzRnJvbUZsYWdzIChmbGFncykge1xuICAgIGNvbnN0IG1vZENvZGVzID0gW107XG4gICAgY29uc3QgZiA9IE51bWJlci5wYXJzZUludChgJHtmbGFnc31gLCAxMCkgfHwgMDtcbiAgICBpZiAoZiAmIDEpIHtcbiAgICAgIG1vZENvZGVzLnB1c2goNDIpOyAvLyBzaGlmdFxuICAgIH1cbiAgICBpZiAoZiAmIDQpIHtcbiAgICAgIG1vZENvZGVzLnB1c2goMjkpOyAvLyBjdHJsXG4gICAgfVxuICAgIGlmIChmICYgOCkge1xuICAgICAgbW9kQ29kZXMucHVzaCg1Nik7IC8vIGFsdFxuICAgIH1cbiAgICBpZiAoZiAmIDY0KSB7XG4gICAgICBtb2RDb2Rlcy5wdXNoKDEyNSk7IC8vIG1ldGFcbiAgICB9XG4gICAgcmV0dXJuIG1vZENvZGVzO1xuICB9XG5cbiAgYXN5bmMgX25vdGlmeUtleWNvZGUgKGtleWNvZGUsIHN0YXRlKSB7XG4gICAgaWYgKHRoaXMuX3BvcnRhbC5rZXlib2FyZEFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaGFzIG5vIEtFWUJPQVJEIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICBpZiAoIXRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wIHx8ICF0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGlzIG5vdCByZWFkeSBmb3Iga2V5Ym9hcmQgZXZlbnRzJyk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeUtleWJvYXJkS2V5Y29kZShcbiAgICAgIHRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlLFxuICAgICAge30sXG4gICAgICBOdW1iZXIoa2V5Y29kZSksXG4gICAgICBOdW1iZXIoc3RhdGUpXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIF90YXBFdmRldldpdGhNb2RzIChldmRldkNvZGUsIG1vZHMgPSBbXSkge1xuICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZHMpIHtcbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kLCAxKTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldkNvZGUsIDEpO1xuICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUoZXZkZXZDb2RlLCAwKTtcbiAgICBmb3IgKGxldCBpID0gbW9kcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2RzW2ldLCAwKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBrZXlib2FyZF90YXBLZXlDb2RlIChrZXljb2RlLCBmbGFncykge1xuICAgIGNvbnN0IGV2ZGV2ID0gdGhpcy5fa2V5c3ltVG9FdmRldihOdW1iZXIucGFyc2VJbnQoYCR7a2V5Y29kZX1gLCAxMCkpO1xuICAgIGlmICghZXZkZXYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQga2V5Y29kZSBmb3IgV2F5bGFuZCBiYWNrZW5kOiAke2tleWNvZGV9YCk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3RhcEV2ZGV2V2l0aE1vZHMoZXZkZXYsIHRoaXMuX21vZHNGcm9tRmxhZ3MoZmxhZ3MpKTtcbiAgfVxuXG4gIGFzeW5jIGtleWJvYXJkX3RvZ2dsZUtleUNvZGUgKGtleWNvZGUsIGRvd24sIGZsYWdzKSB7XG4gICAgY29uc3QgZXZkZXYgPSB0aGlzLl9rZXlzeW1Ub0V2ZGV2KE51bWJlci5wYXJzZUludChgJHtrZXljb2RlfWAsIDEwKSk7XG4gICAgaWYgKCFldmRldikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBrZXljb2RlIGZvciBXYXlsYW5kIGJhY2tlbmQ6ICR7a2V5Y29kZX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKGRvd24pIHtcbiAgICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZHMpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2QsIDEpO1xuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldiwgMSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldiwgMCk7XG4gICAgZm9yIChsZXQgaSA9IG1vZHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kc1tpXSwgMCk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMga2V5Ym9hcmRfdGFwS2V5IChjLCBmbGFncykge1xuICAgIGNvbnN0IHJhdyA9IGAke2MgPz8gJyd9YDtcbiAgICBpZiAoIXJhdykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzcGVjID0gdGhpcy5fY2hhclRvRXZkZXZLZXlTcGVjKHJhd1swXSk7XG4gICAgaWYgKCFzcGVjKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGtleSAnJHtjfScgZm9yIFdheWxhbmQgYmFja2VuZGApO1xuICAgIH1cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKHNwZWMuc2hpZnQgJiYgIW1vZHMuaW5jbHVkZXMoNDIpKSB7XG4gICAgICBtb2RzLnVuc2hpZnQoNDIpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLl90YXBFdmRldldpdGhNb2RzKHNwZWMuZXZkZXYsIG1vZHMpO1xuICB9XG5cbiAgYXN5bmMga2V5Ym9hcmRfdG9nZ2xlS2V5IChjLCBkb3duLCBmbGFncykge1xuICAgIGNvbnN0IHJhdyA9IGAke2MgPz8gJyd9YDtcbiAgICBpZiAoIXJhdykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzcGVjID0gdGhpcy5fY2hhclRvRXZkZXZLZXlTcGVjKHJhd1swXSk7XG4gICAgaWYgKCFzcGVjKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGtleSAnJHtjfScgZm9yIFdheWxhbmQgYmFja2VuZGApO1xuICAgIH1cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKHNwZWMuc2hpZnQgJiYgIW1vZHMuaW5jbHVkZXMoNDIpKSB7XG4gICAgICBtb2RzLnVuc2hpZnQoNDIpO1xuICAgIH1cblxuICAgIGlmIChkb3duKSB7XG4gICAgICBmb3IgKGNvbnN0IG1vZCBvZiBtb2RzKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kLCAxKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUoc3BlYy5ldmRldiwgMSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShzcGVjLmV2ZGV2LCAwKTtcbiAgICBmb3IgKGxldCBpID0gbW9kcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2RzW2ldLCAwKTtcbiAgICB9XG4gIH1cblxuICBrZXlib2FyZF9jb3B5IChzdHIpIHtcbiAgICBpZiAodGhpcy5faGFzV2xDb3B5KSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBzYWZlU3Bhd24oJ3dsLWNvcHknLCBbXSwge2lucHV0OiBgJHtzdHIgPz8gJyd9YH0pO1xuICAgICAgaWYgKHJlc3VsdC5vaykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMuX2dldE5hdGl2ZUFwaXMoKS5rZXlib2FyZF9jb3B5KHN0cik7XG4gIH1cblxuICBrZXlib2FyZF9nZXRDbGlwYm9hcmRDb250ZW50ICgpIHtcbiAgICBpZiAodGhpcy5faGFzV2xQYXN0ZSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gc2FmZVNwYXduKCd3bC1wYXN0ZScsIFsnLW4nXSk7XG4gICAgICBpZiAocmVzdWx0Lm9rKSB7XG4gICAgICAgIHJldHVybiByZXN1bHQuc3Rkb3V0O1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fZ2V0TmF0aXZlQXBpcygpLmtleWJvYXJkX2dldENsaXBib2FyZENvbnRlbnQoKTtcbiAgfVxuXG4gIF9jYW5UeXBlU3RyaW5nRGlyZWN0bHkgKHN0cikge1xuICAgIHJldHVybiBBcnJheS5mcm9tKGAke3N0ciA/PyAnJ31gKS5ldmVyeSgoY2hhcikgPT4ge1xuICAgICAgaWYgKCFgJHtjaGFyID8/ICcnfWApIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gQm9vbGVhbih0aGlzLl9jaGFyVG9FdmRldktleVNwZWMoY2hhcikpO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMga2V5Ym9hcmRfdHlwZVN0cmluZ0NvcHlQYXN0ZSAoc3RyKSB7XG4gICAgY29uc3QgdGV4dCA9IGAke3N0ciA/PyAnJ31gO1xuICAgIGlmICghdGV4dCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9jYW5UeXBlU3RyaW5nRGlyZWN0bHkodGV4dCkpIHtcbiAgICAgIGZvciAoY29uc3QgY2hhciBvZiBBcnJheS5mcm9tKHRleHQpKSB7XG4gICAgICAgIGF3YWl0IHRoaXMua2V5Ym9hcmRfdGFwS2V5KGNoYXIsIDApO1xuICAgICAgICBhd2FpdCBzbGVlcCh0aGlzLl9rZXlUYXBJbnRlckRlbGF5TXMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMua2V5Ym9hcmRfY29weSh0ZXh0KTtcbiAgICBhd2FpdCBzbGVlcCh0aGlzLl9kaXN0cm9JbmZvLmlzUmhlbExpa2UgPyAxMjAgOiAodGhpcy5fZGlzdHJvSW5mby5pc1VidW50dSA/IDEwMCA6IDgwKSk7XG4gICAgYXdhaXQgdGhpcy5rZXlib2FyZF90YXBLZXkoJ3YnLCA0KTtcbiAgfVxuXG4gIF9yZXNvbHZlRmlsZVVyaVBhdGggKHVyaSkge1xuICAgIGNvbnN0IHJhdyA9IGAke3VyaSA/PyAnJ31gLnRyaW0oKTtcbiAgICBpZiAoIXJhdykge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnLycpKSB7XG4gICAgICByZXR1cm4gcmF3O1xuICAgIH1cbiAgICBpZiAoIXJhdy5zdGFydHNXaXRoKCdmaWxlOi8vJykpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTChyYXcpO1xuICAgICAgaWYgKHBhcnNlZC5wcm90b2NvbCAhPT0gJ2ZpbGU6Jykge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQocGFyc2VkLnBhdGhuYW1lKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIF9jYXB0dXJlQnlQb3J0YWxTY3JlZW5zaG90IChvdXRwdXRQYXRoKSB7XG4gICAgaWYgKCF0aGlzLl9wb3J0YWwuc2NyZWVuc2hvdCkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCB7VmFyaWFudH0gPSBkYnVzO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7XG4gICAgICBoYW5kbGVfdG9rZW46IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fbmV4dFRva2VuKCdzc2hvdCcpKSxcbiAgICAgIGludGVyYWN0aXZlOiBuZXcgVmFyaWFudCgnYicsIGZhbHNlKSxcbiAgICAgIG1vZGFsOiBuZXcgVmFyaWFudCgnYicsIGZhbHNlKSxcbiAgICB9O1xuXG4gICAgdGhpcy5fc3RhcnRQb3J0YWxBdXRvU2hhcmVIZWxwZXIoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2NyZWVuc2hvdFJlc3VsdCA9IGF3YWl0IHRoaXMuX3BvcnRhbFJlcXVlc3QodGhpcy5fcG9ydGFsLnNjcmVlbnNob3QsICdTY3JlZW5zaG90JywgJycsIG9wdGlvbnMpO1xuICAgICAgY29uc3Qgc291cmNlUGF0aCA9IHRoaXMuX3Jlc29sdmVGaWxlVXJpUGF0aChzY3JlZW5zaG90UmVzdWx0Py51cmkpO1xuICAgICAgaWYgKCFzb3VyY2VQYXRoIHx8ICFmcy5leGlzdHNTeW5jKHNvdXJjZVBhdGgpKSB7XG4gICAgICAgIHRoaXMuX2xvZ1dhcm4oJ1dheWxhbmQgcG9ydGFsIHNjcmVlbnNob3QgcmV0dXJuZWQgbm8gcmVhZGFibGUgVVJJOyBmYWxsaW5nIGJhY2sgdG8gQ0xJIGNhcHR1cmUgdG9vbHMuJyk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGZzLmNvcHlGaWxlU3luYyhzb3VyY2VQYXRoLCBvdXRwdXRQYXRoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKGBXYXlsYW5kIHBvcnRhbCBzY3JlZW5zaG90IGZhaWxlZCAoJHtlcnJvci5tZXNzYWdlfSk7IGZhbGxpbmcgYmFjayB0byBDTEkgY2FwdHVyZSB0b29scy5gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYXdhaXQgdGhpcy5fc3RvcFBvcnRhbEF1dG9TaGFyZUhlbHBlcigpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNfd2luc2NyZWVuc2hvdCAod2lkLCBuYW1lKSB7XG4gICAgY29uc3Qgb3V0cHV0TmFtZSA9IGAke25hbWUgfHwgJ2FwcGl1bWRyaXZlcid9LnBuZ2A7XG4gICAgY29uc3Qgb3V0cHV0UGF0aCA9IHBhdGguam9pbignL3RtcC8uc3Rkc3BhJywgb3V0cHV0TmFtZSk7XG4gICAgZnMubWtkaXJTeW5jKCcvdG1wLy5zdGRzcGEnLCB7cmVjdXJzaXZlOiB0cnVlfSk7XG5cbiAgICBjb25zdCBzdHJhdGVnaWVzID0gZ2V0V2F5bGFuZFNjcmVlbnNob3RTdHJhdGVnaWVzKHtcbiAgICAgIHBvcnRhbEF2YWlsYWJsZTogQm9vbGVhbih0aGlzLl9wb3J0YWwuc2NyZWVuc2hvdCksXG4gICAgICBoYXNHbm9tZVNjcmVlbnNob3Q6IHRoaXMuX2hhc0dub21lU2NyZWVuc2hvdCxcbiAgICAgIGhhc0dyaW06IHRoaXMuX2hhc0dyaW0sXG4gICAgfSk7XG5cbiAgICBsZXQgY2FwdHVyZU9rID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBzdHJhdGVneSBvZiBzdHJhdGVnaWVzKSB7XG4gICAgICBpZiAoc3RyYXRlZ3kgPT09ICdwb3J0YWwnKSB7XG4gICAgICAgIGNhcHR1cmVPayA9IGF3YWl0IHRoaXMuX2NhcHR1cmVCeVBvcnRhbFNjcmVlbnNob3Qob3V0cHV0UGF0aCk7XG4gICAgICB9IGVsc2UgaWYgKHN0cmF0ZWd5ID09PSAnZ25vbWUtc2NyZWVuc2hvdCcpIHtcbiAgICAgICAgY2FwdHVyZU9rID0gc2FmZVNwYXduKCdnbm9tZS1zY3JlZW5zaG90JywgWyctZicsIG91dHB1dFBhdGhdKS5vaztcbiAgICAgIH0gZWxzZSBpZiAoc3RyYXRlZ3kgPT09ICdncmltJykge1xuICAgICAgICBjYXB0dXJlT2sgPSBzYWZlU3Bhd24oJ2dyaW0nLCBbb3V0cHV0UGF0aF0pLm9rO1xuICAgICAgfVxuICAgICAgaWYgKGNhcHR1cmVPaykge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWNhcHR1cmVPayB8fCAhZnMuZXhpc3RzU3luYyhvdXRwdXRQYXRoKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IHJlY3QgPSB0aGlzLmFwcF9nZXRXaW5SZWN0KHdpZCk7XG4gICAgaWYgKHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMCkge1xuICAgICAgY29uc3QgbGVmdCA9IE1hdGgubWF4KDAsIHJlY3QueCk7XG4gICAgICBjb25zdCB0b3AgPSBNYXRoLm1heCgwLCByZWN0LnkpO1xuICAgICAgY29uc3QgdG1wUGF0aCA9IGAke291dHB1dFBhdGh9LnRtcGA7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBzaGFycChvdXRwdXRQYXRoKVxuICAgICAgICAgIC5leHRyYWN0KHtsZWZ0LCB0b3AsIHdpZHRoOiByZWN0LndpZHRoLCBoZWlnaHQ6IHJlY3QuaGVpZ2h0fSlcbiAgICAgICAgICAucG5nKClcbiAgICAgICAgICAudG9GaWxlKHRtcFBhdGgpO1xuICAgICAgICBmcy5yZW5hbWVTeW5jKHRtcFBhdGgsIG91dHB1dFBhdGgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGlmIChmcy5leGlzdHNTeW5jKHRtcFBhdGgpKSB7XG4gICAgICAgICAgZnMudW5saW5rU3luYyh0bXBQYXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFdheWxhbmRBcGlzO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBLElBQUFBLEdBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLEtBQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFFLE9BQUEsR0FBQUgsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFHLGNBQUEsR0FBQUgsT0FBQTtBQUNBLElBQUFJLFNBQUEsR0FBQUosT0FBQTtBQUNBLElBQUFLLFNBQUEsR0FBQU4sc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFNLE1BQUEsR0FBQVAsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFPLFdBQUEsR0FBQVAsT0FBQTtBQUNBLElBQUFRLGNBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLHVCQUFBLEdBQUFULE9BQUE7QUFNQSxJQUFBVSx1QkFBQSxHQUFBVixPQUFBO0FBQ0EsSUFBQVcsbUJBQUEsR0FBQVgsT0FBQTtBQU1BLE1BQU1ZLFdBQVcsR0FBRyxnQ0FBZ0M7QUFDcEQsTUFBTUMsV0FBVyxHQUFHLGlDQUFpQztBQUNyRCxNQUFNQyxnQkFBZ0IsR0FBRyxpQ0FBaUM7QUFDMUQsTUFBTUMsb0JBQW9CLEdBQUcsZ0NBQWdDO0FBQzdELE1BQU1DLGVBQWUsR0FBRyxzQ0FBc0M7QUFDOUQsTUFBTUMsZUFBZSxHQUFHLG1DQUFtQztBQUMzRCxNQUFNQyxlQUFlLEdBQUcsbUNBQW1DO0FBQzNELE1BQU1DLHFCQUFxQixHQUFHLHNDQUFzQztBQUNwRSxNQUFNQyxrQkFBa0IsR0FBR0MsTUFBTSxDQUFDQyxNQUFNLENBQUMsQ0FDdkMseUJBQXlCLEVBQ3pCLCtCQUErQixFQUMvQkMsYUFBSSxDQUFDQyxJQUFJLENBQUNDLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDQyxJQUFJLElBQUksRUFBRSxFQUFFLDJCQUEyQixDQUFDLENBQy9ELENBQUM7QUFFRixJQUFJQyxnQkFBZ0IsR0FBRyxJQUFJO0FBRTNCLFNBQVNDLGNBQWNBLENBQUEsRUFBSTtFQUN6QixJQUFJLENBQUNELGdCQUFnQixFQUFFO0lBQ3JCLE1BQU1FLFlBQVksR0FBRzlCLE9BQU8sQ0FBQywyQ0FBMkMsQ0FBQztJQUN6RTRCLGdCQUFnQixHQUFHRSxZQUFZLENBQUNDLE9BQU8sSUFBSUQsWUFBWTtFQUN6RDtFQUNBLE9BQU9GLGdCQUFnQjtBQUN6QjtBQUVBLE1BQU1JLFlBQVksR0FBRyxHQUFHO0FBQ3hCLE1BQU1DLGFBQWEsR0FBRyxHQUFHO0FBQ3pCLE1BQU1DLGNBQWMsR0FBRyxHQUFHO0FBSzFCLE1BQU1DLDZCQUE2QixHQUFHLEtBQUs7QUFDM0MsTUFBTUMsK0JBQStCLEdBQUcsQ0FDdEMsZUFBZSxFQUNmLGlCQUFpQixFQUNqQixnQkFBZ0IsRUFDaEIsaUJBQWlCLEVBQ2pCLHFCQUFxQixDQUN0QjtBQUNELE1BQU1DLHdCQUF3QixHQUFHO0FBQ2pDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLENBQUM7QUFDRCxNQUFNQyx3QkFBd0IsR0FBRztBQUNqQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxDQUFDO0FBT0QsSUFBSUMsb0JBQW9CLEdBQUcsSUFBSTtBQUUv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
