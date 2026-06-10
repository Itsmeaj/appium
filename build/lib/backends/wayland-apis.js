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
var _privateapis = _interopRequireDefault(require("@stdspa/stdspalinux_temp/dist/privateapis"));
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
    waylandAutoShare
  } = {}) {
    this.appName = appName;
    this._logger = logger;
    this._nativeApis = _privateapis.default;
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
      desktop = this._nativeApis.a11y_getDesktopUiHierachy();
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
    let pids = this._nativeApis.app_running(this.appName) || [];
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
    return this._nativeApis.app_running(appPath);
  }
  app_launch(appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._nativeApis.app_launch(appPath);
  }
  app_kill(appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._nativeApis.app_kill(appPath);
  }
  a11y_clear_cache() {
    return this._nativeApis.a11y_clear_cache();
  }
  a11y_getWindowUiHierachy(windowName, pid) {
    return this._nativeApis.a11y_getWindowUiHierachy(windowName, pid);
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
    const pids = this._nativeApis.app_running(this.appName) || [];
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
      if (this._nativeApis.a11y_checkWindowExists(windowName, pid)) {
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
      const nativeSize = this._nativeApis.c_getMainDisplaySize();
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
    this._nativeApis.keyboard_copy(str);
  }
  keyboard_getClipboardContent() {
    if (this._hasWlPaste) {
      const result = safeSpawn('wl-paste', ['-n']);
      if (result.ok) {
        return result.stdout;
      }
    }
    return this._nativeApis.keyboard_getClipboardContent();
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2JhY2tlbmRzL3dheWxhbmQtYXBpcy5qcyIsIm5hbWVzIjpbIl9mcyIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3BhdGgiLCJfY3J5cHRvIiwiX2NoaWxkX3Byb2Nlc3MiLCJfYmx1ZWJpcmQiLCJfZGJ1c05leHQiLCJfc2hhcnAiLCJfcHJpdmF0ZWFwaXMiLCJfdG9rZW5TdG9yZSIsIl9saW51eFBsYXRmb3JtIiwiX3dheWxhbmRQZXJtaXNzaW9uVXRpbHMiLCJfd2F5bGFuZFNjcmVlbnNob3RVdGlscyIsIl93YXlsYW5kV2luZG93VXRpbHMiLCJQT1JUQUxfREVTVCIsIlBPUlRBTF9QQVRIIiwiREJVU19QUk9QU19JRkFDRSIsIlBPUlRBTF9SRVFVRVNUX0lGQUNFIiwiUE9SVEFMX1JEX0lGQUNFIiwiUE9SVEFMX1NDX0lGQUNFIiwiUE9SVEFMX1NTX0lGQUNFIiwiUE9SVEFMX1JFR0lTVFJZX0lGQUNFIiwiREVTS1RPUF9FTlRSWV9ESVJTIiwiT2JqZWN0IiwiZnJlZXplIiwicGF0aCIsImpvaW4iLCJwcm9jZXNzIiwiZW52IiwiSE9NRSIsIlBPSU5URVJfTEVGVCIsIlBPSU5URVJfUklHSFQiLCJQT0lOVEVSX01JRERMRSIsIkRFRkFVTFRfQVVUT19TSEFSRV9USU1FT1VUX01TIiwiUE9JTlRFUl9QRVJNSVNTSU9OX0VSUk9SX1RPS0VOUyIsIkFVVE9fU0hBUkVfSEVMUEVSX1NDUklQVCIsIkExMVlfUE9JTlRfQUNUSU9OX1NDUklQVCIsIl9jYWNoZWRQb3J0YWxTZXNzaW9uIiwic2xlZXAiLCJtcyIsIlByb21pc2UiLCJyZXNvbHZlIiwic2V0VGltZW91dCIsImVzYyIsInZhbHVlIiwicmVwbGFjZSIsImhhc0NvbW1hbmQiLCJjb21tYW5kIiwicmVzIiwic3Bhd25TeW5jIiwic3RkaW8iLCJzdGF0dXMiLCJzYWZlU3Bhd24iLCJhcmdzIiwib3B0cyIsImVuY29kaW5nIiwib2siLCJjb2RlIiwic3Rkb3V0Iiwic3RkZXJyIiwicGFyc2VLZXlWYWx1ZU91dHB1dCIsIm91dHB1dCIsInJlc3VsdCIsInJhd0xpbmUiLCJzcGxpdCIsImxpbmUiLCJ0cmltIiwiaWR4IiwiaW5kZXhPZiIsImtleSIsInNsaWNlIiwidW5ib3giLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJBcnJheSIsImlzQXJyYXkiLCJtYXAiLCJpdGVtIiwib3V0IiwiayIsInYiLCJlbnRyaWVzIiwibm9ybWFsaXplVG9rZW4iLCJKU09OIiwic3RyaW5naWZ5IiwiY3JlYXRlU2Vzc2lvbkhhbmRsZUNhbmRpZGF0ZXNGcm9tUmVxdWVzdFBhdGgiLCJyZXF1ZXN0UGF0aCIsInNlc3Npb25IYW5kbGVUb2tlbiIsIm1hdGNoIiwiZXhlYyIsInNlbmRlclNlZ21lbnQiLCJyZXF1ZXN0VG9rZW4iLCJwb3AiLCJjYW5kaWRhdGVzIiwicHVzaCIsInRva2VuIiwiZXhwbGljaXRUb2tlblBhdGgiLCJpbmNsdWRlcyIsImNvZXJjZUJvb2xlYW4iLCJkZWZhdWx0VmFsdWUiLCJ1bmRlZmluZWQiLCJ0ZXh0IiwidG9Mb3dlckNhc2UiLCJmaXJzdEV4ZWNUb2tlbiIsImV4ZWNMaW5lIiwiZGVza3RvcEVudHJ5SWRGb3JGaWxlIiwiZmlsZVBhdGgiLCJiYXNlbmFtZSIsImZpbmREZXNrdG9wRW50cnlJZHNGb3JBcHAiLCJhcHBOYW1lIiwiYXBwVGV4dCIsImFwcEJhc2VOYW1lIiwiYXBwUGF0aCIsImlzQWJzb2x1dGUiLCJtYXRjaGVzIiwiZGlyIiwiZnMiLCJleGlzdHNTeW5jIiwicmVhZGRpclN5bmMiLCJlbnRyeSIsImVuZHNXaXRoIiwiZW50cnlQYXRoIiwiY29udGVudCIsInJlYWRGaWxlU3luYyIsImV4ZWNDb21tYW5kcyIsImZpbHRlciIsInN0YXJ0c1dpdGgiLCJsZW5ndGgiLCJCb29sZWFuIiwiaXNNYXRjaCIsInNvbWUiLCJjb21tYW5kVGV4dCIsImZyb20iLCJTZXQiLCJXYXlsYW5kQXBpcyIsImNvbnN0cnVjdG9yIiwibG9nZ2VyIiwid2F5bGFuZFJlc3RvcmVUb2tlbiIsIndheWxhbmRUb2tlblN0b3JlUGF0aCIsIndheWxhbmRBdXRvU2hhcmUiLCJfbG9nZ2VyIiwiX25hdGl2ZUFwaXMiLCJuYXRpdmVBcGlzIiwiX2Rpc3Ryb0luZm8iLCJkZXRlY3RMaW51eERpc3Ryb0luZm8iLCJfdG9rZW5TdG9yZVBhdGgiLCJub3JtYWxpemVTdG9yZVBhdGgiLCJfcmVzdG9yZVRva2VuRnJvbUNhcHMiLCJfcmVzdG9yZVRva2VuIiwiX3dheWxhbmRBdXRvU2hhcmUiLCJfd2F5bGFuZEF1dG9TaGFyZVRpbWVvdXRNcyIsIl9wb3J0YWxBdXRvU2hhcmVQcm9jIiwiX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lciIsIl9wb3J0YWxBdXRvU2hhcmVTdG9wcGVkIiwiX3dpbmRvd01hcCIsIk1hcCIsIl93aW5kb3dMaXN0IiwiX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSIsIl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVBdCIsIl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVUdGxNcyIsIl9wb3J0YWwiLCJidXMiLCJyZW1vdGVEZXNrdG9wIiwic2NyZWVuQ2FzdCIsInNjcmVlbnNob3QiLCJyZWdpc3RyeSIsInJlZ2lzdGVyZWRBcHBJZCIsInNlc3Npb25IYW5kbGUiLCJzdHJlYW1Ob2RlSWQiLCJsb2dpY2FsU2l6ZSIsImdyYW50ZWREZXZpY2VzIiwicG9pbnRlckFsbG93ZWQiLCJrZXlib2FyZEFsbG93ZWQiLCJyZW1vdGVEZXNrdG9wVmVyc2lvbiIsInNjcmVlbkNhc3RWZXJzaW9uIiwic2NyZWVuc2hvdFZlcnNpb24iLCJfaGFzV2xDb3B5IiwiX2hhc1dsUGFzdGUiLCJfaGFzR25vbWVTY3JlZW5zaG90IiwiX2hhc0dyaW0iLCJfY29tcG9zaXRvclNldHRsZU1zIiwiaXNSaGVsTGlrZSIsImlzVWJ1bnR1IiwiX2J1dHRvblByZXNzUmVsZWFzZUdhcE1zIiwiX2RvdWJsZUNsaWNrSW50ZXJ2YWxNcyIsIl9rZXlUYXBJbnRlckRlbGF5TXMiLCJfbG9nSW5mbyIsIm1zZyIsIl90aGlzJF9sb2dnZXIiLCJpbmZvIiwiX2xvZ1dhcm4iLCJfdGhpcyRfbG9nZ2VyMiIsIndhcm4iLCJfaW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSIsIl9pbnZhbGlkYXRlV2luZG93SGllcmFyY2h5WG1sQ2FjaGUiLCJfd2luZG93SGllcmFyY2h5WG1sQ2FjaGUiLCJfd2luZG93SGllcmFyY2h5WG1sQ2FjaGVBdCIsIl9nZXREZXNrdG9wSGllcmFyY2h5IiwiZm9yY2UiLCJub3ciLCJEYXRlIiwiZGVza3RvcCIsImExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkiLCJfc3RhcnRQb3J0YWxBdXRvU2hhcmVIZWxwZXIiLCJjbGVhclRpbWVvdXQiLCJ0aW1lb3V0U2Vjb25kcyIsIk1hdGgiLCJtYXgiLCJjZWlsIiwic2NyaXB0IiwicHJvYyIsInNwYXduIiwiUFlUSE9OVU5CVUZGRVJFRCIsIm9uIiwiY2h1bmsiLCJlcnJvciIsIm1lc3NhZ2UiLCJzaWduYWwiLCJyZWFzb24iLCJfc3RvcFBvcnRhbEF1dG9TaGFyZUhlbHBlciIsImV4aXRDb2RlIiwic2lnbmFsQ29kZSIsImtpbGwiLCJyYWNlIiwib25jZSIsIl9ydW5XaXRoUG9ydGFsQXV0b1NoYXJlIiwiZm4iLCJzaG91bGRTZXR0bGVIZWxwZXIiLCJfaXNQZXJzaXN0VW5zdXBwb3J0ZWRFcnJvciIsIl9lcnJvciRtZXNzYWdlIiwiX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvciIsIl9lcnJvciRtZXNzYWdlMiIsIl9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQiLCJncmFudEluZm8iLCJfcnVuQTExeVBvaW50QWN0aW9uIiwieCIsInkiLCJtb2RlIiwiX3giLCJOdW1iZXIiLCJfeSIsImlzRmluaXRlIiwiZGV0YWlscyIsIl9jbGlja1ZpYUExMXlQb2ludEZhbGxiYWNrIiwicG9pbnRzIiwicHgiLCJweSIsIl9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlIiwiX3Byb2Nlc3MkZ2V0dWlkIiwiX3Byb2Nlc3MkZ2V0dWlkMiIsIl9wcm9jZXNzIiwiX2RldGFpbHMkTG9ja2VkSGludCIsInVpZCIsImdldHVpZCIsInNlc3Npb25zUmVzIiwicGFydHMiLCJpZCIsInJvd1VpZCIsInVzZXJOYW1lIiwic2VhdCIsImxlYWRlciIsImtsYXNzIiwidHR5IiwiYWN0aXZlIiwiY2xhc3MiLCJhY3RpdmVDYW5kaWRhdGVzIiwicHJlZmVycmVkIiwiZmluZCIsInNob3dSZXMiLCJsb2NrZWQiLCJsb2NrZWRIaW50IiwiTG9ja2VkSGludCIsIl9tdXN0VXNlV2F5bGFuZFNlc3Npb24iLCJzZXNzaW9uVHlwZSIsIlhER19TRVNTSU9OX1RZUEUiLCJXQVlMQU5EX0RJU1BMQVkiLCJFcnJvciIsIl9ydW5QcmVmbGlnaHRDaGVja3MiLCJldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQiLCJhdXRvU2hhcmVFbmFibGVkIiwiZGlzdHJvSW5mbyIsIndhcm5pbmciLCJ3YXJuaW5ncyIsImVycm9ycyIsImRpc3RybyIsImZvcm1hdERpc3Ryb0xhYmVsIiwic2Vzc2lvblN0YXRlIiwic2Vzc2lvbklkIiwiX25leHRUb2tlbiIsInByZWZpeCIsInJhbmRvbSIsImNyeXB0byIsInJhbmRvbUJ5dGVzIiwidG9TdHJpbmciLCJfZ2V0UG9ydGFsSW50ZXJmYWNlVmVyc2lvbiIsImRlc2t0b3BPYmoiLCJpZmFjZU5hbWUiLCJwcm9wcyIsImdldEludGVyZmFjZSIsIkdldCIsInZlcnNpb24iLCJwYXJzZUludCIsIl9yZWdpc3RlclBvcnRhbEFwcElkIiwiYXBwSWQiLCJSZWdpc3RlciIsIl9lcnJvciRtZXNzYWdlMyIsIl9hd2FpdFBvcnRhbFJlc3BvbnNlIiwib2JqIiwiZ2V0UHJveHlPYmplY3QiLCJpZmFjZSIsInJlamVjdCIsInRpbWVvdXQiLCJyZW1vdmVMaXN0ZW5lciIsIm9uUmVzcG9uc2UiLCJyZXNwb25zZUNvZGUiLCJyZXN1bHRzIiwiX3BvcnRhbFJlcXVlc3QiLCJtZXRob2ROYW1lIiwicmVzcG9uc2UiLCJfZXJyb3IkbWVzc2FnZTQiLCJzZXNzaW9uX2hhbmRsZSIsImNyZWF0ZU9wdGlvbnMiLCJzZXNzaW9uX2hhbmRsZV90b2tlbiIsInN5bnRoZXNpemVkSGFuZGxlcyIsInN5bnRoZXNpemVkSGFuZGxlIiwiYWx0SGFuZGxlcyIsInVuYm94ZWRSZXN1bHRzIiwiaGFzUmVzdWx0S2V5cyIsImtleXMiLCJfb3BlblBvcnRhbFNlc3Npb24iLCJWYXJpYW50IiwiZGJ1cyIsInNlc3Npb25CdXMiLCJoYW5kbGVfdG9rZW4iLCJjcmVhdGVSZXN1bHQiLCJzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0Iiwic3VwcG9ydHNSZW1vdGVEZXNrdG9wUGVyc2lzdCIsInNvdXJjZUF0dGVtcHRzIiwidXNlUGVyc2lzdCIsInVzZVJlc3RvcmVUb2tlbiIsInNlbGVjdGVkU291cmNlcyIsInNlbGVjdFNvdXJjZXNFcnJvciIsInBlcnNpc3RBY3R1YWxseVN1cHBvcnRlZCIsImF0dGVtcHQiLCJzb3VyY2VPcHRpb25zIiwidHlwZXMiLCJtdWx0aXBsZSIsImN1cnNvcl9tb2RlIiwicGVyc2lzdF9tb2RlIiwicmVzdG9yZV90b2tlbiIsImVyciIsInNlbGVjdGVkRGV2aWNlcyIsInNlbGVjdERldmljZXNFcnJvciIsImRldmljZVBlcnNpc3RNb2RlcyIsImRldmljZU9wdGlvbnMiLCJERVZJQ0VfVFlQRV9LRVlCT0FSRCIsIkRFVklDRV9UWVBFX1BPSU5URVIiLCJzdGFydE9wdGlvbnMiLCJzdGFydFJlc3VsdHMiLCJwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlcyIsImRldmljZXMiLCJ0b3VjaEFsbG93ZWQiLCJlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24iLCJzdHJlYW1zIiwiZmlyc3RTdHJlYW0iLCJyYXdOb2RlSWQiLCJyYXdNZXRhIiwiX2ZpcnN0U3RyZWFtJCIsIl9maXJzdFN0cmVhbSQyIiwicGFyc2VkTm9kZUlkIiwiX3Jhd01ldGEiLCJzaXplIiwid2lkdGgiLCJoZWlnaHQiLCJyb3RhdGVkVG9rZW4iLCJyZXN0b3JlX2RhdGEiLCJ3cml0ZVdheWxhbmRUb2tlbiIsImluaXRpYWxpemUiLCJta2RpclN5bmMiLCJyZWN1cnNpdmUiLCJyZWFkV2F5bGFuZFRva2VuIiwiYXNzaWduIiwiX3JlZnJlc2hXaW5kb3dDYWNoZSIsInNjcmVlbnNob3RGYWlsdXJlIiwiZ2V0V2F5bGFuZFNjcmVlbnNob3RGYWlsdXJlTWVzc2FnZSIsInBvcnRhbEF2YWlsYWJsZSIsImhhc0dub21lU2NyZWVuc2hvdCIsImhhc0dyaW0iLCJkaXNwb3NlIiwiY2xlYXIiLCJkZXNrdG9wWG1sIiwiX2Rlc2t0b3AiLCJwaWRzIiwiYXBwX3J1bm5pbmciLCJfcGdyZXBQaWRzIiwiX3BncmVwUGlkc0F0IiwiYmFzZU5hbWUiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJ3aW5kb3ciLCJpZGVudGl0eUtleSIsIndpZCIsImV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyIsIndpbmRvd3MiLCJtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzIiwidyIsInNldCIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsInhtbCIsInJlY3QiLCJwaWQiLCJpbnB1dE91dHB1dCIsIm5hbWUiLCJjbGFzc05hbWUiLCJzdGF0ZXMiLCJub2RlVGFnIiwid2luZG93VHlwZSIsImFwcF9nZXRXaW5SZWN0IiwicGFyc2VkV2lkIiwid2luIiwiZ2V0IiwiYXBwX2xhdW5jaCIsImFwcF9raWxsIiwiYTExeV9jbGVhcl9jYWNoZSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeSIsIndpbmRvd05hbWUiLCJhMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSIsInRhcmdldFdpbmRvdyIsInJlc29sdmVkIiwicmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwiLCJhbGxvd1RyYW5zaWVudE92ZXJsYXkiLCJhMTF5X2NoZWNrV2luZG93RXhpc3RzIiwidGFyZ2V0IiwiX3ckY2xhc3NOYW1lIiwiY2xhc3NlcyIsImNfZ2V0TWFpbkRpc3BsYXlTaXplIiwiX3RoaXMkX3BvcnRhbCRsb2dpY2FsIiwiX3RoaXMkX3BvcnRhbCRsb2dpY2FsMiIsIm5hdGl2ZVNpemUiLCJfZW5zdXJlUG9ydGFsUmVhZHlGb3JQb2ludGVyIiwiX2lzUG9ydGFsUmVhZHlGb3JQb2ludGVyIiwiX2J1dHRvbkNvZGUiLCJidXR0b24iLCJtb3VzZV9tb3ZlIiwiTm90aWZ5UG9pbnRlck1vdGlvbkFic29sdXRlIiwibW91c2VfY2xpY2siLCJidXR0b25Db2RlIiwiTm90aWZ5UG9pbnRlckJ1dHRvbiIsIm1vdXNlX2RvdWJsZUNsaWNrIiwibW91c2Vfc3dpcGUiLCJzeCIsInN5IiwiZXgiLCJleSIsInN0ZXBzIiwiaSIsIm1vdXNlX3Njcm9sbF94X3kiLCJob3Jpem9udGFsU3RlcHMiLCJ2ZXJ0aWNhbFN0ZXBzIiwiYXBwbHlEaXNjcmV0ZSIsImF4aXMiLCJjb3VudCIsImFicyIsImRpcmVjdGlvbiIsIk5vdGlmeVBvaW50ZXJBeGlzRGlzY3JldGUiLCJfY2hhclRvRXZkZXZLZXlTcGVjIiwiY2hhciIsInJhdyIsImZpcnN0IiwibG93ZXIiLCJiYXNlTWFwIiwiYSIsImIiLCJjIiwiZCIsImUiLCJmIiwiZyIsImgiLCJqIiwibCIsIm0iLCJuIiwibyIsInAiLCJxIiwiciIsInMiLCJ0IiwidSIsInoiLCJzaGlmdGVkTWFwIiwiXyIsImV2ZGV2Iiwic2hpZnQiLCJfY2hhclRvRXZkZXZLZXljb2RlIiwiX3RoaXMkX2NoYXJUb0V2ZGV2S2V5IiwiX3RoaXMkX2NoYXJUb0V2ZGV2S2V5MiIsIl9rZXlzeW1Ub0V2ZGV2Iiwia2V5c3ltIiwiX21hcCRrZXlzeW0iLCJfbW9kc0Zyb21GbGFncyIsImZsYWdzIiwibW9kQ29kZXMiLCJfbm90aWZ5S2V5Y29kZSIsImtleWNvZGUiLCJzdGF0ZSIsIk5vdGlmeUtleWJvYXJkS2V5Y29kZSIsIl90YXBFdmRldldpdGhNb2RzIiwiZXZkZXZDb2RlIiwibW9kcyIsIm1vZCIsImtleWJvYXJkX3RhcEtleUNvZGUiLCJrZXlib2FyZF90b2dnbGVLZXlDb2RlIiwiZG93biIsImtleWJvYXJkX3RhcEtleSIsInNwZWMiLCJ1bnNoaWZ0Iiwia2V5Ym9hcmRfdG9nZ2xlS2V5Iiwia2V5Ym9hcmRfY29weSIsInN0ciIsImlucHV0Iiwia2V5Ym9hcmRfZ2V0Q2xpcGJvYXJkQ29udGVudCIsIl9jYW5UeXBlU3RyaW5nRGlyZWN0bHkiLCJldmVyeSIsImtleWJvYXJkX3R5cGVTdHJpbmdDb3B5UGFzdGUiLCJfcmVzb2x2ZUZpbGVVcmlQYXRoIiwidXJpIiwicGFyc2VkIiwiVVJMIiwicHJvdG9jb2wiLCJkZWNvZGVVUklDb21wb25lbnQiLCJwYXRobmFtZSIsIl9jYXB0dXJlQnlQb3J0YWxTY3JlZW5zaG90Iiwib3V0cHV0UGF0aCIsIm9wdGlvbnMiLCJpbnRlcmFjdGl2ZSIsIm1vZGFsIiwic2NyZWVuc2hvdFJlc3VsdCIsInNvdXJjZVBhdGgiLCJjb3B5RmlsZVN5bmMiLCJjX3dpbnNjcmVlbnNob3QiLCJvdXRwdXROYW1lIiwic3RyYXRlZ2llcyIsImdldFdheWxhbmRTY3JlZW5zaG90U3RyYXRlZ2llcyIsImNhcHR1cmVPayIsInN0cmF0ZWd5IiwibGVmdCIsInRvcCIsInRtcFBhdGgiLCJzaGFycCIsImV4dHJhY3QiLCJwbmciLCJ0b0ZpbGUiLCJyZW5hbWVTeW5jIiwidW5saW5rU3luYyIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsImRlZmF1bHQiXSwic291cmNlUm9vdCI6Ii4uLy4uLy4uIiwic291cmNlcyI6WyJsaWIvYmFja2VuZHMvd2F5bGFuZC1hcGlzLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBmcyBmcm9tICdmcyc7XG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCBjcnlwdG8gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7c3Bhd24sIHNwYXduU3luY30gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQge1Byb21pc2V9IGZyb20gJ2JsdWViaXJkJztcbmltcG9ydCBkYnVzIGZyb20gJ2RidXMtbmV4dCc7XG5pbXBvcnQgc2hhcnAgZnJvbSAnc2hhcnAnO1xuaW1wb3J0IG5hdGl2ZUFwaXMgZnJvbSAnQHN0ZHNwYS9zdGRzcGFsaW51eF90ZW1wL2Rpc3QvcHJpdmF0ZWFwaXMnO1xuaW1wb3J0IHtyZWFkV2F5bGFuZFRva2VuLCB3cml0ZVdheWxhbmRUb2tlbiwgbm9ybWFsaXplU3RvcmVQYXRofSBmcm9tICcuL3Rva2VuLXN0b3JlJztcbmltcG9ydCB7ZGV0ZWN0TGludXhEaXN0cm9JbmZvLCBldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQsIGZvcm1hdERpc3Ryb0xhYmVsfSBmcm9tICcuL2xpbnV4LXBsYXRmb3JtLmpzJztcbmltcG9ydCB7XG4gIERFVklDRV9UWVBFX0tFWUJPQVJELFxuICBERVZJQ0VfVFlQRV9QT0lOVEVSLFxuICBlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24sXG4gIHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzLFxufSBmcm9tICcuL3dheWxhbmQtcGVybWlzc2lvbi11dGlscy5qcyc7XG5pbXBvcnQge2dldFdheWxhbmRTY3JlZW5zaG90U3RyYXRlZ2llcywgZ2V0V2F5bGFuZFNjcmVlbnNob3RGYWlsdXJlTWVzc2FnZX0gZnJvbSAnLi93YXlsYW5kLXNjcmVlbnNob3QtdXRpbHMuanMnO1xuaW1wb3J0IHtcbiAgZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzLFxuICBtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzLFxuICByZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbCxcbn0gZnJvbSAnLi93YXlsYW5kLXdpbmRvdy11dGlscy5qcyc7XG5cbmNvbnN0IFBPUlRBTF9ERVNUID0gJ29yZy5mcmVlZGVza3RvcC5wb3J0YWwuRGVza3RvcCc7XG5jb25zdCBQT1JUQUxfUEFUSCA9ICcvb3JnL2ZyZWVkZXNrdG9wL3BvcnRhbC9kZXNrdG9wJztcbmNvbnN0IERCVVNfUFJPUFNfSUZBQ0UgPSAnb3JnLmZyZWVkZXNrdG9wLkRCdXMuUHJvcGVydGllcyc7XG5jb25zdCBQT1JUQUxfUkVRVUVTVF9JRkFDRSA9ICdvcmcuZnJlZWRlc2t0b3AucG9ydGFsLlJlcXVlc3QnO1xuY29uc3QgUE9SVEFMX1JEX0lGQUNFID0gJ29yZy5mcmVlZGVza3RvcC5wb3J0YWwuUmVtb3RlRGVza3RvcCc7XG5jb25zdCBQT1JUQUxfU0NfSUZBQ0UgPSAnb3JnLmZyZWVkZXNrdG9wLnBvcnRhbC5TY3JlZW5DYXN0JztcbmNvbnN0IFBPUlRBTF9TU19JRkFDRSA9ICdvcmcuZnJlZWRlc2t0b3AucG9ydGFsLlNjcmVlbnNob3QnO1xuY29uc3QgUE9SVEFMX1JFR0lTVFJZX0lGQUNFID0gJ29yZy5mcmVlZGVza3RvcC5ob3N0LnBvcnRhbC5SZWdpc3RyeSc7XG5jb25zdCBERVNLVE9QX0VOVFJZX0RJUlMgPSBPYmplY3QuZnJlZXplKFtcbiAgJy91c3Ivc2hhcmUvYXBwbGljYXRpb25zJyxcbiAgJy91c3IvbG9jYWwvc2hhcmUvYXBwbGljYXRpb25zJyxcbiAgcGF0aC5qb2luKHByb2Nlc3MuZW52LkhPTUUgfHwgJycsICcubG9jYWwvc2hhcmUvYXBwbGljYXRpb25zJyksXG5dKTtcblxuY29uc3QgUE9JTlRFUl9MRUZUID0gMjcyO1xuY29uc3QgUE9JTlRFUl9SSUdIVCA9IDI3MztcbmNvbnN0IFBPSU5URVJfTUlERExFID0gMjc0O1xuLy8gMTVzIGluaXRpYWwgdGltZW91dCDigJQgdGhlIGhlbHBlciBhdXRvLXJlc3RhcnRzIG9uIHRpbWVvdXQgKGV4aXQgY29kZSAyKSxcbi8vIHNvIGlmIEdOT01FIHRha2VzIGxvbmdlciB0byBzaG93IHRoZSBjb25zZW50IGRpYWxvZyBpdCB3aWxsIGJlIGNhdWdodCBvblxuLy8gdGhlIG5leHQgY3ljbGUuICBBIHNob3J0ZXIgZmlyc3QgY3ljbGUgbWVhbnMgd2UgcmVzdGFydCBhbmQgcmUtcG9sbCBzb29uZXJcbi8vIHdoZW4gdGhlIGRpYWxvZyBhcHBlYXJzIGluIHRoZSAxNS0zMHMgd2luZG93IChvYnNlcnZlZCBvbiBSSEVMIDEwKS5cbmNvbnN0IERFRkFVTFRfQVVUT19TSEFSRV9USU1FT1VUX01TID0gMTUwMDA7XG5jb25zdCBQT0lOVEVSX1BFUk1JU1NJT05fRVJST1JfVE9LRU5TID0gW1xuICAnbm90aWZ5cG9pbnRlcicsXG4gICdwb2ludGVyIG1ldGhvZHMnLFxuICAncG9pbnRlciBhY2Nlc3MnLFxuICAnd2l0aG91dCBwb2ludGVyJyxcbiAgJ25vdCBhbGxvd2VkIHRvIGNhbGwnLFxuXTtcbmNvbnN0IEFVVE9fU0hBUkVfSEVMUEVSX1NDUklQVCA9IGBcbmltcG9ydCBweWF0c3BpXG5pbXBvcnQgc3lzXG5pbXBvcnQgdGltZVxuXG5CVVRUT05fUk9MRSA9IHB5YXRzcGkuUk9MRV9QVVNIX0JVVFRPTlxuQ0hFQ0tCT1hfUk9MRSA9IGdldGF0dHIocHlhdHNwaSwgJ1JPTEVfQ0hFQ0tfQk9YJywgTm9uZSlcblRPR0dMRV9ST0xFID0gZ2V0YXR0cihweWF0c3BpLCAnUk9MRV9UT0dHTEVfQlVUVE9OJywgTm9uZSlcbkNIRUNLQUJMRV9ST0xFUyA9IHtyIGZvciByIGluIChDSEVDS0JPWF9ST0xFLCBUT0dHTEVfUk9MRSkgaWYgciBpcyBub3QgTm9uZX1cblJFTU9URV9DT05UUk9MX1JPTEVTID0gQ0hFQ0tBQkxFX1JPTEVTIHwge0JVVFRPTl9ST0xFfVxuU1RBVEVfQ0hFQ0tFRCA9IGdldGF0dHIocHlhdHNwaSwgJ1NUQVRFX0NIRUNLRUQnLCBOb25lKVxuUkVNT1RFX0NPTlRST0xfS0VZV09SRFMgPSAoJ3JlbW90ZScsICdjb250cm9sJywgJ2tleWJvYXJkJywgJ21vdXNlJywgJ2lucHV0JywgJ2ludGVyYWN0aW9uJylcblJFTUVNQkVSX0tFWVdPUkRTID0gKCdyZW1lbWJlcicsICdzZWxlY3Rpb24nKVxuQVBQUk9WRV9LRVlXT1JEUyA9ICgnc2hhcmUnLCAnYWxsb3cnLCAnZ3JhbnQnKVxuQ0FQVFVSRV9BUFBST1ZFX0tFWVdPUkRTID0gKCdjYXB0dXJlJywgJ3NjcmVlbnNob3QnKVxuUkVKRUNUX0tFWVdPUkRTID0gKCdjYW5jZWwnLCAnZGVueScsICdzdG9wJylcblBPUlRBTF9DT05URVhUX0tFWVdPUkRTID0gKFxuICAgICdyZW1vdGUgZGVza3RvcCcsXG4gICAgJ3NoYXJlIHlvdXIgc2NyZWVuJyxcbiAgICAnYWxsb3cgcmVtb3RlIGludGVyYWN0aW9uJyxcbiAgICAndW5rbm93biBkaXNwbGF5JyxcbiAgICAncmVtZW1iZXIgdGhpcyBzZWxlY3Rpb24nLFxuICAgICdhbGxvdyBhY2Nlc3MnLFxuICAgICdzY3JlZW4gc2hhcmluZycsXG4gICAgJ2FsbG93IGNvbnRyb2wnLFxuICAgICdyZW1vdGUgY29udHJvbCcsXG4gICAgJ3NoYXJlIHRoaXMgc2NyZWVuc2hvdCcsXG4gICAgJ3JlcXVlc3RpbmcgYXBwbGljYXRpb24nLFxuKVxuQ0FQVFVSRV9QT1JUQUxfQ09OVEVYVF9LRVlXT1JEUyA9IChcbiAgICAnc2NyZWVuIHNlbGVjdGlvbicsXG4gICAgJ3dpbmRvdyBzZWxlY3Rpb24nLFxuICAgICdhcmVhIHNlbGVjdGlvbicsXG4gICAgJ3JlY29yZCBzY3JlZW4nLFxuICAgICdzaG93IHBvaW50ZXInLFxuICAgICd0YWtlIHNjcmVlbnNob3QnLFxuICAgICdjYXB0dXJlJyxcbiAgICAnc2NyZWVuY2FzdCcsXG4pXG5USU1FT1VUX1NFQ09ORFMgPSBfX1RJTUVPVVRfU0VDT05EU19fXG5cbmRlZiBpdGVyX25vZGVzKG5vZGUpOlxuICAgIHlpZWxkIG5vZGVcbiAgICB0cnk6XG4gICAgICAgIGNvdW50ID0gbm9kZS5jaGlsZENvdW50XG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcmV0dXJuXG4gICAgZm9yIGlkeCBpbiByYW5nZShjb3VudCk6XG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIGNoaWxkID0gbm9kZVtpZHhdXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICBmb3IgbmVzdGVkIGluIGl0ZXJfbm9kZXMoY2hpbGQpOlxuICAgICAgICAgICAgeWllbGQgbmVzdGVkXG5cbmRlZiBhdHNwaV9jbGlja19hdChub2RlKTpcbiAgICBcIlwiXCJDbGljayBhdCB0aGUgY2VudHJlIG9mIGEgbm9kZSB1c2luZyBweWF0c3BpLlJlZ2lzdHJ5LmdlbmVyYXRlTW91c2VFdmVudC5cbiAgICBXb3JrcyBvbiBXYXlsYW5kIHdoZXJlIHhkb3Rvb2wgZG9lcyBub3QuXCJcIlwiXG4gICAgdHJ5OlxuICAgICAgICBjb21wID0gbm9kZS5xdWVyeUNvbXBvbmVudCgpXG4gICAgICAgIHJlY3QgPSBjb21wLmdldEV4dGVudHMocHlhdHNwaS5ERVNLVE9QX0NPT1JEUylcbiAgICAgICAgY3ggPSByZWN0LnggKyByZWN0LndpZHRoIC8vIDJcbiAgICAgICAgY3kgPSByZWN0LnkgKyByZWN0LmhlaWdodCAvLyAyXG4gICAgICAgIGlmIGN4IDw9IDAgb3IgY3kgPD0gMDpcbiAgICAgICAgICAgIHJldHVybiBGYWxzZVxuICAgICAgICBweWF0c3BpLlJlZ2lzdHJ5LmdlbmVyYXRlTW91c2VFdmVudChjeCwgY3ksICdiMWMnKVxuICAgICAgICByZXR1cm4gVHJ1ZVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiBGYWxzZVxuXG5kZWYgaW52b2tlX2FjdGlvbihub2RlKTpcbiAgICAjIEZpcnN0IHRyeSBBVC1TUEkgZG9BY3Rpb24gKHdvcmtzIG9uIEdUSzMgLyBzb21lIHRvb2xraXRzKVxuICAgIGNhbmRpZGF0ZXMgPSBbXVxuICAgIGN1cnJlbnQgPSBub2RlXG4gICAgd2hpbGUgY3VycmVudCBpcyBub3QgTm9uZSBhbmQgbGVuKGNhbmRpZGF0ZXMpIDwgMzpcbiAgICAgICAgY2FuZGlkYXRlcy5hcHBlbmQoY3VycmVudClcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50XG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjdXJyZW50ID0gTm9uZVxuICAgIGZvciBjYW5kaWRhdGUgaW4gY2FuZGlkYXRlczpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgYWN0aW9uID0gY2FuZGlkYXRlLnF1ZXJ5QWN0aW9uKClcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIHRvdGFsID0gYWN0aW9uLm5BY3Rpb25zXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICB0b3RhbCA9IDBcbiAgICAgICAgZm9yIGlkeCBpbiByYW5nZSh0b3RhbCk6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgYWN0aW9uX25hbWUgPSAoYWN0aW9uLmdldE5hbWUoaWR4KSBvciAnJykuc3RyaXAoKS5sb3dlcigpXG4gICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgICAgIGFjdGlvbl9uYW1lID0gJydcbiAgICAgICAgICAgIGlmIGFjdGlvbl9uYW1lIGluICgnY2xpY2snLCAncHJlc3MnLCAnYWN0aXZhdGUnLCAndG9nZ2xlJywgJ2NoZWNrJywgJycpOlxuICAgICAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICAgICAgaWYgYWN0aW9uLmRvQWN0aW9uKGlkeCk6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gVHJ1ZVxuICAgICAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgIyBGYWxsYmFjazogY29vcmRpbmF0ZSBjbGljayB2aWEgQVQtU1BJIGdlbmVyYXRlTW91c2VFdmVudCAobmVlZGVkIG9uXG4gICAgIyBHTk9NRSA0NiAvIFJIRUwgMTAgd2hlcmUgZG9BY3Rpb24gb24gbGliYWR3YWl0YSBzd2l0Y2hlcyBpcyBhIG5vLW9wKS5cbiAgICByZXR1cm4gYXRzcGlfY2xpY2tfYXQobm9kZSlcblxuZGVmIHNhZmVfbmFtZShub2RlKTpcbiAgICB0cnk6XG4gICAgICAgIHJldHVybiAoZ2V0YXR0cihub2RlLCAnbmFtZScsICcnKSBvciAnJykuc3RyaXAoKVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiAnJ1xuXG5kZWYgbmVhcmJ5X2xhYmVscyhub2RlKTpcbiAgICBsYWJlbHMgPSBbXVxuICAgIHNlZW4gPSBzZXQoKVxuXG4gICAgZGVmIGFkZChjYW5kaWRhdGUpOlxuICAgICAgICBpZiBjYW5kaWRhdGUgaXMgTm9uZTpcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBrZXkgPSBpZChjYW5kaWRhdGUpXG4gICAgICAgIGlmIGtleSBpbiBzZWVuOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIHNlZW4uYWRkKGtleSlcbiAgICAgICAgbmFtZSA9IHNhZmVfbmFtZShjYW5kaWRhdGUpXG4gICAgICAgIGlmIG5hbWU6XG4gICAgICAgICAgICBsYWJlbHMuYXBwZW5kKG5hbWUpXG5cbiAgICBhZGQobm9kZSlcbiAgICB0cnk6XG4gICAgICAgIHBhcmVudCA9IG5vZGUucGFyZW50XG4gICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgcGFyZW50ID0gTm9uZVxuICAgIGFkZChwYXJlbnQpXG4gICAgdHJ5OlxuICAgICAgICBncmFuZHBhcmVudCA9IHBhcmVudC5wYXJlbnQgaWYgcGFyZW50IGlzIG5vdCBOb25lIGVsc2UgTm9uZVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIGdyYW5kcGFyZW50ID0gTm9uZVxuICAgIGFkZChncmFuZHBhcmVudClcbiAgICB0cnk6XG4gICAgICAgIGdyZWF0X2dyYW5kcGFyZW50ID0gZ3JhbmRwYXJlbnQucGFyZW50IGlmIGdyYW5kcGFyZW50IGlzIG5vdCBOb25lIGVsc2UgTm9uZVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIGdyZWF0X2dyYW5kcGFyZW50ID0gTm9uZVxuICAgIGFkZChncmVhdF9ncmFuZHBhcmVudClcblxuICAgIGZvciBjYW5kaWRhdGUgaW4gKG5vZGUsIHBhcmVudCwgZ3JhbmRwYXJlbnQsIGdyZWF0X2dyYW5kcGFyZW50KTpcbiAgICAgICAgaWYgY2FuZGlkYXRlIGlzIE5vbmU6XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBjb3VudCA9IGNhbmRpZGF0ZS5jaGlsZENvdW50XG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb3VudCA9IDBcbiAgICAgICAgZm9yIGlkeCBpbiByYW5nZShjb3VudCk6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY2hpbGQgPSBjYW5kaWRhdGVbaWR4XVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgICAgICAgICAgYWRkKGNoaWxkKVxuICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgIGdyYW5kY2hpbGRfY291bnQgPSBjaGlsZC5jaGlsZENvdW50XG4gICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgICAgIGdyYW5kY2hpbGRfY291bnQgPSAwXG4gICAgICAgICAgICBmb3IgY2hpbGRfaWR4IGluIHJhbmdlKGdyYW5kY2hpbGRfY291bnQpOlxuICAgICAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICAgICAgYWRkKGNoaWxkW2NoaWxkX2lkeF0pXG4gICAgICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICByZXR1cm4gbGFiZWxzXG5cbmRlZiBsb29rc19saWtlX3BvcnRhbF9jb250ZXh0KG5vZGUpOlxuICAgIGxhYmVscyA9IG5lYXJieV9sYWJlbHMobm9kZSlcbiAgICBsb3dlcmVkID0gJyAnLmpvaW4obGFiZWwubG93ZXIoKSBmb3IgbGFiZWwgaW4gbGFiZWxzKVxuICAgIHJldHVybiAoXG4gICAgICAgIGFueShrZXl3b3JkIGluIGxvd2VyZWQgZm9yIGtleXdvcmQgaW4gUE9SVEFMX0NPTlRFWFRfS0VZV09SRFMpIG9yXG4gICAgICAgIGFueShrZXl3b3JkIGluIGxvd2VyZWQgZm9yIGtleXdvcmQgaW4gQ0FQVFVSRV9QT1JUQUxfQ09OVEVYVF9LRVlXT1JEUylcbiAgICApXG5cbmRlZiBsb29rc19saWtlX2NhcHR1cmVfY29udGV4dChsb3dlcmVkX2NvbnRleHQpOlxuICAgIHJldHVybiBhbnkoa2V5d29yZCBpbiBsb3dlcmVkX2NvbnRleHQgZm9yIGtleXdvcmQgaW4gQ0FQVFVSRV9QT1JUQUxfQ09OVEVYVF9LRVlXT1JEUylcblxuZGVmIGlzX2FwcHJvdmVfY2FuZGlkYXRlKGJ1dHRvbl9uYW1lLCBuZWFyYnksIGxvd2VyZWRfY29udGV4dCk6XG4gICAgbG93ZXJfbmFtZSA9IGJ1dHRvbl9uYW1lLmxvd2VyKClcbiAgICBsb3dlcmVkX3ByaW1hcnkgPSAnICcuam9pbihsYWJlbC5sb3dlcigpIGZvciBsYWJlbCBpbiBuZWFyYnlbOjRdKVxuICAgIGlmIGFueShrZXl3b3JkIGluIGxvd2VyX25hbWUgZm9yIGtleXdvcmQgaW4gUkVKRUNUX0tFWVdPUkRTKTpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG4gICAgaWYgYW55KGtleXdvcmQgaW4gbG93ZXJfbmFtZSBmb3Iga2V5d29yZCBpbiBBUFBST1ZFX0tFWVdPUkRTKTpcbiAgICAgICAgcmV0dXJuIFRydWVcbiAgICBpZiBub3QgbG9va3NfbGlrZV9jYXB0dXJlX2NvbnRleHQobG93ZXJlZF9jb250ZXh0KTpcbiAgICAgICAgcmV0dXJuIEZhbHNlXG4gICAgcmV0dXJuIGFueShrZXl3b3JkIGluIGxvd2VyX25hbWUgZm9yIGtleXdvcmQgaW4gQ0FQVFVSRV9BUFBST1ZFX0tFWVdPUkRTKVxuXG5kZWYgY2xhc3NpZnlfY2hlY2thYmxlKG5vZGUpOlxuICAgIGxhYmVscyA9IG5lYXJieV9sYWJlbHMobm9kZSlcbiAgICBsb3dlcmVkID0gJyAnLmpvaW4obGFiZWwubG93ZXIoKSBmb3IgbGFiZWwgaW4gbGFiZWxzKVxuICAgIGlzX3JlbW90ZSA9IGFueShrZXl3b3JkIGluIGxvd2VyZWQgZm9yIGtleXdvcmQgaW4gUkVNT1RFX0NPTlRST0xfS0VZV09SRFMpXG4gICAgaXNfcmVtZW1iZXIgPSBhbnkoa2V5d29yZCBpbiBsb3dlcmVkIGZvciBrZXl3b3JkIGluIFJFTUVNQkVSX0tFWVdPUkRTKVxuICAgIHByaW1hcnkgPSBsYWJlbHNbMF0gaWYgbGFiZWxzIGVsc2UgJ3VubmFtZWQtY2hlY2thYmxlJ1xuICAgIHJldHVybiBpc19yZW1vdGUsIGlzX3JlbWVtYmVyLCBwcmltYXJ5XG5cbmRlZiBtYXliZV9lbmFibGVfcmVtb3RlX2NvbnRyb2xzKGFwcCk6XG4gICAgcmVtb3RlX2NvbnRyb2xfcHJlc2VudCA9IEZhbHNlXG4gICAgcmVtb3RlX2NvbnRyb2xfZW5hYmxlZCA9IEZhbHNlXG4gICAgdG9nZ2xlZF9hbnkgPSBGYWxzZVxuICAgIGZvciBub2RlIGluIGl0ZXJfbm9kZXMoYXBwKTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgcm9sZSA9IG5vZGUuZ2V0Um9sZSgpXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICBpZiByb2xlIG5vdCBpbiBSRU1PVEVfQ09OVFJPTF9ST0xFUzpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGRpcmVjdF9uYW1lID0gc2FmZV9uYW1lKG5vZGUpLmxvd2VyKClcbiAgICAgICAgaWYgcm9sZSA9PSBCVVRUT05fUk9MRTpcbiAgICAgICAgICAgIGlmIGRpcmVjdF9uYW1lIGluICgnY2FuY2VsJywgJ3NoYXJlJywgJ2FsbG93JywgJ2dyYW50Jyk6XG4gICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgIGlmIGRpcmVjdF9uYW1lIGFuZCBub3QgYW55KGtleXdvcmQgaW4gZGlyZWN0X25hbWUgZm9yIGtleXdvcmQgaW4gUkVNT1RFX0NPTlRST0xfS0VZV09SRFMgKyBSRU1FTUJFUl9LRVlXT1JEUyk6XG4gICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgaXNfcmVtb3RlLCBpc19yZW1lbWJlciwgbGFiZWwgPSBjbGFzc2lmeV9jaGVja2FibGUobm9kZSlcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGlmIG5vdCBpc19yZW1vdGUgYW5kIG5vdCBpc19yZW1lbWJlcjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGlmIGlzX3JlbW90ZTpcbiAgICAgICAgICAgIHJlbW90ZV9jb250cm9sX3ByZXNlbnQgPSBUcnVlXG4gICAgICAgIGlmIGlzX2NoZWNrZWQobm9kZSk6XG4gICAgICAgICAgICBpZiBpc19yZW1vdGU6XG4gICAgICAgICAgICAgICAgcmVtb3RlX2NvbnRyb2xfZW5hYmxlZCA9IFRydWVcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGlmIGludm9rZV9hY3Rpb24obm9kZSk6XG4gICAgICAgICAgICB0aW1lLnNsZWVwKDAuNSlcbiAgICAgICAgICAgICMgVmVyaWZ5IHRoZSB0b2dnbGUgYWN0dWFsbHkgZmxpcHBlZCAoR05PTUUvUkhFTCBtYXkgaWdub3JlIGRvQWN0aW9uXG4gICAgICAgICAgICAjIG9uIGxpYmFkd2FpdGEgc3dpdGNoZXMpLiAgSWYgaXQgZGlkbid0LCByZXRyeSB3aXRoIGNvb3JkaW5hdGUgY2xpY2suXG4gICAgICAgICAgICBpZiBub3QgaXNfY2hlY2tlZChub2RlKTpcbiAgICAgICAgICAgICAgICBwcmludCgnYXV0by1zaGFyZS1yZXRyeS1jbGljazonICsgbGFiZWwsIGZsdXNoPVRydWUpXG4gICAgICAgICAgICAgICAgYXRzcGlfY2xpY2tfYXQobm9kZSlcbiAgICAgICAgICAgICAgICB0aW1lLnNsZWVwKDAuNSlcbiAgICAgICAgICAgIHRvZ2dsZWRfYW55ID0gVHJ1ZVxuICAgICAgICAgICAgaWYgaXNfcmVtb3RlOlxuICAgICAgICAgICAgICAgIHJlbW90ZV9jb250cm9sX2VuYWJsZWQgPSBUcnVlXG4gICAgICAgICAgICBwcmludCgnYXV0by1zaGFyZS1lbmFibGVkOicgKyBsYWJlbCwgZmx1c2g9VHJ1ZSlcbiAgICByZXR1cm4gcmVtb3RlX2NvbnRyb2xfcHJlc2VudCwgcmVtb3RlX2NvbnRyb2xfZW5hYmxlZCwgdG9nZ2xlZF9hbnlcblxuZGVmIGlzX2NoZWNrZWQobm9kZSk6XG4gICAgaWYgU1RBVEVfQ0hFQ0tFRCBpcyBOb25lOlxuICAgICAgICByZXR1cm4gRmFsc2VcbiAgICB0cnk6XG4gICAgICAgIHN0YXRlX3NldCA9IG5vZGUuZ2V0U3RhdGUoKVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiBGYWxzZVxuICAgIHRyeTpcbiAgICAgICAgcmV0dXJuIHN0YXRlX3NldC5jb250YWlucyhTVEFURV9DSEVDS0VEKVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiBGYWxzZVxuXG5kZWFkbGluZSA9IHRpbWUudGltZSgpICsgVElNRU9VVF9TRUNPTkRTXG53aGlsZSB0aW1lLnRpbWUoKSA8IGRlYWRsaW5lOlxuICAgIHRyeTpcbiAgICAgICAgZGVza3RvcCA9IHB5YXRzcGkuUmVnaXN0cnkuZ2V0RGVza3RvcCgwKVxuICAgICAgICBhcHBfY291bnQgPSBkZXNrdG9wLmNoaWxkQ291bnRcbiAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICB0aW1lLnNsZWVwKDAuMTUpXG4gICAgICAgIGNvbnRpbnVlXG4gICAgZm9yIGFwcF9pZHggaW4gcmFuZ2UoYXBwX2NvdW50KTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgYXBwID0gZGVza3RvcFthcHBfaWR4XVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgYXBwX25hbWUgPSBzYWZlX25hbWUoYXBwKS5sb3dlcigpXG4gICAgICAgICAgICBpc19wb3J0YWxfYXBwID0gYW55KG5hbWUgaW4gYXBwX25hbWUgZm9yIG5hbWUgaW4gKCdwb3J0YWwnLCAnZ25vbWUtcmVtb3RlLWRlc2t0b3AnLCAnZ25vbWUgcmVtb3RlIGRlc2t0b3AnLCAnbXV0dGVyJykpXG4gICAgICAgICAgICBoYXNfcG9ydGFsX2NvbnRleHQgPSBsb29rc19saWtlX3BvcnRhbF9jb250ZXh0KGFwcClcbiAgICAgICAgICAgIGlmIG5vdCBoYXNfcG9ydGFsX2NvbnRleHQ6XG4gICAgICAgICAgICAgICAgbWF0Y2hlZF9kZXNjZW5kYW50ID0gTm9uZVxuICAgICAgICAgICAgICAgIGZvciBub2RlIGluIGl0ZXJfbm9kZXMoYXBwKTpcbiAgICAgICAgICAgICAgICAgICAgaWYgbG9va3NfbGlrZV9wb3J0YWxfY29udGV4dChub2RlKTpcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hdGNoZWRfZGVzY2VuZGFudCA9IG5vZGVcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgICAgICAgaGFzX3BvcnRhbF9jb250ZXh0ID0gbWF0Y2hlZF9kZXNjZW5kYW50IGlzIG5vdCBOb25lXG4gICAgICAgICAgICBpZiBub3QgaGFzX3BvcnRhbF9jb250ZXh0IGFuZCBub3QgaXNfcG9ydGFsX2FwcDpcbiAgICAgICAgICAgICAgICBjb250aW51ZVxuICAgICAgICAgICAgIyBLZWVwIHRyYXZlcnNpbmcgdGhlIGFwcGxpY2F0aW9uIHJvb3QuIEdOT01FIHNjcmVlbnNob3QgcG9ydGFsc1xuICAgICAgICAgICAgIyBleHBvc2UgdGhlIGFwcHJvdmFsIHRleHQgYW5kIFNoYXJlIGJ1dHRvbiBhcyBzaWJsaW5nIHN1YnRyZWVzLlxuICAgICAgICAgICAgcmVtb3RlX2NvbnRyb2xfcHJlc2VudCwgcmVtb3RlX2NvbnRyb2xfZW5hYmxlZCwgdG9nZ2xlZF9hbnkgPSBtYXliZV9lbmFibGVfcmVtb3RlX2NvbnRyb2xzKGFwcClcbiAgICAgICAgICAgIGlmIHJlbW90ZV9jb250cm9sX3ByZXNlbnQgYW5kIG5vdCByZW1vdGVfY29udHJvbF9lbmFibGVkOlxuICAgICAgICAgICAgICAgIGlmIHRvZ2dsZWRfYW55OlxuICAgICAgICAgICAgICAgICAgICAjIFN1Y2Nlc3NmdWxseSBpbnZva2VkIHRoZSB0b2dnbGUgYnV0IEFULVNQSSBzdGlsbCByZXBvcnRzIG5vdCBlbmFibGVkXG4gICAgICAgICAgICAgICAgICAgICMgKFJIRUwvR05PTUUgc3RhdGUtY2hhbmdlIGxhZykuIEdpdmUgaXQgYSBtb21lbnQgdGhlbiBmYWxsIHRocm91Z2ggdG9cbiAgICAgICAgICAgICAgICAgICAgIyBjbGljayB0aGUgU2hhcmUgYnV0dG9uIHJhdGhlciB0aGFuIGxvb3BpbmcgaW5kZWZpbml0ZWx5LlxuICAgICAgICAgICAgICAgICAgICB0aW1lLnNsZWVwKDAuMylcbiAgICAgICAgICAgICAgICBlbHNlOlxuICAgICAgICAgICAgICAgICAgICB0aW1lLnNsZWVwKDAuMTUpXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICBmb3Igbm9kZSBpbiBpdGVyX25vZGVzKGFwcCk6XG4gICAgICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgICAgICBpZiBub2RlLmdldFJvbGUoKSAhPSBCVVRUT05fUk9MRTpcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgICAgIGJ1dHRvbl9uYW1lID0gc2FmZV9uYW1lKG5vZGUpXG4gICAgICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgICAgICBuZWFyYnkgPSBuZWFyYnlfbGFiZWxzKG5vZGUpXG4gICAgICAgICAgICAgICAgbG93ZXJfbmFtZSA9IGJ1dHRvbl9uYW1lLmxvd2VyKClcbiAgICAgICAgICAgICAgICBsb3dlcmVkX2NvbnRleHQgPSAnICcuam9pbihsYWJlbC5sb3dlcigpIGZvciBsYWJlbCBpbiBuZWFyYnkpXG4gICAgICAgICAgICAgICAgaWYgbm90IGlzX2FwcHJvdmVfY2FuZGlkYXRlKGJ1dHRvbl9uYW1lLCBuZWFyYnksIGxvd2VyZWRfY29udGV4dCk6XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgaWYgaW52b2tlX2FjdGlvbihub2RlKTpcbiAgICAgICAgICAgICAgICAgICAgYnV0dG9uX2xhYmVsID0gYnV0dG9uX25hbWUgb3IgKG5lYXJieVswXSBpZiBuZWFyYnkgZWxzZSAndW5uYW1lZC1hcHByb3ZlJylcbiAgICAgICAgICAgICAgICAgICAgcHJpbnQoJ2F1dG8tc2hhcmUtY2xpY2tlZDonICsgYnV0dG9uX2xhYmVsLCBmbHVzaD1UcnVlKVxuICAgICAgICAgICAgICAgICAgICBzeXMuZXhpdCgwKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICB0aW1lLnNsZWVwKDAuMTUpXG5wcmludCgnYXV0by1zaGFyZS10aW1lb3V0JywgZmlsZT1zeXMuc3RkZXJyLCBmbHVzaD1UcnVlKVxuc3lzLmV4aXQoMilcbmA7XG5jb25zdCBBMTFZX1BPSU5UX0FDVElPTl9TQ1JJUFQgPSBgXG5pbXBvcnQgcHlhdHNwaVxuaW1wb3J0IHN5c1xuaW1wb3J0IHRpbWVcblxuQUNUSU9OX05BTUVTID0gKCdjbGljaycsICdwcmVzcycsICdhY3RpdmF0ZScsICdvcGVuJywgJ2RlZmF1bHQnLCAnJylcbk1BWF9ERVNDRU5UID0gNFxuXG5kZWYgaXRlcl9ub2Rlcyhub2RlLCBkZXB0aD0wKTpcbiAgICB5aWVsZCBub2RlXG4gICAgaWYgZGVwdGggPj0gTUFYX0RFU0NFTlQ6XG4gICAgICAgIHJldHVyblxuICAgIHRyeTpcbiAgICAgICAgY291bnQgPSBub2RlLmNoaWxkQ291bnRcbiAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICByZXR1cm5cbiAgICBmb3IgaWR4IGluIHJhbmdlKGNvdW50KTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY2hpbGQgPSBub2RlW2lkeF1cbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIGZvciBuZXN0ZWQgaW4gaXRlcl9ub2RlcyhjaGlsZCwgZGVwdGggKyAxKTpcbiAgICAgICAgICAgIHlpZWxkIG5lc3RlZFxuXG5kZWYgaW52b2tlX2FjdGlvbihub2RlKTpcbiAgICB0cnk6XG4gICAgICAgIGFjdGlvbiA9IG5vZGUucXVlcnlBY3Rpb24oKVxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiBGYWxzZVxuICAgIHRyeTpcbiAgICAgICAgdG90YWwgPSBhY3Rpb24ubkFjdGlvbnNcbiAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICB0b3RhbCA9IDBcbiAgICBmb3IgaWR4IGluIHJhbmdlKHRvdGFsKTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgYWN0aW9uX25hbWUgPSAoYWN0aW9uLmdldE5hbWUoaWR4KSBvciAnJykuc3RyaXAoKS5sb3dlcigpXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBhY3Rpb25fbmFtZSA9ICcnXG4gICAgICAgIGlmIGFjdGlvbl9uYW1lIG5vdCBpbiBBQ1RJT05fTkFNRVM6XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBpZiBhY3Rpb24uZG9BY3Rpb24oaWR4KTpcbiAgICAgICAgICAgICAgICByZXR1cm4gVHJ1ZVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgY29udGludWVcbiAgICByZXR1cm4gRmFsc2VcblxuZGVmIG5vZGVfYXRfcG9pbnQoeCwgeSk6XG4gICAgdHJ5OlxuICAgICAgICBkZXNrdG9wID0gcHlhdHNwaS5SZWdpc3RyeS5nZXREZXNrdG9wKDApXG4gICAgICAgIGFwcF9jb3VudCA9IGRlc2t0b3AuY2hpbGRDb3VudFxuICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgIHJldHVybiBOb25lXG4gICAgZm9yIGFwcF9pZHggaW4gcmFuZ2UoYXBwX2NvdW50KTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgYXBwID0gZGVza3RvcFthcHBfaWR4XVxuICAgICAgICAgICAgY29tcCA9IGFwcC5xdWVyeUNvbXBvbmVudCgpXG4gICAgICAgICAgICBub2RlID0gY29tcC5nZXRBY2Nlc3NpYmxlQXRQb2ludChpbnQoeCksIGludCh5KSwgcHlhdHNwaS5ERVNLVE9QX0NPT1JEUylcbiAgICAgICAgICAgIGlmIG5vZGUgaXMgbm90IE5vbmU6XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5vZGVcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgcmV0dXJuIE5vbmVcblxuZGVmIGNhbmRpZGF0ZV9ub2RlcyhzZWVkKTpcbiAgICBvcmRlcmVkID0gW11cbiAgICBzZWVuID0gc2V0KClcblxuICAgIGRlZiBwdXNoKG5vZGUpOlxuICAgICAgICBpZiBub2RlIGlzIE5vbmU6XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAga2V5ID0gaWQobm9kZSlcbiAgICAgICAgaWYga2V5IGluIHNlZW46XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgc2Vlbi5hZGQoa2V5KVxuICAgICAgICBvcmRlcmVkLmFwcGVuZChub2RlKVxuXG4gICAgY3VycmVudCA9IHNlZWRcbiAgICB3aGlsZSBjdXJyZW50IGlzIG5vdCBOb25lOlxuICAgICAgICBwdXNoKGN1cnJlbnQpXG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudFxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgYnJlYWtcblxuICAgIGZvciBiYXNlIGluIGxpc3Qob3JkZXJlZCk6XG4gICAgICAgIGZvciBuZXN0ZWQgaW4gaXRlcl9ub2RlcyhiYXNlKTpcbiAgICAgICAgICAgIHB1c2gobmVzdGVkKVxuICAgIHJldHVybiBvcmRlcmVkXG5cbmRlZiBtYWluKCk6XG4gICAgaWYgbGVuKHN5cy5hcmd2KSA8IDM6XG4gICAgICAgIHByaW50KCdtaXNzaW5nLWNvb3JkaW5hdGUtYXJncycsIGZpbGU9c3lzLnN0ZGVyciwgZmx1c2g9VHJ1ZSlcbiAgICAgICAgcmV0dXJuIDJcbiAgICB4ID0gZmxvYXQoc3lzLmFyZ3ZbMV0pXG4gICAgeSA9IGZsb2F0KHN5cy5hcmd2WzJdKVxuICAgIG1vZGUgPSAoc3lzLmFyZ3ZbM10gaWYgbGVuKHN5cy5hcmd2KSA+IDMgZWxzZSAnY2xpY2snKS5zdHJpcCgpLmxvd2VyKClcbiAgICBpdGVyYXRpb25zID0gMiBpZiBtb2RlID09ICdkb3VibGUnIGVsc2UgMVxuXG4gICAgbm9kZSA9IG5vZGVfYXRfcG9pbnQoeCwgeSlcbiAgICBpZiBub2RlIGlzIE5vbmU6XG4gICAgICAgIHByaW50KCdhMTF5LXBvaW50LW1pc3MnLCBmaWxlPXN5cy5zdGRlcnIsIGZsdXNoPVRydWUpXG4gICAgICAgIHJldHVybiAzXG4gICAgY2FuZGlkYXRlcyA9IGNhbmRpZGF0ZV9ub2Rlcyhub2RlKVxuICAgIGlmIG5vdCBjYW5kaWRhdGVzOlxuICAgICAgICBwcmludCgnYTExeS1jYW5kaWRhdGVzLWVtcHR5JywgZmlsZT1zeXMuc3RkZXJyLCBmbHVzaD1UcnVlKVxuICAgICAgICByZXR1cm4gNFxuXG4gICAgZm9yIGlkeCBpbiByYW5nZShpdGVyYXRpb25zKTpcbiAgICAgICAgY2xpY2tlZCA9IEZhbHNlXG4gICAgICAgIGZvciBjYW5kaWRhdGUgaW4gY2FuZGlkYXRlczpcbiAgICAgICAgICAgIGlmIGludm9rZV9hY3Rpb24oY2FuZGlkYXRlKTpcbiAgICAgICAgICAgICAgICBjbGlja2VkID0gVHJ1ZVxuICAgICAgICAgICAgICAgIGJyZWFrXG4gICAgICAgIGlmIG5vdCBjbGlja2VkOlxuICAgICAgICAgICAgcHJpbnQoJ2ExMXktYWN0aW9uLWZhaWxlZCcsIGZpbGU9c3lzLnN0ZGVyciwgZmx1c2g9VHJ1ZSlcbiAgICAgICAgICAgIHJldHVybiA1XG4gICAgICAgIGlmIGlkeCArIDEgPCBpdGVyYXRpb25zOlxuICAgICAgICAgICAgdGltZS5zbGVlcCgwLjA2KVxuXG4gICAgcHJpbnQoJ2ExMXktcG9pbnQtYWN0aW9uLW9rJywgZmx1c2g9VHJ1ZSlcbiAgICByZXR1cm4gMFxuXG5yYWlzZSBTeXN0ZW1FeGl0KG1haW4oKSlcbmA7XG5cbi8vIE1vZHVsZS1sZXZlbCBjYWNoZSBmb3IgdGhlIFdheWxhbmQgcG9ydGFsIHNlc3Npb24uICBDcmVhdGluZyBhIHBvcnRhbFxuLy8gc2Vzc2lvbiBpbnZvbHZlcyBELUJ1cyByb3VuZC10cmlwcyBhbmQsIG9uIFJIRUwvR05PTUUsIGEgY29uc2VudCBkaWFsb2dcbi8vIHRoYXQgbXVzdCBiZSBhcHByb3ZlZCBieSB0aGUgYXV0by1zaGFyZSBoZWxwZXIuICBCeSBjYWNoaW5nIHRoZSBzZXNzaW9uXG4vLyBhdCBtb2R1bGUgc2NvcGUgd2UgY2FuIHJldXNlIGl0IGFjcm9zcyBzdWNjZXNzaXZlIEFwcGl1bSBzZXNzaW9ucyBpbiB0aGVcbi8vIHNhbWUgc2VydmVyIHByb2Nlc3MsIGVsaW1pbmF0aW5nIH40MCBzIG9mIG92ZXJoZWFkIHBlciB0ZXN0LlxubGV0IF9jYWNoZWRQb3J0YWxTZXNzaW9uID0gbnVsbDtcblxuZnVuY3Rpb24gc2xlZXAgKG1zKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxuXG5mdW5jdGlvbiBlc2MgKHZhbHVlKSB7XG4gIHJldHVybiBgJHt2YWx1ZSA/PyAnJ31gXG4gICAgLnJlcGxhY2UoLyYvZywgJyZhbXA7JylcbiAgICAucmVwbGFjZSgvXCIvZywgJyZxdW90OycpXG4gICAgLnJlcGxhY2UoLzwvZywgJyZsdDsnKVxuICAgIC5yZXBsYWNlKC8+L2csICcmZ3Q7Jyk7XG59XG5cbmZ1bmN0aW9uIGhhc0NvbW1hbmQgKGNvbW1hbmQpIHtcbiAgaWYgKGNvbW1hbmQgPT09ICdweXRob24zLXB5YXRzcGknKSB7XG4gICAgY29uc3QgcmVzID0gc3Bhd25TeW5jKCdweXRob24zJywgWyctYycsICdpbXBvcnQgcHlhdHNwaSddLCB7c3RkaW86ICdpZ25vcmUnfSk7XG4gICAgcmV0dXJuIHJlcy5zdGF0dXMgPT09IDA7XG4gIH1cbiAgY29uc3QgcmVzID0gc3Bhd25TeW5jKCd3aGljaCcsIFtjb21tYW5kXSwge3N0ZGlvOiAnaWdub3JlJ30pO1xuICByZXR1cm4gcmVzLnN0YXR1cyA9PT0gMDtcbn1cblxuZnVuY3Rpb24gc2FmZVNwYXduIChjb21tYW5kLCBhcmdzLCBvcHRzID0ge30pIHtcbiAgY29uc3QgcmVzID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICBlbmNvZGluZzogJ3V0ZjgnLFxuICAgIC4uLm9wdHMsXG4gIH0pO1xuICByZXR1cm4ge1xuICAgIG9rOiByZXMuc3RhdHVzID09PSAwLFxuICAgIGNvZGU6IHJlcy5zdGF0dXMsXG4gICAgc3Rkb3V0OiByZXMuc3Rkb3V0IHx8ICcnLFxuICAgIHN0ZGVycjogcmVzLnN0ZGVyciB8fCAnJyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VLZXlWYWx1ZU91dHB1dCAob3V0cHV0KSB7XG4gIGNvbnN0IHJlc3VsdCA9IHt9O1xuICBmb3IgKGNvbnN0IHJhd0xpbmUgb2YgYCR7b3V0cHV0ID8/ICcnfWAuc3BsaXQoJ1xcbicpKSB7XG4gICAgY29uc3QgbGluZSA9IHJhd0xpbmUudHJpbSgpO1xuICAgIGlmICghbGluZSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGlkeCA9IGxpbmUuaW5kZXhPZignPScpO1xuICAgIGlmIChpZHggPD0gMCkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGtleSA9IGxpbmUuc2xpY2UoMCwgaWR4KS50cmltKCk7XG4gICAgY29uc3QgdmFsdWUgPSBsaW5lLnNsaWNlKGlkeCArIDEpLnRyaW0oKTtcbiAgICBpZiAoIWtleSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHJlc3VsdFtrZXldID0gdmFsdWU7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gdW5ib3ggKHZhbHVlKSB7XG4gIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh2YWx1ZSwgJ3NpZ25hdHVyZScpICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh2YWx1ZSwgJ3ZhbHVlJykpIHtcbiAgICByZXR1cm4gdW5ib3godmFsdWUudmFsdWUpO1xuICB9XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZS5tYXAoKGl0ZW0pID0+IHVuYm94KGl0ZW0pKTtcbiAgfVxuICBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgIGNvbnN0IG91dCA9IHt9O1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkge1xuICAgICAgb3V0W2tdID0gdW5ib3godik7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUb2tlbiAodmFsdWUpIHtcbiAgaWYgKCF2YWx1ZSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICB9XG4gIHJldHVybiBgJHt2YWx1ZX1gO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVTZXNzaW9uSGFuZGxlQ2FuZGlkYXRlc0Zyb21SZXF1ZXN0UGF0aCAocmVxdWVzdFBhdGgsIHNlc3Npb25IYW5kbGVUb2tlbikge1xuICBjb25zdCBtYXRjaCA9IC9eXFwvb3JnXFwvZnJlZWRlc2t0b3BcXC9wb3J0YWxcXC9kZXNrdG9wXFwvcmVxdWVzdFxcLyhbXi9dKylcXC9bXi9dKyQvLmV4ZWMoYCR7cmVxdWVzdFBhdGggPz8gJyd9YCk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3Qgc2VuZGVyU2VnbWVudCA9IG1hdGNoWzFdO1xuICBjb25zdCByZXF1ZXN0VG9rZW4gPSBgJHtyZXF1ZXN0UGF0aCA/PyAnJ31gLnNwbGl0KCcvJykucG9wKCk7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBbXTtcbiAgaWYgKHJlcXVlc3RUb2tlbikge1xuICAgIGNhbmRpZGF0ZXMucHVzaChgL29yZy9mcmVlZGVza3RvcC9wb3J0YWwvZGVza3RvcC9zZXNzaW9uLyR7c2VuZGVyU2VnbWVudH0vJHtyZXF1ZXN0VG9rZW59YCk7XG4gIH1cbiAgY29uc3QgdG9rZW4gPSBub3JtYWxpemVUb2tlbihzZXNzaW9uSGFuZGxlVG9rZW4pO1xuICBpZiAodG9rZW4pIHtcbiAgICBjb25zdCBleHBsaWNpdFRva2VuUGF0aCA9IGAvb3JnL2ZyZWVkZXNrdG9wL3BvcnRhbC9kZXNrdG9wL3Nlc3Npb24vJHtzZW5kZXJTZWdtZW50fS8ke3Rva2VufWA7XG4gICAgaWYgKCFjYW5kaWRhdGVzLmluY2x1ZGVzKGV4cGxpY2l0VG9rZW5QYXRoKSkge1xuICAgICAgY2FuZGlkYXRlcy5wdXNoKGV4cGxpY2l0VG9rZW5QYXRoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGNvZXJjZUJvb2xlYW4gKHZhbHVlLCBkZWZhdWx0VmFsdWUgPSBmYWxzZSkge1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGNvbnN0IHRleHQgPSBgJHt2YWx1ZX1gLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoWycxJywgJ3RydWUnLCAneWVzJywgJ3knLCAnb24nXS5pbmNsdWRlcyh0ZXh0KSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChbJzAnLCAnZmFsc2UnLCAnbm8nLCAnbicsICdvZmYnXS5pbmNsdWRlcyh0ZXh0KSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gZGVmYXVsdFZhbHVlO1xufVxuXG5mdW5jdGlvbiBmaXJzdEV4ZWNUb2tlbiAoZXhlY0xpbmUpIHtcbiAgY29uc3QgdGV4dCA9IGAke2V4ZWNMaW5lID8/ICcnfWAudHJpbSgpO1xuICBpZiAoIXRleHQpIHtcbiAgICByZXR1cm4gJyc7XG4gIH1cbiAgY29uc3QgbWF0Y2ggPSAvXlwiKFteXCJdKylcInwnKFteJ10rKSd8KFxcUyspLy5leGVjKHRleHQpO1xuICByZXR1cm4gbWF0Y2ggPyAobWF0Y2hbMV0gfHwgbWF0Y2hbMl0gfHwgbWF0Y2hbM10gfHwgJycpIDogJyc7XG59XG5cbmZ1bmN0aW9uIGRlc2t0b3BFbnRyeUlkRm9yRmlsZSAoZmlsZVBhdGgpIHtcbiAgcmV0dXJuIHBhdGguYmFzZW5hbWUoYCR7ZmlsZVBhdGggPz8gJyd9YCwgJy5kZXNrdG9wJyk7XG59XG5cbmZ1bmN0aW9uIGZpbmREZXNrdG9wRW50cnlJZHNGb3JBcHAgKGFwcE5hbWUpIHtcbiAgY29uc3QgYXBwVGV4dCA9IGAke2FwcE5hbWUgPz8gJyd9YC50cmltKCk7XG4gIGlmICghYXBwVGV4dCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBhcHBCYXNlTmFtZSA9IHBhdGguYmFzZW5hbWUoYXBwVGV4dCkudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgYXBwUGF0aCA9IHBhdGguaXNBYnNvbHV0ZShhcHBUZXh0KSA/IGFwcFRleHQgOiAnJztcbiAgY29uc3QgbWF0Y2hlcyA9IFtdO1xuICBmb3IgKGNvbnN0IGRpciBvZiBERVNLVE9QX0VOVFJZX0RJUlMpIHtcbiAgICBpZiAoIWRpciB8fCAhZnMuZXhpc3RzU3luYyhkaXIpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgbGV0IGVudHJpZXMgPSBbXTtcbiAgICB0cnkge1xuICAgICAgZW50cmllcyA9IGZzLnJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBpZiAoIWVudHJ5LmVuZHNXaXRoKCcuZGVza3RvcCcpKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgZW50cnlQYXRoID0gcGF0aC5qb2luKGRpciwgZW50cnkpO1xuICAgICAgbGV0IGNvbnRlbnQgPSAnJztcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMoZW50cnlQYXRoLCAndXRmOCcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgZXhlY0NvbW1hbmRzID0gY29udGVudFxuICAgICAgICAuc3BsaXQoJ1xcbicpXG4gICAgICAgIC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLnN0YXJ0c1dpdGgoJ0V4ZWM9JykpXG4gICAgICAgIC5tYXAoKGxpbmUpID0+IGZpcnN0RXhlY1Rva2VuKGxpbmUuc2xpY2UoJ0V4ZWM9Jy5sZW5ndGgpKSlcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIGNvbnN0IGlzTWF0Y2ggPSBleGVjQ29tbWFuZHMuc29tZSgoY29tbWFuZCkgPT4ge1xuICAgICAgICBjb25zdCBjb21tYW5kVGV4dCA9IGAke2NvbW1hbmQgPz8gJyd9YC50cmltKCk7XG4gICAgICAgIHJldHVybiBjb21tYW5kVGV4dCA9PT0gYXBwUGF0aCB8fCBwYXRoLmJhc2VuYW1lKGNvbW1hbmRUZXh0KS50b0xvd2VyQ2FzZSgpID09PSBhcHBCYXNlTmFtZTtcbiAgICAgIH0pO1xuICAgICAgaWYgKGlzTWF0Y2gpIHtcbiAgICAgICAgbWF0Y2hlcy5wdXNoKGRlc2t0b3BFbnRyeUlkRm9yRmlsZShlbnRyeVBhdGgpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIEFycmF5LmZyb20obmV3IFNldChtYXRjaGVzKSk7XG59XG5cbmNsYXNzIFdheWxhbmRBcGlzIHtcbiAgY29uc3RydWN0b3IgKHthcHBOYW1lLCBsb2dnZXIsIHdheWxhbmRSZXN0b3JlVG9rZW4sIHdheWxhbmRUb2tlblN0b3JlUGF0aCwgd2F5bGFuZEF1dG9TaGFyZX0gPSB7fSkge1xuICAgIHRoaXMuYXBwTmFtZSA9IGFwcE5hbWU7XG4gICAgdGhpcy5fbG9nZ2VyID0gbG9nZ2VyO1xuICAgIHRoaXMuX25hdGl2ZUFwaXMgPSBuYXRpdmVBcGlzO1xuICAgIHRoaXMuX2Rpc3Ryb0luZm8gPSBkZXRlY3RMaW51eERpc3Ryb0luZm8oKTtcbiAgICB0aGlzLl90b2tlblN0b3JlUGF0aCA9IG5vcm1hbGl6ZVN0b3JlUGF0aCh3YXlsYW5kVG9rZW5TdG9yZVBhdGgpO1xuICAgIHRoaXMuX3Jlc3RvcmVUb2tlbkZyb21DYXBzID0gd2F5bGFuZFJlc3RvcmVUb2tlbiB8fCBudWxsO1xuICAgIHRoaXMuX3Jlc3RvcmVUb2tlbiA9IG51bGw7XG4gICAgdGhpcy5fd2F5bGFuZEF1dG9TaGFyZSA9IGNvZXJjZUJvb2xlYW4od2F5bGFuZEF1dG9TaGFyZSwgdHJ1ZSk7XG4gICAgdGhpcy5fd2F5bGFuZEF1dG9TaGFyZVRpbWVvdXRNcyA9IERFRkFVTFRfQVVUT19TSEFSRV9USU1FT1VUX01TO1xuICAgIHRoaXMuX3BvcnRhbEF1dG9TaGFyZVByb2MgPSBudWxsO1xuICAgIHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lciA9IG51bGw7XG4gICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCA9IGZhbHNlO1xuXG4gICAgdGhpcy5fd2luZG93TWFwID0gbmV3IE1hcCgpO1xuICAgIHRoaXMuX3dpbmRvd0xpc3QgPSBbXTtcbiAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGUgPSAnJztcbiAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVBdCA9IDA7XG4gICAgLy8gMzBzIFRUTCDigJQgdGhlIGNhY2hlIGlzIGV4cGxpY2l0bHkgaW52YWxpZGF0ZWQgYnkgZ2V0V2luZG93SGFuZGxlcygpLFxuICAgIC8vIGFwcF9sYXVuY2goKSwgYW5kIGFwcF9raWxsKCkgd2hlbiBmcmVzaCBkYXRhIGlzIG5lZWRlZC4gIEEgc2hvcnQgVFRMXG4gICAgLy8gKGUuZy4gMnMpIGNhdXNlZCBleHBlbnNpdmUgbmF0aXZlIEFULVNQSSBkZXNrdG9wIHJlLXNjYW5zIG9uIGV2ZXJ5XG4gICAgLy8gZmluZEVsZW1lbnQgZm9yIGRpYWxvZyB3aW5kb3dzIG9uIFJIRUwvV2F5bGFuZC5cbiAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVUdGxNcyA9IDMwMDAwO1xuXG4gICAgdGhpcy5fcG9ydGFsID0ge1xuICAgICAgYnVzOiBudWxsLFxuICAgICAgcmVtb3RlRGVza3RvcDogbnVsbCxcbiAgICAgIHNjcmVlbkNhc3Q6IG51bGwsXG4gICAgICBzY3JlZW5zaG90OiBudWxsLFxuICAgICAgcmVnaXN0cnk6IG51bGwsXG4gICAgICByZWdpc3RlcmVkQXBwSWQ6IG51bGwsXG4gICAgICBzZXNzaW9uSGFuZGxlOiBudWxsLFxuICAgICAgc3RyZWFtTm9kZUlkOiBudWxsLFxuICAgICAgbG9naWNhbFNpemU6IG51bGwsXG4gICAgICBncmFudGVkRGV2aWNlczogbnVsbCxcbiAgICAgIHBvaW50ZXJBbGxvd2VkOiBudWxsLFxuICAgICAga2V5Ym9hcmRBbGxvd2VkOiBudWxsLFxuICAgICAgcmVtb3RlRGVza3RvcFZlcnNpb246IDAsXG4gICAgICBzY3JlZW5DYXN0VmVyc2lvbjogMCxcbiAgICAgIHNjcmVlbnNob3RWZXJzaW9uOiAwLFxuICAgIH07XG5cbiAgICB0aGlzLl9oYXNXbENvcHkgPSBoYXNDb21tYW5kKCd3bC1jb3B5Jyk7XG4gICAgdGhpcy5faGFzV2xQYXN0ZSA9IGhhc0NvbW1hbmQoJ3dsLXBhc3RlJyk7XG4gICAgdGhpcy5faGFzR25vbWVTY3JlZW5zaG90ID0gaGFzQ29tbWFuZCgnZ25vbWUtc2NyZWVuc2hvdCcpO1xuICAgIHRoaXMuX2hhc0dyaW0gPSBoYXNDb21tYW5kKCdncmltJyk7XG5cbiAgICAvLyBSSEVMIEdOT01FIGNvbXBvc2l0b3IgbmVlZHMgc21hbGwgc2V0dGxpbmcgZGVsYXlzIGJldHdlZW4gcG9pbnRlciBtb3Rpb25cbiAgICAvLyBhbmQgYnV0dG9uIGV2ZW50cy4gV2l0aG91dCB0aGVzZSwgY2xpY2tzIGNhbiBsYW5kIGF0IHRoZSB3cm9uZyBjb29yZGluYXRlc1xuICAgIC8vIGJlY2F1c2UgdGhlIGNvbXBvc2l0b3IgaGFzbid0IGZpbmlzaGVkIHByb2Nlc3NpbmcgdGhlIG1vdGlvbiBldmVudC5cbiAgICB0aGlzLl9jb21wb3NpdG9yU2V0dGxlTXMgPSB0aGlzLl9kaXN0cm9JbmZvLmlzUmhlbExpa2UgPyAxMCA6ICh0aGlzLl9kaXN0cm9JbmZvLmlzVWJ1bnR1ID8gNSA6IDApO1xuICAgIHRoaXMuX2J1dHRvblByZXNzUmVsZWFzZUdhcE1zID0gdGhpcy5fZGlzdHJvSW5mby5pc1JoZWxMaWtlID8gNSA6ICh0aGlzLl9kaXN0cm9JbmZvLmlzVWJ1bnR1ID8gMiA6IDApO1xuICAgIHRoaXMuX2RvdWJsZUNsaWNrSW50ZXJ2YWxNcyA9IHRoaXMuX2Rpc3Ryb0luZm8uaXNSaGVsTGlrZSA/IDgwIDogKHRoaXMuX2Rpc3Ryb0luZm8uaXNVYnVudHUgPyA3MCA6IDYwKTtcbiAgICB0aGlzLl9rZXlUYXBJbnRlckRlbGF5TXMgPSAxMDtcbiAgfVxuXG4gIF9sb2dJbmZvIChtc2cpIHtcbiAgICBpZiAodGhpcy5fbG9nZ2VyPy5pbmZvKSB7XG4gICAgICB0aGlzLl9sb2dnZXIuaW5mbyhtc2cpO1xuICAgIH1cbiAgfVxuXG4gIF9sb2dXYXJuIChtc2cpIHtcbiAgICBpZiAodGhpcy5fbG9nZ2VyPy53YXJuKSB7XG4gICAgICB0aGlzLl9sb2dnZXIud2Fybihtc2cpO1xuICAgIH1cbiAgfVxuXG4gIF9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlICgpIHtcbiAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGUgPSAnJztcbiAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVBdCA9IDA7XG4gIH1cblxuICBfaW52YWxpZGF0ZVdpbmRvd0hpZXJhcmNoeVhtbENhY2hlICgpIHtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZSA9IG51bGw7XG4gICAgdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGVBdCA9IDA7XG4gIH1cblxuICBfZ2V0RGVza3RvcEhpZXJhcmNoeSAoe2ZvcmNlID0gZmFsc2V9ID0ge30pIHtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGlmIChcbiAgICAgICFmb3JjZVxuICAgICAgJiYgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlXG4gICAgICAmJiAobm93IC0gdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQpIDw9IHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZVR0bE1zXG4gICAgKSB7XG4gICAgICByZXR1cm4gdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlO1xuICAgIH1cblxuICAgIGxldCBkZXNrdG9wID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgIGRlc2t0b3AgPSB0aGlzLl9uYXRpdmVBcGlzLmExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRlc2t0b3AgPSAnJztcbiAgICB9XG5cbiAgICBpZiAoZGVza3RvcCkge1xuICAgICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlID0gZGVza3RvcDtcbiAgICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0ID0gbm93O1xuICAgICAgcmV0dXJuIGRlc2t0b3A7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSB8fCAnJztcbiAgfVxuXG4gIF9zdGFydFBvcnRhbEF1dG9TaGFyZUhlbHBlciAoKSB7XG4gICAgaWYgKCF0aGlzLl93YXlsYW5kQXV0b1NoYXJlIHx8IHRoaXMuX3BvcnRhbEF1dG9TaGFyZVByb2MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcik7XG4gICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVTdG9wcGVkID0gZmFsc2U7XG4gICAgY29uc3QgdGltZW91dFNlY29uZHMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwodGhpcy5fd2F5bGFuZEF1dG9TaGFyZVRpbWVvdXRNcyAvIDEwMDApKTtcbiAgICBjb25zdCBzY3JpcHQgPSBBVVRPX1NIQVJFX0hFTFBFUl9TQ1JJUFQucmVwbGFjZSgnX19USU1FT1VUX1NFQ09ORFNfXycsIGAke3RpbWVvdXRTZWNvbmRzfWApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9jID0gc3Bhd24oJ3B5dGhvbjMnLCBbJy1jJywgc2NyaXB0XSwge1xuICAgICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFBZVEhPTlVOQlVGRkVSRUQ6ICcxJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlUHJvYyA9IHByb2M7XG4gICAgICBwcm9jLnN0ZG91dC5vbignZGF0YScsIChjaHVuaykgPT4ge1xuICAgICAgICBjb25zdCBtc2cgPSBgJHtjaHVuayA/PyAnJ31gLnRyaW0oKTtcbiAgICAgICAgaWYgKG1zZykge1xuICAgICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGF1dG8tc2hhcmU6ICR7bXNnfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHByb2Muc3RkZXJyLm9uKCdkYXRhJywgKGNodW5rKSA9PiB7XG4gICAgICAgIGNvbnN0IG1zZyA9IGAke2NodW5rID8/ICcnfWAudHJpbSgpO1xuICAgICAgICBpZiAobXNnKSB7XG4gICAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZTogJHttc2d9YCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgcHJvYy5vbignZXJyb3InLCAoZXJyb3IpID0+IHtcbiAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBoZWxwZXIgZmFpbGVkOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICB9KTtcbiAgICAgIHByb2Mub24oJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IHNpZ25hbCA/IGBzaWduYWwgJHtzaWduYWx9YCA6IGBjb2RlICR7Y29kZX1gO1xuICAgICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHBvcnRhbCBhdXRvLXNoYXJlIGhlbHBlciBleGl0ZWQgd2l0aCAke3N0YXR1c31gKTtcbiAgICAgICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVByb2MgPT09IHByb2MpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVQcm9jID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXNpZ25hbCAmJiAoY29kZSA9PT0gMCB8fCBjb2RlID09PSAyKSAmJiAhdGhpcy5fcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCkge1xuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGNvZGUgPT09IDBcbiAgICAgICAgICAgID8gJ2hhbmRsZWQgYSBwb3J0YWwgcHJvbXB0J1xuICAgICAgICAgICAgOiAndGltZWQgb3V0IGJlZm9yZSB0aGUgcG9ydGFsIHNlc3Npb24gd2FzIHJlYWR5JztcbiAgICAgICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHBvcnRhbCBhdXRvLXNoYXJlIGhlbHBlciAke3JlYXNvbn07IHJlc3RhcnRpbmcgaGVscGVyYCk7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlUmVzdGFydFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5fc3RhcnRQb3J0YWxBdXRvU2hhcmVIZWxwZXIoKTtcbiAgICAgICAgICB9LCAyNTApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGF1dG8tc2hhcmUgaGVscGVyIHN0YXJ0ZWQgKHRpbWVvdXQgJHt0aW1lb3V0U2Vjb25kc31zKWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKGBGYWlsZWQgdG8gc3RhcnQgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBoZWxwZXI6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBfc3RvcFBvcnRhbEF1dG9TaGFyZUhlbHBlciAoKSB7XG4gICAgdGhpcy5fcG9ydGFsQXV0b1NoYXJlU3RvcHBlZCA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX3BvcnRhbEF1dG9TaGFyZVJlc3RhcnRUaW1lcik7XG4gICAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVSZXN0YXJ0VGltZXIgPSBudWxsO1xuICAgIH1cbiAgICBjb25zdCBwcm9jID0gdGhpcy5fcG9ydGFsQXV0b1NoYXJlUHJvYztcbiAgICB0aGlzLl9wb3J0YWxBdXRvU2hhcmVQcm9jID0gbnVsbDtcbiAgICBpZiAoIXByb2MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHByb2MuZXhpdENvZGUgIT09IG51bGwgfHwgcHJvYy5zaWduYWxDb2RlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBwcm9jLmtpbGwoJ1NJR1RFUk0nKTtcbiAgICAgIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBwcm9jLm9uY2UoJ2V4aXQnLCByZXNvbHZlKSksXG4gICAgICAgIHNsZWVwKDYwMCksXG4gICAgICBdKTtcbiAgICAgIGlmIChwcm9jLmV4aXRDb2RlID09PSBudWxsICYmICFwcm9jLnNpZ25hbENvZGUpIHtcbiAgICAgICAgcHJvYy5raWxsKCdTSUdLSUxMJyk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBJZ25vcmUgdGVhcmRvd24gZXJyb3JzXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUgKGZuKSB7XG4gICAgY29uc3Qgc2hvdWxkU2V0dGxlSGVscGVyID0gdGhpcy5fd2F5bGFuZEF1dG9TaGFyZTtcbiAgICB0aGlzLl9zdGFydFBvcnRhbEF1dG9TaGFyZUhlbHBlcigpO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHNob3VsZFNldHRsZUhlbHBlcikge1xuICAgICAgICBhd2FpdCBzbGVlcCgxMDAwKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX3N0b3BQb3J0YWxBdXRvU2hhcmVIZWxwZXIoKTtcbiAgICB9XG4gIH1cblxuICBfaXNQZXJzaXN0VW5zdXBwb3J0ZWRFcnJvciAoZXJyb3IpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gYCR7ZXJyb3I/Lm1lc3NhZ2UgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiBtZXNzYWdlLmluY2x1ZGVzKCdjYW5ub3QgcGVyc2lzdCcpIHx8IG1lc3NhZ2UuaW5jbHVkZXMoJ3Nlc3Npb25zIGNhbm5vdCBwZXJzaXN0Jyk7XG4gIH1cblxuICBfaXNQb2ludGVyUGVybWlzc2lvbkVycm9yIChlcnJvcikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBgJHtlcnJvcj8ubWVzc2FnZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIFBPSU5URVJfUEVSTUlTU0lPTl9FUlJPUl9UT0tFTlMuc29tZSgodG9rZW4pID0+IG1lc3NhZ2UuaW5jbHVkZXModG9rZW4pKTtcbiAgfVxuXG4gIF9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQgKGdyYW50SW5mbykge1xuICAgIHJldHVybiBncmFudEluZm8/LmdyYW50ZWREZXZpY2VzID09PSAwO1xuICB9XG5cbiAgX3J1bkExMXlQb2ludEFjdGlvbiAoeCwgeSwgbW9kZSA9ICdjbGljaycpIHtcbiAgICBjb25zdCBfeCA9IE51bWJlcih4KTtcbiAgICBjb25zdCBfeSA9IE51bWJlcih5KTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShfeCkgfHwgIU51bWJlci5pc0Zpbml0ZShfeSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZVNwYXduKFxuICAgICAgJ3B5dGhvbjMnLFxuICAgICAgWyctYycsIEExMVlfUE9JTlRfQUNUSU9OX1NDUklQVCwgYCR7X3h9YCwgYCR7X3l9YCwgbW9kZV0sXG4gICAgICB7XG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFBZVEhPTlVOQlVGRkVSRUQ6ICcxJyxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICApO1xuICAgIGlmIChyZXN1bHQub2spIHtcbiAgICAgIGNvbnN0IG91dHB1dCA9IGAke3Jlc3VsdC5zdGRvdXQgfHwgJyd9YC50cmltKCk7XG4gICAgICBpZiAob3V0cHV0KSB7XG4gICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgYTExeSBpbnB1dCBmYWxsYmFjazogJHtvdXRwdXR9YCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3QgZGV0YWlscyA9IFtgJHtyZXN1bHQuc3Rkb3V0IHx8ICcnfWAudHJpbSgpLCBgJHtyZXN1bHQuc3RkZXJyIHx8ICcnfWAudHJpbSgpXVxuICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgLmpvaW4oJyB8ICcpO1xuICAgIGlmIChkZXRhaWxzKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKGBXYXlsYW5kIGExMXkgaW5wdXQgZmFsbGJhY2sgZmFpbGVkOiAke2RldGFpbHN9YCk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIF9jbGlja1ZpYUExMXlQb2ludEZhbGxiYWNrICh4LCB5LCBtb2RlID0gJ2NsaWNrJykge1xuICAgIGNvbnN0IF94ID0gTnVtYmVyKHgpO1xuICAgIGNvbnN0IF95ID0gTnVtYmVyKHkpO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKF94KSB8fCAhTnVtYmVyLmlzRmluaXRlKF95KSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBwb2ludHMgPSBbXG4gICAgICBbX3gsIF95XSxcbiAgICAgIFtfeCAtIDMsIF95XSxcbiAgICAgIFtfeCArIDMsIF95XSxcbiAgICAgIFtfeCwgX3kgLSAzXSxcbiAgICAgIFtfeCwgX3kgKyAzXSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgW3B4LCBweV0gb2YgcG9pbnRzKSB7XG4gICAgICBpZiAodGhpcy5fcnVuQTExeVBvaW50QWN0aW9uKHB4LCBweSwgbW9kZSkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIF9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlICgpIHtcbiAgICBjb25zdCB1aWQgPSBgJHtwcm9jZXNzLmdldHVpZD8uKCkgPz8gJyd9YDtcbiAgICBpZiAoIXVpZCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvbnNSZXMgPSBzYWZlU3Bhd24oJ2xvZ2luY3RsJywgWydsaXN0LXNlc3Npb25zJywgJy0tbm8tbGVnZW5kJ10pO1xuICAgIGlmICghc2Vzc2lvbnNSZXMub2sgfHwgIXNlc3Npb25zUmVzLnN0ZG91dCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IFtdO1xuICAgIGZvciAoY29uc3QgcmF3TGluZSBvZiBzZXNzaW9uc1Jlcy5zdGRvdXQuc3BsaXQoJ1xcbicpKSB7XG4gICAgICBjb25zdCBsaW5lID0gcmF3TGluZS50cmltKCk7XG4gICAgICBpZiAoIWxpbmUpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBwYXJ0cyA9IGxpbmUuc3BsaXQoL1xccysvKTtcbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPCA4KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgW2lkLCByb3dVaWQsIHVzZXJOYW1lLCBzZWF0LCBsZWFkZXIsIGtsYXNzLCB0dHksIGFjdGl2ZV0gPSBwYXJ0cztcbiAgICAgIGlmIChyb3dVaWQgIT09IHVpZCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNhbmRpZGF0ZXMucHVzaCh7XG4gICAgICAgIGlkLFxuICAgICAgICB1aWQ6IHJvd1VpZCxcbiAgICAgICAgdXNlck5hbWUsXG4gICAgICAgIHNlYXQsXG4gICAgICAgIGxlYWRlcixcbiAgICAgICAgY2xhc3M6IGtsYXNzLFxuICAgICAgICB0dHksXG4gICAgICAgIGFjdGl2ZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGFjdGl2ZUNhbmRpZGF0ZXMgPSBjYW5kaWRhdGVzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5hY3RpdmUgPT09ICd5ZXMnKTtcbiAgICBjb25zdCBwcmVmZXJyZWQgPSBhY3RpdmVDYW5kaWRhdGVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uc2VhdCAhPT0gJy0nKVxuICAgICAgfHwgYWN0aXZlQ2FuZGlkYXRlc1swXVxuICAgICAgfHwgY2FuZGlkYXRlcy5maW5kKChpdGVtKSA9PiBpdGVtLnNlYXQgIT09ICctJylcbiAgICAgIHx8IGNhbmRpZGF0ZXNbMF07XG4gICAgaWYgKCFwcmVmZXJyZWQ/LmlkKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBzaG93UmVzID0gc2FmZVNwYXduKCdsb2dpbmN0bCcsIFtcbiAgICAgICdzaG93LXNlc3Npb24nLFxuICAgICAgcHJlZmVycmVkLmlkLFxuICAgICAgJy1wJywgJ0xvY2tlZEhpbnQnLFxuICAgICAgJy1wJywgJ0FjdGl2ZScsXG4gICAgICAnLXAnLCAnU3RhdGUnLFxuICAgICAgJy1wJywgJ1R5cGUnLFxuICAgICAgJy1wJywgJ1JlbW90ZScsXG4gICAgICAnLXAnLCAnTmFtZScsXG4gICAgXSk7XG4gICAgaWYgKCFzaG93UmVzLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5wcmVmZXJyZWQsXG4gICAgICAgIGRldGFpbHM6IHt9LFxuICAgICAgICBsb2NrZWQ6IG51bGwsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBkZXRhaWxzID0gcGFyc2VLZXlWYWx1ZU91dHB1dChzaG93UmVzLnN0ZG91dCk7XG4gICAgY29uc3QgbG9ja2VkSGludCA9IGAke2RldGFpbHMuTG9ja2VkSGludCA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLnByZWZlcnJlZCxcbiAgICAgIGRldGFpbHMsXG4gICAgICBsb2NrZWQ6IGxvY2tlZEhpbnQgPT09ICd5ZXMnLFxuICAgIH07XG4gIH1cblxuICBfbXVzdFVzZVdheWxhbmRTZXNzaW9uICgpIHtcbiAgICBjb25zdCBzZXNzaW9uVHlwZSA9IChwcm9jZXNzLmVudi5YREdfU0VTU0lPTl9UWVBFIHx8ICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChzZXNzaW9uVHlwZSAhPT0gJ3dheWxhbmQnICYmICFwcm9jZXNzLmVudi5XQVlMQU5EX0RJU1BMQVkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignV2F5bGFuZCBiYWNrZW5kIHJlcXVlc3RlZCwgYnV0IHRoaXMgcHJvY2VzcyBpcyBub3QgaW4gYSBXYXlsYW5kIHNlc3Npb24uIFNldCBhcHBpdW06bGludXhCYWNrZW5kIHRvIHgxMSBvciBydW4gdW5kZXIgV2F5bGFuZC4nKTtcbiAgICB9XG4gIH1cblxuICBfcnVuUHJlZmxpZ2h0Q2hlY2tzICgpIHtcbiAgICBjb25zdCByZXN1bHQgPSBldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQoe1xuICAgICAgaGFzQ29tbWFuZCxcbiAgICAgIGF1dG9TaGFyZUVuYWJsZWQ6IHRoaXMuX3dheWxhbmRBdXRvU2hhcmUsXG4gICAgICBkaXN0cm9JbmZvOiB0aGlzLl9kaXN0cm9JbmZvLFxuICAgIH0pO1xuICAgIGZvciAoY29uc3Qgd2FybmluZyBvZiByZXN1bHQud2FybmluZ3MpIHtcbiAgICAgIHRoaXMuX2xvZ1dhcm4od2FybmluZyk7XG4gICAgfVxuICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGRpc3RybyA9IGZvcm1hdERpc3Ryb0xhYmVsKHRoaXMuX2Rpc3Ryb0luZm8pO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBXYXlsYW5kIHByZWZsaWdodCBmYWlsZWQgb24gJHtkaXN0cm99Olxcbi0gJHtyZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbi0gJyl9YCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gdGhpcy5fZ2V0QWN0aXZlVXNlclNlc3Npb25TdGF0ZSgpO1xuICAgIGlmIChzZXNzaW9uU3RhdGU/LmxvY2tlZCA9PT0gdHJ1ZSkge1xuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gc2Vzc2lvblN0YXRlLmlkIHx8ICd1bmtub3duJztcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFdheWxhbmQgZGVza3RvcCBzZXNzaW9uICcke3Nlc3Npb25JZH0nIGlzIGxvY2tlZC4gYCArXG4gICAgICAgIGBVbmxvY2sgdGhlIEdVSSBzZXNzaW9uIChmb3IgZXhhbXBsZTogbG9naW5jdGwgdW5sb2NrLXNlc3Npb24gJHtzZXNzaW9uSWR9KSBhbmQgcmV0cnkuYFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBfbmV4dFRva2VuIChwcmVmaXgpIHtcbiAgICBjb25zdCByYW5kb20gPSBjcnlwdG8ucmFuZG9tQnl0ZXMoOCkudG9TdHJpbmcoJ2hleCcpO1xuICAgIHJldHVybiBgJHtwcmVmaXh9XyR7RGF0ZS5ub3coKX1fJHtyYW5kb219YDtcbiAgfVxuXG4gIGFzeW5jIF9nZXRQb3J0YWxJbnRlcmZhY2VWZXJzaW9uIChkZXNrdG9wT2JqLCBpZmFjZU5hbWUpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvcHMgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShEQlVTX1BST1BTX0lGQUNFKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb3BzLkdldChpZmFjZU5hbWUsICd2ZXJzaW9uJyk7XG4gICAgICBjb25zdCB2ZXJzaW9uID0gTnVtYmVyLnBhcnNlSW50KGAke3VuYm94KHJlc3VsdCl9YCwgMTApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZSh2ZXJzaW9uKSAmJiB2ZXJzaW9uID4gMCkge1xuICAgICAgICByZXR1cm4gdmVyc2lvbjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGZhbGwgdGhyb3VnaFxuICAgIH1cbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGFzeW5jIF9yZWdpc3RlclBvcnRhbEFwcElkICgpIHtcbiAgICBpZiAoIXRoaXMuX3BvcnRhbC5yZWdpc3RyeSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjYW5kaWRhdGVzID0gZmluZERlc2t0b3BFbnRyeUlkc0ZvckFwcCh0aGlzLmFwcE5hbWUpO1xuICAgIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgYXBwIHJlZ2lzdHJhdGlvbiBza2lwcGVkOyBubyBkZXNrdG9wIGVudHJ5IG1hdGNoZWQgYXBwICcke3RoaXMuYXBwTmFtZSB8fCAnJ30nYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgYXBwSWQgb2YgY2FuZGlkYXRlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlZ2lzdHJ5LlJlZ2lzdGVyKGFwcElkLCB7fSk7XG4gICAgICAgIHRoaXMuX3BvcnRhbC5yZWdpc3RlcmVkQXBwSWQgPSBhcHBJZDtcbiAgICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgcmVnaXN0ZXJlZCBob3N0IGFwcCBpZCAnJHthcHBJZH0nYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgJHtlcnJvcj8ubWVzc2FnZSA/PyAnJ31gO1xuICAgICAgICBpZiAobWVzc2FnZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdjb25uZWN0aW9uIGFscmVhZHkgYXNzb2NpYXRlZCcpKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnJlZ2lzdGVyZWRBcHBJZCA9IGFwcElkO1xuICAgICAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgcG9ydGFsIGhvc3QgYXBwIGlkIHdhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgKCR7YXBwSWR9KWApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9sb2dXYXJuKGBXYXlsYW5kIHBvcnRhbCBhcHAgcmVnaXN0cmF0aW9uIGZhaWxlZCBmb3IgJyR7YXBwSWR9JzogJHttZXNzYWdlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIF9hd2FpdFBvcnRhbFJlc3BvbnNlIChyZXF1ZXN0UGF0aCkge1xuICAgIGNvbnN0IG9iaiA9IGF3YWl0IHRoaXMuX3BvcnRhbC5idXMuZ2V0UHJveHlPYmplY3QoUE9SVEFMX0RFU1QsIHJlcXVlc3RQYXRoKTtcbiAgICBjb25zdCBpZmFjZSA9IG9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1JFUVVFU1RfSUZBQ0UpO1xuICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmYWNlLnJlbW92ZUxpc3RlbmVyKCdSZXNwb25zZScsIG9uUmVzcG9uc2UpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKGBQb3J0YWwgcmVxdWVzdCB0aW1lZCBvdXQgZm9yICR7cmVxdWVzdFBhdGh9YCkpO1xuICAgICAgfSwgMTgwMDAwKTtcblxuICAgICAgY29uc3Qgb25SZXNwb25zZSA9IChyZXNwb25zZUNvZGUsIHJlc3VsdHMpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICBpZmFjZS5yZW1vdmVMaXN0ZW5lcignUmVzcG9uc2UnLCBvblJlc3BvbnNlKTtcbiAgICAgICAgcmVzb2x2ZSh7XG4gICAgICAgICAgcmVzcG9uc2VDb2RlLFxuICAgICAgICAgIHJlc3VsdHM6IHVuYm94KHJlc3VsdHMpLFxuICAgICAgICB9KTtcbiAgICAgIH07XG5cbiAgICAgIGlmYWNlLm9uKCdSZXNwb25zZScsIG9uUmVzcG9uc2UpO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgX3BvcnRhbFJlcXVlc3QgKGlmYWNlLCBtZXRob2ROYW1lLCAuLi5hcmdzKSB7XG4gICAgY29uc3QgcmVxdWVzdFBhdGggPSBhd2FpdCBpZmFjZVttZXRob2ROYW1lXSguLi5hcmdzKTtcbiAgICBsZXQgcmVzcG9uc2UgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMuX2F3YWl0UG9ydGFsUmVzcG9uc2UocmVxdWVzdFBhdGgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYCR7ZXJyb3I/Lm1lc3NhZ2UgPz8gJyd9YDtcbiAgICAgIGlmIChtZXNzYWdlLmluY2x1ZGVzKCdpbnRlcmZhY2Ugbm90IGZvdW5kIGluIHByb3h5IG9iamVjdDogb3JnLmZyZWVkZXNrdG9wLnBvcnRhbC5SZXF1ZXN0JykpIHtcbiAgICAgICAgdGhpcy5fbG9nV2FybihgUG9ydGFsICR7bWV0aG9kTmFtZX0gZGlkIG5vdCBleHBvc2UgUmVxdWVzdCBpbnRlcmZhY2UgYXQgJyR7cmVxdWVzdFBhdGh9Jy4gRmFsbGluZyBiYWNrIHRvIGltbWVkaWF0ZS1yZXN1bHQgbW9kZS5gKTtcbiAgICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdDcmVhdGVTZXNzaW9uJyAmJiBgJHtyZXF1ZXN0UGF0aH1gLmluY2x1ZGVzKCcvc2Vzc2lvbi8nKSkge1xuICAgICAgICAgIHJldHVybiB7c2Vzc2lvbl9oYW5kbGU6IGAke3JlcXVlc3RQYXRofWB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXRob2ROYW1lID09PSAnQ3JlYXRlU2Vzc2lvbicpIHtcbiAgICAgICAgICBjb25zdCBjcmVhdGVPcHRpb25zID0gYXJnc1swXSB8fCB7fTtcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSGFuZGxlVG9rZW4gPSB1bmJveChjcmVhdGVPcHRpb25zPy5zZXNzaW9uX2hhbmRsZV90b2tlbik7XG4gICAgICAgICAgY29uc3Qgc3ludGhlc2l6ZWRIYW5kbGVzID0gY3JlYXRlU2Vzc2lvbkhhbmRsZUNhbmRpZGF0ZXNGcm9tUmVxdWVzdFBhdGgocmVxdWVzdFBhdGgsIHNlc3Npb25IYW5kbGVUb2tlbik7XG4gICAgICAgICAgaWYgKHN5bnRoZXNpemVkSGFuZGxlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBzeW50aGVzaXplZEhhbmRsZSA9IHN5bnRoZXNpemVkSGFuZGxlc1swXTtcbiAgICAgICAgICAgIGNvbnN0IGFsdEhhbmRsZXMgPSBzeW50aGVzaXplZEhhbmRsZXMuc2xpY2UoMSk7XG4gICAgICAgICAgICB0aGlzLl9sb2dXYXJuKFxuICAgICAgICAgICAgICBgUG9ydGFsIENyZWF0ZVNlc3Npb24gcmV0dXJuZWQgcmVxdWVzdCBwYXRoIHdpdGhvdXQgUmVxdWVzdCBpbnRlcmZhY2UuIGAgK1xuICAgICAgICAgICAgICBgU3ludGhlc2l6aW5nIHNlc3Npb24gaGFuZGxlICcke3N5bnRoZXNpemVkSGFuZGxlfSdgICtcbiAgICAgICAgICAgICAgKGFsdEhhbmRsZXMubGVuZ3RoID4gMCA/IGAgKGFsdGVybmF0ZXM6ICR7YWx0SGFuZGxlcy5qb2luKCcsICcpfSlgIDogJycpICtcbiAgICAgICAgICAgICAgJy4nXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuIHtzZXNzaW9uX2hhbmRsZTogc3ludGhlc2l6ZWRIYW5kbGV9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge307XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gICAgY29uc3Qge3Jlc3BvbnNlQ29kZSwgcmVzdWx0c30gPSByZXNwb25zZTtcbiAgICBpZiAocmVzcG9uc2VDb2RlICE9PSAwKSB7XG4gICAgICBjb25zdCB1bmJveGVkUmVzdWx0cyA9IHJlc3VsdHMgfHwge307XG4gICAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBtZXRob2ROYW1lID09PSAnQ3JlYXRlU2Vzc2lvbicgPyB0aGlzLl9nZXRBY3RpdmVVc2VyU2Vzc2lvblN0YXRlKCkgOiBudWxsO1xuICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdDcmVhdGVTZXNzaW9uJyAmJiBzZXNzaW9uU3RhdGU/LmxvY2tlZCA9PT0gdHJ1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFBvcnRhbCBDcmVhdGVTZXNzaW9uIGZhaWxlZCB3aXRoIHJlc3BvbnNlIGNvZGUgJHtyZXNwb25zZUNvZGV9OiBgICtcbiAgICAgICAgICBgZGVza3RvcCBzZXNzaW9uICcke3Nlc3Npb25TdGF0ZS5pZCB8fCAndW5rbm93bid9JyBpcyBsb2NrZWRgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBoYXNSZXN1bHRLZXlzID0gT2JqZWN0LmtleXModW5ib3hlZFJlc3VsdHMpLmxlbmd0aCA+IDA7XG4gICAgICBjb25zdCBkZXRhaWxzID0gaGFzUmVzdWx0S2V5cyA/IGAgKGRldGFpbHM6ICR7SlNPTi5zdHJpbmdpZnkodW5ib3hlZFJlc3VsdHMpfSlgIDogJyc7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFBvcnRhbCAke21ldGhvZE5hbWV9IGZhaWxlZCB3aXRoIHJlc3BvbnNlIGNvZGUgJHtyZXNwb25zZUNvZGV9JHtkZXRhaWxzfWApO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cyB8fCB7fTtcbiAgfVxuXG4gIGFzeW5jIF9vcGVuUG9ydGFsU2Vzc2lvbiAoKSB7XG4gICAgY29uc3Qge1ZhcmlhbnR9ID0gZGJ1cztcbiAgICB0aGlzLl9wb3J0YWwuYnVzID0gZGJ1cy5zZXNzaW9uQnVzKCk7XG4gICAgaWYgKCF0aGlzLl9wb3J0YWwuYnVzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBjb25uZWN0IHRvIERCdXMgc2Vzc2lvbiBidXMgZm9yIHhkZy1kZXNrdG9wLXBvcnRhbCcpO1xuICAgIH1cblxuICAgIGNvbnN0IGRlc2t0b3BPYmogPSBhd2FpdCB0aGlzLl9wb3J0YWwuYnVzLmdldFByb3h5T2JqZWN0KFBPUlRBTF9ERVNULCBQT1JUQUxfUEFUSCk7XG4gICAgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfUkRfSUZBQ0UpO1xuICAgIHRoaXMuX3BvcnRhbC5zY3JlZW5DYXN0ID0gZGVza3RvcE9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1NDX0lGQUNFKTtcbiAgICB0cnkge1xuICAgICAgdGhpcy5fcG9ydGFsLnJlZ2lzdHJ5ID0gZGVza3RvcE9iai5nZXRJbnRlcmZhY2UoUE9SVEFMX1JFR0lTVFJZX0lGQUNFKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRoaXMuX3BvcnRhbC5yZWdpc3RyeSA9IG51bGw7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3JlZ2lzdGVyUG9ydGFsQXBwSWQoKTtcbiAgICB0cnkge1xuICAgICAgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3QgPSBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfU1NfSUZBQ0UpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3QgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcFZlcnNpb24gPSBhd2FpdCB0aGlzLl9nZXRQb3J0YWxJbnRlcmZhY2VWZXJzaW9uKGRlc2t0b3BPYmosIFBPUlRBTF9SRF9JRkFDRSk7XG4gICAgdGhpcy5fcG9ydGFsLnNjcmVlbkNhc3RWZXJzaW9uID0gYXdhaXQgdGhpcy5fZ2V0UG9ydGFsSW50ZXJmYWNlVmVyc2lvbihkZXNrdG9wT2JqLCBQT1JUQUxfU0NfSUZBQ0UpO1xuICAgIHRoaXMuX3BvcnRhbC5zY3JlZW5zaG90VmVyc2lvbiA9IGF3YWl0IHRoaXMuX2dldFBvcnRhbEludGVyZmFjZVZlcnNpb24oZGVza3RvcE9iaiwgUE9SVEFMX1NTX0lGQUNFKTtcblxuICAgIGlmICh0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcFZlcnNpb24gPiAwIHx8IHRoaXMuX3BvcnRhbC5zY3JlZW5DYXN0VmVyc2lvbiA+IDAgfHwgdGhpcy5fcG9ydGFsLnNjcmVlbnNob3RWZXJzaW9uID4gMCkge1xuICAgICAgdGhpcy5fbG9nSW5mbyhcbiAgICAgICAgYFdheWxhbmQgcG9ydGFsIGludGVyZmFjZSB2ZXJzaW9uczogUmVtb3RlRGVza3RvcD0ke3RoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wVmVyc2lvbiB8fCAndW5rbm93bid9LCBgICtcbiAgICAgICAgYFNjcmVlbkNhc3Q9JHt0aGlzLl9wb3J0YWwuc2NyZWVuQ2FzdFZlcnNpb24gfHwgJ3Vua25vd24nfSwgYCArXG4gICAgICAgIGBTY3JlZW5zaG90PSR7dGhpcy5fcG9ydGFsLnNjcmVlbnNob3RWZXJzaW9uIHx8ICd1bmtub3duJ31gXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNyZWF0ZU9wdGlvbnMgPSB7XG4gICAgICBoYW5kbGVfdG9rZW46IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fbmV4dFRva2VuKCdyZF9jcmVhdGUnKSksXG4gICAgICBzZXNzaW9uX2hhbmRsZV90b2tlbjogbmV3IFZhcmlhbnQoJ3MnLCB0aGlzLl9uZXh0VG9rZW4oJ3JkX3Nlc3Npb24nKSksXG4gICAgfTtcblxuICAgIGNvbnN0IGNyZWF0ZVJlc3VsdCA9IGF3YWl0IHRoaXMuX3BvcnRhbFJlcXVlc3QodGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AsICdDcmVhdGVTZXNzaW9uJywgY3JlYXRlT3B0aW9ucyk7XG4gICAgY29uc3Qgc2Vzc2lvbkhhbmRsZSA9IGNyZWF0ZVJlc3VsdC5zZXNzaW9uX2hhbmRsZTtcbiAgICBpZiAoIXNlc3Npb25IYW5kbGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignUG9ydGFsIENyZWF0ZVNlc3Npb24gc3VjY2VlZGVkIGJ1dCBkaWQgbm90IHJldHVybiBzZXNzaW9uX2hhbmRsZScpO1xuICAgIH1cbiAgICB0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSA9IHNlc3Npb25IYW5kbGU7XG5cbiAgICBjb25zdCBzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0ID0gdGhpcy5fcG9ydGFsLnNjcmVlbkNhc3RWZXJzaW9uID49IDI7XG4gICAgY29uc3Qgc3VwcG9ydHNSZW1vdGVEZXNrdG9wUGVyc2lzdCA9IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wVmVyc2lvbiA+PSAyO1xuXG4gICAgaWYgKCFzdXBwb3J0c1JlbW90ZURlc2t0b3BQZXJzaXN0KSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKFxuICAgICAgICBgUmVtb3RlRGVza3RvcCBwb3J0YWwgdiR7dGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3BWZXJzaW9uIHx8ICd1bmtub3duJ30gZG9lcyBub3Qgc3VwcG9ydCBwZXJzaXN0X21vZGUvcmVzdG9yZV90b2tlbi4gYCArXG4gICAgICAgICdXYXlsYW5kIHNoYXJlIGNvbnNlbnQgY2Fubm90IGJlIGZ1bGx5IGJ5cGFzc2VkIG9uIHRoaXMgZGVza3RvcCBiYWNrZW5kLidcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc291cmNlQXR0ZW1wdHMgPSBbXTtcbiAgICBpZiAodGhpcy5fcmVzdG9yZVRva2VuICYmIHN1cHBvcnRzU2NyZWVuQ2FzdFBlcnNpc3QpIHtcbiAgICAgIHNvdXJjZUF0dGVtcHRzLnB1c2goe1xuICAgICAgICB1c2VQZXJzaXN0OiB0cnVlLFxuICAgICAgICB1c2VSZXN0b3JlVG9rZW46IHRydWUsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuX3Jlc3RvcmVUb2tlbiAmJiAhc3VwcG9ydHNTY3JlZW5DYXN0UGVyc2lzdCkge1xuICAgICAgdGhpcy5fbG9nV2FybihcbiAgICAgICAgYFNjcmVlbkNhc3QgcG9ydGFsIHYke3RoaXMuX3BvcnRhbC5zY3JlZW5DYXN0VmVyc2lvbiB8fCAndW5rbm93bid9IGRvZXMgbm90IHN1cHBvcnQgcmVzdG9yZSB0b2tlbnMuIGAgK1xuICAgICAgICAnSWdub3JpbmcgcHJvdmlkZWQgV2F5bGFuZCByZXN0b3JlIHRva2VuLidcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChzdXBwb3J0c1NjcmVlbkNhc3RQZXJzaXN0KSB7XG4gICAgICBzb3VyY2VBdHRlbXB0cy5wdXNoKHtcbiAgICAgICAgdXNlUGVyc2lzdDogdHJ1ZSxcbiAgICAgICAgdXNlUmVzdG9yZVRva2VuOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBzb3VyY2VBdHRlbXB0cy5wdXNoKHtcbiAgICAgIHVzZVBlcnNpc3Q6IGZhbHNlLFxuICAgICAgdXNlUmVzdG9yZVRva2VuOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGxldCBzZWxlY3RlZFNvdXJjZXMgPSBmYWxzZTtcbiAgICBsZXQgc2VsZWN0U291cmNlc0Vycm9yID0gbnVsbDtcbiAgICBsZXQgcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkID0gdHJ1ZTtcbiAgICBmb3IgKGNvbnN0IGF0dGVtcHQgb2Ygc291cmNlQXR0ZW1wdHMpIHtcbiAgICAgIC8vIE9uY2UgcGVyc2lzdF9tb2RlIGlzIGtub3duIHRvIGJlIHVuc3VwcG9ydGVkLCBza2lwIHJlbWFpbmluZyBwZXJzaXN0IGF0dGVtcHRzLlxuICAgICAgaWYgKGF0dGVtcHQudXNlUGVyc2lzdCAmJiAhcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3Qgc291cmNlT3B0aW9ucyA9IHtcbiAgICAgICAgaGFuZGxlX3Rva2VuOiBuZXcgVmFyaWFudCgncycsIHRoaXMuX25leHRUb2tlbignc2Nfc291cmNlcycpKSxcbiAgICAgICAgdHlwZXM6IG5ldyBWYXJpYW50KCd1JywgMSksXG4gICAgICAgIG11bHRpcGxlOiBuZXcgVmFyaWFudCgnYicsIGZhbHNlKSxcbiAgICAgICAgY3Vyc29yX21vZGU6IG5ldyBWYXJpYW50KCd1JywgMiksXG4gICAgICB9O1xuICAgICAgaWYgKGF0dGVtcHQudXNlUGVyc2lzdCkge1xuICAgICAgICBzb3VyY2VPcHRpb25zLnBlcnNpc3RfbW9kZSA9IG5ldyBWYXJpYW50KCd1JywgMik7XG4gICAgICB9XG4gICAgICBpZiAoYXR0ZW1wdC51c2VSZXN0b3JlVG9rZW4gJiYgdGhpcy5fcmVzdG9yZVRva2VuKSB7XG4gICAgICAgIHNvdXJjZU9wdGlvbnMucmVzdG9yZV90b2tlbiA9IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fcmVzdG9yZVRva2VuKTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUoKCkgPT4gdGhpcy5fcG9ydGFsUmVxdWVzdChcbiAgICAgICAgICB0aGlzLl9wb3J0YWwuc2NyZWVuQ2FzdCxcbiAgICAgICAgICAnU2VsZWN0U291cmNlcycsXG4gICAgICAgICAgc2Vzc2lvbkhhbmRsZSxcbiAgICAgICAgICBzb3VyY2VPcHRpb25zXG4gICAgICAgICkpO1xuICAgICAgICBzZWxlY3RlZFNvdXJjZXMgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoYXR0ZW1wdC51c2VQZXJzaXN0ICYmIHRoaXMuX2lzUGVyc2lzdFVuc3VwcG9ydGVkRXJyb3IoZXJyKSkge1xuICAgICAgICAgIHBlcnNpc3RBY3R1YWxseVN1cHBvcnRlZCA9IGZhbHNlO1xuICAgICAgICAgIHRoaXMuX2xvZ1dhcm4oJ1BvcnRhbCBkb2VzIG5vdCBzdXBwb3J0IHBlcnNpc3RlZCBzY3JlZW5jYXN0IHNlc3Npb25zLiBSZXRyeWluZyB3aXRob3V0IHBlcnNpc3RfbW9kZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBzZWxlY3RTb3VyY2VzRXJyb3IgPSBlcnI7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghc2VsZWN0ZWRTb3VyY2VzICYmIHNlbGVjdFNvdXJjZXNFcnJvcikge1xuICAgICAgdGhyb3cgc2VsZWN0U291cmNlc0Vycm9yO1xuICAgIH1cblxuICAgIGxldCBzZWxlY3RlZERldmljZXMgPSBmYWxzZTtcbiAgICBsZXQgc2VsZWN0RGV2aWNlc0Vycm9yID0gbnVsbDtcbiAgICAvLyBTa2lwIHBlcnNpc3RfbW9kZSBmb3IgU2VsZWN0RGV2aWNlcyB3aGVuIFNlbGVjdFNvdXJjZXMgYWxyZWFkeSBwcm92ZWQgaXQgdW5zdXBwb3J0ZWQuXG4gICAgY29uc3QgZGV2aWNlUGVyc2lzdE1vZGVzID0gKHN1cHBvcnRzUmVtb3RlRGVza3RvcFBlcnNpc3QgJiYgcGVyc2lzdEFjdHVhbGx5U3VwcG9ydGVkKSA/IFt0cnVlLCBmYWxzZV0gOiBbZmFsc2VdO1xuICAgIGZvciAoY29uc3QgdXNlUGVyc2lzdCBvZiBkZXZpY2VQZXJzaXN0TW9kZXMpIHtcbiAgICAgIGNvbnN0IGRldmljZU9wdGlvbnMgPSB7XG4gICAgICAgIGhhbmRsZV90b2tlbjogbmV3IFZhcmlhbnQoJ3MnLCB0aGlzLl9uZXh0VG9rZW4oJ3JkX2RldmljZXMnKSksXG4gICAgICAgIHR5cGVzOiBuZXcgVmFyaWFudCgndScsIERFVklDRV9UWVBFX0tFWUJPQVJEIHwgREVWSUNFX1RZUEVfUE9JTlRFUiksXG4gICAgICB9O1xuICAgICAgaWYgKHVzZVBlcnNpc3QpIHtcbiAgICAgICAgZGV2aWNlT3B0aW9ucy5wZXJzaXN0X21vZGUgPSBuZXcgVmFyaWFudCgndScsIDIpO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fcnVuV2l0aFBvcnRhbEF1dG9TaGFyZSgoKSA9PiB0aGlzLl9wb3J0YWxSZXF1ZXN0KFxuICAgICAgICAgIHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLFxuICAgICAgICAgICdTZWxlY3REZXZpY2VzJyxcbiAgICAgICAgICBzZXNzaW9uSGFuZGxlLFxuICAgICAgICAgIGRldmljZU9wdGlvbnNcbiAgICAgICAgKSk7XG4gICAgICAgIHNlbGVjdGVkRGV2aWNlcyA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmICh1c2VQZXJzaXN0ICYmIHRoaXMuX2lzUGVyc2lzdFVuc3VwcG9ydGVkRXJyb3IoZXJyKSkge1xuICAgICAgICAgIHRoaXMuX2xvZ1dhcm4oJ1BvcnRhbCBkb2VzIG5vdCBzdXBwb3J0IHBlcnNpc3RlZCByZW1vdGUtZGVza3RvcCBzZXNzaW9ucy4gUmV0cnlpbmcgd2l0aG91dCBwZXJzaXN0X21vZGUuJyk7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZWN0RGV2aWNlc0Vycm9yID0gZXJyO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIXNlbGVjdGVkRGV2aWNlcyAmJiBzZWxlY3REZXZpY2VzRXJyb3IpIHtcbiAgICAgIHRocm93IHNlbGVjdERldmljZXNFcnJvcjtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFydE9wdGlvbnMgPSB7XG4gICAgICBoYW5kbGVfdG9rZW46IG5ldyBWYXJpYW50KCdzJywgdGhpcy5fbmV4dFRva2VuKCdyZF9zdGFydCcpKSxcbiAgICB9O1xuXG4gICAgbGV0IHN0YXJ0UmVzdWx0cyA9IGF3YWl0IHRoaXMuX3J1bldpdGhQb3J0YWxBdXRvU2hhcmUoKCkgPT4gdGhpcy5fcG9ydGFsUmVxdWVzdChcbiAgICAgIHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLFxuICAgICAgJ1N0YXJ0JyxcbiAgICAgIHNlc3Npb25IYW5kbGUsXG4gICAgICAnJyxcbiAgICAgIHN0YXJ0T3B0aW9uc1xuICAgICkpO1xuICAgIHN0YXJ0UmVzdWx0cyA9IHN0YXJ0UmVzdWx0cyB8fCB7fTtcblxuICAgIGNvbnN0IGdyYW50SW5mbyA9IHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzKHN0YXJ0UmVzdWx0cy5kZXZpY2VzKTtcbiAgICBpZiAoZ3JhbnRJbmZvLmdyYW50ZWREZXZpY2VzICE9PSBudWxsKSB7XG4gICAgICB0aGlzLl9wb3J0YWwuZ3JhbnRlZERldmljZXMgPSBncmFudEluZm8uZ3JhbnRlZERldmljZXM7XG4gICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBncmFudEluZm8ucG9pbnRlckFsbG93ZWQ7XG4gICAgICB0aGlzLl9wb3J0YWwua2V5Ym9hcmRBbGxvd2VkID0gZ3JhbnRJbmZvLmtleWJvYXJkQWxsb3dlZDtcbiAgICAgIHRoaXMuX2xvZ0luZm8oXG4gICAgICAgIGBXYXlsYW5kIHBvcnRhbCBncmFudGVkIGRldmljZXM9JHtncmFudEluZm8uZ3JhbnRlZERldmljZXN9IGAgK1xuICAgICAgICBgKGtleWJvYXJkPSR7dGhpcy5fcG9ydGFsLmtleWJvYXJkQWxsb3dlZH0sIHBvaW50ZXI9JHt0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWR9LCBgICtcbiAgICAgICAgYHRvdWNoPSR7Z3JhbnRJbmZvLnRvdWNoQWxsb3dlZH0pYFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fcG9ydGFsLmdyYW50ZWREZXZpY2VzID0gbnVsbDtcbiAgICAgIHRoaXMuX3BvcnRhbC5wb2ludGVyQWxsb3dlZCA9IG51bGw7XG4gICAgICB0aGlzLl9wb3J0YWwua2V5Ym9hcmRBbGxvd2VkID0gbnVsbDtcbiAgICAgIHRoaXMuX2xvZ1dhcm4oJ1dheWxhbmQgcG9ydGFsIFN0YXJ0IGRpZCBub3QgcmVwb3J0IGdyYW50ZWQgZGV2aWNlczsgcG9pbnRlciBlbnRpdGxlbWVudCBpcyB1bmtub3duLicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24oZ3JhbnRJbmZvKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCF0aGlzLl9jYW5Db250aW51ZVdpdGhvdXRQb3J0YWxQb2ludGVyR3JhbnQoZ3JhbnRJbmZvKSkge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2xvZ1dhcm4oXG4gICAgICAgIGAke2Vycm9yLm1lc3NhZ2V9IENvbnRpbnVpbmcgd2l0aCBBVC1TUEkgcG9pbnRlciBmYWxsYmFjazsgYCArXG4gICAgICAgICdwb3J0YWwtb25seSBwb2ludGVyLCBrZXlib2FyZCwgc3dpcGUsIGFuZCBzY3JvbGwgYWN0aW9ucyBtYXkgYmUgdW5hdmFpbGFibGUuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdHJlYW1zID0gQXJyYXkuaXNBcnJheShzdGFydFJlc3VsdHMuc3RyZWFtcykgPyBzdGFydFJlc3VsdHMuc3RyZWFtcyA6IFtdO1xuICAgIGlmIChzdHJlYW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGZpcnN0U3RyZWFtID0gc3RyZWFtc1swXTtcbiAgICAgIGxldCByYXdOb2RlSWQgPSBudWxsO1xuICAgICAgbGV0IHJhd01ldGEgPSBudWxsO1xuXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShmaXJzdFN0cmVhbSkgJiYgZmlyc3RTdHJlYW0ubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBTdGFuZGFyZCBkYnVzLW5leHQgZm9ybWF0OiBbbm9kZUlkLCB7c2l6ZTogW3csIGhdLCAuLi59XVxuICAgICAgICByYXdOb2RlSWQgPSBmaXJzdFN0cmVhbVswXTtcbiAgICAgICAgcmF3TWV0YSA9IGZpcnN0U3RyZWFtWzFdO1xuICAgICAgfSBlbHNlIGlmIChmaXJzdFN0cmVhbSAhPT0gbnVsbCAmJiB0eXBlb2YgZmlyc3RTdHJlYW0gPT09ICdvYmplY3QnKSB7XG4gICAgICAgIC8vIE9iamVjdC1rZXllZCBzdHJ1Y3QgZm9ybWF0IHNlZW4gb24gUkhFTCAxMCB3aXRoIHNvbWUgZGJ1cy1uZXh0IHZlcnNpb25zOlxuICAgICAgICAvLyB7ICcwJzogbm9kZUlkLCAnMSc6IHsgc2l6ZTogW3csIGhdIH0gfVxuICAgICAgICByYXdOb2RlSWQgPSBmaXJzdFN0cmVhbVsnMCddID8/IGZpcnN0U3RyZWFtWzBdO1xuICAgICAgICByYXdNZXRhID0gZmlyc3RTdHJlYW1bJzEnXSA/PyBmaXJzdFN0cmVhbVsxXTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGFyc2VkTm9kZUlkID0gTnVtYmVyLnBhcnNlSW50KGAke3Jhd05vZGVJZH1gLCAxMCk7XG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHBhcnNlZE5vZGVJZCkpIHtcbiAgICAgICAgdGhpcy5fcG9ydGFsLnN0cmVhbU5vZGVJZCA9IHBhcnNlZE5vZGVJZDtcbiAgICAgICAgY29uc3Qgc2l6ZSA9IHJhd01ldGE/LnNpemU7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHNpemUpICYmIHNpemUubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLmxvZ2ljYWxTaXplID0ge1xuICAgICAgICAgICAgd2lkdGg6IE51bWJlci5wYXJzZUludChgJHtzaXplWzBdfWAsIDEwKSxcbiAgICAgICAgICAgIGhlaWdodDogTnVtYmVyLnBhcnNlSW50KGAke3NpemVbMV19YCwgMTApLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX2xvZ1dhcm4oXG4gICAgICAgICAgYFdheWxhbmQgcG9ydGFsIFN0YXJ0IHJldHVybmVkICR7c3RyZWFtcy5sZW5ndGh9IHN0cmVhbShzKSBidXQgc3RyZWFtIG5vZGUgaWQgY291bGQgbm90IGJlIHBhcnNlZCBgICtcbiAgICAgICAgICBgKGZpcnN0U3RyZWFtIHR5cGU9JHtBcnJheS5pc0FycmF5KGZpcnN0U3RyZWFtKSA/ICdhcnJheScgOiB0eXBlb2YgZmlyc3RTdHJlYW19LCBgICtcbiAgICAgICAgICBgcmF3Tm9kZUlkPSR7SlNPTi5zdHJpbmdpZnkocmF3Tm9kZUlkKX0pLiBgICtcbiAgICAgICAgICAnUG9pbnRlciBhYnNvbHV0ZSBldmVudHMgd2lsbCBmYWxsIGJhY2sgdG8gQVQtU1BJLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByb3RhdGVkVG9rZW4gPSBub3JtYWxpemVUb2tlbihzdGFydFJlc3VsdHMucmVzdG9yZV90b2tlbiB8fCBzdGFydFJlc3VsdHMucmVzdG9yZV9kYXRhIHx8IG51bGwpO1xuICAgIGlmIChyb3RhdGVkVG9rZW4pIHtcbiAgICAgIHRoaXMuX3Jlc3RvcmVUb2tlbiA9IHJvdGF0ZWRUb2tlbjtcbiAgICAgIHdyaXRlV2F5bGFuZFRva2VuKHRoaXMuX3Rva2VuU3RvcmVQYXRoLCB0aGlzLmFwcE5hbWUsIHJvdGF0ZWRUb2tlbik7XG4gICAgICB0aGlzLl9sb2dJbmZvKGBXYXlsYW5kIHJlc3RvcmUgdG9rZW4gdXBkYXRlZCBhdCAke3RoaXMuX3Rva2VuU3RvcmVQYXRofWApO1xuICAgIH1cblxuICAgIHRoaXMuX2xvZ0luZm8oJ1dheWxhbmQgUmVtb3RlRGVza3RvcCBwb3J0YWwgc2Vzc2lvbiBpcyByZWFkeScpO1xuICB9XG5cbiAgYXN5bmMgaW5pdGlhbGl6ZSAoKSB7XG4gICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBiYWNrZW5kIGRpc3RybyBjb250ZXh0OiAke2Zvcm1hdERpc3Ryb0xhYmVsKHRoaXMuX2Rpc3Ryb0luZm8pfWApO1xuICAgIHRoaXMuX3J1blByZWZsaWdodENoZWNrcygpO1xuICAgIHRoaXMuX211c3RVc2VXYXlsYW5kU2Vzc2lvbigpO1xuICAgIGZzLm1rZGlyU3luYygnL3RtcC8uc3Rkc3BhJywge3JlY3Vyc2l2ZTogdHJ1ZX0pO1xuICAgIGlmICh0aGlzLl93YXlsYW5kQXV0b1NoYXJlKSB7XG4gICAgICBjb25zdCB0aW1lb3V0U2Vjb25kcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbCh0aGlzLl93YXlsYW5kQXV0b1NoYXJlVGltZW91dE1zIC8gMTAwMCkpO1xuICAgICAgdGhpcy5fbG9nSW5mbyhgV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBpcyBlbmFibGVkICh0aW1lb3V0ICR7dGltZW91dFNlY29uZHN9cylgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fbG9nSW5mbygnV2F5bGFuZCBwb3J0YWwgYXV0by1zaGFyZSBpcyBkaXNhYmxlZCcpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9yZXN0b3JlVG9rZW5Gcm9tQ2Fwcykge1xuICAgICAgdGhpcy5fcmVzdG9yZVRva2VuID0gdGhpcy5fcmVzdG9yZVRva2VuRnJvbUNhcHM7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHt0b2tlbn0gPSByZWFkV2F5bGFuZFRva2VuKHRoaXMuX3Rva2VuU3RvcmVQYXRoLCB0aGlzLmFwcE5hbWUpO1xuICAgICAgdGhpcy5fcmVzdG9yZVRva2VuID0gdG9rZW47XG4gICAgfVxuXG4gICAgLy8gUmV1c2UgdGhlIGNhY2hlZCBwb3J0YWwgc2Vzc2lvbiBmcm9tIGEgcHJldmlvdXMgQXBwaXVtIHNlc3Npb24gaW5cbiAgICAvLyB0aGUgc2FtZSBzZXJ2ZXIgcHJvY2Vzcy4gIFRoaXMgYXZvaWRzIHJlLW9wZW5pbmcgdGhlIEQtQnVzIHBvcnRhbFxuICAgIC8vIGFuZCByZS1ydW5uaW5nIHRoZSBhdXRvLXNoYXJlIGNvbnNlbnQgZmxvdyBvbiBldmVyeSB0ZXN0LlxuICAgIGlmIChfY2FjaGVkUG9ydGFsU2Vzc2lvbiAmJiBfY2FjaGVkUG9ydGFsU2Vzc2lvbi5idXMgJiYgX2NhY2hlZFBvcnRhbFNlc3Npb24uc2Vzc2lvbkhhbmRsZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gUXVpY2sgaGVhbHRoLWNoZWNrOiByZWFkIGEgcG9ydGFsIHByb3BlcnR5IHRvIGNvbmZpcm0gdGhlIGJ1cyBpcyBhbGl2ZS5cbiAgICAgICAgY29uc3QgZGVza3RvcE9iaiA9IGF3YWl0IF9jYWNoZWRQb3J0YWxTZXNzaW9uLmJ1cy5nZXRQcm94eU9iamVjdChQT1JUQUxfREVTVCwgUE9SVEFMX1BBVEgpO1xuICAgICAgICBkZXNrdG9wT2JqLmdldEludGVyZmFjZShQT1JUQUxfUkRfSUZBQ0UpO1xuICAgICAgICAvLyBTZXNzaW9uIGlzIHN0aWxsIHZhbGlkIOKAlCBhZG9wdCBpdC5cbiAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLl9wb3J0YWwsIF9jYWNoZWRQb3J0YWxTZXNzaW9uKTtcbiAgICAgICAgdGhpcy5fbG9nSW5mbygnV2F5bGFuZCBwb3J0YWwgc2Vzc2lvbiByZXVzZWQgZnJvbSBjYWNoZSAoc2tpcHBpbmcgcG9ydGFsIHNldHVwKScpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHRoaXMuX2xvZ1dhcm4oJ0NhY2hlZCBwb3J0YWwgc2Vzc2lvbiBpcyBzdGFsZTsgY3JlYXRpbmcgYSBuZXcgb25lJyk7XG4gICAgICAgIF9jYWNoZWRQb3J0YWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgYXdhaXQgdGhpcy5fb3BlblBvcnRhbFNlc3Npb24oKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQgdGhpcy5fb3BlblBvcnRhbFNlc3Npb24oKTtcbiAgICB9XG5cbiAgICAvLyBDYWNoZSB0aGUgcG9ydGFsIHN0YXRlIGZvciBmdXR1cmUgc2Vzc2lvbnMuXG4gICAgX2NhY2hlZFBvcnRhbFNlc3Npb24gPSB7Li4udGhpcy5fcG9ydGFsfTtcblxuICAgIHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuXG4gICAgY29uc3Qgc2NyZWVuc2hvdEZhaWx1cmUgPSBnZXRXYXlsYW5kU2NyZWVuc2hvdEZhaWx1cmVNZXNzYWdlKHtcbiAgICAgIHBvcnRhbEF2YWlsYWJsZTogQm9vbGVhbih0aGlzLl9wb3J0YWwuc2NyZWVuc2hvdCksXG4gICAgICBoYXNHbm9tZVNjcmVlbnNob3Q6IHRoaXMuX2hhc0dub21lU2NyZWVuc2hvdCxcbiAgICAgIGhhc0dyaW06IHRoaXMuX2hhc0dyaW0sXG4gICAgfSk7XG4gICAgaWYgKHNjcmVlbnNob3RGYWlsdXJlKSB7XG4gICAgICB0aGlzLl9sb2dXYXJuKHNjcmVlbnNob3RGYWlsdXJlKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLl9oYXNXbENvcHkgfHwgIXRoaXMuX2hhc1dsUGFzdGUpIHtcbiAgICAgIHRoaXMuX2xvZ1dhcm4oJ3dsLWNvcHkgLyB3bC1wYXN0ZSBub3QgZm91bmQuIENsaXBib2FyZCBjb21tYW5kcyB3aWxsIGZhbGxiYWNrIHRvIHN0ZHNwYSBuYXRpdmUgQVBJcy4nKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBkaXNwb3NlICgpIHtcbiAgICBhd2FpdCB0aGlzLl9zdG9wUG9ydGFsQXV0b1NoYXJlSGVscGVyKCk7XG4gICAgLy8gS2VlcCB0aGUgcG9ydGFsIHNlc3Npb24gYWxpdmUgaW4gdGhlIG1vZHVsZSBjYWNoZSBzbyB0aGUgbmV4dCBBcHBpdW1cbiAgICAvLyBzZXNzaW9uIGluIHRoZSBzYW1lIHByb2Nlc3MgY2FuIHJldXNlIGl0LiAgVGhlIHBvcnRhbCBELUJ1cyBjb25uZWN0aW9uXG4gICAgLy8gYW5kIHNlc3Npb24gaGFuZGxlIHJlbWFpbiB2YWxpZCBhY3Jvc3MgQXBwaXVtIGRyaXZlciBzZXNzaW9ucy5cbiAgICAvLyBPbmx5IGNsZWFyIGluc3RhbmNlLWxldmVsIHJlZmVyZW5jZXMgc28gdGhpcyBXYXlsYW5kQXBpcyBvYmplY3QgY2FuXG4gICAgLy8gYmUgZ2FyYmFnZS1jb2xsZWN0ZWQuXG4gICAgdGhpcy5fd2luZG93TGlzdCA9IFtdO1xuICAgIHRoaXMuX3dpbmRvd01hcC5jbGVhcigpO1xuICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZSA9ICcnO1xuICAgIHRoaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0ID0gMDtcbiAgfVxuXG4gIF9yZWZyZXNoV2luZG93Q2FjaGUgKGRlc2t0b3BYbWwgPSBudWxsKSB7XG4gICAgbGV0IHBpZHMgPSB0aGlzLl9uYXRpdmVBcGlzLmFwcF9ydW5uaW5nKHRoaXMuYXBwTmFtZSkgfHwgW107XG4gICAgLy8gRmFsbGJhY2sgd2l0aCBzaG9ydC1saXZlZCBjYWNoZSB0byBhdm9pZCBzcGF3bmluZyBwZ3JlcCBvbiBldmVyeSBjYWxsXG4gICAgaWYgKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgICAgaWYgKHRoaXMuX3BncmVwUGlkcyAmJiAobm93IC0gdGhpcy5fcGdyZXBQaWRzQXQpIDwgMzAwMCkge1xuICAgICAgICBwaWRzID0gdGhpcy5fcGdyZXBQaWRzO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBiYXNlTmFtZSA9ICh0aGlzLmFwcE5hbWUgfHwgJycpLnNwbGl0KCcvJykucG9wKCk7XG4gICAgICAgICAgaWYgKGJhc2VOYW1lKSB7XG4gICAgICAgICAgICBjb25zdCByZXMgPSBzcGF3blN5bmMoJ3BncmVwJywgWyctZicsIGJhc2VOYW1lXSwge2VuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDMwMDB9KTtcbiAgICAgICAgICAgIGlmIChyZXMuc3RhdHVzID09PSAwICYmIHJlcy5zdGRvdXQpIHtcbiAgICAgICAgICAgICAgcGlkcyA9IHJlcy5zdGRvdXQudHJpbSgpLnNwbGl0KC9cXHMrLykubWFwKE51bWJlcikuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7XG4gICAgICAgICAgICAgIHRoaXMuX3BncmVwUGlkcyA9IHBpZHM7XG4gICAgICAgICAgICAgIHRoaXMuX3BncmVwUGlkc0F0ID0gbm93O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghcGlkcyB8fCBwaWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhpcy5fd2luZG93TGlzdCA9IFtdO1xuICAgICAgdGhpcy5fd2luZG93TWFwLmNsZWFyKCk7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuXG4gICAgbGV0IGRlc2t0b3AgPSBkZXNrdG9wWG1sO1xuICAgIGlmIChgJHtkZXNrdG9wID8/ICcnfWAudHJpbSgpKSB7XG4gICAgICB0aGlzLl9kZXNrdG9wSGllcmFyY2h5Q2FjaGUgPSBkZXNrdG9wO1xuICAgICAgdGhpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQgPSBEYXRlLm5vdygpO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZXNrdG9wID0gdGhpcy5fZ2V0RGVza3RvcEhpZXJhcmNoeSgpO1xuICAgIH1cbiAgICBpZiAoIWRlc2t0b3ApIHtcbiAgICAgIHRoaXMuX3dpbmRvd0xpc3QgPSBbXTtcbiAgICAgIHRoaXMuX3dpbmRvd01hcC5jbGVhcigpO1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cblxuICAgIGNvbnN0IHByZXZpb3VzV2lkQnlJZGVudGl0eSA9IG5ldyBNYXAoXG4gICAgICAodGhpcy5fd2luZG93TGlzdCB8fCBbXSkubWFwKCh3aW5kb3cpID0+IFt3aW5kb3cuaWRlbnRpdHlLZXksIHdpbmRvdy53aWRdKVxuICAgICk7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyhkZXNrdG9wLCBwaWRzKTtcbiAgICBjb25zdCB7d2luZG93c30gPSBtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzKGNhbmRpZGF0ZXMsIHByZXZpb3VzV2lkQnlJZGVudGl0eSk7XG5cbiAgICB0aGlzLl93aW5kb3dMaXN0ID0gd2luZG93cztcbiAgICB0aGlzLl93aW5kb3dNYXAuY2xlYXIoKTtcbiAgICBmb3IgKGNvbnN0IHcgb2Ygd2luZG93cykge1xuICAgICAgdGhpcy5fd2luZG93TWFwLnNldCh3LndpZCwgdyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHdpbmRvd3M7XG4gIH1cblxuICBhcHBfZ2V0V2luZG93SGllcmFjaHkgKCkge1xuICAgIC8vIENhY2hlIHRoZSBidWlsdCBYTUwgZm9yIDIgc2Vjb25kcyB0byBhdm9pZCByZWR1bmRhbnQgX3JlZnJlc2hXaW5kb3dDYWNoZVxuICAgIC8vIGNhbGxzIGR1cmluZyByYXBpZCBnZXRXaW5kb3dIYW5kbGUvZ2V0V2luZG93SGFuZGxlcyBwb2xsaW5nLlxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgaWYgKHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlICYmIChub3cgLSB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZUF0KSA8PSAyMDAwKSB7XG4gICAgICByZXR1cm4gdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGU7XG4gICAgfVxuICAgIGNvbnN0IHdpbmRvd3MgPSB0aGlzLl9yZWZyZXNoV2luZG93Q2FjaGUoKTtcbiAgICBjb25zdCB4bWwgPSB3aW5kb3dzLm1hcCgodykgPT4ge1xuICAgICAgY29uc3QgcmVjdCA9IGBbJHt3LnJlY3QueH0sJHt3LnJlY3QueX0sJHt3LnJlY3Qud2lkdGh9LCR7dy5yZWN0LmhlaWdodH1dYDtcbiAgICAgIHJldHVybiAoXG4gICAgICAgIGA8d2luZG93IHBpZD1cIiR7dy5waWR9XCIgd2lkPVwiJHt3LndpZH1cIiBJbnB1dE91dHB1dD1cIiR7dy5pbnB1dE91dHB1dH1cIiBgICtcbiAgICAgICAgYG5hbWU9XCIke2VzYyh3Lm5hbWUpfVwiIGNsYXNzPVwiJHtlc2Mody5jbGFzc05hbWUpfVwiIHJlY3Q9XCIke3JlY3R9XCIgYCArXG4gICAgICAgIGBzdGF0ZXM9XCIke2VzYyh3LnN0YXRlcyl9XCIgdGFnPVwiJHtlc2Mody5ub2RlVGFnKX1cIiBgICtcbiAgICAgICAgYHdpbmRvdy10eXBlPVwiJHtlc2Mody53aW5kb3dUeXBlKX1cIiBpZGVudGl0eT1cIiR7ZXNjKHcuaWRlbnRpdHlLZXkpfVwiLz5gXG4gICAgICApO1xuICAgIH0pLmpvaW4oJycpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGA8d2luZG93cz4ke3htbH08L3dpbmRvd3M+YDtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZSA9IHJlc3VsdDtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZUF0ID0gbm93O1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBhcHBfZ2V0V2luUmVjdCAod2lkKSB7XG4gICAgY29uc3QgcGFyc2VkV2lkID0gTnVtYmVyLnBhcnNlSW50KGAke3dpZH1gLCAxMCk7XG4gICAgbGV0IHdpbiA9IHRoaXMuX3dpbmRvd01hcC5nZXQocGFyc2VkV2lkKTtcbiAgICBpZiAoIXdpbikge1xuICAgICAgdGhpcy5fcmVmcmVzaFdpbmRvd0NhY2hlKCk7XG4gICAgICB3aW4gPSB0aGlzLl93aW5kb3dNYXAuZ2V0KHBhcnNlZFdpZCk7XG4gICAgfVxuICAgIGlmICghd2luKSB7XG4gICAgICByZXR1cm4ge3g6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgeDogd2luLnJlY3QueCxcbiAgICAgIHk6IHdpbi5yZWN0LnksXG4gICAgICB3aWR0aDogd2luLnJlY3Qud2lkdGgsXG4gICAgICBoZWlnaHQ6IHdpbi5yZWN0LmhlaWdodCxcbiAgICB9O1xuICB9XG5cbiAgYXBwX3J1bm5pbmcgKGFwcFBhdGgpIHtcbiAgICByZXR1cm4gdGhpcy5fbmF0aXZlQXBpcy5hcHBfcnVubmluZyhhcHBQYXRoKTtcbiAgfVxuXG4gIGFwcF9sYXVuY2ggKGFwcFBhdGgpIHtcbiAgICB0aGlzLl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlKCk7XG4gICAgdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGUgPSBudWxsO1xuICAgIHRoaXMuX3dpbmRvd0hpZXJhcmNoeVhtbENhY2hlQXQgPSAwO1xuICAgIHJldHVybiB0aGlzLl9uYXRpdmVBcGlzLmFwcF9sYXVuY2goYXBwUGF0aCk7XG4gIH1cblxuICBhcHBfa2lsbCAoYXBwUGF0aCkge1xuICAgIHRoaXMuX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUoKTtcbiAgICB0aGlzLl93aW5kb3dIaWVyYXJjaHlYbWxDYWNoZSA9IG51bGw7XG4gICAgdGhpcy5fd2luZG93SGllcmFyY2h5WG1sQ2FjaGVBdCA9IDA7XG4gICAgcmV0dXJuIHRoaXMuX25hdGl2ZUFwaXMuYXBwX2tpbGwoYXBwUGF0aCk7XG4gIH1cblxuICBhMTF5X2NsZWFyX2NhY2hlICgpIHtcbiAgICAvLyBPbmx5IGNsZWFyIHRoZSBuYXRpdmUgQVQtU1BJIGNhY2hlLiAgTmVpdGhlciB0aGUgSlMgZGVza3RvcCBoaWVyYXJjaHlcbiAgICAvLyBjYWNoZSBub3IgdGhlIHdpbmRvdyBoaWVyYXJjaHkgWE1MIGNhY2hlIGlzIGludmFsaWRhdGVkIGhlcmUuXG4gICAgLy8gVGhlIFhNTCBjYWNoZSBob2xkcyB3aW5kb3ctbGV2ZWwgbWV0YWRhdGEgKHBpZC93aWQvbmFtZSkgd2hpY2ggZG9lc1xuICAgIC8vIG5vdCBjaGFuZ2UgYmV0d2VlbiBmaW5kRWxlbWVudCBjYWxscyDigJQgaXQgaXMgZXhwbGljaXRseSBpbnZhbGlkYXRlZFxuICAgIC8vIGJ5IGdldFdpbmRvd0hhbmRsZXMoKSwgYXBwX2xhdW5jaCgpLCBhbmQgYXBwX2tpbGwoKS5cbiAgICAvLyBDbGVhcmluZyBpdCBoZXJlIGZvcmNlZCBfdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8gdG8gcmVidWlsZCB0aGVcbiAgICAvLyB3aW5kb3cgbGlzdCBmcm9tIHRoZSBkZXNrdG9wIGhpZXJhcmNoeSBvbiBldmVyeSBmaW5kRWxlbWVudCwgd2hpY2hcbiAgICAvLyBvbiBSSEVMIFdheWxhbmQgdHJpZ2dlcmVkIGV4cGVuc2l2ZSAyLThzIG5hdGl2ZSBBVC1TUEkgZGVza3RvcCBzY2Fuc1xuICAgIC8vIHdoZW5ldmVyIHRoZSBkZXNrdG9wIGNhY2hlIFRUTCBoYWQgYWxzbyBleHBpcmVkLlxuICAgIHJldHVybiB0aGlzLl9uYXRpdmVBcGlzLmExMXlfY2xlYXJfY2FjaGUoKTtcbiAgfVxuXG4gIGExMXlfZ2V0V2luZG93VWlIaWVyYWNoeSAod2luZG93TmFtZSwgcGlkKSB7XG4gICAgcmV0dXJuIHRoaXMuX25hdGl2ZUFwaXMuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5KHdpbmRvd05hbWUsIHBpZCk7XG4gIH1cblxuICBhMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSAod2lkLCBwaWQsIHdpbmRvd05hbWUpIHtcbiAgICBjb25zdCBwYXJzZWRXaWQgPSBOdW1iZXIucGFyc2VJbnQoYCR7d2lkfWAsIDEwKTtcbiAgICBsZXQgdGFyZ2V0V2luZG93ID0gdGhpcy5fd2luZG93TWFwLmdldChwYXJzZWRXaWQpO1xuXG4gICAgY29uc3QgZGVza3RvcCA9IHRoaXMuX2dldERlc2t0b3BIaWVyYXJjaHkoKTtcbiAgICBpZiAoIWRlc2t0b3ApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFdheWxhbmQgc2NvcGVkIHdpbmRvdyB0cmVlIGNvdWxkIG5vdCBiZSByZXNvbHZlZCBmb3Igd2lkPSR7d2lkfSwgbmFtZT0ke3dpbmRvd05hbWV9LCBwaWQ9JHtwaWR9OiBkZXNrdG9wIGhpZXJhcmNoeSBpcyB1bmF2YWlsYWJsZWBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gT25seSByZWJ1aWxkIHRoZSB3aW5kb3cgbGlzdCBpZiB0aGUgdGFyZ2V0IHdpbmRvdyBpcyBub3QgYWxyZWFkeSBrbm93bi5cbiAgICAvLyBTa2lwcGluZyB0aGUgcmVkdW5kYW50IF9yZWZyZXNoV2luZG93Q2FjaGUgYXZvaWRzIHJlLXBhcnNpbmcgdGhlIGRlc2t0b3BcbiAgICAvLyBYTUwgKERPTSArIFhQYXRoIG92ZXIgYWxsIG5vZGVzKSBvbiBldmVyeSBmaW5kRWxlbWVudCBjYWxsLlxuICAgIGlmICghdGFyZ2V0V2luZG93KSB7XG4gICAgICB0aGlzLl9yZWZyZXNoV2luZG93Q2FjaGUoZGVza3RvcCk7XG4gICAgICB0YXJnZXRXaW5kb3cgPSB0aGlzLl93aW5kb3dNYXAuZ2V0KHBhcnNlZFdpZCk7XG4gICAgfVxuICAgIGlmICghdGFyZ2V0V2luZG93KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBXYXlsYW5kIHNjb3BlZCB3aW5kb3cgdHJlZSBjb3VsZCBub3QgYmUgcmVzb2x2ZWQgZm9yIHdpZD0ke3dpZH0sIG5hbWU9JHt3aW5kb3dOYW1lfSwgcGlkPSR7cGlkfTogd2luZG93IGhhbmRsZSBpcyBubyBsb25nZXIgcHJlc2VudGBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcGlkcyA9IHRoaXMuX25hdGl2ZUFwaXMuYXBwX3J1bm5pbmcodGhpcy5hcHBOYW1lKSB8fCBbXTtcbiAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sKGRlc2t0b3AsIHBpZHMsIHRhcmdldFdpbmRvdywge2FsbG93VHJhbnNpZW50T3ZlcmxheTogdHJ1ZX0pO1xuICAgIGlmIChyZXNvbHZlZC54bWwpIHtcbiAgICAgIHJldHVybiByZXNvbHZlZC54bWw7XG4gICAgfVxuXG4gICAgY29uc3QgcmVhc29uID0gcmVzb2x2ZWQucmVhc29uID09PSAnYW1iaWd1b3VzJ1xuICAgICAgPyAnbXVsdGlwbGUgbWF0Y2hpbmcgd2luZG93IHN1YnRyZWVzIHdlcmUgZm91bmQnXG4gICAgICA6ICdubyBtYXRjaGluZyB3aW5kb3cgc3VidHJlZSB3YXMgZm91bmQnO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBXYXlsYW5kIHNjb3BlZCB3aW5kb3cgdHJlZSBjb3VsZCBub3QgYmUgcmVzb2x2ZWQgZm9yIHdpZD0ke3RhcmdldFdpbmRvdy53aWR9LCBuYW1lPSR7dGFyZ2V0V2luZG93Lm5hbWUgfHwgd2luZG93TmFtZX0sIHBpZD0ke3RhcmdldFdpbmRvdy5waWQgfHwgcGlkfTogJHtyZWFzb259YFxuICAgICk7XG4gIH1cblxuICBhMTF5X2dldERlc2t0b3BVaUhpZXJhY2h5ICgpIHtcbiAgICByZXR1cm4gdGhpcy5fZ2V0RGVza3RvcEhpZXJhcmNoeSgpO1xuICB9XG5cbiAgYTExeV9jaGVja1dpbmRvd0V4aXN0cyAod2luZG93TmFtZSwgcGlkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICh0aGlzLl9uYXRpdmVBcGlzLmExMXlfY2hlY2tXaW5kb3dFeGlzdHMod2luZG93TmFtZSwgcGlkKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGZhbGwgdGhyb3VnaFxuICAgIH1cblxuICAgIHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuICAgIGNvbnN0IHRhcmdldCA9IGAke3dpbmRvd05hbWUgPz8gJyd9YC50cmltKCk7XG4gICAgcmV0dXJuIHRoaXMuX3dpbmRvd0xpc3Quc29tZSgodykgPT4ge1xuICAgICAgaWYgKHcucGlkICE9PSBOdW1iZXIucGFyc2VJbnQoYCR7cGlkfWAsIDEwKSkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICBpZiAody5uYW1lID09PSB0YXJnZXQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBjb25zdCBjbGFzc2VzID0gYCR7dy5jbGFzc05hbWUgPz8gJyd9YC5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIHJldHVybiBjbGFzc2VzLmluY2x1ZGVzKHRhcmdldCk7XG4gICAgfSk7XG4gIH1cblxuICBjX2dldE1haW5EaXNwbGF5U2l6ZSAoKSB7XG4gICAgaWYgKHRoaXMuX3BvcnRhbC5sb2dpY2FsU2l6ZT8ud2lkdGggPiAwICYmIHRoaXMuX3BvcnRhbC5sb2dpY2FsU2l6ZT8uaGVpZ2h0ID4gMCkge1xuICAgICAgcmV0dXJuIHRoaXMuX3BvcnRhbC5sb2dpY2FsU2l6ZTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbmF0aXZlU2l6ZSA9IHRoaXMuX25hdGl2ZUFwaXMuY19nZXRNYWluRGlzcGxheVNpemUoKTtcbiAgICAgIGlmIChuYXRpdmVTaXplPy53aWR0aCA+IDAgJiYgbmF0aXZlU2l6ZT8uaGVpZ2h0ID4gMCkge1xuICAgICAgICByZXR1cm4gbmF0aXZlU2l6ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGZhbGwgdGhyb3VnaFxuICAgIH1cblxuICAgIHRoaXMuX3JlZnJlc2hXaW5kb3dDYWNoZSgpO1xuICAgIGxldCB3aWR0aCA9IDA7XG4gICAgbGV0IGhlaWdodCA9IDA7XG4gICAgZm9yIChjb25zdCB3IG9mIHRoaXMuX3dpbmRvd0xpc3QpIHtcbiAgICAgIHdpZHRoID0gTWF0aC5tYXgod2lkdGgsIHcucmVjdC54ICsgdy5yZWN0LndpZHRoKTtcbiAgICAgIGhlaWdodCA9IE1hdGgubWF4KGhlaWdodCwgdy5yZWN0LnkgKyB3LnJlY3QuaGVpZ2h0KTtcbiAgICB9XG4gICAgcmV0dXJuIHt3aWR0aCwgaGVpZ2h0fTtcbiAgfVxuXG4gIF9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIgKCkge1xuICAgIGlmICghdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AgfHwgIXRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaXMgbm90IHJlYWR5IGZvciBwb2ludGVyIGV2ZW50cycpO1xuICAgIH1cbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZSh0aGlzLl9wb3J0YWwuc3RyZWFtTm9kZUlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBkaWQgbm90IHByb3ZpZGUgYSBzdHJlYW0gbm9kZSBpZC4gUG9pbnRlciBhYnNvbHV0ZSBldmVudHMgYXJlIHVuYXZhaWxhYmxlLicpO1xuICAgIH1cbiAgfVxuXG4gIF9pc1BvcnRhbFJlYWR5Rm9yUG9pbnRlciAoKSB7XG4gICAgcmV0dXJuIEJvb2xlYW4oXG4gICAgICB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcCAmJlxuICAgICAgdGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUgJiZcbiAgICAgIE51bWJlci5pc0Zpbml0ZSh0aGlzLl9wb3J0YWwuc3RyZWFtTm9kZUlkKVxuICAgICk7XG4gIH1cblxuICBfYnV0dG9uQ29kZSAoYnV0dG9uKSB7XG4gICAgaWYgKGJ1dHRvbiA9PT0gMykge1xuICAgICAgcmV0dXJuIFBPSU5URVJfUklHSFQ7XG4gICAgfVxuICAgIGlmIChidXR0b24gPT09IDIpIHtcbiAgICAgIHJldHVybiBQT0lOVEVSX01JRERMRTtcbiAgICB9XG4gICAgcmV0dXJuIFBPSU5URVJfTEVGVDtcbiAgfVxuXG4gIGFzeW5jIG1vdXNlX21vdmUgKHgsIHkpIHtcbiAgICBpZiAodGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGhhcyBubyBQT0lOVEVSIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICB0aGlzLl9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIoKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AuTm90aWZ5UG9pbnRlck1vdGlvbkFic29sdXRlKFxuICAgICAgICB0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSxcbiAgICAgICAge30sXG4gICAgICAgIHRoaXMuX3BvcnRhbC5zdHJlYW1Ob2RlSWQsXG4gICAgICAgIE51bWJlcih4KSxcbiAgICAgICAgTnVtYmVyKHkpXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAodGhpcy5faXNQb2ludGVyUGVybWlzc2lvbkVycm9yKGVycm9yKSkge1xuICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICdXYXlsYW5kIHBvcnRhbCBkZW5pZWQgcG9pbnRlciBtb3Rpb24gZXZlbnRzLiAnICtcbiAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1vdXNlX2NsaWNrICh4LCB5LCBidXR0b24pIHtcbiAgICBjb25zdCBidXR0b25Db2RlID0gdGhpcy5fYnV0dG9uQ29kZShidXR0b24pO1xuXG4gICAgLy8gRmFzdCBwYXRoOiBwb3J0YWwgaXMgZnVsbHkgcmVhZHkgKGhhcyBzdHJlYW1Ob2RlSWQpLiBVc2VkIG9uIFVidW50dSBhbmQgUkhFTCB3aGVuXG4gICAgLy8gc3RyZWFtIHBhcnNpbmcgc3VjY2VlZHMuXG4gICAgaWYgKHRoaXMuX2lzUG9ydGFsUmVhZHlGb3JQb2ludGVyKCkgJiYgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkICE9PSBmYWxzZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5tb3VzZV9tb3ZlKHgsIHkpO1xuICAgICAgICBpZiAodGhpcy5fY29tcG9zaXRvclNldHRsZU1zID4gMCkge1xuICAgICAgICAgIGF3YWl0IHNsZWVwKHRoaXMuX2NvbXBvc2l0b3JTZXR0bGVNcyk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgdGhpcy5fcG9ydGFsLnJlbW90ZURlc2t0b3AuTm90aWZ5UG9pbnRlckJ1dHRvbih0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSwge30sIGJ1dHRvbkNvZGUsIDEpO1xuICAgICAgICBpZiAodGhpcy5fYnV0dG9uUHJlc3NSZWxlYXNlR2FwTXMgPiAwKSB7XG4gICAgICAgICAgYXdhaXQgc2xlZXAodGhpcy5fYnV0dG9uUHJlc3NSZWxlYXNlR2FwTXMpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJCdXR0b24odGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsIHt9LCBidXR0b25Db2RlLCAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgYnV0dG9uIGV2ZW50cy4gJyArXG4gICAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5vbi1wZXJtaXNzaW9uIHBvcnRhbCBlcnJvcjogZmFsbCB0aHJvdWdoIHRvIEFULVNQSSBmYWxsYmFjay5cbiAgICAgICAgdGhpcy5fbG9nV2FybihgV2F5bGFuZCBwb3J0YWwgY2xpY2sgZmFpbGVkICgke2Vycm9yLm1lc3NhZ2V9KTsgdHJ5aW5nIEFULVNQSSBmYWxsYmFja2ApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEFULVNQSSBmYWxsYmFjazogdmFsaWQgZm9yIHByaW1hcnkgYnV0dG9uIG9ubHkgKEFULVNQSSAnY2xpY2snIGlzIGxlZnQtYnV0dG9uIHNlbWFudGljcykuXG4gICAgaWYgKChidXR0b24gPT09IDEgfHwgYnV0dG9uID09PSB1bmRlZmluZWQpICYmIHRoaXMuX2NsaWNrVmlhQTExeVBvaW50RmFsbGJhY2soeCwgeSwgJ2NsaWNrJykpIHtcbiAgICAgIHRoaXMuX2xvZ0luZm8oYFdheWxhbmQgY2xpY2sgYXQgKCR7eH0sICR7eX0pIHN1Y2NlZWRlZCB2aWEgQVQtU1BJIGZhbGxiYWNrYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU3VyZmFjZSBhIGNsZWFyIGVycm9yIGlmIG5vdGhpbmcgd29ya2VkLlxuICAgIHRoaXMuX2Vuc3VyZVBvcnRhbFJlYWR5Rm9yUG9pbnRlcigpO1xuICB9XG5cbiAgYXN5bmMgbW91c2VfZG91YmxlQ2xpY2sgKHgsIHksIGJ1dHRvbikge1xuICAgIC8vIFdoZW4gcG9ydGFsIHN0cmVhbSBpcyB1bmF2YWlsYWJsZSwgdXNlIEFULVNQSSBuYXRpdmUgZG91YmxlLWNsaWNrIChzaW5nbGUgYXRvbWljIGFjdGlvbixcbiAgICAvLyBtb3JlIHJlbGlhYmxlIHRoYW4gdHdvIHNlcGFyYXRlIHBvcnRhbCBjbGlja3Mgd2l0aCBhIG1pc3Npbmcgc3RyZWFtIG5vZGUgaWQpLlxuICAgIGlmICghdGhpcy5faXNQb3J0YWxSZWFkeUZvclBvaW50ZXIoKSB8fCB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICBpZiAoKGJ1dHRvbiA9PT0gMSB8fCBidXR0b24gPT09IHVuZGVmaW5lZCkgJiYgdGhpcy5fY2xpY2tWaWFBMTF5UG9pbnRGYWxsYmFjayh4LCB5LCAnZG91YmxlJykpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBTdGFuZGFyZCBwYXRoOiB0d28gcG9ydGFsIGNsaWNrcyAodW5jaGFuZ2VkIGJlaGF2aW9yIGZvciBVYnVudHUpLlxuICAgIGF3YWl0IHRoaXMubW91c2VfY2xpY2soeCwgeSwgYnV0dG9uKTtcbiAgICBhd2FpdCBzbGVlcCh0aGlzLl9kb3VibGVDbGlja0ludGVydmFsTXMpO1xuICAgIGF3YWl0IHRoaXMubW91c2VfY2xpY2soeCwgeSwgYnV0dG9uKTtcbiAgfVxuXG4gIGFzeW5jIG1vdXNlX3N3aXBlIChzeCwgc3ksIGV4LCBleSkge1xuICAgIGlmICh0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaGFzIG5vIFBPSU5URVIgcGVybWlzc2lvbi4gUmUtcnVuIGFuZCBncmFudCByZW1vdGUgY29udHJvbCBhY2Nlc3MuJyk7XG4gICAgfVxuICAgIHRoaXMuX2Vuc3VyZVBvcnRhbFJlYWR5Rm9yUG9pbnRlcigpO1xuICAgIGNvbnN0IHN0ZXBzID0gMTg7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMubW91c2VfbW92ZShzeCwgc3kpO1xuICAgICAgaWYgKHRoaXMuX2NvbXBvc2l0b3JTZXR0bGVNcyA+IDApIHtcbiAgICAgICAgYXdhaXQgc2xlZXAodGhpcy5fY29tcG9zaXRvclNldHRsZU1zKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJCdXR0b24odGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsIHt9LCBQT0lOVEVSX0xFRlQsIDEpO1xuICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPD0gc3RlcHM7IGkrKykge1xuICAgICAgICBjb25zdCB4ID0gc3ggKyAoKGV4IC0gc3gpICogaSkgLyBzdGVwcztcbiAgICAgICAgY29uc3QgeSA9IHN5ICsgKChleSAtIHN5KSAqIGkpIC8gc3RlcHM7XG4gICAgICAgIGF3YWl0IHRoaXMubW91c2VfbW92ZSh4LCB5KTtcbiAgICAgICAgYXdhaXQgc2xlZXAoOCk7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLl9wb3J0YWwucmVtb3RlRGVza3RvcC5Ob3RpZnlQb2ludGVyQnV0dG9uKHRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlLCB7fSwgUE9JTlRFUl9MRUZULCAwKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID0gZmFsc2U7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgc3dpcGUgZXZlbnRzLiAnICtcbiAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1vdXNlX3Njcm9sbF94X3kgKHgsIHkpIHtcbiAgICBpZiAodGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGhhcyBubyBQT0lOVEVSIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICB0aGlzLl9lbnN1cmVQb3J0YWxSZWFkeUZvclBvaW50ZXIoKTtcblxuICAgIGNvbnN0IGhvcml6b250YWxTdGVwcyA9IE51bWJlci5wYXJzZUludChgJHt4fWAsIDEwKSB8fCAwO1xuICAgIGNvbnN0IHZlcnRpY2FsU3RlcHMgPSBOdW1iZXIucGFyc2VJbnQoYCR7eX1gLCAxMCkgfHwgMDtcblxuICAgIGNvbnN0IGFwcGx5RGlzY3JldGUgPSBhc3luYyAoYXhpcywgc3RlcHMpID0+IHtcbiAgICAgIGNvbnN0IGNvdW50ID0gTWF0aC5hYnMoc3RlcHMpO1xuICAgICAgY29uc3QgZGlyZWN0aW9uID0gc3RlcHMgPiAwID8gMSA6IC0xO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjb3VudDsgaSsrKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeVBvaW50ZXJBeGlzRGlzY3JldGUoXG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnNlc3Npb25IYW5kbGUsXG4gICAgICAgICAge30sXG4gICAgICAgICAgYXhpcyxcbiAgICAgICAgICBkaXJlY3Rpb25cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgaWYgKGhvcml6b250YWxTdGVwcyAhPT0gMCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXBwbHlEaXNjcmV0ZSgxLCBob3Jpem9udGFsU3RlcHMpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHRoaXMuX2lzUG9pbnRlclBlcm1pc3Npb25FcnJvcihlcnJvcikpIHtcbiAgICAgICAgICB0aGlzLl9wb3J0YWwucG9pbnRlckFsbG93ZWQgPSBmYWxzZTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnV2F5bGFuZCBwb3J0YWwgZGVuaWVkIHBvaW50ZXIgc2Nyb2xsIGV2ZW50cy4gJyArXG4gICAgICAgICAgICAnUmUtcnVuIGFuZCBlbnN1cmUgcmVtb3RlIGNvbnRyb2wvcG9pbnRlciBhY2Nlc3MgaXMgZ3JhbnRlZCBpbiB0aGUgc2hhcmUgZGlhbG9nLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAodmVydGljYWxTdGVwcyAhPT0gMCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXBwbHlEaXNjcmV0ZSgwLCB2ZXJ0aWNhbFN0ZXBzKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICh0aGlzLl9pc1BvaW50ZXJQZXJtaXNzaW9uRXJyb3IoZXJyb3IpKSB7XG4gICAgICAgICAgdGhpcy5fcG9ydGFsLnBvaW50ZXJBbGxvd2VkID0gZmFsc2U7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ1dheWxhbmQgcG9ydGFsIGRlbmllZCBwb2ludGVyIHNjcm9sbCBldmVudHMuICcgK1xuICAgICAgICAgICAgJ1JlLXJ1biBhbmQgZW5zdXJlIHJlbW90ZSBjb250cm9sL3BvaW50ZXIgYWNjZXNzIGlzIGdyYW50ZWQgaW4gdGhlIHNoYXJlIGRpYWxvZy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBfY2hhclRvRXZkZXZLZXlTcGVjIChjaGFyKSB7XG4gICAgY29uc3QgcmF3ID0gYCR7Y2hhciA/PyAnJ31gO1xuICAgIGlmICghcmF3KSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgZmlyc3QgPSByYXdbMF07XG4gICAgY29uc3QgbG93ZXIgPSBmaXJzdC50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IGJhc2VNYXAgPSB7XG4gICAgICBhOiAzMCwgYjogNDgsIGM6IDQ2LCBkOiAzMiwgZTogMTgsIGY6IDMzLCBnOiAzNCwgaDogMzUsIGk6IDIzLFxuICAgICAgajogMzYsIGs6IDM3LCBsOiAzOCwgbTogNTAsIG46IDQ5LCBvOiAyNCwgcDogMjUsIHE6IDE2LCByOiAxOSxcbiAgICAgIHM6IDMxLCB0OiAyMCwgdTogMjIsIHY6IDQ3LCB3OiAxNywgeDogNDUsIHk6IDIxLCB6OiA0NCxcbiAgICAgIDE6IDIsIDI6IDMsIDM6IDQsIDQ6IDUsIDU6IDYsIDY6IDcsIDc6IDgsIDg6IDksIDk6IDEwLCAwOiAxMSxcbiAgICAgICcgJzogNTcsXG4gICAgICAnLSc6IDEyLFxuICAgICAgJz0nOiAxMyxcbiAgICAgICdbJzogMjYsXG4gICAgICAnXSc6IDI3LFxuICAgICAgJzsnOiAzOSxcbiAgICAgICdcXCcnOiA0MCxcbiAgICAgICcsJzogNTEsXG4gICAgICAnLic6IDUyLFxuICAgICAgJy8nOiA1MyxcbiAgICAgICdcXFxcJzogNDMsXG4gICAgICAnYCc6IDQxLFxuICAgIH07XG4gICAgY29uc3Qgc2hpZnRlZE1hcCA9IHtcbiAgICAgICchJzogMixcbiAgICAgICdAJzogMyxcbiAgICAgICcjJzogNCxcbiAgICAgICckJzogNSxcbiAgICAgICclJzogNixcbiAgICAgICdeJzogNyxcbiAgICAgICcmJzogOCxcbiAgICAgICcqJzogOSxcbiAgICAgICcoJzogMTAsXG4gICAgICAnKSc6IDExLFxuICAgICAgXzogMTIsXG4gICAgICAnKyc6IDEzLFxuICAgICAgJ3snOiAyNixcbiAgICAgICd9JzogMjcsXG4gICAgICAnOic6IDM5LFxuICAgICAgJ1wiJzogNDAsXG4gICAgICAnPCc6IDUxLFxuICAgICAgJz4nOiA1MixcbiAgICAgICc/JzogNTMsXG4gICAgICAnfCc6IDQzLFxuICAgICAgJ34nOiA0MSxcbiAgICB9O1xuXG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzaGlmdGVkTWFwLCBmaXJzdCkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGV2ZGV2OiBzaGlmdGVkTWFwW2ZpcnN0XSxcbiAgICAgICAgc2hpZnQ6IHRydWUsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoYmFzZU1hcCwgbG93ZXIpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBldmRldjogYmFzZU1hcFtsb3dlcl0sXG4gICAgICAgIHNoaWZ0OiBmaXJzdCAhPT0gbG93ZXIsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgX2NoYXJUb0V2ZGV2S2V5Y29kZSAoY2hhcikge1xuICAgIHJldHVybiB0aGlzLl9jaGFyVG9FdmRldktleVNwZWMoY2hhcik/LmV2ZGV2ID8/IG51bGw7XG4gIH1cblxuICBfa2V5c3ltVG9FdmRldiAoa2V5c3ltKSB7XG4gICAgY29uc3QgbWFwID0ge1xuICAgICAgNjUyODg6IDE0LFxuICAgICAgNjU1MzU6IDExMSxcbiAgICAgIDY1MjkzOiAyOCxcbiAgICAgIDY1Mjg5OiAxNSxcbiAgICAgIDY1MzA3OiAxLFxuICAgICAgNjUzNjI6IDEwMyxcbiAgICAgIDY1MzY0OiAxMDgsXG4gICAgICA2NTM2MTogMTA1LFxuICAgICAgNjUzNjM6IDEwNixcbiAgICAgIDY1MzYwOiAxMDIsXG4gICAgICA2NTM2NzogMTA3LFxuICAgICAgNjUzNjU6IDEwNCxcbiAgICAgIDY1MzY2OiAxMDksXG4gICAgICA2NTQ3MDogNTksXG4gICAgICA2NTQ3MTogNjAsXG4gICAgICA2NTQ3MjogNjEsXG4gICAgICA2NTQ3MzogNjIsXG4gICAgICA2NTQ3NDogNjMsXG4gICAgICA2NTQ3NTogNjQsXG4gICAgICA2NTQ3NjogNjUsXG4gICAgICA2NTQ3NzogNjYsXG4gICAgICA2NTQ3ODogNjcsXG4gICAgICA2NTQ3OTogNjgsXG4gICAgICA2NTQ4MDogODcsXG4gICAgICA2NTQ4MTogODgsXG4gICAgICA2NTUwNzogMjksXG4gICAgICA2NTUwODogOTcsXG4gICAgICA2NTUxMzogNTYsXG4gICAgICA2NTUxNDogMTAwLFxuICAgICAgNjU1MDU6IDQyLFxuICAgICAgNjU1MDY6IDU0LFxuICAgICAgNjU1MTU6IDEyNSxcbiAgICAgIDY1NTE2OiAxMjYsXG4gICAgICAzMjogNTcsXG4gICAgfTtcbiAgICByZXR1cm4gbWFwW2tleXN5bV0gPz8gbnVsbDtcbiAgfVxuXG4gIF9tb2RzRnJvbUZsYWdzIChmbGFncykge1xuICAgIGNvbnN0IG1vZENvZGVzID0gW107XG4gICAgY29uc3QgZiA9IE51bWJlci5wYXJzZUludChgJHtmbGFnc31gLCAxMCkgfHwgMDtcbiAgICBpZiAoZiAmIDEpIHtcbiAgICAgIG1vZENvZGVzLnB1c2goNDIpOyAvLyBzaGlmdFxuICAgIH1cbiAgICBpZiAoZiAmIDQpIHtcbiAgICAgIG1vZENvZGVzLnB1c2goMjkpOyAvLyBjdHJsXG4gICAgfVxuICAgIGlmIChmICYgOCkge1xuICAgICAgbW9kQ29kZXMucHVzaCg1Nik7IC8vIGFsdFxuICAgIH1cbiAgICBpZiAoZiAmIDY0KSB7XG4gICAgICBtb2RDb2Rlcy5wdXNoKDEyNSk7IC8vIG1ldGFcbiAgICB9XG4gICAgcmV0dXJuIG1vZENvZGVzO1xuICB9XG5cbiAgYXN5bmMgX25vdGlmeUtleWNvZGUgKGtleWNvZGUsIHN0YXRlKSB7XG4gICAgaWYgKHRoaXMuX3BvcnRhbC5rZXlib2FyZEFsbG93ZWQgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dheWxhbmQgcG9ydGFsIHNlc3Npb24gaGFzIG5vIEtFWUJPQVJEIHBlcm1pc3Npb24uIFJlLXJ1biBhbmQgZ3JhbnQgcmVtb3RlIGNvbnRyb2wgYWNjZXNzLicpO1xuICAgIH1cbiAgICBpZiAoIXRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wIHx8ICF0aGlzLl9wb3J0YWwuc2Vzc2lvbkhhbmRsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXYXlsYW5kIHBvcnRhbCBzZXNzaW9uIGlzIG5vdCByZWFkeSBmb3Iga2V5Ym9hcmQgZXZlbnRzJyk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3BvcnRhbC5yZW1vdGVEZXNrdG9wLk5vdGlmeUtleWJvYXJkS2V5Y29kZShcbiAgICAgIHRoaXMuX3BvcnRhbC5zZXNzaW9uSGFuZGxlLFxuICAgICAge30sXG4gICAgICBOdW1iZXIoa2V5Y29kZSksXG4gICAgICBOdW1iZXIoc3RhdGUpXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIF90YXBFdmRldldpdGhNb2RzIChldmRldkNvZGUsIG1vZHMgPSBbXSkge1xuICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZHMpIHtcbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kLCAxKTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldkNvZGUsIDEpO1xuICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUoZXZkZXZDb2RlLCAwKTtcbiAgICBmb3IgKGxldCBpID0gbW9kcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2RzW2ldLCAwKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBrZXlib2FyZF90YXBLZXlDb2RlIChrZXljb2RlLCBmbGFncykge1xuICAgIGNvbnN0IGV2ZGV2ID0gdGhpcy5fa2V5c3ltVG9FdmRldihOdW1iZXIucGFyc2VJbnQoYCR7a2V5Y29kZX1gLCAxMCkpO1xuICAgIGlmICghZXZkZXYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQga2V5Y29kZSBmb3IgV2F5bGFuZCBiYWNrZW5kOiAke2tleWNvZGV9YCk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuX3RhcEV2ZGV2V2l0aE1vZHMoZXZkZXYsIHRoaXMuX21vZHNGcm9tRmxhZ3MoZmxhZ3MpKTtcbiAgfVxuXG4gIGFzeW5jIGtleWJvYXJkX3RvZ2dsZUtleUNvZGUgKGtleWNvZGUsIGRvd24sIGZsYWdzKSB7XG4gICAgY29uc3QgZXZkZXYgPSB0aGlzLl9rZXlzeW1Ub0V2ZGV2KE51bWJlci5wYXJzZUludChgJHtrZXljb2RlfWAsIDEwKSk7XG4gICAgaWYgKCFldmRldikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBrZXljb2RlIGZvciBXYXlsYW5kIGJhY2tlbmQ6ICR7a2V5Y29kZX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKGRvd24pIHtcbiAgICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZHMpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2QsIDEpO1xuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldiwgMSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShldmRldiwgMCk7XG4gICAgZm9yIChsZXQgaSA9IG1vZHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kc1tpXSwgMCk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMga2V5Ym9hcmRfdGFwS2V5IChjLCBmbGFncykge1xuICAgIGNvbnN0IHJhdyA9IGAke2MgPz8gJyd9YDtcbiAgICBpZiAoIXJhdykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzcGVjID0gdGhpcy5fY2hhclRvRXZkZXZLZXlTcGVjKHJhd1swXSk7XG4gICAgaWYgKCFzcGVjKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGtleSAnJHtjfScgZm9yIFdheWxhbmQgYmFja2VuZGApO1xuICAgIH1cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKHNwZWMuc2hpZnQgJiYgIW1vZHMuaW5jbHVkZXMoNDIpKSB7XG4gICAgICBtb2RzLnVuc2hpZnQoNDIpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLl90YXBFdmRldldpdGhNb2RzKHNwZWMuZXZkZXYsIG1vZHMpO1xuICB9XG5cbiAgYXN5bmMga2V5Ym9hcmRfdG9nZ2xlS2V5IChjLCBkb3duLCBmbGFncykge1xuICAgIGNvbnN0IHJhdyA9IGAke2MgPz8gJyd9YDtcbiAgICBpZiAoIXJhdykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzcGVjID0gdGhpcy5fY2hhclRvRXZkZXZLZXlTcGVjKHJhd1swXSk7XG4gICAgaWYgKCFzcGVjKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGtleSAnJHtjfScgZm9yIFdheWxhbmQgYmFja2VuZGApO1xuICAgIH1cbiAgICBjb25zdCBtb2RzID0gdGhpcy5fbW9kc0Zyb21GbGFncyhmbGFncyk7XG4gICAgaWYgKHNwZWMuc2hpZnQgJiYgIW1vZHMuaW5jbHVkZXMoNDIpKSB7XG4gICAgICBtb2RzLnVuc2hpZnQoNDIpO1xuICAgIH1cblxuICAgIGlmIChkb3duKSB7XG4gICAgICBmb3IgKGNvbnN0IG1vZCBvZiBtb2RzKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUobW9kLCAxKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRoaXMuX25vdGlmeUtleWNvZGUoc3BlYy5ldmRldiwgMSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShzcGVjLmV2ZGV2LCAwKTtcbiAgICBmb3IgKGxldCBpID0gbW9kcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgYXdhaXQgdGhpcy5fbm90aWZ5S2V5Y29kZShtb2RzW2ldLCAwKTtcbiAgICB9XG4gIH1cblxuICBrZXlib2FyZF9jb3B5IChzdHIpIHtcbiAgICBpZiAodGhpcy5faGFzV2xDb3B5KSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBzYWZlU3Bhd24oJ3dsLWNvcHknLCBbXSwge2lucHV0OiBgJHtzdHIgPz8gJyd9YH0pO1xuICAgICAgaWYgKHJlc3VsdC5vaykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMuX25hdGl2ZUFwaXMua2V5Ym9hcmRfY29weShzdHIpO1xuICB9XG5cbiAga2V5Ym9hcmRfZ2V0Q2xpcGJvYXJkQ29udGVudCAoKSB7XG4gICAgaWYgKHRoaXMuX2hhc1dsUGFzdGUpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHNhZmVTcGF3bignd2wtcGFzdGUnLCBbJy1uJ10pO1xuICAgICAgaWYgKHJlc3VsdC5vaykge1xuICAgICAgICByZXR1cm4gcmVzdWx0LnN0ZG91dDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX25hdGl2ZUFwaXMua2V5Ym9hcmRfZ2V0Q2xpcGJvYXJkQ29udGVudCgpO1xuICB9XG5cbiAgX2NhblR5cGVTdHJpbmdEaXJlY3RseSAoc3RyKSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20oYCR7c3RyID8/ICcnfWApLmV2ZXJ5KChjaGFyKSA9PiB7XG4gICAgICBpZiAoIWAke2NoYXIgPz8gJyd9YCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBCb29sZWFuKHRoaXMuX2NoYXJUb0V2ZGV2S2V5U3BlYyhjaGFyKSk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBrZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlIChzdHIpIHtcbiAgICBjb25zdCB0ZXh0ID0gYCR7c3RyID8/ICcnfWA7XG4gICAgaWYgKCF0ZXh0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2NhblR5cGVTdHJpbmdEaXJlY3RseSh0ZXh0KSkge1xuICAgICAgZm9yIChjb25zdCBjaGFyIG9mIEFycmF5LmZyb20odGV4dCkpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5rZXlib2FyZF90YXBLZXkoY2hhciwgMCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKHRoaXMuX2tleVRhcEludGVyRGVsYXlNcyk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5rZXlib2FyZF9jb3B5KHRleHQpO1xuICAgIGF3YWl0IHNsZWVwKHRoaXMuX2Rpc3Ryb0luZm8uaXNSaGVsTGlrZSA/IDEyMCA6ICh0aGlzLl9kaXN0cm9JbmZvLmlzVWJ1bnR1ID8gMTAwIDogODApKTtcbiAgICBhd2FpdCB0aGlzLmtleWJvYXJkX3RhcEtleSgndicsIDQpO1xuICB9XG5cbiAgX3Jlc29sdmVGaWxlVXJpUGF0aCAodXJpKSB7XG4gICAgY29uc3QgcmF3ID0gYCR7dXJpID8/ICcnfWAudHJpbSgpO1xuICAgIGlmICghcmF3KSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKHJhdy5zdGFydHNXaXRoKCcvJykpIHtcbiAgICAgIHJldHVybiByYXc7XG4gICAgfVxuICAgIGlmICghcmF3LnN0YXJ0c1dpdGgoJ2ZpbGU6Ly8nKSkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHJhdyk7XG4gICAgICBpZiAocGFyc2VkLnByb3RvY29sICE9PSAnZmlsZTonKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudChwYXJzZWQucGF0aG5hbWUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX2NhcHR1cmVCeVBvcnRhbFNjcmVlbnNob3QgKG91dHB1dFBhdGgpIHtcbiAgICBpZiAoIXRoaXMuX3BvcnRhbC5zY3JlZW5zaG90KSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IHtWYXJpYW50fSA9IGRidXM7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAgICAgIGhhbmRsZV90b2tlbjogbmV3IFZhcmlhbnQoJ3MnLCB0aGlzLl9uZXh0VG9rZW4oJ3NzaG90JykpLFxuICAgICAgaW50ZXJhY3RpdmU6IG5ldyBWYXJpYW50KCdiJywgZmFsc2UpLFxuICAgICAgbW9kYWw6IG5ldyBWYXJpYW50KCdiJywgZmFsc2UpLFxuICAgIH07XG5cbiAgICB0aGlzLl9zdGFydFBvcnRhbEF1dG9TaGFyZUhlbHBlcigpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzY3JlZW5zaG90UmVzdWx0ID0gYXdhaXQgdGhpcy5fcG9ydGFsUmVxdWVzdCh0aGlzLl9wb3J0YWwuc2NyZWVuc2hvdCwgJ1NjcmVlbnNob3QnLCAnJywgb3B0aW9ucyk7XG4gICAgICBjb25zdCBzb3VyY2VQYXRoID0gdGhpcy5fcmVzb2x2ZUZpbGVVcmlQYXRoKHNjcmVlbnNob3RSZXN1bHQ/LnVyaSk7XG4gICAgICBpZiAoIXNvdXJjZVBhdGggfHwgIWZzLmV4aXN0c1N5bmMoc291cmNlUGF0aCkpIHtcbiAgICAgICAgdGhpcy5fbG9nV2FybignV2F5bGFuZCBwb3J0YWwgc2NyZWVuc2hvdCByZXR1cm5lZCBubyByZWFkYWJsZSBVUkk7IGZhbGxpbmcgYmFjayB0byBDTEkgY2FwdHVyZSB0b29scy4nKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgZnMuY29weUZpbGVTeW5jKHNvdXJjZVBhdGgsIG91dHB1dFBhdGgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRoaXMuX2xvZ1dhcm4oYFdheWxhbmQgcG9ydGFsIHNjcmVlbnNob3QgZmFpbGVkICgke2Vycm9yLm1lc3NhZ2V9KTsgZmFsbGluZyBiYWNrIHRvIENMSSBjYXB0dXJlIHRvb2xzLmApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBhd2FpdCB0aGlzLl9zdG9wUG9ydGFsQXV0b1NoYXJlSGVscGVyKCk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgY193aW5zY3JlZW5zaG90ICh3aWQsIG5hbWUpIHtcbiAgICBjb25zdCBvdXRwdXROYW1lID0gYCR7bmFtZSB8fCAnYXBwaXVtZHJpdmVyJ30ucG5nYDtcbiAgICBjb25zdCBvdXRwdXRQYXRoID0gcGF0aC5qb2luKCcvdG1wLy5zdGRzcGEnLCBvdXRwdXROYW1lKTtcbiAgICBmcy5ta2RpclN5bmMoJy90bXAvLnN0ZHNwYScsIHtyZWN1cnNpdmU6IHRydWV9KTtcblxuICAgIGNvbnN0IHN0cmF0ZWdpZXMgPSBnZXRXYXlsYW5kU2NyZWVuc2hvdFN0cmF0ZWdpZXMoe1xuICAgICAgcG9ydGFsQXZhaWxhYmxlOiBCb29sZWFuKHRoaXMuX3BvcnRhbC5zY3JlZW5zaG90KSxcbiAgICAgIGhhc0dub21lU2NyZWVuc2hvdDogdGhpcy5faGFzR25vbWVTY3JlZW5zaG90LFxuICAgICAgaGFzR3JpbTogdGhpcy5faGFzR3JpbSxcbiAgICB9KTtcblxuICAgIGxldCBjYXB0dXJlT2sgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IHN0cmF0ZWd5IG9mIHN0cmF0ZWdpZXMpIHtcbiAgICAgIGlmIChzdHJhdGVneSA9PT0gJ3BvcnRhbCcpIHtcbiAgICAgICAgY2FwdHVyZU9rID0gYXdhaXQgdGhpcy5fY2FwdHVyZUJ5UG9ydGFsU2NyZWVuc2hvdChvdXRwdXRQYXRoKTtcbiAgICAgIH0gZWxzZSBpZiAoc3RyYXRlZ3kgPT09ICdnbm9tZS1zY3JlZW5zaG90Jykge1xuICAgICAgICBjYXB0dXJlT2sgPSBzYWZlU3Bhd24oJ2dub21lLXNjcmVlbnNob3QnLCBbJy1mJywgb3V0cHV0UGF0aF0pLm9rO1xuICAgICAgfSBlbHNlIGlmIChzdHJhdGVneSA9PT0gJ2dyaW0nKSB7XG4gICAgICAgIGNhcHR1cmVPayA9IHNhZmVTcGF3bignZ3JpbScsIFtvdXRwdXRQYXRoXSkub2s7XG4gICAgICB9XG4gICAgICBpZiAoY2FwdHVyZU9rKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghY2FwdHVyZU9rIHx8ICFmcy5leGlzdHNTeW5jKG91dHB1dFBhdGgpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgY29uc3QgcmVjdCA9IHRoaXMuYXBwX2dldFdpblJlY3Qod2lkKTtcbiAgICBpZiAocmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwKSB7XG4gICAgICBjb25zdCBsZWZ0ID0gTWF0aC5tYXgoMCwgcmVjdC54KTtcbiAgICAgIGNvbnN0IHRvcCA9IE1hdGgubWF4KDAsIHJlY3QueSk7XG4gICAgICBjb25zdCB0bXBQYXRoID0gYCR7b3V0cHV0UGF0aH0udG1wYDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHNoYXJwKG91dHB1dFBhdGgpXG4gICAgICAgICAgLmV4dHJhY3Qoe2xlZnQsIHRvcCwgd2lkdGg6IHJlY3Qud2lkdGgsIGhlaWdodDogcmVjdC5oZWlnaHR9KVxuICAgICAgICAgIC5wbmcoKVxuICAgICAgICAgIC50b0ZpbGUodG1wUGF0aCk7XG4gICAgICAgIGZzLnJlbmFtZVN5bmModG1wUGF0aCwgb3V0cHV0UGF0aCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmModG1wUGF0aCkpIHtcbiAgICAgICAgICBmcy51bmxpbmtTeW5jKHRtcFBhdGgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgV2F5bGFuZEFwaXM7XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBQUEsSUFBQUEsR0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsS0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsT0FBQSxHQUFBSCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsY0FBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksU0FBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssU0FBQSxHQUFBTixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU0sTUFBQSxHQUFBUCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU8sWUFBQSxHQUFBUixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVEsV0FBQSxHQUFBUixPQUFBO0FBQ0EsSUFBQVMsY0FBQSxHQUFBVCxPQUFBO0FBQ0EsSUFBQVUsdUJBQUEsR0FBQVYsT0FBQTtBQU1BLElBQUFXLHVCQUFBLEdBQUFYLE9BQUE7QUFDQSxJQUFBWSxtQkFBQSxHQUFBWixPQUFBO0FBTUEsTUFBTWEsV0FBVyxHQUFHLGdDQUFnQztBQUNwRCxNQUFNQyxXQUFXLEdBQUcsaUNBQWlDO0FBQ3JELE1BQU1DLGdCQUFnQixHQUFHLGlDQUFpQztBQUMxRCxNQUFNQyxvQkFBb0IsR0FBRyxnQ0FBZ0M7QUFDN0QsTUFBTUMsZUFBZSxHQUFHLHNDQUFzQztBQUM5RCxNQUFNQyxlQUFlLEdBQUcsbUNBQW1DO0FBQzNELE1BQU1DLGVBQWUsR0FBRyxtQ0FBbUM7QUFDM0QsTUFBTUMscUJBQXFCLEdBQUcsc0NBQXNDO0FBQ3BFLE1BQU1DLGtCQUFrQixHQUFHQyxNQUFNLENBQUNDLE1BQU0sQ0FBQyxDQUN2Qyx5QkFBeUIsRUFDekIsK0JBQStCLEVBQy9CQyxhQUFJLENBQUNDLElBQUksQ0FBQ0MsT0FBTyxDQUFDQyxHQUFHLENBQUNDLElBQUksSUFBSSxFQUFFLEVBQUUsMkJBQTJCLENBQUMsQ0FDL0QsQ0FBQztBQUVGLE1BQU1DLFlBQVksR0FBRyxHQUFHO0FBQ3hCLE1BQU1DLGFBQWEsR0FBRyxHQUFHO0FBQ3pCLE1BQU1DLGNBQWMsR0FBRyxHQUFHO0FBSzFCLE1BQU1DLDZCQUE2QixHQUFHLEtBQUs7QUFDM0MsTUFBTUMsK0JBQStCLEdBQUcsQ0FDdEMsZUFBZSxFQUNmLGlCQUFpQixFQUNqQixnQkFBZ0IsRUFDaEIsaUJBQWlCLEVBQ2pCLHFCQUFxQixDQUN0QjtBQUNELE1BQU1DLHdCQUF3QixHQUFHO0FBQ2pDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLENBQUM7QUFDRCxNQUFNQyx3QkFBd0IsR0FBRztBQUNqQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FB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
