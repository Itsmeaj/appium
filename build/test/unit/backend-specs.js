"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
require("source-map-support/register");
var _chai = _interopRequireDefault(require("chai"));
var _fs = _interopRequireDefault(require("fs"));
var _os = _interopRequireDefault(require("os"));
var _path = _interopRequireDefault(require("path"));
var _index = require("../../lib/backends/index.js");
var _tokenStore = require("../../lib/backends/token-store.js");
var _linuxPlatform = require("../../lib/backends/linux-platform.js");
var _waylandPermissionUtils = require("../../lib/backends/wayland-permission-utils.js");
var _waylandScreenshotUtils = require("../../lib/backends/wayland-screenshot-utils.js");
var _waylandApis = _interopRequireDefault(require("../../lib/backends/wayland-apis.js"));
var _find = _interopRequireDefault(require("../../lib/commands/find.js"));
var _window = _interopRequireDefault(require("../../lib/commands/window.js"));
var _waylandWindowUtils = require("../../lib/backends/wayland-window-utils.js");
const should = _chai.default.should();
function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
  }
}
describe('Linux backend selection', function () {
  it('should honor explicit linuxBackend capability', function () {
    (0, _index.resolveLinuxBackend)({
      linuxBackend: 'x11'
    }).should.eql('x11');
    (0, _index.resolveLinuxBackend)({
      linuxBackend: 'wayland'
    }).should.eql('wayland');
  });
  it('should auto-select wayland when XDG session says wayland', function () {
    withEnv('XDG_SESSION_TYPE', 'wayland', () => {
      (0, _index.resolveLinuxBackend)({
        linuxBackend: 'auto'
      }).should.eql('wayland');
    });
  });
  it('should auto-select x11 when wayland env is absent', function () {
    withEnv('XDG_SESSION_TYPE', null, () => {
      withEnv('WAYLAND_DISPLAY', null, () => {
        (0, _index.resolveLinuxBackend)({
          linuxBackend: 'auto'
        }).should.eql('x11');
      });
    });
  });
});
describe('Wayland token store', function () {
  it('should write and read restore token', function () {
    const tmpPath = _path.default.join(_os.default.tmpdir(), `appium-linux-driver-token-${Date.now()}.json`);
    if (_fs.default.existsSync(tmpPath)) {
      _fs.default.unlinkSync(tmpPath);
    }
    (0, _tokenStore.writeWaylandToken)(tmpPath, 'yelp', 'restore-token-1');
    const data = (0, _tokenStore.readWaylandToken)(tmpPath, 'yelp');
    data.token.should.eql('restore-token-1');
    should.exist(data.updatedAt);
    (_fs.default.statSync(tmpPath).mode & 0o777).should.eql(0o600);
    if (_fs.default.existsSync(tmpPath)) {
      _fs.default.unlinkSync(tmpPath);
    }
  });
});
describe('Linux platform helpers', function () {
  it('should parse /etc/os-release style content', function () {
    const parsed = (0, _linuxPlatform.parseOsRelease)(`
NAME="Red Hat Enterprise Linux"
VERSION_ID="9.4"
ID="rhel"
ID_LIKE="fedora centos"
    `);
    parsed.ID.should.eql('rhel');
    parsed.VERSION_ID.should.eql('9.4');
    parsed.ID_LIKE.should.eql('fedora centos');
  });
  it('should detect RHEL family and supported major', function () {
    const distro = (0, _linuxPlatform.detectLinuxDistroInfo)({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=rhel\nVERSION_ID="9.3"\nPRETTY_NAME="RHEL 9.3"'
    });
    distro.isRhelLike.should.eql(true);
    distro.majorVersion.should.eql(9);
    distro.isSupportedRhelMajor.should.eql(true);
  });
  it('should detect Ubuntu 26 as a supported Wayland target', function () {
    const distro = (0, _linuxPlatform.detectLinuxDistroInfo)({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"'
    });
    distro.isUbuntu.should.eql(true);
    distro.majorVersion.should.eql(26);
    distro.isSupportedUbuntuMajor.should.eql(true);
  });
  it('should produce actionable preflight errors on missing RHEL dependencies', function () {
    const distro = (0, _linuxPlatform.detectLinuxDistroInfo)({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=rhel\nVERSION_ID="9.3"\nPRETTY_NAME="RHEL 9.3"'
    });
    const res = (0, _linuxPlatform.evaluateWaylandPreflight)({
      env: {
        XDG_SESSION_TYPE: 'wayland',
        WAYLAND_DISPLAY: 'wayland-0'
      },
      distroInfo: distro,
      hasCommand: () => false,
      autoShareEnabled: true
    });
    res.errors.length.should.be.greaterThan(0);
    res.errors.join('\n').should.contain('sudo dnf install -y xdg-desktop-portal xdg-desktop-portal-gnome');
    res.errors.join('\n').should.contain('sudo dnf install -y pipewire pipewire-utils');
  });
});
describe('Wayland screenshot strategy helpers', function () {
  it('should prioritize portal then CLI fallbacks', function () {
    (0, _waylandScreenshotUtils.getWaylandScreenshotStrategies)({
      portalAvailable: true,
      hasGnomeScreenshot: true,
      hasGrim: true
    }).should.eql(['gnome-screenshot', 'portal', 'grim']);
  });
  it('should return explicit failure message when no strategy is available', function () {
    const message = (0, _waylandScreenshotUtils.getWaylandScreenshotFailureMessage)({
      portalAvailable: false,
      hasGnomeScreenshot: false,
      hasGrim: false
    });
    should.exist(message);
    message.should.contain('portal/gnome-screenshot/grim');
  });
});
describe('Wayland pointer permissions', function () {
  it('should parse granted devices and fail when pointer is missing', function () {
    const grantInfo = (0, _waylandPermissionUtils.parseWaylandGrantedDevices)(1);
    grantInfo.keyboardAllowed.should.eql(true);
    grantInfo.pointerAllowed.should.eql(false);
    (() => (0, _waylandPermissionUtils.ensureWaylandPointerPermission)(grantInfo)).should.throw('POINTER permission');
  });
  it('should fail when portal start does not report granted devices', function () {
    const grantInfo = (0, _waylandPermissionUtils.parseWaylandGrantedDevices)(null);
    should.equal(grantInfo.grantedDevices, null);
    (() => (0, _waylandPermissionUtils.ensureWaylandPointerPermission)(grantInfo)).should.throw('did not report granted devices');
  });
});
describe('Wayland keyboard typing', function () {
  it('should type supported ASCII directly before using clipboard paste', async function () {
    const apis = new _waylandApis.default();
    const tapped = [];
    let copied = null;
    apis.keyboard_tapKey = function (char, flags) {
      tapped.push([char, flags]);
    };
    apis.keyboard_copy = function (str) {
      copied = str;
    };
    await apis.keyboard_typeStringCopyPaste('10.4.134.220');
    tapped.map(([char]) => char).join('').should.eql('10.4.134.220');
    tapped.every(([, flags]) => flags === 0).should.eql(true);
    should.equal(copied, null);
  });
  it('should send shifted symbols as direct key events', async function () {
    const apis = new _waylandApis.default();
    const tapped = [];
    let copied = null;
    apis.keyboard_tapKey = function (char, flags) {
      tapped.push([char, flags]);
    };
    apis.keyboard_copy = function (str) {
      copied = str;
    };
    await apis.keyboard_typeStringCopyPaste('Administrator@cartdev.atl');
    tapped.map(([char]) => char).join('').should.eql('Administrator@cartdev.atl');
    tapped.every(([, flags]) => flags === 0).should.eql(true);
    should.equal(copied, null);
  });
  it('should apply shift when typing @ directly', async function () {
    const apis = new _waylandApis.default();
    let observed = null;
    apis._tapEvdevWithMods = function (evdev, mods) {
      observed = {
        evdev,
        mods
      };
    };
    await apis.keyboard_tapKey('@', 0);
    observed.should.eql({
      evdev: 3,
      mods: [42]
    });
  });
  it('should fall back to clipboard paste for unsupported characters', async function () {
    const apis = new _waylandApis.default();
    const tapped = [];
    let copied = null;
    apis.keyboard_tapKey = function (char, flags) {
      tapped.push([char, flags]);
    };
    apis.keyboard_copy = function (str) {
      copied = str;
    };
    await apis.keyboard_typeStringCopyPaste('Pass\u2603word');
    copied.should.eql('Pass\u2603word');
    tapped.should.eql([['v', 4]]);
  });
});
describe('Wayland window scoping helpers', function () {
  const DESKTOP_XML = `
<desktop>
  <frame pid="42" name="Main Window" class="GtkWindow" states="[ACTIVE,SHOWING,VISIBLE]" rect="[10,20,800,600]" window-type="normal">
    <push-button name="New Server" rect="[30,40,120,40]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </frame>
  <panel pid="42" name="Main Window" class="GtkBox" states="[SHOWING,VISIBLE]" rect="[10,20,800,600]">
    <label name="Main Window Label" rect="[40,60,180,20]" states="[SHOWING,VISIBLE]"/>
  </panel>
  <dialog pid="42" name="Add Server" class="GtkDialog" states="[SHOWING,VISIBLE]" rect="[120,140,420,220]" window-type="dialog">
    <text name="Enter the name of the Connection Server" rect="[150,180,240,30]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </dialog>
</desktop>
  `;
  const REORDERED_DESKTOP_XML = `
<desktop>
  <dialog pid="42" name="Add Server" class="GtkDialog" states="[SHOWING,VISIBLE]" rect="[120,140,420,220]" window-type="dialog">
    <text name="Enter the name of the Connection Server" rect="[150,180,240,30]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </dialog>
  <frame pid="42" name="Main Window" class="GtkWindow" states="[ACTIVE,SHOWING,VISIBLE]" rect="[10,20,800,600]" window-type="normal">
    <push-button name="New Server" rect="[30,40,120,40]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </frame>
</desktop>
  `;
  it('should keep synthetic window handles stable across refreshes', function () {
    const firstCandidates = (0, _waylandWindowUtils.extractWaylandWindowCandidates)(DESKTOP_XML, [42]);
    const first = (0, _waylandWindowUtils.materializeWaylandWindows)(firstCandidates);
    const previousWidByIdentity = new Map(first.windows.map(window => [window.identityKey, window.wid]));
    const secondCandidates = (0, _waylandWindowUtils.extractWaylandWindowCandidates)(REORDERED_DESKTOP_XML, [42]);
    const second = (0, _waylandWindowUtils.materializeWaylandWindows)(secondCandidates, previousWidByIdentity);
    const firstByName = new Map(first.windows.map(window => [window.name, window.wid]));
    const secondByName = new Map(second.windows.map(window => [window.name, window.wid]));
    secondByName.get('Main Window').should.eql(firstByName.get('Main Window'));
    secondByName.get('Add Server').should.eql(firstByName.get('Add Server'));
  });
  it('should resolve scoped xml for the selected window only', function () {
    const {
      windows
    } = (0, _waylandWindowUtils.materializeWaylandWindows)((0, _waylandWindowUtils.extractWaylandWindowCandidates)(DESKTOP_XML, [42]));
    const dialogWindow = windows.find(window => window.name === 'Add Server');
    should.exist(dialogWindow);
    const resolved = (0, _waylandWindowUtils.resolveWaylandScopedWindowXml)(REORDERED_DESKTOP_XML, [42], dialogWindow);
    resolved.reason.should.eql('ok');
    resolved.xml.should.contain('Enter the name of the Connection Server');
    resolved.xml.should.not.contain('New Server');
  });
  it('should redirect a frame handle to an active transient overlay for modal prompts', function () {
    const modalDesktopXml = `
<desktop>
  <frame pid="42" name="AzWin11Cli" class="GtkWindow" states="[ACTIVE,SHOWING,VISIBLE]" rect="[10,20,1000,700]" window-type="normal">
    <menu name="Connection" rect="[20,30,120,30]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </frame>
  <alert pid="42" name="Question" class="GtkMessageDialog" states="[ACTIVE,ENABLED,MODAL,SHOWING,VISIBLE]" rect="[210,180,420,180]" window-type="dialog">
    <label name="Log Off Desktop" rect="[230,200,180,26]" states="[SHOWING,VISIBLE]"/>
    <push-button name="Log Off" rect="[470,310,120,36]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </alert>
</desktop>
    `;
    const {
      windows
    } = (0, _waylandWindowUtils.materializeWaylandWindows)((0, _waylandWindowUtils.extractWaylandWindowCandidates)(modalDesktopXml, [42]));
    const frameWindow = windows.find(window => window.name === 'AzWin11Cli');
    should.exist(frameWindow);
    (0, _waylandWindowUtils.isTransientWindowCandidate)(frameWindow).should.eql(false);
    const resolved = (0, _waylandWindowUtils.resolveWaylandScopedWindowXml)(modalDesktopXml, [42], frameWindow, {
      allowTransientOverlay: true
    });
    resolved.reason.should.eql('ok');
    resolved.redirectedToTransientOverlay.should.eql(true);
    resolved.candidate.name.should.eql('Question');
    resolved.xml.should.contain('Log Off');
    resolved.xml.should.not.contain('Connection');
  });
  it('should report ambiguity when multiple scoped window matches are equally valid', function () {
    const ambiguousXml = `
<desktop>
  <dialog pid="42" name="Add Server" class="GtkDialog" states="[SHOWING,VISIBLE]" rect="[120,140,420,220]" window-type="dialog">
    <text name="Server A" rect="[150,180,240,30]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </dialog>
  <dialog pid="42" name="Add Server" class="GtkDialog" states="[SHOWING,VISIBLE]" rect="[120,140,420,220]" window-type="dialog">
    <text name="Server B" rect="[150,180,240,30]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </dialog>
</desktop>
    `;
    const targetWindow = {
      pid: 42,
      wid: 101,
      name: 'Add Server',
      className: 'GtkDialog',
      nodeTag: 'dialog',
      windowType: 'dialog',
      rect: {
        x: 120,
        y: 140,
        width: 420,
        height: 220
      },
      identityKey: '42|dialog|dialog|Add Server|GtkDialog|420x220'
    };
    const resolved = (0, _waylandWindowUtils.resolveWaylandScopedWindowXml)(ambiguousXml, [42], targetWindow);
    resolved.reason.should.eql('ambiguous');
    resolved.xml.should.eql('');
  });
  it('should keep window-like alert roots even when pid is only present on descendants', function () {
    const alertDesktopXml = `
<desktop>
  <frame pid="42" name="Omnissa Horizon Client" class="GtkWindow" states="[SHOWING,VISIBLE]" rect="[863,142,640,585]" window-type="normal"/>
  <alert name="Information" class="GtkAlert" states="[ACTIVE,ENABLED,MODAL,SHOWING,VISIBLE]" rect="[824,331,718,207]" window-type="dialog">
    <label pid="42" name="Connect to Server" rect="[860,360,200,32]" states="[SHOWING,VISIBLE]"/>
    <push-button pid="42" name="Connect Insecurely" rect="[1180,470,180,40]" states="[ENABLED,SHOWING,VISIBLE]"/>
  </alert>
</desktop>
    `;
    const candidates = (0, _waylandWindowUtils.extractWaylandWindowCandidates)(alertDesktopXml, [42]);
    const materialized = (0, _waylandWindowUtils.materializeWaylandWindows)(candidates);
    const names = materialized.windows.map(window => window.name);
    names.should.include('Information');
    const alertWindow = materialized.windows.find(window => window.name === 'Information');
    should.exist(alertWindow);
    alertWindow.nodeTag.should.eql('alert');
    alertWindow.pid.should.eql(42);
  });
});
describe('Wayland window command healing', function () {
  const WINDOW_HIERARCHY_XML = `
<windows>
  <window pid="42" wid="111" InputOutput="true" name="Main Window" class="GtkWindow" rect="[10,20,800,600]" states="[ACTIVE,SHOWING,VISIBLE]" tag="frame" window-type="normal"/>
  <window pid="42" wid="222" InputOutput="true" name="Untrusted Connection" class="GtkAlert" rect="[210,160,420,220]" states="[SHOWING,VISIBLE]" tag="alert" window-type="dialog"/>
  <window pid="84" wid="333" InputOutput="true" name="Attached Window" class="GtkWindow" rect="[10,20,800,600]" states="[ACTIVE,SHOWING,VISIBLE]" tag="frame" window-type="normal"/>
</windows>
  `;
  function buildWaylandCtx() {
    const ctx = {
      appName: 'horizon-client',
      linuxBackend: 'wayland',
      _backendApis: {
        app_running: () => [42],
        app_getWindowHierachy: () => WINDOW_HIERARCHY_XML
      },
      _win: {
        pid: 42,
        wid: 999,
        name: 'Gone'
      }
    };
    ctx.getWindowHandles = _window.default.getWindowHandles.bind(ctx);
    ctx._getWindowHandlesCore = _window.default._getWindowHandlesCore.bind(ctx);
    ctx._getWinAndPid_FromWinId = _window.default._getWinAndPid_FromWinId.bind(ctx);
    ctx._resolveBestAvailableWindow = _window.default._resolveBestAvailableWindow.bind(ctx);
    ctx.getWindowHandle = _window.default.getWindowHandle.bind(ctx);
    ctx._validateOrUpdateWinInfo = _find.default._validateOrUpdateWinInfo.bind(ctx);
    return ctx;
  }
  it('should prioritize alert-like windows in wayland handle ordering', function () {
    const ctx = buildWaylandCtx();
    ctx.getWindowHandles().should.eql([222, 111]);
  });
  it('should recover current wayland window handle when the selected one disappears', function () {
    const ctx = buildWaylandCtx();
    ctx.getWindowHandle().should.eql(222);
    ctx._win.wid.should.eql(222);
    ctx._win.name.should.eql('Untrusted Connection');
  });
  it('should heal stale wayland window info during element lookup validation', function () {
    const ctx = buildWaylandCtx();
    ctx._validateOrUpdateWinInfo().should.eql(true);
    ctx._win.wid.should.eql(222);
    ctx._win.name.should.eql('Untrusted Connection');
  });
});
describe('Wayland transient selector routing', function () {
  it('should use handle-scoped hierarchy for transient xpath selectors on normal windows', function () {
    let nativeCalls = 0;
    let handleCalls = 0;
    const ctx = {
      linuxBackend: 'wayland',
      _win: {
        pid: 42,
        wid: 111,
        name: 'AzWin11Cli',
        tag: 'frame',
        windowType: 'normal'
      },
      _cache: new Map(),
      _validateOrUpdateWinInfo: () => true,
      _backendApis: {
        a11y_clear_cache: () => {},
        a11y_getWindowUiHierachy: () => {
          nativeCalls += 1;
          return '';
        },
        a11y_getWindowUiHierachyByHandle: () => {
          handleCalls += 1;
          return `
<alert name="Question" pid="42" rect="[210,180,420,180]" states="[ACTIVE,MODAL,SHOWING,VISIBLE]">
  <push-button name="Log Off" rect="[470,310,120,36]" states="[ENABLED,SHOWING,VISIBLE]"/>
</alert>
          `;
        }
      }
    };
    const result = _find.default.findElOrEls.call(ctx, 'xpath', "//alert[@name='Question']//push-button[@name='Log Off']", false, undefined);
    should.exist(result);
    handleCalls.should.eql(1);
    nativeCalls.should.eql(1);
  });
});require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC91bml0L2JhY2tlbmQtc3BlY3MuanMiLCJuYW1lcyI6WyJfY2hhaSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2ZzIiwiX29zIiwiX3BhdGgiLCJfaW5kZXgiLCJfdG9rZW5TdG9yZSIsIl9saW51eFBsYXRmb3JtIiwiX3dheWxhbmRQZXJtaXNzaW9uVXRpbHMiLCJfd2F5bGFuZFNjcmVlbnNob3RVdGlscyIsIl93YXlsYW5kQXBpcyIsIl9maW5kIiwiX3dpbmRvdyIsIl93YXlsYW5kV2luZG93VXRpbHMiLCJzaG91bGQiLCJjaGFpIiwid2l0aEVudiIsImtleSIsInZhbHVlIiwiZm4iLCJvbGQiLCJwcm9jZXNzIiwiZW52IiwidW5kZWZpbmVkIiwiZGVzY3JpYmUiLCJpdCIsInJlc29sdmVMaW51eEJhY2tlbmQiLCJsaW51eEJhY2tlbmQiLCJlcWwiLCJ0bXBQYXRoIiwicGF0aCIsImpvaW4iLCJvcyIsInRtcGRpciIsIkRhdGUiLCJub3ciLCJmcyIsImV4aXN0c1N5bmMiLCJ1bmxpbmtTeW5jIiwid3JpdGVXYXlsYW5kVG9rZW4iLCJkYXRhIiwicmVhZFdheWxhbmRUb2tlbiIsInRva2VuIiwiZXhpc3QiLCJ1cGRhdGVkQXQiLCJzdGF0U3luYyIsIm1vZGUiLCJwYXJzZWQiLCJwYXJzZU9zUmVsZWFzZSIsIklEIiwiVkVSU0lPTl9JRCIsIklEX0xJS0UiLCJkaXN0cm8iLCJkZXRlY3RMaW51eERpc3Ryb0luZm8iLCJwbGF0Zm9ybSIsIm9zUmVsZWFzZVRleHQiLCJpc1JoZWxMaWtlIiwibWFqb3JWZXJzaW9uIiwiaXNTdXBwb3J0ZWRSaGVsTWFqb3IiLCJpc1VidW50dSIsImlzU3VwcG9ydGVkVWJ1bnR1TWFqb3IiLCJyZXMiLCJldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQiLCJYREdfU0VTU0lPTl9UWVBFIiwiV0FZTEFORF9ESVNQTEFZIiwiZGlzdHJvSW5mbyIsImhhc0NvbW1hbmQiLCJhdXRvU2hhcmVFbmFibGVkIiwiZXJyb3JzIiwibGVuZ3RoIiwiYmUiLCJncmVhdGVyVGhhbiIsImNvbnRhaW4iLCJnZXRXYXlsYW5kU2NyZWVuc2hvdFN0cmF0ZWdpZXMiLCJwb3J0YWxBdmFpbGFibGUiLCJoYXNHbm9tZVNjcmVlbnNob3QiLCJoYXNHcmltIiwibWVzc2FnZSIsImdldFdheWxhbmRTY3JlZW5zaG90RmFpbHVyZU1lc3NhZ2UiLCJncmFudEluZm8iLCJwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlcyIsImtleWJvYXJkQWxsb3dlZCIsInBvaW50ZXJBbGxvd2VkIiwiZW5zdXJlV2F5bGFuZFBvaW50ZXJQZXJtaXNzaW9uIiwidGhyb3ciLCJlcXVhbCIsImdyYW50ZWREZXZpY2VzIiwiYXBpcyIsIldheWxhbmRBcGlzIiwidGFwcGVkIiwiY29waWVkIiwia2V5Ym9hcmRfdGFwS2V5IiwiY2hhciIsImZsYWdzIiwicHVzaCIsImtleWJvYXJkX2NvcHkiLCJzdHIiLCJrZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlIiwibWFwIiwiZXZlcnkiLCJvYnNlcnZlZCIsIl90YXBFdmRldldpdGhNb2RzIiwiZXZkZXYiLCJtb2RzIiwiREVTS1RPUF9YTUwiLCJSRU9SREVSRURfREVTS1RPUF9YTUwiLCJmaXJzdENhbmRpZGF0ZXMiLCJleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMiLCJmaXJzdCIsIm1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJNYXAiLCJ3aW5kb3dzIiwid2luZG93IiwiaWRlbnRpdHlLZXkiLCJ3aWQiLCJzZWNvbmRDYW5kaWRhdGVzIiwic2Vjb25kIiwiZmlyc3RCeU5hbWUiLCJuYW1lIiwic2Vjb25kQnlOYW1lIiwiZ2V0IiwiZGlhbG9nV2luZG93IiwiZmluZCIsInJlc29sdmVkIiwicmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwiLCJyZWFzb24iLCJ4bWwiLCJub3QiLCJtb2RhbERlc2t0b3BYbWwiLCJmcmFtZVdpbmRvdyIsImlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlIiwiYWxsb3dUcmFuc2llbnRPdmVybGF5IiwicmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheSIsImNhbmRpZGF0ZSIsImFtYmlndW91c1htbCIsInRhcmdldFdpbmRvdyIsInBpZCIsImNsYXNzTmFtZSIsIm5vZGVUYWciLCJ3aW5kb3dUeXBlIiwicmVjdCIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJhbGVydERlc2t0b3BYbWwiLCJjYW5kaWRhdGVzIiwibWF0ZXJpYWxpemVkIiwibmFtZXMiLCJpbmNsdWRlIiwiYWxlcnRXaW5kb3ciLCJXSU5ET1dfSElFUkFSQ0hZX1hNTCIsImJ1aWxkV2F5bGFuZEN0eCIsImN0eCIsImFwcE5hbWUiLCJfYmFja2VuZEFwaXMiLCJhcHBfcnVubmluZyIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsIl93aW4iLCJnZXRXaW5kb3dIYW5kbGVzIiwid2luZG93Q29tbWFuZHMiLCJiaW5kIiwiX2dldFdpbmRvd0hhbmRsZXNDb3JlIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQiLCJfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3ciLCJnZXRXaW5kb3dIYW5kbGUiLCJfdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8iLCJmaW5kQ29tbWFuZHMiLCJuYXRpdmVDYWxscyIsImhhbmRsZUNhbGxzIiwidGFnIiwiX2NhY2hlIiwiYTExeV9jbGVhcl9jYWNoZSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeUJ5SGFuZGxlIiwicmVzdWx0IiwiZmluZEVsT3JFbHMiLCJjYWxsIl0sInNvdXJjZVJvb3QiOiIuLi8uLi8uLiIsInNvdXJjZXMiOlsidGVzdC91bml0L2JhY2tlbmQtc3BlY3MuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNoYWkgZnJvbSAnY2hhaSc7XG5pbXBvcnQgZnMgZnJvbSAnZnMnO1xuaW1wb3J0IG9zIGZyb20gJ29zJztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgcmVzb2x2ZUxpbnV4QmFja2VuZCB9IGZyb20gJy4uLy4uL2xpYi9iYWNrZW5kcy9pbmRleC5qcyc7XG5pbXBvcnQgeyByZWFkV2F5bGFuZFRva2VuLCB3cml0ZVdheWxhbmRUb2tlbiB9IGZyb20gJy4uLy4uL2xpYi9iYWNrZW5kcy90b2tlbi1zdG9yZS5qcyc7XG5pbXBvcnQge3BhcnNlT3NSZWxlYXNlLCBkZXRlY3RMaW51eERpc3Ryb0luZm8sIGV2YWx1YXRlV2F5bGFuZFByZWZsaWdodH0gZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL2xpbnV4LXBsYXRmb3JtLmpzJztcbmltcG9ydCB7ZW5zdXJlV2F5bGFuZFBvaW50ZXJQZXJtaXNzaW9uLCBwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlc30gZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL3dheWxhbmQtcGVybWlzc2lvbi11dGlscy5qcyc7XG5pbXBvcnQge2dldFdheWxhbmRTY3JlZW5zaG90U3RyYXRlZ2llcywgZ2V0V2F5bGFuZFNjcmVlbnNob3RGYWlsdXJlTWVzc2FnZX0gZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL3dheWxhbmQtc2NyZWVuc2hvdC11dGlscy5qcyc7XG5pbXBvcnQgV2F5bGFuZEFwaXMgZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL3dheWxhbmQtYXBpcy5qcyc7XG5pbXBvcnQgZmluZENvbW1hbmRzIGZyb20gJy4uLy4uL2xpYi9jb21tYW5kcy9maW5kLmpzJztcbmltcG9ydCB3aW5kb3dDb21tYW5kcyBmcm9tICcuLi8uLi9saWIvY29tbWFuZHMvd2luZG93LmpzJztcbmltcG9ydCB7XG4gIGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyxcbiAgaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUsXG4gIG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MsXG4gIHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sLFxufSBmcm9tICcuLi8uLi9saWIvYmFja2VuZHMvd2F5bGFuZC13aW5kb3ctdXRpbHMuanMnO1xuXG5jb25zdCBzaG91bGQgPSBjaGFpLnNob3VsZCgpO1xuXG5mdW5jdGlvbiB3aXRoRW52IChrZXksIHZhbHVlLCBmbikge1xuICBjb25zdCBvbGQgPSBwcm9jZXNzLmVudltrZXldO1xuICBpZiAodmFsdWUgPT09IG51bGwpIHtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZba2V5XTtcbiAgfSBlbHNlIHtcbiAgICBwcm9jZXNzLmVudltrZXldID0gdmFsdWU7XG4gIH1cbiAgdHJ5IHtcbiAgICBmbigpO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChvbGQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52W2tleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb2Nlc3MuZW52W2tleV0gPSBvbGQ7XG4gICAgfVxuICB9XG59XG5cbmRlc2NyaWJlKCdMaW51eCBiYWNrZW5kIHNlbGVjdGlvbicsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCBob25vciBleHBsaWNpdCBsaW51eEJhY2tlbmQgY2FwYWJpbGl0eScsIGZ1bmN0aW9uICgpIHtcbiAgICByZXNvbHZlTGludXhCYWNrZW5kKHtsaW51eEJhY2tlbmQ6ICd4MTEnfSkuc2hvdWxkLmVxbCgneDExJyk7XG4gICAgcmVzb2x2ZUxpbnV4QmFja2VuZCh7bGludXhCYWNrZW5kOiAnd2F5bGFuZCd9KS5zaG91bGQuZXFsKCd3YXlsYW5kJyk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgYXV0by1zZWxlY3Qgd2F5bGFuZCB3aGVuIFhERyBzZXNzaW9uIHNheXMgd2F5bGFuZCcsIGZ1bmN0aW9uICgpIHtcbiAgICB3aXRoRW52KCdYREdfU0VTU0lPTl9UWVBFJywgJ3dheWxhbmQnLCAoKSA9PiB7XG4gICAgICByZXNvbHZlTGludXhCYWNrZW5kKHtsaW51eEJhY2tlbmQ6ICdhdXRvJ30pLnNob3VsZC5lcWwoJ3dheWxhbmQnKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBhdXRvLXNlbGVjdCB4MTEgd2hlbiB3YXlsYW5kIGVudiBpcyBhYnNlbnQnLCBmdW5jdGlvbiAoKSB7XG4gICAgd2l0aEVudignWERHX1NFU1NJT05fVFlQRScsIG51bGwsICgpID0+IHtcbiAgICAgIHdpdGhFbnYoJ1dBWUxBTkRfRElTUExBWScsIG51bGwsICgpID0+IHtcbiAgICAgICAgcmVzb2x2ZUxpbnV4QmFja2VuZCh7bGludXhCYWNrZW5kOiAnYXV0byd9KS5zaG91bGQuZXFsKCd4MTEnKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZSgnV2F5bGFuZCB0b2tlbiBzdG9yZScsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCB3cml0ZSBhbmQgcmVhZCByZXN0b3JlIHRva2VuJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHRtcFBhdGggPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksIGBhcHBpdW0tbGludXgtZHJpdmVyLXRva2VuLSR7RGF0ZS5ub3coKX0uanNvbmApO1xuICAgIGlmIChmcy5leGlzdHNTeW5jKHRtcFBhdGgpKSB7XG4gICAgICBmcy51bmxpbmtTeW5jKHRtcFBhdGgpO1xuICAgIH1cblxuICAgIHdyaXRlV2F5bGFuZFRva2VuKHRtcFBhdGgsICd5ZWxwJywgJ3Jlc3RvcmUtdG9rZW4tMScpO1xuICAgIGNvbnN0IGRhdGEgPSByZWFkV2F5bGFuZFRva2VuKHRtcFBhdGgsICd5ZWxwJyk7XG5cbiAgICBkYXRhLnRva2VuLnNob3VsZC5lcWwoJ3Jlc3RvcmUtdG9rZW4tMScpO1xuICAgIHNob3VsZC5leGlzdChkYXRhLnVwZGF0ZWRBdCk7XG4gICAgKGZzLnN0YXRTeW5jKHRtcFBhdGgpLm1vZGUgJiAwbzc3Nykuc2hvdWxkLmVxbCgwbzYwMCk7XG5cbiAgICBpZiAoZnMuZXhpc3RzU3luYyh0bXBQYXRoKSkge1xuICAgICAgZnMudW5saW5rU3luYyh0bXBQYXRoKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdMaW51eCBwbGF0Zm9ybSBoZWxwZXJzJywgZnVuY3Rpb24gKCkge1xuICBpdCgnc2hvdWxkIHBhcnNlIC9ldGMvb3MtcmVsZWFzZSBzdHlsZSBjb250ZW50JywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlT3NSZWxlYXNlKGBcbk5BTUU9XCJSZWQgSGF0IEVudGVycHJpc2UgTGludXhcIlxuVkVSU0lPTl9JRD1cIjkuNFwiXG5JRD1cInJoZWxcIlxuSURfTElLRT1cImZlZG9yYSBjZW50b3NcIlxuICAgIGApO1xuICAgIHBhcnNlZC5JRC5zaG91bGQuZXFsKCdyaGVsJyk7XG4gICAgcGFyc2VkLlZFUlNJT05fSUQuc2hvdWxkLmVxbCgnOS40Jyk7XG4gICAgcGFyc2VkLklEX0xJS0Uuc2hvdWxkLmVxbCgnZmVkb3JhIGNlbnRvcycpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGRldGVjdCBSSEVMIGZhbWlseSBhbmQgc3VwcG9ydGVkIG1ham9yJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGRpc3RybyA9IGRldGVjdExpbnV4RGlzdHJvSW5mbyh7XG4gICAgICBwbGF0Zm9ybTogJ2xpbnV4JyxcbiAgICAgIGVudjoge30sXG4gICAgICBvc1JlbGVhc2VUZXh0OiAnSUQ9cmhlbFxcblZFUlNJT05fSUQ9XCI5LjNcIlxcblBSRVRUWV9OQU1FPVwiUkhFTCA5LjNcIicsXG4gICAgfSk7XG4gICAgZGlzdHJvLmlzUmhlbExpa2Uuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICBkaXN0cm8ubWFqb3JWZXJzaW9uLnNob3VsZC5lcWwoOSk7XG4gICAgZGlzdHJvLmlzU3VwcG9ydGVkUmhlbE1ham9yLnNob3VsZC5lcWwodHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgZGV0ZWN0IFVidW50dSAyNiBhcyBhIHN1cHBvcnRlZCBXYXlsYW5kIHRhcmdldCcsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBkaXN0cm8gPSBkZXRlY3RMaW51eERpc3Ryb0luZm8oe1xuICAgICAgcGxhdGZvcm06ICdsaW51eCcsXG4gICAgICBlbnY6IHt9LFxuICAgICAgb3NSZWxlYXNlVGV4dDogJ0lEPXVidW50dVxcblZFUlNJT05fSUQ9XCIyNi4wNFwiXFxuUFJFVFRZX05BTUU9XCJVYnVudHUgMjYuMDQgTFRTXCInLFxuICAgIH0pO1xuICAgIGRpc3Ryby5pc1VidW50dS5zaG91bGQuZXFsKHRydWUpO1xuICAgIGRpc3Ryby5tYWpvclZlcnNpb24uc2hvdWxkLmVxbCgyNik7XG4gICAgZGlzdHJvLmlzU3VwcG9ydGVkVWJ1bnR1TWFqb3Iuc2hvdWxkLmVxbCh0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBwcm9kdWNlIGFjdGlvbmFibGUgcHJlZmxpZ2h0IGVycm9ycyBvbiBtaXNzaW5nIFJIRUwgZGVwZW5kZW5jaWVzJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGRpc3RybyA9IGRldGVjdExpbnV4RGlzdHJvSW5mbyh7XG4gICAgICBwbGF0Zm9ybTogJ2xpbnV4JyxcbiAgICAgIGVudjoge30sXG4gICAgICBvc1JlbGVhc2VUZXh0OiAnSUQ9cmhlbFxcblZFUlNJT05fSUQ9XCI5LjNcIlxcblBSRVRUWV9OQU1FPVwiUkhFTCA5LjNcIicsXG4gICAgfSk7XG4gICAgY29uc3QgcmVzID0gZXZhbHVhdGVXYXlsYW5kUHJlZmxpZ2h0KHtcbiAgICAgIGVudjoge1xuICAgICAgICBYREdfU0VTU0lPTl9UWVBFOiAnd2F5bGFuZCcsXG4gICAgICAgIFdBWUxBTkRfRElTUExBWTogJ3dheWxhbmQtMCcsXG4gICAgICB9LFxuICAgICAgZGlzdHJvSW5mbzogZGlzdHJvLFxuICAgICAgaGFzQ29tbWFuZDogKCkgPT4gZmFsc2UsXG4gICAgICBhdXRvU2hhcmVFbmFibGVkOiB0cnVlLFxuICAgIH0pO1xuICAgIHJlcy5lcnJvcnMubGVuZ3RoLnNob3VsZC5iZS5ncmVhdGVyVGhhbigwKTtcbiAgICByZXMuZXJyb3JzLmpvaW4oJ1xcbicpLnNob3VsZC5jb250YWluKCdzdWRvIGRuZiBpbnN0YWxsIC15IHhkZy1kZXNrdG9wLXBvcnRhbCB4ZGctZGVza3RvcC1wb3J0YWwtZ25vbWUnKTtcbiAgICByZXMuZXJyb3JzLmpvaW4oJ1xcbicpLnNob3VsZC5jb250YWluKCdzdWRvIGRuZiBpbnN0YWxsIC15IHBpcGV3aXJlIHBpcGV3aXJlLXV0aWxzJyk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIHNjcmVlbnNob3Qgc3RyYXRlZ3kgaGVscGVycycsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCBwcmlvcml0aXplIHBvcnRhbCB0aGVuIENMSSBmYWxsYmFja3MnLCBmdW5jdGlvbiAoKSB7XG4gICAgZ2V0V2F5bGFuZFNjcmVlbnNob3RTdHJhdGVnaWVzKHtcbiAgICAgIHBvcnRhbEF2YWlsYWJsZTogdHJ1ZSxcbiAgICAgIGhhc0dub21lU2NyZWVuc2hvdDogdHJ1ZSxcbiAgICAgIGhhc0dyaW06IHRydWUsXG4gICAgfSkuc2hvdWxkLmVxbChbJ2dub21lLXNjcmVlbnNob3QnLCAncG9ydGFsJywgJ2dyaW0nXSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgcmV0dXJuIGV4cGxpY2l0IGZhaWx1cmUgbWVzc2FnZSB3aGVuIG5vIHN0cmF0ZWd5IGlzIGF2YWlsYWJsZScsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gZ2V0V2F5bGFuZFNjcmVlbnNob3RGYWlsdXJlTWVzc2FnZSh7XG4gICAgICBwb3J0YWxBdmFpbGFibGU6IGZhbHNlLFxuICAgICAgaGFzR25vbWVTY3JlZW5zaG90OiBmYWxzZSxcbiAgICAgIGhhc0dyaW06IGZhbHNlLFxuICAgIH0pO1xuICAgIHNob3VsZC5leGlzdChtZXNzYWdlKTtcbiAgICBtZXNzYWdlLnNob3VsZC5jb250YWluKCdwb3J0YWwvZ25vbWUtc2NyZWVuc2hvdC9ncmltJyk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIHBvaW50ZXIgcGVybWlzc2lvbnMnLCBmdW5jdGlvbiAoKSB7XG4gIGl0KCdzaG91bGQgcGFyc2UgZ3JhbnRlZCBkZXZpY2VzIGFuZCBmYWlsIHdoZW4gcG9pbnRlciBpcyBtaXNzaW5nJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGdyYW50SW5mbyA9IHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzKDEpO1xuICAgIGdyYW50SW5mby5rZXlib2FyZEFsbG93ZWQuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICBncmFudEluZm8ucG9pbnRlckFsbG93ZWQuc2hvdWxkLmVxbChmYWxzZSk7XG4gICAgKCgpID0+IGVuc3VyZVdheWxhbmRQb2ludGVyUGVybWlzc2lvbihncmFudEluZm8pKS5zaG91bGQudGhyb3coJ1BPSU5URVIgcGVybWlzc2lvbicpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGZhaWwgd2hlbiBwb3J0YWwgc3RhcnQgZG9lcyBub3QgcmVwb3J0IGdyYW50ZWQgZGV2aWNlcycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBncmFudEluZm8gPSBwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlcyhudWxsKTtcbiAgICBzaG91bGQuZXF1YWwoZ3JhbnRJbmZvLmdyYW50ZWREZXZpY2VzLCBudWxsKTtcbiAgICAoKCkgPT4gZW5zdXJlV2F5bGFuZFBvaW50ZXJQZXJtaXNzaW9uKGdyYW50SW5mbykpLnNob3VsZC50aHJvdygnZGlkIG5vdCByZXBvcnQgZ3JhbnRlZCBkZXZpY2VzJyk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIGtleWJvYXJkIHR5cGluZycsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCB0eXBlIHN1cHBvcnRlZCBBU0NJSSBkaXJlY3RseSBiZWZvcmUgdXNpbmcgY2xpcGJvYXJkIHBhc3RlJywgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFwaXMgPSBuZXcgV2F5bGFuZEFwaXMoKTtcbiAgICBjb25zdCB0YXBwZWQgPSBbXTtcbiAgICBsZXQgY29waWVkID0gbnVsbDtcblxuICAgIGFwaXMua2V5Ym9hcmRfdGFwS2V5ID0gZnVuY3Rpb24gKGNoYXIsIGZsYWdzKSB7XG4gICAgICB0YXBwZWQucHVzaChbY2hhciwgZmxhZ3NdKTtcbiAgICB9O1xuICAgIGFwaXMua2V5Ym9hcmRfY29weSA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgICAgIGNvcGllZCA9IHN0cjtcbiAgICB9O1xuXG4gICAgYXdhaXQgYXBpcy5rZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlKCcxMC40LjEzNC4yMjAnKTtcblxuICAgIHRhcHBlZC5tYXAoKFtjaGFyXSkgPT4gY2hhcikuam9pbignJykuc2hvdWxkLmVxbCgnMTAuNC4xMzQuMjIwJyk7XG4gICAgdGFwcGVkLmV2ZXJ5KChbLCBmbGFnc10pID0+IGZsYWdzID09PSAwKS5zaG91bGQuZXFsKHRydWUpO1xuICAgIHNob3VsZC5lcXVhbChjb3BpZWQsIG51bGwpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIHNlbmQgc2hpZnRlZCBzeW1ib2xzIGFzIGRpcmVjdCBrZXkgZXZlbnRzJywgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFwaXMgPSBuZXcgV2F5bGFuZEFwaXMoKTtcbiAgICBjb25zdCB0YXBwZWQgPSBbXTtcbiAgICBsZXQgY29waWVkID0gbnVsbDtcblxuICAgIGFwaXMua2V5Ym9hcmRfdGFwS2V5ID0gZnVuY3Rpb24gKGNoYXIsIGZsYWdzKSB7XG4gICAgICB0YXBwZWQucHVzaChbY2hhciwgZmxhZ3NdKTtcbiAgICB9O1xuICAgIGFwaXMua2V5Ym9hcmRfY29weSA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgICAgIGNvcGllZCA9IHN0cjtcbiAgICB9O1xuXG4gICAgYXdhaXQgYXBpcy5rZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlKCdBZG1pbmlzdHJhdG9yQGNhcnRkZXYuYXRsJyk7XG5cbiAgICB0YXBwZWQubWFwKChbY2hhcl0pID0+IGNoYXIpLmpvaW4oJycpLnNob3VsZC5lcWwoJ0FkbWluaXN0cmF0b3JAY2FydGRldi5hdGwnKTtcbiAgICB0YXBwZWQuZXZlcnkoKFssIGZsYWdzXSkgPT4gZmxhZ3MgPT09IDApLnNob3VsZC5lcWwodHJ1ZSk7XG4gICAgc2hvdWxkLmVxdWFsKGNvcGllZCwgbnVsbCk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgYXBwbHkgc2hpZnQgd2hlbiB0eXBpbmcgQCBkaXJlY3RseScsIGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBhcGlzID0gbmV3IFdheWxhbmRBcGlzKCk7XG4gICAgbGV0IG9ic2VydmVkID0gbnVsbDtcblxuICAgIGFwaXMuX3RhcEV2ZGV2V2l0aE1vZHMgPSBmdW5jdGlvbiAoZXZkZXYsIG1vZHMpIHtcbiAgICAgIG9ic2VydmVkID0ge2V2ZGV2LCBtb2RzfTtcbiAgICB9O1xuXG4gICAgYXdhaXQgYXBpcy5rZXlib2FyZF90YXBLZXkoJ0AnLCAwKTtcblxuICAgIG9ic2VydmVkLnNob3VsZC5lcWwoe2V2ZGV2OiAzLCBtb2RzOiBbNDJdfSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgZmFsbCBiYWNrIHRvIGNsaXBib2FyZCBwYXN0ZSBmb3IgdW5zdXBwb3J0ZWQgY2hhcmFjdGVycycsIGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBhcGlzID0gbmV3IFdheWxhbmRBcGlzKCk7XG4gICAgY29uc3QgdGFwcGVkID0gW107XG4gICAgbGV0IGNvcGllZCA9IG51bGw7XG5cbiAgICBhcGlzLmtleWJvYXJkX3RhcEtleSA9IGZ1bmN0aW9uIChjaGFyLCBmbGFncykge1xuICAgICAgdGFwcGVkLnB1c2goW2NoYXIsIGZsYWdzXSk7XG4gICAgfTtcbiAgICBhcGlzLmtleWJvYXJkX2NvcHkgPSBmdW5jdGlvbiAoc3RyKSB7XG4gICAgICBjb3BpZWQgPSBzdHI7XG4gICAgfTtcblxuICAgIGF3YWl0IGFwaXMua2V5Ym9hcmRfdHlwZVN0cmluZ0NvcHlQYXN0ZSgnUGFzc1xcdTI2MDN3b3JkJyk7XG5cbiAgICBjb3BpZWQuc2hvdWxkLmVxbCgnUGFzc1xcdTI2MDN3b3JkJyk7XG4gICAgdGFwcGVkLnNob3VsZC5lcWwoW1sndicsIDRdXSk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIHdpbmRvdyBzY29waW5nIGhlbHBlcnMnLCBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IERFU0tUT1BfWE1MID0gYFxuPGRlc2t0b3A+XG4gIDxmcmFtZSBwaWQ9XCI0MlwiIG5hbWU9XCJNYWluIFdpbmRvd1wiIGNsYXNzPVwiR3RrV2luZG93XCIgc3RhdGVzPVwiW0FDVElWRSxTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMCwyMCw4MDAsNjAwXVwiIHdpbmRvdy10eXBlPVwibm9ybWFsXCI+XG4gICAgPHB1c2gtYnV0dG9uIG5hbWU9XCJOZXcgU2VydmVyXCIgcmVjdD1cIlszMCw0MCwxMjAsNDBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9mcmFtZT5cbiAgPHBhbmVsIHBpZD1cIjQyXCIgbmFtZT1cIk1haW4gV2luZG93XCIgY2xhc3M9XCJHdGtCb3hcIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbMTAsMjAsODAwLDYwMF1cIj5cbiAgICA8bGFiZWwgbmFtZT1cIk1haW4gV2luZG93IExhYmVsXCIgcmVjdD1cIls0MCw2MCwxODAsMjBdXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvcGFuZWw+XG4gIDxkaWFsb2cgcGlkPVwiNDJcIiBuYW1lPVwiQWRkIFNlcnZlclwiIGNsYXNzPVwiR3RrRGlhbG9nXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEyMCwxNDAsNDIwLDIyMF1cIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiPlxuICAgIDx0ZXh0IG5hbWU9XCJFbnRlciB0aGUgbmFtZSBvZiB0aGUgQ29ubmVjdGlvbiBTZXJ2ZXJcIiByZWN0PVwiWzE1MCwxODAsMjQwLDMwXVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvZGlhbG9nPlxuPC9kZXNrdG9wPlxuICBgO1xuXG4gIGNvbnN0IFJFT1JERVJFRF9ERVNLVE9QX1hNTCA9IGBcbjxkZXNrdG9wPlxuICA8ZGlhbG9nIHBpZD1cIjQyXCIgbmFtZT1cIkFkZCBTZXJ2ZXJcIiBjbGFzcz1cIkd0a0RpYWxvZ1wiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMjAsMTQwLDQyMCwyMjBdXCIgd2luZG93LXR5cGU9XCJkaWFsb2dcIj5cbiAgICA8dGV4dCBuYW1lPVwiRW50ZXIgdGhlIG5hbWUgb2YgdGhlIENvbm5lY3Rpb24gU2VydmVyXCIgcmVjdD1cIlsxNTAsMTgwLDI0MCwzMF1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICA8L2RpYWxvZz5cbiAgPGZyYW1lIHBpZD1cIjQyXCIgbmFtZT1cIk1haW4gV2luZG93XCIgY2xhc3M9XCJHdGtXaW5kb3dcIiBzdGF0ZXM9XCJbQUNUSVZFLFNIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEwLDIwLDgwMCw2MDBdXCIgd2luZG93LXR5cGU9XCJub3JtYWxcIj5cbiAgICA8cHVzaC1idXR0b24gbmFtZT1cIk5ldyBTZXJ2ZXJcIiByZWN0PVwiWzMwLDQwLDEyMCw0MF1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICA8L2ZyYW1lPlxuPC9kZXNrdG9wPlxuICBgO1xuXG4gIGl0KCdzaG91bGQga2VlcCBzeW50aGV0aWMgd2luZG93IGhhbmRsZXMgc3RhYmxlIGFjcm9zcyByZWZyZXNoZXMnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgZmlyc3RDYW5kaWRhdGVzID0gZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKERFU0tUT1BfWE1MLCBbNDJdKTtcbiAgICBjb25zdCBmaXJzdCA9IG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MoZmlyc3RDYW5kaWRhdGVzKTtcbiAgICBjb25zdCBwcmV2aW91c1dpZEJ5SWRlbnRpdHkgPSBuZXcgTWFwKGZpcnN0LndpbmRvd3MubWFwKCh3aW5kb3cpID0+IFt3aW5kb3cuaWRlbnRpdHlLZXksIHdpbmRvdy53aWRdKSk7XG5cbiAgICBjb25zdCBzZWNvbmRDYW5kaWRhdGVzID0gZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKFJFT1JERVJFRF9ERVNLVE9QX1hNTCwgWzQyXSk7XG4gICAgY29uc3Qgc2Vjb25kID0gbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyhzZWNvbmRDYW5kaWRhdGVzLCBwcmV2aW91c1dpZEJ5SWRlbnRpdHkpO1xuXG4gICAgY29uc3QgZmlyc3RCeU5hbWUgPSBuZXcgTWFwKGZpcnN0LndpbmRvd3MubWFwKCh3aW5kb3cpID0+IFt3aW5kb3cubmFtZSwgd2luZG93LndpZF0pKTtcbiAgICBjb25zdCBzZWNvbmRCeU5hbWUgPSBuZXcgTWFwKHNlY29uZC53aW5kb3dzLm1hcCgod2luZG93KSA9PiBbd2luZG93Lm5hbWUsIHdpbmRvdy53aWRdKSk7XG4gICAgc2Vjb25kQnlOYW1lLmdldCgnTWFpbiBXaW5kb3cnKS5zaG91bGQuZXFsKGZpcnN0QnlOYW1lLmdldCgnTWFpbiBXaW5kb3cnKSk7XG4gICAgc2Vjb25kQnlOYW1lLmdldCgnQWRkIFNlcnZlcicpLnNob3VsZC5lcWwoZmlyc3RCeU5hbWUuZ2V0KCdBZGQgU2VydmVyJykpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIHJlc29sdmUgc2NvcGVkIHhtbCBmb3IgdGhlIHNlbGVjdGVkIHdpbmRvdyBvbmx5JywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHt3aW5kb3dzfSA9IG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MoZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKERFU0tUT1BfWE1MLCBbNDJdKSk7XG4gICAgY29uc3QgZGlhbG9nV2luZG93ID0gd2luZG93cy5maW5kKCh3aW5kb3cpID0+IHdpbmRvdy5uYW1lID09PSAnQWRkIFNlcnZlcicpO1xuICAgIHNob3VsZC5leGlzdChkaWFsb2dXaW5kb3cpO1xuXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbChSRU9SREVSRURfREVTS1RPUF9YTUwsIFs0Ml0sIGRpYWxvZ1dpbmRvdyk7XG4gICAgcmVzb2x2ZWQucmVhc29uLnNob3VsZC5lcWwoJ29rJyk7XG4gICAgcmVzb2x2ZWQueG1sLnNob3VsZC5jb250YWluKCdFbnRlciB0aGUgbmFtZSBvZiB0aGUgQ29ubmVjdGlvbiBTZXJ2ZXInKTtcbiAgICByZXNvbHZlZC54bWwuc2hvdWxkLm5vdC5jb250YWluKCdOZXcgU2VydmVyJyk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgcmVkaXJlY3QgYSBmcmFtZSBoYW5kbGUgdG8gYW4gYWN0aXZlIHRyYW5zaWVudCBvdmVybGF5IGZvciBtb2RhbCBwcm9tcHRzJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IG1vZGFsRGVza3RvcFhtbCA9IGBcbjxkZXNrdG9wPlxuICA8ZnJhbWUgcGlkPVwiNDJcIiBuYW1lPVwiQXpXaW4xMUNsaVwiIGNsYXNzPVwiR3RrV2luZG93XCIgc3RhdGVzPVwiW0FDVElWRSxTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMCwyMCwxMDAwLDcwMF1cIiB3aW5kb3ctdHlwZT1cIm5vcm1hbFwiPlxuICAgIDxtZW51IG5hbWU9XCJDb25uZWN0aW9uXCIgcmVjdD1cIlsyMCwzMCwxMjAsMzBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9mcmFtZT5cbiAgPGFsZXJ0IHBpZD1cIjQyXCIgbmFtZT1cIlF1ZXN0aW9uXCIgY2xhc3M9XCJHdGtNZXNzYWdlRGlhbG9nXCIgc3RhdGVzPVwiW0FDVElWRSxFTkFCTEVELE1PREFMLFNIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzIxMCwxODAsNDIwLDE4MF1cIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiPlxuICAgIDxsYWJlbCBuYW1lPVwiTG9nIE9mZiBEZXNrdG9wXCIgcmVjdD1cIlsyMzAsMjAwLDE4MCwyNl1cIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgICA8cHVzaC1idXR0b24gbmFtZT1cIkxvZyBPZmZcIiByZWN0PVwiWzQ3MCwzMTAsMTIwLDM2XVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvYWxlcnQ+XG48L2Rlc2t0b3A+XG4gICAgYDtcbiAgICBjb25zdCB7d2luZG93c30gPSBtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzKGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyhtb2RhbERlc2t0b3BYbWwsIFs0Ml0pKTtcbiAgICBjb25zdCBmcmFtZVdpbmRvdyA9IHdpbmRvd3MuZmluZCgod2luZG93KSA9PiB3aW5kb3cubmFtZSA9PT0gJ0F6V2luMTFDbGknKTtcbiAgICBzaG91bGQuZXhpc3QoZnJhbWVXaW5kb3cpO1xuICAgIGlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlKGZyYW1lV2luZG93KS5zaG91bGQuZXFsKGZhbHNlKTtcblxuICAgIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwobW9kYWxEZXNrdG9wWG1sLCBbNDJdLCBmcmFtZVdpbmRvdywge1xuICAgICAgYWxsb3dUcmFuc2llbnRPdmVybGF5OiB0cnVlLFxuICAgIH0pO1xuICAgIHJlc29sdmVkLnJlYXNvbi5zaG91bGQuZXFsKCdvaycpO1xuICAgIHJlc29sdmVkLnJlZGlyZWN0ZWRUb1RyYW5zaWVudE92ZXJsYXkuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICByZXNvbHZlZC5jYW5kaWRhdGUubmFtZS5zaG91bGQuZXFsKCdRdWVzdGlvbicpO1xuICAgIHJlc29sdmVkLnhtbC5zaG91bGQuY29udGFpbignTG9nIE9mZicpO1xuICAgIHJlc29sdmVkLnhtbC5zaG91bGQubm90LmNvbnRhaW4oJ0Nvbm5lY3Rpb24nKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCByZXBvcnQgYW1iaWd1aXR5IHdoZW4gbXVsdGlwbGUgc2NvcGVkIHdpbmRvdyBtYXRjaGVzIGFyZSBlcXVhbGx5IHZhbGlkJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFtYmlndW91c1htbCA9IGBcbjxkZXNrdG9wPlxuICA8ZGlhbG9nIHBpZD1cIjQyXCIgbmFtZT1cIkFkZCBTZXJ2ZXJcIiBjbGFzcz1cIkd0a0RpYWxvZ1wiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMjAsMTQwLDQyMCwyMjBdXCIgd2luZG93LXR5cGU9XCJkaWFsb2dcIj5cbiAgICA8dGV4dCBuYW1lPVwiU2VydmVyIEFcIiByZWN0PVwiWzE1MCwxODAsMjQwLDMwXVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvZGlhbG9nPlxuICA8ZGlhbG9nIHBpZD1cIjQyXCIgbmFtZT1cIkFkZCBTZXJ2ZXJcIiBjbGFzcz1cIkd0a0RpYWxvZ1wiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMjAsMTQwLDQyMCwyMjBdXCIgd2luZG93LXR5cGU9XCJkaWFsb2dcIj5cbiAgICA8dGV4dCBuYW1lPVwiU2VydmVyIEJcIiByZWN0PVwiWzE1MCwxODAsMjQwLDMwXVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvZGlhbG9nPlxuPC9kZXNrdG9wPlxuICAgIGA7XG4gICAgY29uc3QgdGFyZ2V0V2luZG93ID0ge1xuICAgICAgcGlkOiA0MixcbiAgICAgIHdpZDogMTAxLFxuICAgICAgbmFtZTogJ0FkZCBTZXJ2ZXInLFxuICAgICAgY2xhc3NOYW1lOiAnR3RrRGlhbG9nJyxcbiAgICAgIG5vZGVUYWc6ICdkaWFsb2cnLFxuICAgICAgd2luZG93VHlwZTogJ2RpYWxvZycsXG4gICAgICByZWN0OiB7eDogMTIwLCB5OiAxNDAsIHdpZHRoOiA0MjAsIGhlaWdodDogMjIwfSxcbiAgICAgIGlkZW50aXR5S2V5OiAnNDJ8ZGlhbG9nfGRpYWxvZ3xBZGQgU2VydmVyfEd0a0RpYWxvZ3w0MjB4MjIwJyxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbChhbWJpZ3VvdXNYbWwsIFs0Ml0sIHRhcmdldFdpbmRvdyk7XG4gICAgcmVzb2x2ZWQucmVhc29uLnNob3VsZC5lcWwoJ2FtYmlndW91cycpO1xuICAgIHJlc29sdmVkLnhtbC5zaG91bGQuZXFsKCcnKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBrZWVwIHdpbmRvdy1saWtlIGFsZXJ0IHJvb3RzIGV2ZW4gd2hlbiBwaWQgaXMgb25seSBwcmVzZW50IG9uIGRlc2NlbmRhbnRzJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFsZXJ0RGVza3RvcFhtbCA9IGBcbjxkZXNrdG9wPlxuICA8ZnJhbWUgcGlkPVwiNDJcIiBuYW1lPVwiT21uaXNzYSBIb3Jpem9uIENsaWVudFwiIGNsYXNzPVwiR3RrV2luZG93XCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzg2MywxNDIsNjQwLDU4NV1cIiB3aW5kb3ctdHlwZT1cIm5vcm1hbFwiLz5cbiAgPGFsZXJ0IG5hbWU9XCJJbmZvcm1hdGlvblwiIGNsYXNzPVwiR3RrQWxlcnRcIiBzdGF0ZXM9XCJbQUNUSVZFLEVOQUJMRUQsTU9EQUwsU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbODI0LDMzMSw3MTgsMjA3XVwiIHdpbmRvdy10eXBlPVwiZGlhbG9nXCI+XG4gICAgPGxhYmVsIHBpZD1cIjQyXCIgbmFtZT1cIkNvbm5lY3QgdG8gU2VydmVyXCIgcmVjdD1cIls4NjAsMzYwLDIwMCwzMl1cIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgICA8cHVzaC1idXR0b24gcGlkPVwiNDJcIiBuYW1lPVwiQ29ubmVjdCBJbnNlY3VyZWx5XCIgcmVjdD1cIlsxMTgwLDQ3MCwxODAsNDBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9hbGVydD5cbjwvZGVza3RvcD5cbiAgICBgO1xuXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyhhbGVydERlc2t0b3BYbWwsIFs0Ml0pO1xuICAgIGNvbnN0IG1hdGVyaWFsaXplZCA9IG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MoY2FuZGlkYXRlcyk7XG4gICAgY29uc3QgbmFtZXMgPSBtYXRlcmlhbGl6ZWQud2luZG93cy5tYXAoKHdpbmRvdykgPT4gd2luZG93Lm5hbWUpO1xuXG4gICAgbmFtZXMuc2hvdWxkLmluY2x1ZGUoJ0luZm9ybWF0aW9uJyk7XG4gICAgY29uc3QgYWxlcnRXaW5kb3cgPSBtYXRlcmlhbGl6ZWQud2luZG93cy5maW5kKCh3aW5kb3cpID0+IHdpbmRvdy5uYW1lID09PSAnSW5mb3JtYXRpb24nKTtcbiAgICBzaG91bGQuZXhpc3QoYWxlcnRXaW5kb3cpO1xuICAgIGFsZXJ0V2luZG93Lm5vZGVUYWcuc2hvdWxkLmVxbCgnYWxlcnQnKTtcbiAgICBhbGVydFdpbmRvdy5waWQuc2hvdWxkLmVxbCg0Mik7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIHdpbmRvdyBjb21tYW5kIGhlYWxpbmcnLCBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IFdJTkRPV19ISUVSQVJDSFlfWE1MID0gYFxuPHdpbmRvd3M+XG4gIDx3aW5kb3cgcGlkPVwiNDJcIiB3aWQ9XCIxMTFcIiBJbnB1dE91dHB1dD1cInRydWVcIiBuYW1lPVwiTWFpbiBXaW5kb3dcIiBjbGFzcz1cIkd0a1dpbmRvd1wiIHJlY3Q9XCJbMTAsMjAsODAwLDYwMF1cIiBzdGF0ZXM9XCJbQUNUSVZFLFNIT1dJTkcsVklTSUJMRV1cIiB0YWc9XCJmcmFtZVwiIHdpbmRvdy10eXBlPVwibm9ybWFsXCIvPlxuICA8d2luZG93IHBpZD1cIjQyXCIgd2lkPVwiMjIyXCIgSW5wdXRPdXRwdXQ9XCJ0cnVlXCIgbmFtZT1cIlVudHJ1c3RlZCBDb25uZWN0aW9uXCIgY2xhc3M9XCJHdGtBbGVydFwiIHJlY3Q9XCJbMjEwLDE2MCw0MjAsMjIwXVwiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIgdGFnPVwiYWxlcnRcIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiLz5cbiAgPHdpbmRvdyBwaWQ9XCI4NFwiIHdpZD1cIjMzM1wiIElucHV0T3V0cHV0PVwidHJ1ZVwiIG5hbWU9XCJBdHRhY2hlZCBXaW5kb3dcIiBjbGFzcz1cIkd0a1dpbmRvd1wiIHJlY3Q9XCJbMTAsMjAsODAwLDYwMF1cIiBzdGF0ZXM9XCJbQUNUSVZFLFNIT1dJTkcsVklTSUJMRV1cIiB0YWc9XCJmcmFtZVwiIHdpbmRvdy10eXBlPVwibm9ybWFsXCIvPlxuPC93aW5kb3dzPlxuICBgO1xuXG4gIGZ1bmN0aW9uIGJ1aWxkV2F5bGFuZEN0eCAoKSB7XG4gICAgY29uc3QgY3R4ID0ge1xuICAgICAgYXBwTmFtZTogJ2hvcml6b24tY2xpZW50JyxcbiAgICAgIGxpbnV4QmFja2VuZDogJ3dheWxhbmQnLFxuICAgICAgX2JhY2tlbmRBcGlzOiB7XG4gICAgICAgIGFwcF9ydW5uaW5nOiAoKSA9PiBbNDJdLFxuICAgICAgICBhcHBfZ2V0V2luZG93SGllcmFjaHk6ICgpID0+IFdJTkRPV19ISUVSQVJDSFlfWE1MLFxuICAgICAgfSxcbiAgICAgIF93aW46IHtwaWQ6IDQyLCB3aWQ6IDk5OSwgbmFtZTogJ0dvbmUnfSxcbiAgICB9O1xuICAgIGN0eC5nZXRXaW5kb3dIYW5kbGVzID0gd2luZG93Q29tbWFuZHMuZ2V0V2luZG93SGFuZGxlcy5iaW5kKGN0eCk7XG4gICAgY3R4Ll9nZXRXaW5kb3dIYW5kbGVzQ29yZSA9IHdpbmRvd0NvbW1hbmRzLl9nZXRXaW5kb3dIYW5kbGVzQ29yZS5iaW5kKGN0eCk7XG4gICAgY3R4Ll9nZXRXaW5BbmRQaWRfRnJvbVdpbklkID0gd2luZG93Q29tbWFuZHMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQuYmluZChjdHgpO1xuICAgIGN0eC5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgPSB3aW5kb3dDb21tYW5kcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cuYmluZChjdHgpO1xuICAgIGN0eC5nZXRXaW5kb3dIYW5kbGUgPSB3aW5kb3dDb21tYW5kcy5nZXRXaW5kb3dIYW5kbGUuYmluZChjdHgpO1xuICAgIGN0eC5fdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8gPSBmaW5kQ29tbWFuZHMuX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvLmJpbmQoY3R4KTtcbiAgICByZXR1cm4gY3R4O1xuICB9XG5cbiAgaXQoJ3Nob3VsZCBwcmlvcml0aXplIGFsZXJ0LWxpa2Ugd2luZG93cyBpbiB3YXlsYW5kIGhhbmRsZSBvcmRlcmluZycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguZ2V0V2luZG93SGFuZGxlcygpLnNob3VsZC5lcWwoWzIyMiwgMTExXSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgcmVjb3ZlciBjdXJyZW50IHdheWxhbmQgd2luZG93IGhhbmRsZSB3aGVuIHRoZSBzZWxlY3RlZCBvbmUgZGlzYXBwZWFycycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguZ2V0V2luZG93SGFuZGxlKCkuc2hvdWxkLmVxbCgyMjIpO1xuICAgIGN0eC5fd2luLndpZC5zaG91bGQuZXFsKDIyMik7XG4gICAgY3R4Ll93aW4ubmFtZS5zaG91bGQuZXFsKCdVbnRydXN0ZWQgQ29ubmVjdGlvbicpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGhlYWwgc3RhbGUgd2F5bGFuZCB3aW5kb3cgaW5mbyBkdXJpbmcgZWxlbWVudCBsb29rdXAgdmFsaWRhdGlvbicsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvKCkuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICBjdHguX3dpbi53aWQuc2hvdWxkLmVxbCgyMjIpO1xuICAgIGN0eC5fd2luLm5hbWUuc2hvdWxkLmVxbCgnVW50cnVzdGVkIENvbm5lY3Rpb24nKTtcbiAgfSk7XG5cbn0pO1xuXG5kZXNjcmliZSgnV2F5bGFuZCB0cmFuc2llbnQgc2VsZWN0b3Igcm91dGluZycsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCB1c2UgaGFuZGxlLXNjb3BlZCBoaWVyYXJjaHkgZm9yIHRyYW5zaWVudCB4cGF0aCBzZWxlY3RvcnMgb24gbm9ybWFsIHdpbmRvd3MnLCBmdW5jdGlvbiAoKSB7XG4gICAgbGV0IG5hdGl2ZUNhbGxzID0gMDtcbiAgICBsZXQgaGFuZGxlQ2FsbHMgPSAwO1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIGxpbnV4QmFja2VuZDogJ3dheWxhbmQnLFxuICAgICAgX3dpbjoge1xuICAgICAgICBwaWQ6IDQyLFxuICAgICAgICB3aWQ6IDExMSxcbiAgICAgICAgbmFtZTogJ0F6V2luMTFDbGknLFxuICAgICAgICB0YWc6ICdmcmFtZScsXG4gICAgICAgIHdpbmRvd1R5cGU6ICdub3JtYWwnLFxuICAgICAgfSxcbiAgICAgIF9jYWNoZTogbmV3IE1hcCgpLFxuICAgICAgX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvOiAoKSA9PiB0cnVlLFxuICAgICAgX2JhY2tlbmRBcGlzOiB7XG4gICAgICAgIGExMXlfY2xlYXJfY2FjaGU6ICgpID0+IHt9LFxuICAgICAgICBhMTF5X2dldFdpbmRvd1VpSGllcmFjaHk6ICgpID0+IHtcbiAgICAgICAgICBuYXRpdmVDYWxscyArPSAxO1xuICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgfSxcbiAgICAgICAgYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGU6ICgpID0+IHtcbiAgICAgICAgICBoYW5kbGVDYWxscyArPSAxO1xuICAgICAgICAgIHJldHVybiBgXG48YWxlcnQgbmFtZT1cIlF1ZXN0aW9uXCIgcGlkPVwiNDJcIiByZWN0PVwiWzIxMCwxODAsNDIwLDE4MF1cIiBzdGF0ZXM9XCJbQUNUSVZFLE1PREFMLFNIT1dJTkcsVklTSUJMRV1cIj5cbiAgPHB1c2gtYnV0dG9uIG5hbWU9XCJMb2cgT2ZmXCIgcmVjdD1cIls0NzAsMzEwLDEyMCwzNl1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuPC9hbGVydD5cbiAgICAgICAgICBgO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZmluZENvbW1hbmRzLmZpbmRFbE9yRWxzLmNhbGwoXG4gICAgICBjdHgsXG4gICAgICAneHBhdGgnLFxuICAgICAgXCIvL2FsZXJ0W0BuYW1lPSdRdWVzdGlvbiddLy9wdXNoLWJ1dHRvbltAbmFtZT0nTG9nIE9mZiddXCIsXG4gICAgICBmYWxzZSxcbiAgICAgIHVuZGVmaW5lZFxuICAgICk7XG5cbiAgICBzaG91bGQuZXhpc3QocmVzdWx0KTtcbiAgICBoYW5kbGVDYWxscy5zaG91bGQuZXFsKDEpO1xuICAgIG5hdGl2ZUNhbGxzLnNob3VsZC5lcWwoMSk7XG4gIH0pO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxJQUFBQSxLQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxHQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxHQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxLQUFBLEdBQUFKLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSSxNQUFBLEdBQUFKLE9BQUE7QUFDQSxJQUFBSyxXQUFBLEdBQUFMLE9BQUE7QUFDQSxJQUFBTSxjQUFBLEdBQUFOLE9BQUE7QUFDQSxJQUFBTyx1QkFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsdUJBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLFlBQUEsR0FBQVYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFVLEtBQUEsR0FBQVgsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFXLE9BQUEsR0FBQVosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFZLG1CQUFBLEdBQUFaLE9BQUE7QUFPQSxNQUFNYSxNQUFNLEdBQUdDLGFBQUksQ0FBQ0Qs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
