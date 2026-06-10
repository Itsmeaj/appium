import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {spawn, spawnSync} from 'child_process';
import {Promise} from 'bluebird';
import dbus from 'dbus-next';
import sharp from 'sharp';
import nativeApis from '@stdspa/stdspalinux_temp/dist/privateapis';
import {readWaylandToken, writeWaylandToken, normalizeStorePath} from './token-store';
import {detectLinuxDistroInfo, evaluateWaylandPreflight, formatDistroLabel} from './linux-platform.js';
import {
  DEVICE_TYPE_KEYBOARD,
  DEVICE_TYPE_POINTER,
  ensureWaylandPointerPermission,
  parseWaylandGrantedDevices,
} from './wayland-permission-utils.js';
import {getWaylandScreenshotStrategies, getWaylandScreenshotFailureMessage} from './wayland-screenshot-utils.js';
import {
  extractWaylandWindowCandidates,
  materializeWaylandWindows,
  resolveWaylandScopedWindowXml,
} from './wayland-window-utils.js';

const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const DBUS_PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const PORTAL_REQUEST_IFACE = 'org.freedesktop.portal.Request';
const PORTAL_RD_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const PORTAL_SC_IFACE = 'org.freedesktop.portal.ScreenCast';
const PORTAL_SS_IFACE = 'org.freedesktop.portal.Screenshot';
const PORTAL_REGISTRY_IFACE = 'org.freedesktop.host.portal.Registry';
const DESKTOP_ENTRY_DIRS = Object.freeze([
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(process.env.HOME || '', '.local/share/applications'),
]);

const POINTER_LEFT = 272;
const POINTER_RIGHT = 273;
const POINTER_MIDDLE = 274;
// 15s initial timeout — the helper auto-restarts on timeout (exit code 2),
// so if GNOME takes longer to show the consent dialog it will be caught on
// the next cycle.  A shorter first cycle means we restart and re-poll sooner
// when the dialog appears in the 15-30s window (observed on RHEL 10).
const DEFAULT_AUTO_SHARE_TIMEOUT_MS = 15000;
const POINTER_PERMISSION_ERROR_TOKENS = [
  'notifypointer',
  'pointer methods',
  'pointer access',
  'without pointer',
  'not allowed to call',
];
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

// Module-level cache for the Wayland portal session.  Creating a portal
// session involves D-Bus round-trips and, on RHEL/GNOME, a consent dialog
// that must be approved by the auto-share helper.  By caching the session
// at module scope we can reuse it across successive Appium sessions in the
// same server process, eliminating ~40 s of overhead per test.
let _cachedPortalSession = null;

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc (value) {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hasCommand (command) {
  if (command === 'python3-pyatspi') {
    const res = spawnSync('python3', ['-c', 'import pyatspi'], {stdio: 'ignore'});
    return res.status === 0;
  }
  const res = spawnSync('which', [command], {stdio: 'ignore'});
  return res.status === 0;
}

function safeSpawn (command, args, opts = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    ...opts,
  });
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function parseKeyValueOutput (output) {
  const result = {};
  for (const rawLine of `${output ?? ''}`.split('\n')) {
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

function unbox (value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'signature') && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return unbox(value.value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => unbox(item));
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

function normalizeToken (value) {
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

function createSessionHandleCandidatesFromRequestPath (requestPath, sessionHandleToken) {
  const match = /^\/org\/freedesktop\/portal\/desktop\/request\/([^/]+)\/[^/]+$/.exec(`${requestPath ?? ''}`);
  if (!match) {
    return [];
  }
  const senderSegment = match[1];
  const requestToken = `${requestPath ?? ''}`.split('/').pop();
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

function coerceBoolean (value, defaultValue = false) {
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

function firstExecToken (execLine) {
  const text = `${execLine ?? ''}`.trim();
  if (!text) {
    return '';
  }
  const match = /^"([^"]+)"|'([^']+)'|(\S+)/.exec(text);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function desktopEntryIdForFile (filePath) {
  return path.basename(`${filePath ?? ''}`, '.desktop');
}

function findDesktopEntryIdsForApp (appName) {
  const appText = `${appName ?? ''}`.trim();
  if (!appText) {
    return [];
  }
  const appBaseName = path.basename(appText).toLowerCase();
  const appPath = path.isAbsolute(appText) ? appText : '';
  const matches = [];
  for (const dir of DESKTOP_ENTRY_DIRS) {
    if (!dir || !fs.existsSync(dir)) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.desktop')) {
        continue;
      }
      const entryPath = path.join(dir, entry);
      let content = '';
      try {
        content = fs.readFileSync(entryPath, 'utf8');
      } catch {
        continue;
      }
      const execCommands = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Exec='))
        .map((line) => firstExecToken(line.slice('Exec='.length)))
        .filter(Boolean);
      const isMatch = execCommands.some((command) => {
        const commandText = `${command ?? ''}`.trim();
        return commandText === appPath || path.basename(commandText).toLowerCase() === appBaseName;
      });
      if (isMatch) {
        matches.push(desktopEntryIdForFile(entryPath));
      }
    }
  }
  return Array.from(new Set(matches));
}

class WaylandApis {
  constructor ({appName, logger, waylandRestoreToken, waylandTokenStorePath, waylandAutoShare} = {}) {
    this.appName = appName;
    this._logger = logger;
    this._nativeApis = nativeApis;
    this._distroInfo = detectLinuxDistroInfo();
    this._tokenStorePath = normalizeStorePath(waylandTokenStorePath);
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
    // 30s TTL — the cache is explicitly invalidated by getWindowHandles(),
    // app_launch(), and app_kill() when fresh data is needed.  A short TTL
    // (e.g. 2s) caused expensive native AT-SPI desktop re-scans on every
    // findElement for dialog windows on RHEL/Wayland.
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
      screenshotVersion: 0,
    };

    this._hasWlCopy = hasCommand('wl-copy');
    this._hasWlPaste = hasCommand('wl-paste');
    this._hasGnomeScreenshot = hasCommand('gnome-screenshot');
    this._hasGrim = hasCommand('grim');

    // RHEL GNOME compositor needs small settling delays between pointer motion
    // and button events. Without these, clicks can land at the wrong coordinates
    // because the compositor hasn't finished processing the motion event.
    this._compositorSettleMs = this._distroInfo.isRhelLike ? 10 : (this._distroInfo.isUbuntu ? 5 : 0);
    this._buttonPressReleaseGapMs = this._distroInfo.isRhelLike ? 5 : (this._distroInfo.isUbuntu ? 2 : 0);
    this._doubleClickIntervalMs = this._distroInfo.isRhelLike ? 80 : (this._distroInfo.isUbuntu ? 70 : 60);
    this._keyTapInterDelayMs = 10;
  }

  _logInfo (msg) {
    if (this._logger?.info) {
      this._logger.info(msg);
    }
  }

  _logWarn (msg) {
    if (this._logger?.warn) {
      this._logger.warn(msg);
    }
  }

  _invalidateDesktopHierarchyCache () {
    this._desktopHierarchyCache = '';
    this._desktopHierarchyCacheAt = 0;
  }

  _invalidateWindowHierarchyXmlCache () {
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
  }

  _getDesktopHierarchy ({force = false} = {}) {
    const now = Date.now();
    if (
      !force
      && this._desktopHierarchyCache
      && (now - this._desktopHierarchyCacheAt) <= this._desktopHierarchyCacheTtlMs
    ) {
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

  _startPortalAutoShareHelper () {
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
      const proc = spawn('python3', ['-c', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      });
      this._portalAutoShareProc = proc;
      proc.stdout.on('data', (chunk) => {
        const msg = `${chunk ?? ''}`.trim();
        if (msg) {
          this._logInfo(`Wayland portal auto-share: ${msg}`);
        }
      });
      proc.stderr.on('data', (chunk) => {
        const msg = `${chunk ?? ''}`.trim();
        if (msg) {
          this._logWarn(`Wayland portal auto-share: ${msg}`);
        }
      });
      proc.on('error', (error) => {
        this._logWarn(`Wayland portal auto-share helper failed: ${error.message}`);
      });
      proc.on('exit', (code, signal) => {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        this._logInfo(`Wayland portal auto-share helper exited with ${status}`);
        if (this._portalAutoShareProc === proc) {
          this._portalAutoShareProc = null;
        }
        if (!signal && (code === 0 || code === 2) && !this._portalAutoShareStopped) {
          const reason = code === 0
            ? 'handled a portal prompt'
            : 'timed out before the portal session was ready';
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

  async _stopPortalAutoShareHelper () {
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
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        sleep(600),
      ]);
      if (proc.exitCode === null && !proc.signalCode) {
        proc.kill('SIGKILL');
      }
    } catch {
      // Ignore teardown errors
    }
  }

  async _runWithPortalAutoShare (fn) {
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

  _isPersistUnsupportedError (error) {
    const message = `${error?.message ?? ''}`.toLowerCase();
    return message.includes('cannot persist') || message.includes('sessions cannot persist');
  }

  _isPointerPermissionError (error) {
    const message = `${error?.message ?? ''}`.toLowerCase();
    return POINTER_PERMISSION_ERROR_TOKENS.some((token) => message.includes(token));
  }

  _canContinueWithoutPortalPointerGrant (grantInfo) {
    return grantInfo?.grantedDevices === 0;
  }

  _runA11yPointAction (x, y, mode = 'click') {
    const _x = Number(x);
    const _y = Number(y);
    if (!Number.isFinite(_x) || !Number.isFinite(_y)) {
      return false;
    }
    const result = safeSpawn(
      'python3',
      ['-c', A11Y_POINT_ACTION_SCRIPT, `${_x}`, `${_y}`, mode],
      {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      }
    );
    if (result.ok) {
      const output = `${result.stdout || ''}`.trim();
      if (output) {
        this._logInfo(`Wayland a11y input fallback: ${output}`);
      }
      return true;
    }
    const details = [`${result.stdout || ''}`.trim(), `${result.stderr || ''}`.trim()]
      .filter(Boolean)
      .join(' | ');
    if (details) {
      this._logWarn(`Wayland a11y input fallback failed: ${details}`);
    }
    return false;
  }

  _clickViaA11yPointFallback (x, y, mode = 'click') {
    const _x = Number(x);
    const _y = Number(y);
    if (!Number.isFinite(_x) || !Number.isFinite(_y)) {
      return false;
    }
    const points = [
      [_x, _y],
      [_x - 3, _y],
      [_x + 3, _y],
      [_x, _y - 3],
      [_x, _y + 3],
    ];
    for (const [px, py] of points) {
      if (this._runA11yPointAction(px, py, mode)) {
        return true;
      }
    }
    return false;
  }

  _getActiveUserSessionState () {
    const uid = `${process.getuid?.() ?? ''}`;
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
        active,
      });
    }
    if (candidates.length === 0) {
      return null;
    }

    const activeCandidates = candidates.filter((item) => item.active === 'yes');
    const preferred = activeCandidates.find((item) => item.seat !== '-')
      || activeCandidates[0]
      || candidates.find((item) => item.seat !== '-')
      || candidates[0];
    if (!preferred?.id) {
      return null;
    }

    const showRes = safeSpawn('loginctl', [
      'show-session',
      preferred.id,
      '-p', 'LockedHint',
      '-p', 'Active',
      '-p', 'State',
      '-p', 'Type',
      '-p', 'Remote',
      '-p', 'Name',
    ]);
    if (!showRes.ok) {
      return {
        ...preferred,
        details: {},
        locked: null,
      };
    }
    const details = parseKeyValueOutput(showRes.stdout);
    const lockedHint = `${details.LockedHint ?? ''}`.toLowerCase();
    return {
      ...preferred,
      details,
      locked: lockedHint === 'yes',
    };
  }

  _mustUseWaylandSession () {
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
    if (sessionType !== 'wayland' && !process.env.WAYLAND_DISPLAY) {
      throw new Error('Wayland backend requested, but this process is not in a Wayland session. Set appium:linuxBackend to x11 or run under Wayland.');
    }
  }

  _runPreflightChecks () {
    const result = evaluateWaylandPreflight({
      hasCommand,
      autoShareEnabled: this._waylandAutoShare,
      distroInfo: this._distroInfo,
    });
    for (const warning of result.warnings) {
      this._logWarn(warning);
    }
    if (result.errors.length > 0) {
      const distro = formatDistroLabel(this._distroInfo);
      throw new Error(`Wayland preflight failed on ${distro}:\n- ${result.errors.join('\n- ')}`);
    }

    const sessionState = this._getActiveUserSessionState();
    if (sessionState?.locked === true) {
      const sessionId = sessionState.id || 'unknown';
      throw new Error(
        `Wayland desktop session '${sessionId}' is locked. ` +
        `Unlock the GUI session (for example: loginctl unlock-session ${sessionId}) and retry.`
      );
    }
  }

  _nextToken (prefix) {
    const random = crypto.randomBytes(8).toString('hex');
    return `${prefix}_${Date.now()}_${random}`;
  }

  async _getPortalInterfaceVersion (desktopObj, ifaceName) {
    try {
      const props = desktopObj.getInterface(DBUS_PROPS_IFACE);
      const result = await props.Get(ifaceName, 'version');
      const version = Number.parseInt(`${unbox(result)}`, 10);
      if (Number.isFinite(version) && version > 0) {
        return version;
      }
    } catch {
      // fall through
    }
    return 0;
  }

  async _registerPortalAppId () {
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
        const message = `${error?.message ?? ''}`;
        if (message.toLowerCase().includes('connection already associated')) {
          this._portal.registeredAppId = appId;
          this._logInfo(`Wayland portal host app id was already registered (${appId})`);
          return;
        }
        this._logWarn(`Wayland portal app registration failed for '${appId}': ${message}`);
      }
    }
  }

  async _awaitPortalResponse (requestPath) {
    const obj = await this._portal.bus.getProxyObject(PORTAL_DEST, requestPath);
    const iface = obj.getInterface(PORTAL_REQUEST_IFACE);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        iface.removeListener('Response', onResponse);
        reject(new Error(`Portal request timed out for ${requestPath}`));
      }, 180000);

      const onResponse = (responseCode, results) => {
        clearTimeout(timeout);
        iface.removeListener('Response', onResponse);
        resolve({
          responseCode,
          results: unbox(results),
        });
      };

      iface.on('Response', onResponse);
    });
  }

  async _portalRequest (iface, methodName, ...args) {
    const requestPath = await iface[methodName](...args);
    let response = null;
    try {
      response = await this._awaitPortalResponse(requestPath);
    } catch (error) {
      const message = `${error?.message ?? ''}`;
      if (message.includes('interface not found in proxy object: org.freedesktop.portal.Request')) {
        this._logWarn(`Portal ${methodName} did not expose Request interface at '${requestPath}'. Falling back to immediate-result mode.`);
        if (methodName === 'CreateSession' && `${requestPath}`.includes('/session/')) {
          return {session_handle: `${requestPath}`};
        }
        if (methodName === 'CreateSession') {
          const createOptions = args[0] || {};
          const sessionHandleToken = unbox(createOptions?.session_handle_token);
          const synthesizedHandles = createSessionHandleCandidatesFromRequestPath(requestPath, sessionHandleToken);
          if (synthesizedHandles.length > 0) {
            const synthesizedHandle = synthesizedHandles[0];
            const altHandles = synthesizedHandles.slice(1);
            this._logWarn(
              `Portal CreateSession returned request path without Request interface. ` +
              `Synthesizing session handle '${synthesizedHandle}'` +
              (altHandles.length > 0 ? ` (alternates: ${altHandles.join(', ')})` : '') +
              '.'
            );
            return {session_handle: synthesizedHandle};
          }
        }
        return {};
      }
      throw error;
    }
    const {responseCode, results} = response;
    if (responseCode !== 0) {
      const unboxedResults = results || {};
      const sessionState = methodName === 'CreateSession' ? this._getActiveUserSessionState() : null;
      if (methodName === 'CreateSession' && sessionState?.locked === true) {
        throw new Error(
          `Portal CreateSession failed with response code ${responseCode}: ` +
          `desktop session '${sessionState.id || 'unknown'}' is locked`
        );
      }
      const hasResultKeys = Object.keys(unboxedResults).length > 0;
      const details = hasResultKeys ? ` (details: ${JSON.stringify(unboxedResults)})` : '';
      throw new Error(`Portal ${methodName} failed with response code ${responseCode}${details}`);
    }
    return results || {};
  }

  async _openPortalSession () {
    const {Variant} = dbus;
    this._portal.bus = dbus.sessionBus();
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
      this._logInfo(
        `Wayland portal interface versions: RemoteDesktop=${this._portal.remoteDesktopVersion || 'unknown'}, ` +
        `ScreenCast=${this._portal.screenCastVersion || 'unknown'}, ` +
        `Screenshot=${this._portal.screenshotVersion || 'unknown'}`
      );
    }

    const createOptions = {
      handle_token: new Variant('s', this._nextToken('rd_create')),
      session_handle_token: new Variant('s', this._nextToken('rd_session')),
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
      this._logWarn(
        `RemoteDesktop portal v${this._portal.remoteDesktopVersion || 'unknown'} does not support persist_mode/restore_token. ` +
        'Wayland share consent cannot be fully bypassed on this desktop backend.'
      );
    }

    const sourceAttempts = [];
    if (this._restoreToken && supportsScreenCastPersist) {
      sourceAttempts.push({
        usePersist: true,
        useRestoreToken: true,
      });
    } else if (this._restoreToken && !supportsScreenCastPersist) {
      this._logWarn(
        `ScreenCast portal v${this._portal.screenCastVersion || 'unknown'} does not support restore tokens. ` +
        'Ignoring provided Wayland restore token.'
      );
    }
    if (supportsScreenCastPersist) {
      sourceAttempts.push({
        usePersist: true,
        useRestoreToken: false,
      });
    }
    sourceAttempts.push({
      usePersist: false,
      useRestoreToken: false,
    });

    let selectedSources = false;
    let selectSourcesError = null;
    let persistActuallySupported = true;
    for (const attempt of sourceAttempts) {
      // Once persist_mode is known to be unsupported, skip remaining persist attempts.
      if (attempt.usePersist && !persistActuallySupported) {
        continue;
      }
      const sourceOptions = {
        handle_token: new Variant('s', this._nextToken('sc_sources')),
        types: new Variant('u', 1),
        multiple: new Variant('b', false),
        cursor_mode: new Variant('u', 2),
      };
      if (attempt.usePersist) {
        sourceOptions.persist_mode = new Variant('u', 2);
      }
      if (attempt.useRestoreToken && this._restoreToken) {
        sourceOptions.restore_token = new Variant('s', this._restoreToken);
      }
      try {
        await this._runWithPortalAutoShare(() => this._portalRequest(
          this._portal.screenCast,
          'SelectSources',
          sessionHandle,
          sourceOptions
        ));
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
    // Skip persist_mode for SelectDevices when SelectSources already proved it unsupported.
    const devicePersistModes = (supportsRemoteDesktopPersist && persistActuallySupported) ? [true, false] : [false];
    for (const usePersist of devicePersistModes) {
      const deviceOptions = {
        handle_token: new Variant('s', this._nextToken('rd_devices')),
        types: new Variant('u', DEVICE_TYPE_KEYBOARD | DEVICE_TYPE_POINTER),
      };
      if (usePersist) {
        deviceOptions.persist_mode = new Variant('u', 2);
      }
      try {
        await this._runWithPortalAutoShare(() => this._portalRequest(
          this._portal.remoteDesktop,
          'SelectDevices',
          sessionHandle,
          deviceOptions
        ));
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
      handle_token: new Variant('s', this._nextToken('rd_start')),
    };

    let startResults = await this._runWithPortalAutoShare(() => this._portalRequest(
      this._portal.remoteDesktop,
      'Start',
      sessionHandle,
      '',
      startOptions
    ));
    startResults = startResults || {};

    const grantInfo = parseWaylandGrantedDevices(startResults.devices);
    if (grantInfo.grantedDevices !== null) {
      this._portal.grantedDevices = grantInfo.grantedDevices;
      this._portal.pointerAllowed = grantInfo.pointerAllowed;
      this._portal.keyboardAllowed = grantInfo.keyboardAllowed;
      this._logInfo(
        `Wayland portal granted devices=${grantInfo.grantedDevices} ` +
        `(keyboard=${this._portal.keyboardAllowed}, pointer=${this._portal.pointerAllowed}, ` +
        `touch=${grantInfo.touchAllowed})`
      );
    } else {
      this._portal.grantedDevices = null;
      this._portal.pointerAllowed = null;
      this._portal.keyboardAllowed = null;
      this._logWarn('Wayland portal Start did not report granted devices; pointer entitlement is unknown.');
    }

    try {
      ensureWaylandPointerPermission(grantInfo);
    } catch (error) {
      if (!this._canContinueWithoutPortalPointerGrant(grantInfo)) {
        throw error;
      }
      this._logWarn(
        `${error.message} Continuing with AT-SPI pointer fallback; ` +
        'portal-only pointer, keyboard, swipe, and scroll actions may be unavailable.'
      );
    }

    const streams = Array.isArray(startResults.streams) ? startResults.streams : [];
    if (streams.length > 0) {
      const firstStream = streams[0];
      let rawNodeId = null;
      let rawMeta = null;

      if (Array.isArray(firstStream) && firstStream.length > 0) {
        // Standard dbus-next format: [nodeId, {size: [w, h], ...}]
        rawNodeId = firstStream[0];
        rawMeta = firstStream[1];
      } else if (firstStream !== null && typeof firstStream === 'object') {
        // Object-keyed struct format seen on RHEL 10 with some dbus-next versions:
        // { '0': nodeId, '1': { size: [w, h] } }
        rawNodeId = firstStream['0'] ?? firstStream[0];
        rawMeta = firstStream['1'] ?? firstStream[1];
      }

      const parsedNodeId = Number.parseInt(`${rawNodeId}`, 10);
      if (Number.isFinite(parsedNodeId)) {
        this._portal.streamNodeId = parsedNodeId;
        const size = rawMeta?.size;
        if (Array.isArray(size) && size.length === 2) {
          this._portal.logicalSize = {
            width: Number.parseInt(`${size[0]}`, 10),
            height: Number.parseInt(`${size[1]}`, 10),
          };
        }
      } else {
        this._logWarn(
          `Wayland portal Start returned ${streams.length} stream(s) but stream node id could not be parsed ` +
          `(firstStream type=${Array.isArray(firstStream) ? 'array' : typeof firstStream}, ` +
          `rawNodeId=${JSON.stringify(rawNodeId)}). ` +
          'Pointer absolute events will fall back to AT-SPI.'
        );
      }
    }

    const rotatedToken = normalizeToken(startResults.restore_token || startResults.restore_data || null);
    if (rotatedToken) {
      this._restoreToken = rotatedToken;
      writeWaylandToken(this._tokenStorePath, this.appName, rotatedToken);
      this._logInfo(`Wayland restore token updated at ${this._tokenStorePath}`);
    }

    this._logInfo('Wayland RemoteDesktop portal session is ready');
  }

  async initialize () {
    this._logInfo(`Wayland backend distro context: ${formatDistroLabel(this._distroInfo)}`);
    this._runPreflightChecks();
    this._mustUseWaylandSession();
    fs.mkdirSync('/tmp/.stdspa', {recursive: true});
    if (this._waylandAutoShare) {
      const timeoutSeconds = Math.max(1, Math.ceil(this._waylandAutoShareTimeoutMs / 1000));
      this._logInfo(`Wayland portal auto-share is enabled (timeout ${timeoutSeconds}s)`);
    } else {
      this._logInfo('Wayland portal auto-share is disabled');
    }

    if (this._restoreTokenFromCaps) {
      this._restoreToken = this._restoreTokenFromCaps;
    } else {
      const {token} = readWaylandToken(this._tokenStorePath, this.appName);
      this._restoreToken = token;
    }

    // Reuse the cached portal session from a previous Appium session in
    // the same server process.  This avoids re-opening the D-Bus portal
    // and re-running the auto-share consent flow on every test.
    if (_cachedPortalSession && _cachedPortalSession.bus && _cachedPortalSession.sessionHandle) {
      try {
        // Quick health-check: read a portal property to confirm the bus is alive.
        const desktopObj = await _cachedPortalSession.bus.getProxyObject(PORTAL_DEST, PORTAL_PATH);
        desktopObj.getInterface(PORTAL_RD_IFACE);
        // Session is still valid — adopt it.
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

    // Cache the portal state for future sessions.
    _cachedPortalSession = {...this._portal};

    this._refreshWindowCache();

    const screenshotFailure = getWaylandScreenshotFailureMessage({
      portalAvailable: Boolean(this._portal.screenshot),
      hasGnomeScreenshot: this._hasGnomeScreenshot,
      hasGrim: this._hasGrim,
    });
    if (screenshotFailure) {
      this._logWarn(screenshotFailure);
    }
    if (!this._hasWlCopy || !this._hasWlPaste) {
      this._logWarn('wl-copy / wl-paste not found. Clipboard commands will fallback to stdspa native APIs.');
    }
  }

  async dispose () {
    await this._stopPortalAutoShareHelper();
    // Keep the portal session alive in the module cache so the next Appium
    // session in the same process can reuse it.  The portal D-Bus connection
    // and session handle remain valid across Appium driver sessions.
    // Only clear instance-level references so this WaylandApis object can
    // be garbage-collected.
    this._windowList = [];
    this._windowMap.clear();
    this._desktopHierarchyCache = '';
    this._desktopHierarchyCacheAt = 0;
  }

  _refreshWindowCache (desktopXml = null) {
    let pids = this._nativeApis.app_running(this.appName) || [];
    // Fallback with short-lived cache to avoid spawning pgrep on every call
    if (!pids || pids.length === 0) {
      const now = Date.now();
      if (this._pgrepPids && (now - this._pgrepPidsAt) < 3000) {
        pids = this._pgrepPids;
      } else {
        try {
          const baseName = (this.appName || '').split('/').pop();
          if (baseName) {
            const res = spawnSync('pgrep', ['-f', baseName], {encoding: 'utf8', timeout: 3000});
            if (res.status === 0 && res.stdout) {
              pids = res.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
              this._pgrepPids = pids;
              this._pgrepPidsAt = now;
            }
          }
        } catch { /* ignore */ }
      }
    }
    if (!pids || pids.length === 0) {
      this._windowList = [];
      this._windowMap.clear();
      return [];
    }

    let desktop = desktopXml;
    if (`${desktop ?? ''}`.trim()) {
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

    const previousWidByIdentity = new Map(
      (this._windowList || []).map((window) => [window.identityKey, window.wid])
    );
    const candidates = extractWaylandWindowCandidates(desktop, pids);
    const {windows} = materializeWaylandWindows(candidates, previousWidByIdentity);

    this._windowList = windows;
    this._windowMap.clear();
    for (const w of windows) {
      this._windowMap.set(w.wid, w);
    }

    return windows;
  }

  app_getWindowHierachy () {
    // Cache the built XML for 2 seconds to avoid redundant _refreshWindowCache
    // calls during rapid getWindowHandle/getWindowHandles polling.
    const now = Date.now();
    if (this._windowHierarchyXmlCache && (now - this._windowHierarchyXmlCacheAt) <= 2000) {
      return this._windowHierarchyXmlCache;
    }
    const windows = this._refreshWindowCache();
    const xml = windows.map((w) => {
      const rect = `[${w.rect.x},${w.rect.y},${w.rect.width},${w.rect.height}]`;
      return (
        `<window pid="${w.pid}" wid="${w.wid}" InputOutput="${w.inputOutput}" ` +
        `name="${esc(w.name)}" class="${esc(w.className)}" rect="${rect}" ` +
        `states="${esc(w.states)}" tag="${esc(w.nodeTag)}" ` +
        `window-type="${esc(w.windowType)}" identity="${esc(w.identityKey)}"/>`
      );
    }).join('');
    const result = `<windows>${xml}</windows>`;
    this._windowHierarchyXmlCache = result;
    this._windowHierarchyXmlCacheAt = now;
    return result;
  }

  app_getWinRect (wid) {
    const parsedWid = Number.parseInt(`${wid}`, 10);
    let win = this._windowMap.get(parsedWid);
    if (!win) {
      this._refreshWindowCache();
      win = this._windowMap.get(parsedWid);
    }
    if (!win) {
      return {x: 0, y: 0, width: 0, height: 0};
    }
    return {
      x: win.rect.x,
      y: win.rect.y,
      width: win.rect.width,
      height: win.rect.height,
    };
  }

  app_running (appPath) {
    return this._nativeApis.app_running(appPath);
  }

  app_launch (appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._nativeApis.app_launch(appPath);
  }

  app_kill (appPath) {
    this._invalidateDesktopHierarchyCache();
    this._windowHierarchyXmlCache = null;
    this._windowHierarchyXmlCacheAt = 0;
    return this._nativeApis.app_kill(appPath);
  }

  a11y_clear_cache () {
    // Only clear the native AT-SPI cache.  Neither the JS desktop hierarchy
    // cache nor the window hierarchy XML cache is invalidated here.
    // The XML cache holds window-level metadata (pid/wid/name) which does
    // not change between findElement calls — it is explicitly invalidated
    // by getWindowHandles(), app_launch(), and app_kill().
    // Clearing it here forced _validateOrUpdateWinInfo to rebuild the
    // window list from the desktop hierarchy on every findElement, which
    // on RHEL Wayland triggered expensive 2-8s native AT-SPI desktop scans
    // whenever the desktop cache TTL had also expired.
    return this._nativeApis.a11y_clear_cache();
  }

  a11y_getWindowUiHierachy (windowName, pid) {
    return this._nativeApis.a11y_getWindowUiHierachy(windowName, pid);
  }

  a11y_getWindowUiHierachyByHandle (wid, pid, windowName) {
    const parsedWid = Number.parseInt(`${wid}`, 10);
    let targetWindow = this._windowMap.get(parsedWid);

    const desktop = this._getDesktopHierarchy();
    if (!desktop) {
      throw new Error(
        `Wayland scoped window tree could not be resolved for wid=${wid}, name=${windowName}, pid=${pid}: desktop hierarchy is unavailable`
      );
    }

    // Only rebuild the window list if the target window is not already known.
    // Skipping the redundant _refreshWindowCache avoids re-parsing the desktop
    // XML (DOM + XPath over all nodes) on every findElement call.
    if (!targetWindow) {
      this._refreshWindowCache(desktop);
      targetWindow = this._windowMap.get(parsedWid);
    }
    if (!targetWindow) {
      throw new Error(
        `Wayland scoped window tree could not be resolved for wid=${wid}, name=${windowName}, pid=${pid}: window handle is no longer present`
      );
    }

    const pids = this._nativeApis.app_running(this.appName) || [];
    const resolved = resolveWaylandScopedWindowXml(desktop, pids, targetWindow, {allowTransientOverlay: true});
    if (resolved.xml) {
      return resolved.xml;
    }

    const reason = resolved.reason === 'ambiguous'
      ? 'multiple matching window subtrees were found'
      : 'no matching window subtree was found';
    throw new Error(
      `Wayland scoped window tree could not be resolved for wid=${targetWindow.wid}, name=${targetWindow.name || windowName}, pid=${targetWindow.pid || pid}: ${reason}`
    );
  }

  a11y_getDesktopUiHierachy () {
    return this._getDesktopHierarchy();
  }

  a11y_checkWindowExists (windowName, pid) {
    try {
      if (this._nativeApis.a11y_checkWindowExists(windowName, pid)) {
        return true;
      }
    } catch {
      // fall through
    }

    this._refreshWindowCache();
    const target = `${windowName ?? ''}`.trim();
    return this._windowList.some((w) => {
      if (w.pid !== Number.parseInt(`${pid}`, 10)) {
        return false;
      }
      if (w.name === target) {
        return true;
      }
      const classes = `${w.className ?? ''}`.split(/\s+/).filter(Boolean);
      return classes.includes(target);
    });
  }

  c_getMainDisplaySize () {
    if (this._portal.logicalSize?.width > 0 && this._portal.logicalSize?.height > 0) {
      return this._portal.logicalSize;
    }

    try {
      const nativeSize = this._nativeApis.c_getMainDisplaySize();
      if (nativeSize?.width > 0 && nativeSize?.height > 0) {
        return nativeSize;
      }
    } catch {
      // fall through
    }

    this._refreshWindowCache();
    let width = 0;
    let height = 0;
    for (const w of this._windowList) {
      width = Math.max(width, w.rect.x + w.rect.width);
      height = Math.max(height, w.rect.y + w.rect.height);
    }
    return {width, height};
  }

  _ensurePortalReadyForPointer () {
    if (!this._portal.remoteDesktop || !this._portal.sessionHandle) {
      throw new Error('Wayland portal session is not ready for pointer events');
    }
    if (!Number.isFinite(this._portal.streamNodeId)) {
      throw new Error('Wayland portal did not provide a stream node id. Pointer absolute events are unavailable.');
    }
  }

  _isPortalReadyForPointer () {
    return Boolean(
      this._portal.remoteDesktop &&
      this._portal.sessionHandle &&
      Number.isFinite(this._portal.streamNodeId)
    );
  }

  _buttonCode (button) {
    if (button === 3) {
      return POINTER_RIGHT;
    }
    if (button === 2) {
      return POINTER_MIDDLE;
    }
    return POINTER_LEFT;
  }

  async mouse_move (x, y) {
    if (this._portal.pointerAllowed === false) {
      throw new Error('Wayland portal session has no POINTER permission. Re-run and grant remote control access.');
    }
    this._ensurePortalReadyForPointer();
    try {
      await this._portal.remoteDesktop.NotifyPointerMotionAbsolute(
        this._portal.sessionHandle,
        {},
        this._portal.streamNodeId,
        Number(x),
        Number(y)
      );
    } catch (error) {
      if (this._isPointerPermissionError(error)) {
        this._portal.pointerAllowed = false;
        throw new Error(
          'Wayland portal denied pointer motion events. ' +
          'Re-run and ensure remote control/pointer access is granted in the share dialog.'
        );
      }
      throw error;
    }
  }

  async mouse_click (x, y, button) {
    const buttonCode = this._buttonCode(button);

    // Fast path: portal is fully ready (has streamNodeId). Used on Ubuntu and RHEL when
    // stream parsing succeeds.
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
          throw new Error(
            'Wayland portal denied pointer button events. ' +
            'Re-run and ensure remote control/pointer access is granted in the share dialog.'
          );
        }
        // Non-permission portal error: fall through to AT-SPI fallback.
        this._logWarn(`Wayland portal click failed (${error.message}); trying AT-SPI fallback`);
      }
    }

    // AT-SPI fallback: valid for primary button only (AT-SPI 'click' is left-button semantics).
    if ((button === 1 || button === undefined) && this._clickViaA11yPointFallback(x, y, 'click')) {
      this._logInfo(`Wayland click at (${x}, ${y}) succeeded via AT-SPI fallback`);
      return;
    }

    // Surface a clear error if nothing worked.
    this._ensurePortalReadyForPointer();
  }

  async mouse_doubleClick (x, y, button) {
    // When portal stream is unavailable, use AT-SPI native double-click (single atomic action,
    // more reliable than two separate portal clicks with a missing stream node id).
    if (!this._isPortalReadyForPointer() || this._portal.pointerAllowed === false) {
      if ((button === 1 || button === undefined) && this._clickViaA11yPointFallback(x, y, 'double')) {
        return;
      }
    }
    // Standard path: two portal clicks (unchanged behavior for Ubuntu).
    await this.mouse_click(x, y, button);
    await sleep(this._doubleClickIntervalMs);
    await this.mouse_click(x, y, button);
  }

  async mouse_swipe (sx, sy, ex, ey) {
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
        const x = sx + ((ex - sx) * i) / steps;
        const y = sy + ((ey - sy) * i) / steps;
        await this.mouse_move(x, y);
        await sleep(8);
      }
      await this._portal.remoteDesktop.NotifyPointerButton(this._portal.sessionHandle, {}, POINTER_LEFT, 0);
    } catch (error) {
      if (this._isPointerPermissionError(error)) {
        this._portal.pointerAllowed = false;
        throw new Error(
          'Wayland portal denied pointer swipe events. ' +
          'Re-run and ensure remote control/pointer access is granted in the share dialog.'
        );
      }
      throw error;
    }
  }

  async mouse_scroll_x_y (x, y) {
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
        await this._portal.remoteDesktop.NotifyPointerAxisDiscrete(
          this._portal.sessionHandle,
          {},
          axis,
          direction
        );
      }
    };

    if (horizontalSteps !== 0) {
      try {
        await applyDiscrete(1, horizontalSteps);
      } catch (error) {
        if (this._isPointerPermissionError(error)) {
          this._portal.pointerAllowed = false;
          throw new Error(
            'Wayland portal denied pointer scroll events. ' +
            'Re-run and ensure remote control/pointer access is granted in the share dialog.'
          );
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
          throw new Error(
            'Wayland portal denied pointer scroll events. ' +
            'Re-run and ensure remote control/pointer access is granted in the share dialog.'
          );
        }
        throw error;
      }
    }
  }

  _charToEvdevKeySpec (char) {
    const raw = `${char ?? ''}`;
    if (!raw) {
      return null;
    }
    const first = raw[0];
    const lower = first.toLowerCase();
    const baseMap = {
      a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23,
      j: 36, k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19,
      s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
      1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
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
      '`': 41,
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
      '~': 41,
    };

    if (Object.prototype.hasOwnProperty.call(shiftedMap, first)) {
      return {
        evdev: shiftedMap[first],
        shift: true,
      };
    }

    if (Object.prototype.hasOwnProperty.call(baseMap, lower)) {
      return {
        evdev: baseMap[lower],
        shift: first !== lower,
      };
    }

    return null;
  }

  _charToEvdevKeycode (char) {
    return this._charToEvdevKeySpec(char)?.evdev ?? null;
  }

  _keysymToEvdev (keysym) {
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
      32: 57,
    };
    return map[keysym] ?? null;
  }

  _modsFromFlags (flags) {
    const modCodes = [];
    const f = Number.parseInt(`${flags}`, 10) || 0;
    if (f & 1) {
      modCodes.push(42); // shift
    }
    if (f & 4) {
      modCodes.push(29); // ctrl
    }
    if (f & 8) {
      modCodes.push(56); // alt
    }
    if (f & 64) {
      modCodes.push(125); // meta
    }
    return modCodes;
  }

  async _notifyKeycode (keycode, state) {
    if (this._portal.keyboardAllowed === false) {
      throw new Error('Wayland portal session has no KEYBOARD permission. Re-run and grant remote control access.');
    }
    if (!this._portal.remoteDesktop || !this._portal.sessionHandle) {
      throw new Error('Wayland portal session is not ready for keyboard events');
    }
    await this._portal.remoteDesktop.NotifyKeyboardKeycode(
      this._portal.sessionHandle,
      {},
      Number(keycode),
      Number(state)
    );
  }

  async _tapEvdevWithMods (evdevCode, mods = []) {
    for (const mod of mods) {
      await this._notifyKeycode(mod, 1);
    }
    await this._notifyKeycode(evdevCode, 1);
    await this._notifyKeycode(evdevCode, 0);
    for (let i = mods.length - 1; i >= 0; i--) {
      await this._notifyKeycode(mods[i], 0);
    }
  }

  async keyboard_tapKeyCode (keycode, flags) {
    const evdev = this._keysymToEvdev(Number.parseInt(`${keycode}`, 10));
    if (!evdev) {
      throw new Error(`Unsupported keycode for Wayland backend: ${keycode}`);
    }
    await this._tapEvdevWithMods(evdev, this._modsFromFlags(flags));
  }

  async keyboard_toggleKeyCode (keycode, down, flags) {
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

  async keyboard_tapKey (c, flags) {
    const raw = `${c ?? ''}`;
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

  async keyboard_toggleKey (c, down, flags) {
    const raw = `${c ?? ''}`;
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

  keyboard_copy (str) {
    if (this._hasWlCopy) {
      const result = safeSpawn('wl-copy', [], {input: `${str ?? ''}`});
      if (result.ok) {
        return;
      }
    }
    this._nativeApis.keyboard_copy(str);
  }

  keyboard_getClipboardContent () {
    if (this._hasWlPaste) {
      const result = safeSpawn('wl-paste', ['-n']);
      if (result.ok) {
        return result.stdout;
      }
    }
    return this._nativeApis.keyboard_getClipboardContent();
  }

  _canTypeStringDirectly (str) {
    return Array.from(`${str ?? ''}`).every((char) => {
      if (!`${char ?? ''}`) {
        return true;
      }
      return Boolean(this._charToEvdevKeySpec(char));
    });
  }

  async keyboard_typeStringCopyPaste (str) {
    const text = `${str ?? ''}`;
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
    await sleep(this._distroInfo.isRhelLike ? 120 : (this._distroInfo.isUbuntu ? 100 : 80));
    await this.keyboard_tapKey('v', 4);
  }

  _resolveFileUriPath (uri) {
    const raw = `${uri ?? ''}`.trim();
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

  async _captureByPortalScreenshot (outputPath) {
    if (!this._portal.screenshot) {
      return false;
    }
    const {Variant} = dbus;
    const options = {
      handle_token: new Variant('s', this._nextToken('sshot')),
      interactive: new Variant('b', false),
      modal: new Variant('b', false),
    };

    this._startPortalAutoShareHelper();
    try {
      const screenshotResult = await this._portalRequest(this._portal.screenshot, 'Screenshot', '', options);
      const sourcePath = this._resolveFileUriPath(screenshotResult?.uri);
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        this._logWarn('Wayland portal screenshot returned no readable URI; falling back to CLI capture tools.');
        return false;
      }
      fs.copyFileSync(sourcePath, outputPath);
      return true;
    } catch (error) {
      this._logWarn(`Wayland portal screenshot failed (${error.message}); falling back to CLI capture tools.`);
      return false;
    } finally {
      await this._stopPortalAutoShareHelper();
    }
  }

  async c_winscreenshot (wid, name) {
    const outputName = `${name || 'appiumdriver'}.png`;
    const outputPath = path.join('/tmp/.stdspa', outputName);
    fs.mkdirSync('/tmp/.stdspa', {recursive: true});

    const strategies = getWaylandScreenshotStrategies({
      portalAvailable: Boolean(this._portal.screenshot),
      hasGnomeScreenshot: this._hasGnomeScreenshot,
      hasGrim: this._hasGrim,
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

    if (!captureOk || !fs.existsSync(outputPath)) {
      return false;
    }

    const rect = this.app_getWinRect(wid);
    if (rect.width > 0 && rect.height > 0) {
      const left = Math.max(0, rect.x);
      const top = Math.max(0, rect.y);
      const tmpPath = `${outputPath}.tmp`;
      try {
        await sharp(outputPath)
          .extract({left, top, width: rect.width, height: rect.height})
          .png()
          .toFile(tmpPath);
        fs.renameSync(tmpPath, outputPath);
      } catch {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      }
    }

    return true;
  }
}

export default WaylandApis;
