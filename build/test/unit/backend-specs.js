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
        a11y_getWindowUiHierachy: () => {
          nativeCalls += 1;
          return `
<frame name="AzWin11Cli" pid="42" rect="[0,0,1000,700]" states="[ACTIVE,SHOWING,VISIBLE]">
  <menu name="Connection" rect="[20,30,120,30]"/>
</frame>
          `;
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
    nativeCalls.should.eql(0);
  });
});require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC91bml0L2JhY2tlbmQtc3BlY3MuanMiLCJuYW1lcyI6WyJfY2hhaSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2ZzIiwiX29zIiwiX3BhdGgiLCJfaW5kZXgiLCJfdG9rZW5TdG9yZSIsIl9saW51eFBsYXRmb3JtIiwiX3dheWxhbmRQZXJtaXNzaW9uVXRpbHMiLCJfd2F5bGFuZFNjcmVlbnNob3RVdGlscyIsIl93YXlsYW5kQXBpcyIsIl9maW5kIiwiX3dpbmRvdyIsIl93YXlsYW5kV2luZG93VXRpbHMiLCJzaG91bGQiLCJjaGFpIiwid2l0aEVudiIsImtleSIsInZhbHVlIiwiZm4iLCJvbGQiLCJwcm9jZXNzIiwiZW52IiwidW5kZWZpbmVkIiwiZGVzY3JpYmUiLCJpdCIsInJlc29sdmVMaW51eEJhY2tlbmQiLCJsaW51eEJhY2tlbmQiLCJlcWwiLCJ0bXBQYXRoIiwicGF0aCIsImpvaW4iLCJvcyIsInRtcGRpciIsIkRhdGUiLCJub3ciLCJmcyIsImV4aXN0c1N5bmMiLCJ1bmxpbmtTeW5jIiwid3JpdGVXYXlsYW5kVG9rZW4iLCJkYXRhIiwicmVhZFdheWxhbmRUb2tlbiIsInRva2VuIiwiZXhpc3QiLCJ1cGRhdGVkQXQiLCJwYXJzZWQiLCJwYXJzZU9zUmVsZWFzZSIsIklEIiwiVkVSU0lPTl9JRCIsIklEX0xJS0UiLCJkaXN0cm8iLCJkZXRlY3RMaW51eERpc3Ryb0luZm8iLCJwbGF0Zm9ybSIsIm9zUmVsZWFzZVRleHQiLCJpc1JoZWxMaWtlIiwibWFqb3JWZXJzaW9uIiwiaXNTdXBwb3J0ZWRSaGVsTWFqb3IiLCJpc1VidW50dSIsImlzU3VwcG9ydGVkVWJ1bnR1TWFqb3IiLCJyZXMiLCJldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQiLCJYREdfU0VTU0lPTl9UWVBFIiwiV0FZTEFORF9ESVNQTEFZIiwiZGlzdHJvSW5mbyIsImhhc0NvbW1hbmQiLCJhdXRvU2hhcmVFbmFibGVkIiwiZXJyb3JzIiwibGVuZ3RoIiwiYmUiLCJncmVhdGVyVGhhbiIsImNvbnRhaW4iLCJnZXRXYXlsYW5kU2NyZWVuc2hvdFN0cmF0ZWdpZXMiLCJwb3J0YWxBdmFpbGFibGUiLCJoYXNHbm9tZVNjcmVlbnNob3QiLCJoYXNHcmltIiwibWVzc2FnZSIsImdldFdheWxhbmRTY3JlZW5zaG90RmFpbHVyZU1lc3NhZ2UiLCJncmFudEluZm8iLCJwYXJzZVdheWxhbmRHcmFudGVkRGV2aWNlcyIsImtleWJvYXJkQWxsb3dlZCIsInBvaW50ZXJBbGxvd2VkIiwiZW5zdXJlV2F5bGFuZFBvaW50ZXJQZXJtaXNzaW9uIiwidGhyb3ciLCJlcXVhbCIsImdyYW50ZWREZXZpY2VzIiwiYXBpcyIsIldheWxhbmRBcGlzIiwidGFwcGVkIiwiY29waWVkIiwia2V5Ym9hcmRfdGFwS2V5IiwiY2hhciIsImZsYWdzIiwicHVzaCIsImtleWJvYXJkX2NvcHkiLCJzdHIiLCJrZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlIiwibWFwIiwiZXZlcnkiLCJvYnNlcnZlZCIsIl90YXBFdmRldldpdGhNb2RzIiwiZXZkZXYiLCJtb2RzIiwiREVTS1RPUF9YTUwiLCJSRU9SREVSRURfREVTS1RPUF9YTUwiLCJmaXJzdENhbmRpZGF0ZXMiLCJleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMiLCJmaXJzdCIsIm1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJNYXAiLCJ3aW5kb3dzIiwid2luZG93IiwiaWRlbnRpdHlLZXkiLCJ3aWQiLCJzZWNvbmRDYW5kaWRhdGVzIiwic2Vjb25kIiwiZmlyc3RCeU5hbWUiLCJuYW1lIiwic2Vjb25kQnlOYW1lIiwiZ2V0IiwiZGlhbG9nV2luZG93IiwiZmluZCIsInJlc29sdmVkIiwicmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwiLCJyZWFzb24iLCJ4bWwiLCJub3QiLCJtb2RhbERlc2t0b3BYbWwiLCJmcmFtZVdpbmRvdyIsImlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlIiwiYWxsb3dUcmFuc2llbnRPdmVybGF5IiwicmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheSIsImNhbmRpZGF0ZSIsImFtYmlndW91c1htbCIsInRhcmdldFdpbmRvdyIsInBpZCIsImNsYXNzTmFtZSIsIm5vZGVUYWciLCJ3aW5kb3dUeXBlIiwicmVjdCIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJhbGVydERlc2t0b3BYbWwiLCJjYW5kaWRhdGVzIiwibWF0ZXJpYWxpemVkIiwibmFtZXMiLCJpbmNsdWRlIiwiYWxlcnRXaW5kb3ciLCJXSU5ET1dfSElFUkFSQ0hZX1hNTCIsImJ1aWxkV2F5bGFuZEN0eCIsImN0eCIsImFwcE5hbWUiLCJfYmFja2VuZEFwaXMiLCJhcHBfcnVubmluZyIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsIl93aW4iLCJnZXRXaW5kb3dIYW5kbGVzIiwid2luZG93Q29tbWFuZHMiLCJiaW5kIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQiLCJfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3ciLCJnZXRXaW5kb3dIYW5kbGUiLCJfdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8iLCJmaW5kQ29tbWFuZHMiLCJuYXRpdmVDYWxscyIsImhhbmRsZUNhbGxzIiwidGFnIiwiX2NhY2hlIiwiYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5IiwiYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGUiLCJyZXN1bHQiLCJmaW5kRWxPckVscyIsImNhbGwiXSwic291cmNlUm9vdCI6Ii4uLy4uLy4uIiwic291cmNlcyI6WyJ0ZXN0L3VuaXQvYmFja2VuZC1zcGVjcy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY2hhaSBmcm9tICdjaGFpJztcbmltcG9ydCBmcyBmcm9tICdmcyc7XG5pbXBvcnQgb3MgZnJvbSAnb3MnO1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyByZXNvbHZlTGludXhCYWNrZW5kIH0gZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL2luZGV4LmpzJztcbmltcG9ydCB7IHJlYWRXYXlsYW5kVG9rZW4sIHdyaXRlV2F5bGFuZFRva2VuIH0gZnJvbSAnLi4vLi4vbGliL2JhY2tlbmRzL3Rva2VuLXN0b3JlLmpzJztcbmltcG9ydCB7cGFyc2VPc1JlbGVhc2UsIGRldGVjdExpbnV4RGlzdHJvSW5mbywgZXZhbHVhdGVXYXlsYW5kUHJlZmxpZ2h0fSBmcm9tICcuLi8uLi9saWIvYmFja2VuZHMvbGludXgtcGxhdGZvcm0uanMnO1xuaW1wb3J0IHtlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24sIHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzfSBmcm9tICcuLi8uLi9saWIvYmFja2VuZHMvd2F5bGFuZC1wZXJtaXNzaW9uLXV0aWxzLmpzJztcbmltcG9ydCB7Z2V0V2F5bGFuZFNjcmVlbnNob3RTdHJhdGVnaWVzLCBnZXRXYXlsYW5kU2NyZWVuc2hvdEZhaWx1cmVNZXNzYWdlfSBmcm9tICcuLi8uLi9saWIvYmFja2VuZHMvd2F5bGFuZC1zY3JlZW5zaG90LXV0aWxzLmpzJztcbmltcG9ydCBXYXlsYW5kQXBpcyBmcm9tICcuLi8uLi9saWIvYmFja2VuZHMvd2F5bGFuZC1hcGlzLmpzJztcbmltcG9ydCBmaW5kQ29tbWFuZHMgZnJvbSAnLi4vLi4vbGliL2NvbW1hbmRzL2ZpbmQuanMnO1xuaW1wb3J0IHdpbmRvd0NvbW1hbmRzIGZyb20gJy4uLy4uL2xpYi9jb21tYW5kcy93aW5kb3cuanMnO1xuaW1wb3J0IHtcbiAgZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzLFxuICBpc1RyYW5zaWVudFdpbmRvd0NhbmRpZGF0ZSxcbiAgbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyxcbiAgcmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwsXG59IGZyb20gJy4uLy4uL2xpYi9iYWNrZW5kcy93YXlsYW5kLXdpbmRvdy11dGlscy5qcyc7XG5cbmNvbnN0IHNob3VsZCA9IGNoYWkuc2hvdWxkKCk7XG5cbmZ1bmN0aW9uIHdpdGhFbnYgKGtleSwgdmFsdWUsIGZuKSB7XG4gIGNvbnN0IG9sZCA9IHByb2Nlc3MuZW52W2tleV07XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkge1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudltrZXldO1xuICB9IGVsc2Uge1xuICAgIHByb2Nlc3MuZW52W2tleV0gPSB2YWx1ZTtcbiAgfVxuICB0cnkge1xuICAgIGZuKCk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG9sZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnZba2V5XTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5lbnZba2V5XSA9IG9sZDtcbiAgICB9XG4gIH1cbn1cblxuZGVzY3JpYmUoJ0xpbnV4IGJhY2tlbmQgc2VsZWN0aW9uJywgZnVuY3Rpb24gKCkge1xuICBpdCgnc2hvdWxkIGhvbm9yIGV4cGxpY2l0IGxpbnV4QmFja2VuZCBjYXBhYmlsaXR5JywgZnVuY3Rpb24gKCkge1xuICAgIHJlc29sdmVMaW51eEJhY2tlbmQoe2xpbnV4QmFja2VuZDogJ3gxMSd9KS5zaG91bGQuZXFsKCd4MTEnKTtcbiAgICByZXNvbHZlTGludXhCYWNrZW5kKHtsaW51eEJhY2tlbmQ6ICd3YXlsYW5kJ30pLnNob3VsZC5lcWwoJ3dheWxhbmQnKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBhdXRvLXNlbGVjdCB3YXlsYW5kIHdoZW4gWERHIHNlc3Npb24gc2F5cyB3YXlsYW5kJywgZnVuY3Rpb24gKCkge1xuICAgIHdpdGhFbnYoJ1hER19TRVNTSU9OX1RZUEUnLCAnd2F5bGFuZCcsICgpID0+IHtcbiAgICAgIHJlc29sdmVMaW51eEJhY2tlbmQoe2xpbnV4QmFja2VuZDogJ2F1dG8nfSkuc2hvdWxkLmVxbCgnd2F5bGFuZCcpO1xuICAgIH0pO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGF1dG8tc2VsZWN0IHgxMSB3aGVuIHdheWxhbmQgZW52IGlzIGFic2VudCcsIGZ1bmN0aW9uICgpIHtcbiAgICB3aXRoRW52KCdYREdfU0VTU0lPTl9UWVBFJywgbnVsbCwgKCkgPT4ge1xuICAgICAgd2l0aEVudignV0FZTEFORF9ESVNQTEFZJywgbnVsbCwgKCkgPT4ge1xuICAgICAgICByZXNvbHZlTGludXhCYWNrZW5kKHtsaW51eEJhY2tlbmQ6ICdhdXRvJ30pLnNob3VsZC5lcWwoJ3gxMScpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKCdXYXlsYW5kIHRva2VuIHN0b3JlJywgZnVuY3Rpb24gKCkge1xuICBpdCgnc2hvdWxkIHdyaXRlIGFuZCByZWFkIHJlc3RvcmUgdG9rZW4nLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgdG1wUGF0aCA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgYGFwcGl1bS1saW51eC1kcml2ZXItdG9rZW4tJHtEYXRlLm5vdygpfS5qc29uYCk7XG4gICAgaWYgKGZzLmV4aXN0c1N5bmModG1wUGF0aCkpIHtcbiAgICAgIGZzLnVubGlua1N5bmModG1wUGF0aCk7XG4gICAgfVxuXG4gICAgd3JpdGVXYXlsYW5kVG9rZW4odG1wUGF0aCwgJ3llbHAnLCAncmVzdG9yZS10b2tlbi0xJyk7XG4gICAgY29uc3QgZGF0YSA9IHJlYWRXYXlsYW5kVG9rZW4odG1wUGF0aCwgJ3llbHAnKTtcblxuICAgIGRhdGEudG9rZW4uc2hvdWxkLmVxbCgncmVzdG9yZS10b2tlbi0xJyk7XG4gICAgc2hvdWxkLmV4aXN0KGRhdGEudXBkYXRlZEF0KTtcblxuICAgIGlmIChmcy5leGlzdHNTeW5jKHRtcFBhdGgpKSB7XG4gICAgICBmcy51bmxpbmtTeW5jKHRtcFBhdGgpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ0xpbnV4IHBsYXRmb3JtIGhlbHBlcnMnLCBmdW5jdGlvbiAoKSB7XG4gIGl0KCdzaG91bGQgcGFyc2UgL2V0Yy9vcy1yZWxlYXNlIHN0eWxlIGNvbnRlbnQnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VPc1JlbGVhc2UoYFxuTkFNRT1cIlJlZCBIYXQgRW50ZXJwcmlzZSBMaW51eFwiXG5WRVJTSU9OX0lEPVwiOS40XCJcbklEPVwicmhlbFwiXG5JRF9MSUtFPVwiZmVkb3JhIGNlbnRvc1wiXG4gICAgYCk7XG4gICAgcGFyc2VkLklELnNob3VsZC5lcWwoJ3JoZWwnKTtcbiAgICBwYXJzZWQuVkVSU0lPTl9JRC5zaG91bGQuZXFsKCc5LjQnKTtcbiAgICBwYXJzZWQuSURfTElLRS5zaG91bGQuZXFsKCdmZWRvcmEgY2VudG9zJyk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgZGV0ZWN0IFJIRUwgZmFtaWx5IGFuZCBzdXBwb3J0ZWQgbWFqb3InLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgZGlzdHJvID0gZGV0ZWN0TGludXhEaXN0cm9JbmZvKHtcbiAgICAgIHBsYXRmb3JtOiAnbGludXgnLFxuICAgICAgZW52OiB7fSxcbiAgICAgIG9zUmVsZWFzZVRleHQ6ICdJRD1yaGVsXFxuVkVSU0lPTl9JRD1cIjkuM1wiXFxuUFJFVFRZX05BTUU9XCJSSEVMIDkuM1wiJyxcbiAgICB9KTtcbiAgICBkaXN0cm8uaXNSaGVsTGlrZS5zaG91bGQuZXFsKHRydWUpO1xuICAgIGRpc3Ryby5tYWpvclZlcnNpb24uc2hvdWxkLmVxbCg5KTtcbiAgICBkaXN0cm8uaXNTdXBwb3J0ZWRSaGVsTWFqb3Iuc2hvdWxkLmVxbCh0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBkZXRlY3QgVWJ1bnR1IDI2IGFzIGEgc3VwcG9ydGVkIFdheWxhbmQgdGFyZ2V0JywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGRpc3RybyA9IGRldGVjdExpbnV4RGlzdHJvSW5mbyh7XG4gICAgICBwbGF0Zm9ybTogJ2xpbnV4JyxcbiAgICAgIGVudjoge30sXG4gICAgICBvc1JlbGVhc2VUZXh0OiAnSUQ9dWJ1bnR1XFxuVkVSU0lPTl9JRD1cIjI2LjA0XCJcXG5QUkVUVFlfTkFNRT1cIlVidW50dSAyNi4wNCBMVFNcIicsXG4gICAgfSk7XG4gICAgZGlzdHJvLmlzVWJ1bnR1LnNob3VsZC5lcWwodHJ1ZSk7XG4gICAgZGlzdHJvLm1ham9yVmVyc2lvbi5zaG91bGQuZXFsKDI2KTtcbiAgICBkaXN0cm8uaXNTdXBwb3J0ZWRVYnVudHVNYWpvci5zaG91bGQuZXFsKHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIHByb2R1Y2UgYWN0aW9uYWJsZSBwcmVmbGlnaHQgZXJyb3JzIG9uIG1pc3NpbmcgUkhFTCBkZXBlbmRlbmNpZXMnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgZGlzdHJvID0gZGV0ZWN0TGludXhEaXN0cm9JbmZvKHtcbiAgICAgIHBsYXRmb3JtOiAnbGludXgnLFxuICAgICAgZW52OiB7fSxcbiAgICAgIG9zUmVsZWFzZVRleHQ6ICdJRD1yaGVsXFxuVkVSU0lPTl9JRD1cIjkuM1wiXFxuUFJFVFRZX05BTUU9XCJSSEVMIDkuM1wiJyxcbiAgICB9KTtcbiAgICBjb25zdCByZXMgPSBldmFsdWF0ZVdheWxhbmRQcmVmbGlnaHQoe1xuICAgICAgZW52OiB7XG4gICAgICAgIFhER19TRVNTSU9OX1RZUEU6ICd3YXlsYW5kJyxcbiAgICAgICAgV0FZTEFORF9ESVNQTEFZOiAnd2F5bGFuZC0wJyxcbiAgICAgIH0sXG4gICAgICBkaXN0cm9JbmZvOiBkaXN0cm8sXG4gICAgICBoYXNDb21tYW5kOiAoKSA9PiBmYWxzZSxcbiAgICAgIGF1dG9TaGFyZUVuYWJsZWQ6IHRydWUsXG4gICAgfSk7XG4gICAgcmVzLmVycm9ycy5sZW5ndGguc2hvdWxkLmJlLmdyZWF0ZXJUaGFuKDApO1xuICAgIHJlcy5lcnJvcnMuam9pbignXFxuJykuc2hvdWxkLmNvbnRhaW4oJ3N1ZG8gZG5mIGluc3RhbGwgLXkgeGRnLWRlc2t0b3AtcG9ydGFsIHhkZy1kZXNrdG9wLXBvcnRhbC1nbm9tZScpO1xuICAgIHJlcy5lcnJvcnMuam9pbignXFxuJykuc2hvdWxkLmNvbnRhaW4oJ3N1ZG8gZG5mIGluc3RhbGwgLXkgcGlwZXdpcmUgcGlwZXdpcmUtdXRpbHMnKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQgc2NyZWVuc2hvdCBzdHJhdGVneSBoZWxwZXJzJywgZnVuY3Rpb24gKCkge1xuICBpdCgnc2hvdWxkIHByaW9yaXRpemUgcG9ydGFsIHRoZW4gQ0xJIGZhbGxiYWNrcycsIGZ1bmN0aW9uICgpIHtcbiAgICBnZXRXYXlsYW5kU2NyZWVuc2hvdFN0cmF0ZWdpZXMoe1xuICAgICAgcG9ydGFsQXZhaWxhYmxlOiB0cnVlLFxuICAgICAgaGFzR25vbWVTY3JlZW5zaG90OiB0cnVlLFxuICAgICAgaGFzR3JpbTogdHJ1ZSxcbiAgICB9KS5zaG91bGQuZXFsKFsnZ25vbWUtc2NyZWVuc2hvdCcsICdwb3J0YWwnLCAnZ3JpbSddKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCByZXR1cm4gZXhwbGljaXQgZmFpbHVyZSBtZXNzYWdlIHdoZW4gbm8gc3RyYXRlZ3kgaXMgYXZhaWxhYmxlJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBnZXRXYXlsYW5kU2NyZWVuc2hvdEZhaWx1cmVNZXNzYWdlKHtcbiAgICAgIHBvcnRhbEF2YWlsYWJsZTogZmFsc2UsXG4gICAgICBoYXNHbm9tZVNjcmVlbnNob3Q6IGZhbHNlLFxuICAgICAgaGFzR3JpbTogZmFsc2UsXG4gICAgfSk7XG4gICAgc2hvdWxkLmV4aXN0KG1lc3NhZ2UpO1xuICAgIG1lc3NhZ2Uuc2hvdWxkLmNvbnRhaW4oJ3BvcnRhbC9nbm9tZS1zY3JlZW5zaG90L2dyaW0nKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQgcG9pbnRlciBwZXJtaXNzaW9ucycsIGZ1bmN0aW9uICgpIHtcbiAgaXQoJ3Nob3VsZCBwYXJzZSBncmFudGVkIGRldmljZXMgYW5kIGZhaWwgd2hlbiBwb2ludGVyIGlzIG1pc3NpbmcnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgZ3JhbnRJbmZvID0gcGFyc2VXYXlsYW5kR3JhbnRlZERldmljZXMoMSk7XG4gICAgZ3JhbnRJbmZvLmtleWJvYXJkQWxsb3dlZC5zaG91bGQuZXFsKHRydWUpO1xuICAgIGdyYW50SW5mby5wb2ludGVyQWxsb3dlZC5zaG91bGQuZXFsKGZhbHNlKTtcbiAgICAoKCkgPT4gZW5zdXJlV2F5bGFuZFBvaW50ZXJQZXJtaXNzaW9uKGdyYW50SW5mbykpLnNob3VsZC50aHJvdygnUE9JTlRFUiBwZXJtaXNzaW9uJyk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgZmFpbCB3aGVuIHBvcnRhbCBzdGFydCBkb2VzIG5vdCByZXBvcnQgZ3JhbnRlZCBkZXZpY2VzJywgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGdyYW50SW5mbyA9IHBhcnNlV2F5bGFuZEdyYW50ZWREZXZpY2VzKG51bGwpO1xuICAgIHNob3VsZC5lcXVhbChncmFudEluZm8uZ3JhbnRlZERldmljZXMsIG51bGwpO1xuICAgICgoKSA9PiBlbnN1cmVXYXlsYW5kUG9pbnRlclBlcm1pc3Npb24oZ3JhbnRJbmZvKSkuc2hvdWxkLnRocm93KCdkaWQgbm90IHJlcG9ydCBncmFudGVkIGRldmljZXMnKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQga2V5Ym9hcmQgdHlwaW5nJywgZnVuY3Rpb24gKCkge1xuICBpdCgnc2hvdWxkIHR5cGUgc3VwcG9ydGVkIEFTQ0lJIGRpcmVjdGx5IGJlZm9yZSB1c2luZyBjbGlwYm9hcmQgcGFzdGUnLCBhc3luYyBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgYXBpcyA9IG5ldyBXYXlsYW5kQXBpcygpO1xuICAgIGNvbnN0IHRhcHBlZCA9IFtdO1xuICAgIGxldCBjb3BpZWQgPSBudWxsO1xuXG4gICAgYXBpcy5rZXlib2FyZF90YXBLZXkgPSBmdW5jdGlvbiAoY2hhciwgZmxhZ3MpIHtcbiAgICAgIHRhcHBlZC5wdXNoKFtjaGFyLCBmbGFnc10pO1xuICAgIH07XG4gICAgYXBpcy5rZXlib2FyZF9jb3B5ID0gZnVuY3Rpb24gKHN0cikge1xuICAgICAgY29waWVkID0gc3RyO1xuICAgIH07XG5cbiAgICBhd2FpdCBhcGlzLmtleWJvYXJkX3R5cGVTdHJpbmdDb3B5UGFzdGUoJzEwLjQuMTM0LjIyMCcpO1xuXG4gICAgdGFwcGVkLm1hcCgoW2NoYXJdKSA9PiBjaGFyKS5qb2luKCcnKS5zaG91bGQuZXFsKCcxMC40LjEzNC4yMjAnKTtcbiAgICB0YXBwZWQuZXZlcnkoKFssIGZsYWdzXSkgPT4gZmxhZ3MgPT09IDApLnNob3VsZC5lcWwodHJ1ZSk7XG4gICAgc2hvdWxkLmVxdWFsKGNvcGllZCwgbnVsbCk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgc2VuZCBzaGlmdGVkIHN5bWJvbHMgYXMgZGlyZWN0IGtleSBldmVudHMnLCBhc3luYyBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgYXBpcyA9IG5ldyBXYXlsYW5kQXBpcygpO1xuICAgIGNvbnN0IHRhcHBlZCA9IFtdO1xuICAgIGxldCBjb3BpZWQgPSBudWxsO1xuXG4gICAgYXBpcy5rZXlib2FyZF90YXBLZXkgPSBmdW5jdGlvbiAoY2hhciwgZmxhZ3MpIHtcbiAgICAgIHRhcHBlZC5wdXNoKFtjaGFyLCBmbGFnc10pO1xuICAgIH07XG4gICAgYXBpcy5rZXlib2FyZF9jb3B5ID0gZnVuY3Rpb24gKHN0cikge1xuICAgICAgY29waWVkID0gc3RyO1xuICAgIH07XG5cbiAgICBhd2FpdCBhcGlzLmtleWJvYXJkX3R5cGVTdHJpbmdDb3B5UGFzdGUoJ0FkbWluaXN0cmF0b3JAY2FydGRldi5hdGwnKTtcblxuICAgIHRhcHBlZC5tYXAoKFtjaGFyXSkgPT4gY2hhcikuam9pbignJykuc2hvdWxkLmVxbCgnQWRtaW5pc3RyYXRvckBjYXJ0ZGV2LmF0bCcpO1xuICAgIHRhcHBlZC5ldmVyeSgoWywgZmxhZ3NdKSA9PiBmbGFncyA9PT0gMCkuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICBzaG91bGQuZXF1YWwoY29waWVkLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBhcHBseSBzaGlmdCB3aGVuIHR5cGluZyBAIGRpcmVjdGx5JywgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFwaXMgPSBuZXcgV2F5bGFuZEFwaXMoKTtcbiAgICBsZXQgb2JzZXJ2ZWQgPSBudWxsO1xuXG4gICAgYXBpcy5fdGFwRXZkZXZXaXRoTW9kcyA9IGZ1bmN0aW9uIChldmRldiwgbW9kcykge1xuICAgICAgb2JzZXJ2ZWQgPSB7ZXZkZXYsIG1vZHN9O1xuICAgIH07XG5cbiAgICBhd2FpdCBhcGlzLmtleWJvYXJkX3RhcEtleSgnQCcsIDApO1xuXG4gICAgb2JzZXJ2ZWQuc2hvdWxkLmVxbCh7ZXZkZXY6IDMsIG1vZHM6IFs0Ml19KTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCBmYWxsIGJhY2sgdG8gY2xpcGJvYXJkIHBhc3RlIGZvciB1bnN1cHBvcnRlZCBjaGFyYWN0ZXJzJywgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IGFwaXMgPSBuZXcgV2F5bGFuZEFwaXMoKTtcbiAgICBjb25zdCB0YXBwZWQgPSBbXTtcbiAgICBsZXQgY29waWVkID0gbnVsbDtcblxuICAgIGFwaXMua2V5Ym9hcmRfdGFwS2V5ID0gZnVuY3Rpb24gKGNoYXIsIGZsYWdzKSB7XG4gICAgICB0YXBwZWQucHVzaChbY2hhciwgZmxhZ3NdKTtcbiAgICB9O1xuICAgIGFwaXMua2V5Ym9hcmRfY29weSA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgICAgIGNvcGllZCA9IHN0cjtcbiAgICB9O1xuXG4gICAgYXdhaXQgYXBpcy5rZXlib2FyZF90eXBlU3RyaW5nQ29weVBhc3RlKCdQYXNzXFx1MjYwM3dvcmQnKTtcblxuICAgIGNvcGllZC5zaG91bGQuZXFsKCdQYXNzXFx1MjYwM3dvcmQnKTtcbiAgICB0YXBwZWQuc2hvdWxkLmVxbChbWyd2JywgNF1dKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQgd2luZG93IHNjb3BpbmcgaGVscGVycycsIGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgREVTS1RPUF9YTUwgPSBgXG48ZGVza3RvcD5cbiAgPGZyYW1lIHBpZD1cIjQyXCIgbmFtZT1cIk1haW4gV2luZG93XCIgY2xhc3M9XCJHdGtXaW5kb3dcIiBzdGF0ZXM9XCJbQUNUSVZFLFNIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEwLDIwLDgwMCw2MDBdXCIgd2luZG93LXR5cGU9XCJub3JtYWxcIj5cbiAgICA8cHVzaC1idXR0b24gbmFtZT1cIk5ldyBTZXJ2ZXJcIiByZWN0PVwiWzMwLDQwLDEyMCw0MF1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICA8L2ZyYW1lPlxuICA8cGFuZWwgcGlkPVwiNDJcIiBuYW1lPVwiTWFpbiBXaW5kb3dcIiBjbGFzcz1cIkd0a0JveFwiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIlsxMCwyMCw4MDAsNjAwXVwiPlxuICAgIDxsYWJlbCBuYW1lPVwiTWFpbiBXaW5kb3cgTGFiZWxcIiByZWN0PVwiWzQwLDYwLDE4MCwyMF1cIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9wYW5lbD5cbiAgPGRpYWxvZyBwaWQ9XCI0MlwiIG5hbWU9XCJBZGQgU2VydmVyXCIgY2xhc3M9XCJHdGtEaWFsb2dcIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbMTIwLDE0MCw0MjAsMjIwXVwiIHdpbmRvdy10eXBlPVwiZGlhbG9nXCI+XG4gICAgPHRleHQgbmFtZT1cIkVudGVyIHRoZSBuYW1lIG9mIHRoZSBDb25uZWN0aW9uIFNlcnZlclwiIHJlY3Q9XCJbMTUwLDE4MCwyNDAsMzBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9kaWFsb2c+XG48L2Rlc2t0b3A+XG4gIGA7XG5cbiAgY29uc3QgUkVPUkRFUkVEX0RFU0tUT1BfWE1MID0gYFxuPGRlc2t0b3A+XG4gIDxkaWFsb2cgcGlkPVwiNDJcIiBuYW1lPVwiQWRkIFNlcnZlclwiIGNsYXNzPVwiR3RrRGlhbG9nXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEyMCwxNDAsNDIwLDIyMF1cIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiPlxuICAgIDx0ZXh0IG5hbWU9XCJFbnRlciB0aGUgbmFtZSBvZiB0aGUgQ29ubmVjdGlvbiBTZXJ2ZXJcIiByZWN0PVwiWzE1MCwxODAsMjQwLDMwXVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvZGlhbG9nPlxuICA8ZnJhbWUgcGlkPVwiNDJcIiBuYW1lPVwiTWFpbiBXaW5kb3dcIiBjbGFzcz1cIkd0a1dpbmRvd1wiIHN0YXRlcz1cIltBQ1RJVkUsU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbMTAsMjAsODAwLDYwMF1cIiB3aW5kb3ctdHlwZT1cIm5vcm1hbFwiPlxuICAgIDxwdXNoLWJ1dHRvbiBuYW1lPVwiTmV3IFNlcnZlclwiIHJlY3Q9XCJbMzAsNDAsMTIwLDQwXVwiIHN0YXRlcz1cIltFTkFCTEVELFNIT1dJTkcsVklTSUJMRV1cIi8+XG4gIDwvZnJhbWU+XG48L2Rlc2t0b3A+XG4gIGA7XG5cbiAgaXQoJ3Nob3VsZCBrZWVwIHN5bnRoZXRpYyB3aW5kb3cgaGFuZGxlcyBzdGFibGUgYWNyb3NzIHJlZnJlc2hlcycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBmaXJzdENhbmRpZGF0ZXMgPSBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMoREVTS1RPUF9YTUwsIFs0Ml0pO1xuICAgIGNvbnN0IGZpcnN0ID0gbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyhmaXJzdENhbmRpZGF0ZXMpO1xuICAgIGNvbnN0IHByZXZpb3VzV2lkQnlJZGVudGl0eSA9IG5ldyBNYXAoZmlyc3Qud2luZG93cy5tYXAoKHdpbmRvdykgPT4gW3dpbmRvdy5pZGVudGl0eUtleSwgd2luZG93LndpZF0pKTtcblxuICAgIGNvbnN0IHNlY29uZENhbmRpZGF0ZXMgPSBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMoUkVPUkRFUkVEX0RFU0tUT1BfWE1MLCBbNDJdKTtcbiAgICBjb25zdCBzZWNvbmQgPSBtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzKHNlY29uZENhbmRpZGF0ZXMsIHByZXZpb3VzV2lkQnlJZGVudGl0eSk7XG5cbiAgICBjb25zdCBmaXJzdEJ5TmFtZSA9IG5ldyBNYXAoZmlyc3Qud2luZG93cy5tYXAoKHdpbmRvdykgPT4gW3dpbmRvdy5uYW1lLCB3aW5kb3cud2lkXSkpO1xuICAgIGNvbnN0IHNlY29uZEJ5TmFtZSA9IG5ldyBNYXAoc2Vjb25kLndpbmRvd3MubWFwKCh3aW5kb3cpID0+IFt3aW5kb3cubmFtZSwgd2luZG93LndpZF0pKTtcbiAgICBzZWNvbmRCeU5hbWUuZ2V0KCdNYWluIFdpbmRvdycpLnNob3VsZC5lcWwoZmlyc3RCeU5hbWUuZ2V0KCdNYWluIFdpbmRvdycpKTtcbiAgICBzZWNvbmRCeU5hbWUuZ2V0KCdBZGQgU2VydmVyJykuc2hvdWxkLmVxbChmaXJzdEJ5TmFtZS5nZXQoJ0FkZCBTZXJ2ZXInKSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgcmVzb2x2ZSBzY29wZWQgeG1sIGZvciB0aGUgc2VsZWN0ZWQgd2luZG93IG9ubHknLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3Qge3dpbmRvd3N9ID0gbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyhleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMoREVTS1RPUF9YTUwsIFs0Ml0pKTtcbiAgICBjb25zdCBkaWFsb2dXaW5kb3cgPSB3aW5kb3dzLmZpbmQoKHdpbmRvdykgPT4gd2luZG93Lm5hbWUgPT09ICdBZGQgU2VydmVyJyk7XG4gICAgc2hvdWxkLmV4aXN0KGRpYWxvZ1dpbmRvdyk7XG5cbiAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sKFJFT1JERVJFRF9ERVNLVE9QX1hNTCwgWzQyXSwgZGlhbG9nV2luZG93KTtcbiAgICByZXNvbHZlZC5yZWFzb24uc2hvdWxkLmVxbCgnb2snKTtcbiAgICByZXNvbHZlZC54bWwuc2hvdWxkLmNvbnRhaW4oJ0VudGVyIHRoZSBuYW1lIG9mIHRoZSBDb25uZWN0aW9uIFNlcnZlcicpO1xuICAgIHJlc29sdmVkLnhtbC5zaG91bGQubm90LmNvbnRhaW4oJ05ldyBTZXJ2ZXInKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3VsZCByZWRpcmVjdCBhIGZyYW1lIGhhbmRsZSB0byBhbiBhY3RpdmUgdHJhbnNpZW50IG92ZXJsYXkgZm9yIG1vZGFsIHByb21wdHMnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgbW9kYWxEZXNrdG9wWG1sID0gYFxuPGRlc2t0b3A+XG4gIDxmcmFtZSBwaWQ9XCI0MlwiIG5hbWU9XCJBeldpbjExQ2xpXCIgY2xhc3M9XCJHdGtXaW5kb3dcIiBzdGF0ZXM9XCJbQUNUSVZFLFNIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEwLDIwLDEwMDAsNzAwXVwiIHdpbmRvdy10eXBlPVwibm9ybWFsXCI+XG4gICAgPG1lbnUgbmFtZT1cIkNvbm5lY3Rpb25cIiByZWN0PVwiWzIwLDMwLDEyMCwzMF1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICA8L2ZyYW1lPlxuICA8YWxlcnQgcGlkPVwiNDJcIiBuYW1lPVwiUXVlc3Rpb25cIiBjbGFzcz1cIkd0a01lc3NhZ2VEaWFsb2dcIiBzdGF0ZXM9XCJbQUNUSVZFLEVOQUJMRUQsTU9EQUwsU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbMjEwLDE4MCw0MjAsMTgwXVwiIHdpbmRvdy10eXBlPVwiZGlhbG9nXCI+XG4gICAgPGxhYmVsIG5hbWU9XCJMb2cgT2ZmIERlc2t0b3BcIiByZWN0PVwiWzIzMCwyMDAsMTgwLDI2XVwiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICAgIDxwdXNoLWJ1dHRvbiBuYW1lPVwiTG9nIE9mZlwiIHJlY3Q9XCJbNDcwLDMxMCwxMjAsMzZdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9hbGVydD5cbjwvZGVza3RvcD5cbiAgICBgO1xuICAgIGNvbnN0IHt3aW5kb3dzfSA9IG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MoZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKG1vZGFsRGVza3RvcFhtbCwgWzQyXSkpO1xuICAgIGNvbnN0IGZyYW1lV2luZG93ID0gd2luZG93cy5maW5kKCh3aW5kb3cpID0+IHdpbmRvdy5uYW1lID09PSAnQXpXaW4xMUNsaScpO1xuICAgIHNob3VsZC5leGlzdChmcmFtZVdpbmRvdyk7XG4gICAgaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUoZnJhbWVXaW5kb3cpLnNob3VsZC5lcWwoZmFsc2UpO1xuXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbChtb2RhbERlc2t0b3BYbWwsIFs0Ml0sIGZyYW1lV2luZG93LCB7XG4gICAgICBhbGxvd1RyYW5zaWVudE92ZXJsYXk6IHRydWUsXG4gICAgfSk7XG4gICAgcmVzb2x2ZWQucmVhc29uLnNob3VsZC5lcWwoJ29rJyk7XG4gICAgcmVzb2x2ZWQucmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheS5zaG91bGQuZXFsKHRydWUpO1xuICAgIHJlc29sdmVkLmNhbmRpZGF0ZS5uYW1lLnNob3VsZC5lcWwoJ1F1ZXN0aW9uJyk7XG4gICAgcmVzb2x2ZWQueG1sLnNob3VsZC5jb250YWluKCdMb2cgT2ZmJyk7XG4gICAgcmVzb2x2ZWQueG1sLnNob3VsZC5ub3QuY29udGFpbignQ29ubmVjdGlvbicpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIHJlcG9ydCBhbWJpZ3VpdHkgd2hlbiBtdWx0aXBsZSBzY29wZWQgd2luZG93IG1hdGNoZXMgYXJlIGVxdWFsbHkgdmFsaWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgYW1iaWd1b3VzWG1sID0gYFxuPGRlc2t0b3A+XG4gIDxkaWFsb2cgcGlkPVwiNDJcIiBuYW1lPVwiQWRkIFNlcnZlclwiIGNsYXNzPVwiR3RrRGlhbG9nXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEyMCwxNDAsNDIwLDIyMF1cIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiPlxuICAgIDx0ZXh0IG5hbWU9XCJTZXJ2ZXIgQVwiIHJlY3Q9XCJbMTUwLDE4MCwyNDAsMzBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9kaWFsb2c+XG4gIDxkaWFsb2cgcGlkPVwiNDJcIiBuYW1lPVwiQWRkIFNlcnZlclwiIGNsYXNzPVwiR3RrRGlhbG9nXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiByZWN0PVwiWzEyMCwxNDAsNDIwLDIyMF1cIiB3aW5kb3ctdHlwZT1cImRpYWxvZ1wiPlxuICAgIDx0ZXh0IG5hbWU9XCJTZXJ2ZXIgQlwiIHJlY3Q9XCJbMTUwLDE4MCwyNDAsMzBdXCIgc3RhdGVzPVwiW0VOQUJMRUQsU0hPV0lORyxWSVNJQkxFXVwiLz5cbiAgPC9kaWFsb2c+XG48L2Rlc2t0b3A+XG4gICAgYDtcbiAgICBjb25zdCB0YXJnZXRXaW5kb3cgPSB7XG4gICAgICBwaWQ6IDQyLFxuICAgICAgd2lkOiAxMDEsXG4gICAgICBuYW1lOiAnQWRkIFNlcnZlcicsXG4gICAgICBjbGFzc05hbWU6ICdHdGtEaWFsb2cnLFxuICAgICAgbm9kZVRhZzogJ2RpYWxvZycsXG4gICAgICB3aW5kb3dUeXBlOiAnZGlhbG9nJyxcbiAgICAgIHJlY3Q6IHt4OiAxMjAsIHk6IDE0MCwgd2lkdGg6IDQyMCwgaGVpZ2h0OiAyMjB9LFxuICAgICAgaWRlbnRpdHlLZXk6ICc0MnxkaWFsb2d8ZGlhbG9nfEFkZCBTZXJ2ZXJ8R3RrRGlhbG9nfDQyMHgyMjAnLFxuICAgIH07XG5cbiAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sKGFtYmlndW91c1htbCwgWzQyXSwgdGFyZ2V0V2luZG93KTtcbiAgICByZXNvbHZlZC5yZWFzb24uc2hvdWxkLmVxbCgnYW1iaWd1b3VzJyk7XG4gICAgcmVzb2x2ZWQueG1sLnNob3VsZC5lcWwoJycpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGtlZXAgd2luZG93LWxpa2UgYWxlcnQgcm9vdHMgZXZlbiB3aGVuIHBpZCBpcyBvbmx5IHByZXNlbnQgb24gZGVzY2VuZGFudHMnLCBmdW5jdGlvbiAoKSB7XG4gICAgY29uc3QgYWxlcnREZXNrdG9wWG1sID0gYFxuPGRlc2t0b3A+XG4gIDxmcmFtZSBwaWQ9XCI0MlwiIG5hbWU9XCJPbW5pc3NhIEhvcml6b24gQ2xpZW50XCIgY2xhc3M9XCJHdGtXaW5kb3dcIiBzdGF0ZXM9XCJbU0hPV0lORyxWSVNJQkxFXVwiIHJlY3Q9XCJbODYzLDE0Miw2NDAsNTg1XVwiIHdpbmRvdy10eXBlPVwibm9ybWFsXCIvPlxuICA8YWxlcnQgbmFtZT1cIkluZm9ybWF0aW9uXCIgY2xhc3M9XCJHdGtBbGVydFwiIHN0YXRlcz1cIltBQ1RJVkUsRU5BQkxFRCxNT0RBTCxTSE9XSU5HLFZJU0lCTEVdXCIgcmVjdD1cIls4MjQsMzMxLDcxOCwyMDddXCIgd2luZG93LXR5cGU9XCJkaWFsb2dcIj5cbiAgICA8bGFiZWwgcGlkPVwiNDJcIiBuYW1lPVwiQ29ubmVjdCB0byBTZXJ2ZXJcIiByZWN0PVwiWzg2MCwzNjAsMjAwLDMyXVwiIHN0YXRlcz1cIltTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICAgIDxwdXNoLWJ1dHRvbiBwaWQ9XCI0MlwiIG5hbWU9XCJDb25uZWN0IEluc2VjdXJlbHlcIiByZWN0PVwiWzExODAsNDcwLDE4MCw0MF1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuICA8L2FsZXJ0PlxuPC9kZXNrdG9wPlxuICAgIGA7XG5cbiAgICBjb25zdCBjYW5kaWRhdGVzID0gZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzKGFsZXJ0RGVza3RvcFhtbCwgWzQyXSk7XG4gICAgY29uc3QgbWF0ZXJpYWxpemVkID0gbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyhjYW5kaWRhdGVzKTtcbiAgICBjb25zdCBuYW1lcyA9IG1hdGVyaWFsaXplZC53aW5kb3dzLm1hcCgod2luZG93KSA9PiB3aW5kb3cubmFtZSk7XG5cbiAgICBuYW1lcy5zaG91bGQuaW5jbHVkZSgnSW5mb3JtYXRpb24nKTtcbiAgICBjb25zdCBhbGVydFdpbmRvdyA9IG1hdGVyaWFsaXplZC53aW5kb3dzLmZpbmQoKHdpbmRvdykgPT4gd2luZG93Lm5hbWUgPT09ICdJbmZvcm1hdGlvbicpO1xuICAgIHNob3VsZC5leGlzdChhbGVydFdpbmRvdyk7XG4gICAgYWxlcnRXaW5kb3cubm9kZVRhZy5zaG91bGQuZXFsKCdhbGVydCcpO1xuICAgIGFsZXJ0V2luZG93LnBpZC5zaG91bGQuZXFsKDQyKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQgd2luZG93IGNvbW1hbmQgaGVhbGluZycsIGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgV0lORE9XX0hJRVJBUkNIWV9YTUwgPSBgXG48d2luZG93cz5cbiAgPHdpbmRvdyBwaWQ9XCI0MlwiIHdpZD1cIjExMVwiIElucHV0T3V0cHV0PVwidHJ1ZVwiIG5hbWU9XCJNYWluIFdpbmRvd1wiIGNsYXNzPVwiR3RrV2luZG93XCIgcmVjdD1cIlsxMCwyMCw4MDAsNjAwXVwiIHN0YXRlcz1cIltBQ1RJVkUsU0hPV0lORyxWSVNJQkxFXVwiIHRhZz1cImZyYW1lXCIgd2luZG93LXR5cGU9XCJub3JtYWxcIi8+XG4gIDx3aW5kb3cgcGlkPVwiNDJcIiB3aWQ9XCIyMjJcIiBJbnB1dE91dHB1dD1cInRydWVcIiBuYW1lPVwiVW50cnVzdGVkIENvbm5lY3Rpb25cIiBjbGFzcz1cIkd0a0FsZXJ0XCIgcmVjdD1cIlsyMTAsMTYwLDQyMCwyMjBdXCIgc3RhdGVzPVwiW1NIT1dJTkcsVklTSUJMRV1cIiB0YWc9XCJhbGVydFwiIHdpbmRvdy10eXBlPVwiZGlhbG9nXCIvPlxuPC93aW5kb3dzPlxuICBgO1xuXG4gIGZ1bmN0aW9uIGJ1aWxkV2F5bGFuZEN0eCAoKSB7XG4gICAgY29uc3QgY3R4ID0ge1xuICAgICAgYXBwTmFtZTogJ2hvcml6b24tY2xpZW50JyxcbiAgICAgIGxpbnV4QmFja2VuZDogJ3dheWxhbmQnLFxuICAgICAgX2JhY2tlbmRBcGlzOiB7XG4gICAgICAgIGFwcF9ydW5uaW5nOiAoKSA9PiBbNDJdLFxuICAgICAgICBhcHBfZ2V0V2luZG93SGllcmFjaHk6ICgpID0+IFdJTkRPV19ISUVSQVJDSFlfWE1MLFxuICAgICAgfSxcbiAgICAgIF93aW46IHtwaWQ6IDQyLCB3aWQ6IDk5OSwgbmFtZTogJ0dvbmUnfSxcbiAgICB9O1xuICAgIGN0eC5nZXRXaW5kb3dIYW5kbGVzID0gd2luZG93Q29tbWFuZHMuZ2V0V2luZG93SGFuZGxlcy5iaW5kKGN0eCk7XG4gICAgY3R4Ll9nZXRXaW5BbmRQaWRfRnJvbVdpbklkID0gd2luZG93Q29tbWFuZHMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQuYmluZChjdHgpO1xuICAgIGN0eC5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgPSB3aW5kb3dDb21tYW5kcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cuYmluZChjdHgpO1xuICAgIGN0eC5nZXRXaW5kb3dIYW5kbGUgPSB3aW5kb3dDb21tYW5kcy5nZXRXaW5kb3dIYW5kbGUuYmluZChjdHgpO1xuICAgIGN0eC5fdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8gPSBmaW5kQ29tbWFuZHMuX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvLmJpbmQoY3R4KTtcbiAgICByZXR1cm4gY3R4O1xuICB9XG5cbiAgaXQoJ3Nob3VsZCBwcmlvcml0aXplIGFsZXJ0LWxpa2Ugd2luZG93cyBpbiB3YXlsYW5kIGhhbmRsZSBvcmRlcmluZycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguZ2V0V2luZG93SGFuZGxlcygpLnNob3VsZC5lcWwoWzIyMiwgMTExXSk7XG4gIH0pO1xuXG4gIGl0KCdzaG91bGQgcmVjb3ZlciBjdXJyZW50IHdheWxhbmQgd2luZG93IGhhbmRsZSB3aGVuIHRoZSBzZWxlY3RlZCBvbmUgZGlzYXBwZWFycycsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguZ2V0V2luZG93SGFuZGxlKCkuc2hvdWxkLmVxbCgyMjIpO1xuICAgIGN0eC5fd2luLndpZC5zaG91bGQuZXFsKDIyMik7XG4gICAgY3R4Ll93aW4ubmFtZS5zaG91bGQuZXFsKCdVbnRydXN0ZWQgQ29ubmVjdGlvbicpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkIGhlYWwgc3RhbGUgd2F5bGFuZCB3aW5kb3cgaW5mbyBkdXJpbmcgZWxlbWVudCBsb29rdXAgdmFsaWRhdGlvbicsIGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBjdHggPSBidWlsZFdheWxhbmRDdHgoKTtcbiAgICBjdHguX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvKCkuc2hvdWxkLmVxbCh0cnVlKTtcbiAgICBjdHguX3dpbi53aWQuc2hvdWxkLmVxbCgyMjIpO1xuICAgIGN0eC5fd2luLm5hbWUuc2hvdWxkLmVxbCgnVW50cnVzdGVkIENvbm5lY3Rpb24nKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1dheWxhbmQgdHJhbnNpZW50IHNlbGVjdG9yIHJvdXRpbmcnLCBmdW5jdGlvbiAoKSB7XG4gIGl0KCdzaG91bGQgdXNlIGhhbmRsZS1zY29wZWQgaGllcmFyY2h5IGZvciB0cmFuc2llbnQgeHBhdGggc2VsZWN0b3JzIG9uIG5vcm1hbCB3aW5kb3dzJywgZnVuY3Rpb24gKCkge1xuICAgIGxldCBuYXRpdmVDYWxscyA9IDA7XG4gICAgbGV0IGhhbmRsZUNhbGxzID0gMDtcbiAgICBjb25zdCBjdHggPSB7XG4gICAgICBsaW51eEJhY2tlbmQ6ICd3YXlsYW5kJyxcbiAgICAgIF93aW46IHtcbiAgICAgICAgcGlkOiA0MixcbiAgICAgICAgd2lkOiAxMTEsXG4gICAgICAgIG5hbWU6ICdBeldpbjExQ2xpJyxcbiAgICAgICAgdGFnOiAnZnJhbWUnLFxuICAgICAgICB3aW5kb3dUeXBlOiAnbm9ybWFsJyxcbiAgICAgIH0sXG4gICAgICBfY2FjaGU6IG5ldyBNYXAoKSxcbiAgICAgIF92YWxpZGF0ZU9yVXBkYXRlV2luSW5mbzogKCkgPT4gdHJ1ZSxcbiAgICAgIF9iYWNrZW5kQXBpczoge1xuICAgICAgICBhMTF5X2dldFdpbmRvd1VpSGllcmFjaHk6ICgpID0+IHtcbiAgICAgICAgICBuYXRpdmVDYWxscyArPSAxO1xuICAgICAgICAgIHJldHVybiBgXG48ZnJhbWUgbmFtZT1cIkF6V2luMTFDbGlcIiBwaWQ9XCI0MlwiIHJlY3Q9XCJbMCwwLDEwMDAsNzAwXVwiIHN0YXRlcz1cIltBQ1RJVkUsU0hPV0lORyxWSVNJQkxFXVwiPlxuICA8bWVudSBuYW1lPVwiQ29ubmVjdGlvblwiIHJlY3Q9XCJbMjAsMzAsMTIwLDMwXVwiLz5cbjwvZnJhbWU+XG4gICAgICAgICAgYDtcbiAgICAgICAgfSxcbiAgICAgICAgYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGU6ICgpID0+IHtcbiAgICAgICAgICBoYW5kbGVDYWxscyArPSAxO1xuICAgICAgICAgIHJldHVybiBgXG48YWxlcnQgbmFtZT1cIlF1ZXN0aW9uXCIgcGlkPVwiNDJcIiByZWN0PVwiWzIxMCwxODAsNDIwLDE4MF1cIiBzdGF0ZXM9XCJbQUNUSVZFLE1PREFMLFNIT1dJTkcsVklTSUJMRV1cIj5cbiAgPHB1c2gtYnV0dG9uIG5hbWU9XCJMb2cgT2ZmXCIgcmVjdD1cIls0NzAsMzEwLDEyMCwzNl1cIiBzdGF0ZXM9XCJbRU5BQkxFRCxTSE9XSU5HLFZJU0lCTEVdXCIvPlxuPC9hbGVydD5cbiAgICAgICAgICBgO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZmluZENvbW1hbmRzLmZpbmRFbE9yRWxzLmNhbGwoXG4gICAgICBjdHgsXG4gICAgICAneHBhdGgnLFxuICAgICAgXCIvL2FsZXJ0W0BuYW1lPSdRdWVzdGlvbiddLy9wdXNoLWJ1dHRvbltAbmFtZT0nTG9nIE9mZiddXCIsXG4gICAgICBmYWxzZSxcbiAgICAgIHVuZGVmaW5lZFxuICAgICk7XG5cbiAgICBzaG91bGQuZXhpc3QocmVzdWx0KTtcbiAgICBoYW5kbGVDYWxscy5zaG91bGQuZXFsKDEpO1xuICAgIG5hdGl2ZUNhbGxzLnNob3VsZC5lcWwoMCk7XG4gIH0pO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxJQUFBQSxLQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxHQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxHQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxLQUFBLEdBQUFKLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSSxNQUFBLEdBQUFKLE9BQUE7QUFDQSxJQUFBSyxXQUFBLEdBQUFMLE9BQUE7QUFDQSxJQUFBTSxjQUFBLEdBQUFOLE9BQUE7QUFDQSxJQUFBTyx1QkFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsdUJBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLFlBQUEsR0FBQVYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFVLEtBQUEsR0FBQVgsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFXLE9BQUEsR0FBQVosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFZLG1CQUFBLEdBQUFaLE9BQUE7QUFPQSxNQUFNYSxNQUFNLEdBQUdDLGFBQUksQ0FBQ0QsTUFBTSxDQUFDLENBQUM7QUFFNUIsU0FBU0UsT0FBT0EsQ0FBRUMsR0FBRyxFQUFFQyxLQUFLLEVBQUVDLEVBQUUsRUFBRTtFQUNoQyxNQUFNQyxHQUFHLEdBQUdDLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDTCxHQUFHLENBQUM7RUFDNUIsSUFBSUMsS0FBSyxLQUFLLElBQUksRUFBRTtJQUNsQixPQUFPRyxPQUFPLENBQUNDLEdBQUcsQ0FBQ0wsR0FBRyxDQUFDO0VBQ3pCLENBQUMsTUFBTTtJQUNMSSxPQUFPLENBQUNDLEdBQUcsQ0FBQ0wsR0FBRyxDQUFDLEdBQUdDLEtB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
