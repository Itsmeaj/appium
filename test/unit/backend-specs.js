import chai from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveLinuxBackend } from '../../lib/backends/index.js';
import { readWaylandToken, writeWaylandToken } from '../../lib/backends/token-store.js';
import {parseOsRelease, detectLinuxDistroInfo, evaluateWaylandPreflight} from '../../lib/backends/linux-platform.js';
import {ensureWaylandPointerPermission, parseWaylandGrantedDevices} from '../../lib/backends/wayland-permission-utils.js';
import {getWaylandScreenshotStrategies, getWaylandScreenshotFailureMessage} from '../../lib/backends/wayland-screenshot-utils.js';
import WaylandApis from '../../lib/backends/wayland-apis.js';
import findCommands from '../../lib/commands/find.js';
import windowCommands from '../../lib/commands/window.js';
import {
  extractWaylandWindowCandidates,
  isTransientWindowCandidate,
  materializeWaylandWindows,
  resolveWaylandScopedWindowXml,
} from '../../lib/backends/wayland-window-utils.js';

const should = chai.should();

function withEnv (key, value, fn) {
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
    resolveLinuxBackend({linuxBackend: 'x11'}).should.eql('x11');
    resolveLinuxBackend({linuxBackend: 'wayland'}).should.eql('wayland');
  });

  it('should auto-select wayland when XDG session says wayland', function () {
    withEnv('XDG_SESSION_TYPE', 'wayland', () => {
      resolveLinuxBackend({linuxBackend: 'auto'}).should.eql('wayland');
    });
  });

  it('should auto-select x11 when wayland env is absent', function () {
    withEnv('XDG_SESSION_TYPE', null, () => {
      withEnv('WAYLAND_DISPLAY', null, () => {
        resolveLinuxBackend({linuxBackend: 'auto'}).should.eql('x11');
      });
    });
  });
});

describe('Wayland token store', function () {
  it('should write and read restore token', function () {
    const tmpPath = path.join(os.tmpdir(), `appium-linux-driver-token-${Date.now()}.json`);
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }

    writeWaylandToken(tmpPath, 'yelp', 'restore-token-1');
    const data = readWaylandToken(tmpPath, 'yelp');

    data.token.should.eql('restore-token-1');
    should.exist(data.updatedAt);

    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  });
});

describe('Linux platform helpers', function () {
  it('should parse /etc/os-release style content', function () {
    const parsed = parseOsRelease(`
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
    const distro = detectLinuxDistroInfo({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=rhel\nVERSION_ID="9.3"\nPRETTY_NAME="RHEL 9.3"',
    });
    distro.isRhelLike.should.eql(true);
    distro.majorVersion.should.eql(9);
    distro.isSupportedRhelMajor.should.eql(true);
  });

  it('should detect Ubuntu 26 as a supported Wayland target', function () {
    const distro = detectLinuxDistroInfo({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"',
    });
    distro.isUbuntu.should.eql(true);
    distro.majorVersion.should.eql(26);
    distro.isSupportedUbuntuMajor.should.eql(true);
  });

  it('should produce actionable preflight errors on missing RHEL dependencies', function () {
    const distro = detectLinuxDistroInfo({
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=rhel\nVERSION_ID="9.3"\nPRETTY_NAME="RHEL 9.3"',
    });
    const res = evaluateWaylandPreflight({
      env: {
        XDG_SESSION_TYPE: 'wayland',
        WAYLAND_DISPLAY: 'wayland-0',
      },
      distroInfo: distro,
      hasCommand: () => false,
      autoShareEnabled: true,
    });
    res.errors.length.should.be.greaterThan(0);
    res.errors.join('\n').should.contain('sudo dnf install -y xdg-desktop-portal xdg-desktop-portal-gnome');
    res.errors.join('\n').should.contain('sudo dnf install -y pipewire pipewire-utils');
  });
});

describe('Wayland screenshot strategy helpers', function () {
  it('should prioritize portal then CLI fallbacks', function () {
    getWaylandScreenshotStrategies({
      portalAvailable: true,
      hasGnomeScreenshot: true,
      hasGrim: true,
    }).should.eql(['gnome-screenshot', 'portal', 'grim']);
  });

  it('should return explicit failure message when no strategy is available', function () {
    const message = getWaylandScreenshotFailureMessage({
      portalAvailable: false,
      hasGnomeScreenshot: false,
      hasGrim: false,
    });
    should.exist(message);
    message.should.contain('portal/gnome-screenshot/grim');
  });
});

describe('Wayland pointer permissions', function () {
  it('should parse granted devices and fail when pointer is missing', function () {
    const grantInfo = parseWaylandGrantedDevices(1);
    grantInfo.keyboardAllowed.should.eql(true);
    grantInfo.pointerAllowed.should.eql(false);
    (() => ensureWaylandPointerPermission(grantInfo)).should.throw('POINTER permission');
  });

  it('should fail when portal start does not report granted devices', function () {
    const grantInfo = parseWaylandGrantedDevices(null);
    should.equal(grantInfo.grantedDevices, null);
    (() => ensureWaylandPointerPermission(grantInfo)).should.throw('did not report granted devices');
  });
});

describe('Wayland keyboard typing', function () {
  it('should type supported ASCII directly before using clipboard paste', async function () {
    const apis = new WaylandApis();
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
    const apis = new WaylandApis();
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
    const apis = new WaylandApis();
    let observed = null;

    apis._tapEvdevWithMods = function (evdev, mods) {
      observed = {evdev, mods};
    };

    await apis.keyboard_tapKey('@', 0);

    observed.should.eql({evdev: 3, mods: [42]});
  });

  it('should fall back to clipboard paste for unsupported characters', async function () {
    const apis = new WaylandApis();
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
    const firstCandidates = extractWaylandWindowCandidates(DESKTOP_XML, [42]);
    const first = materializeWaylandWindows(firstCandidates);
    const previousWidByIdentity = new Map(first.windows.map((window) => [window.identityKey, window.wid]));

    const secondCandidates = extractWaylandWindowCandidates(REORDERED_DESKTOP_XML, [42]);
    const second = materializeWaylandWindows(secondCandidates, previousWidByIdentity);

    const firstByName = new Map(first.windows.map((window) => [window.name, window.wid]));
    const secondByName = new Map(second.windows.map((window) => [window.name, window.wid]));
    secondByName.get('Main Window').should.eql(firstByName.get('Main Window'));
    secondByName.get('Add Server').should.eql(firstByName.get('Add Server'));
  });

  it('should resolve scoped xml for the selected window only', function () {
    const {windows} = materializeWaylandWindows(extractWaylandWindowCandidates(DESKTOP_XML, [42]));
    const dialogWindow = windows.find((window) => window.name === 'Add Server');
    should.exist(dialogWindow);

    const resolved = resolveWaylandScopedWindowXml(REORDERED_DESKTOP_XML, [42], dialogWindow);
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
    const {windows} = materializeWaylandWindows(extractWaylandWindowCandidates(modalDesktopXml, [42]));
    const frameWindow = windows.find((window) => window.name === 'AzWin11Cli');
    should.exist(frameWindow);
    isTransientWindowCandidate(frameWindow).should.eql(false);

    const resolved = resolveWaylandScopedWindowXml(modalDesktopXml, [42], frameWindow, {
      allowTransientOverlay: true,
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
      rect: {x: 120, y: 140, width: 420, height: 220},
      identityKey: '42|dialog|dialog|Add Server|GtkDialog|420x220',
    };

    const resolved = resolveWaylandScopedWindowXml(ambiguousXml, [42], targetWindow);
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

    const candidates = extractWaylandWindowCandidates(alertDesktopXml, [42]);
    const materialized = materializeWaylandWindows(candidates);
    const names = materialized.windows.map((window) => window.name);

    names.should.include('Information');
    const alertWindow = materialized.windows.find((window) => window.name === 'Information');
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

  function buildWaylandCtx () {
    const ctx = {
      appName: 'horizon-client',
      linuxBackend: 'wayland',
      _backendApis: {
        app_running: () => [42],
        app_getWindowHierachy: () => WINDOW_HIERARCHY_XML,
      },
      _win: {pid: 42, wid: 999, name: 'Gone'},
    };
    ctx.getWindowHandles = windowCommands.getWindowHandles.bind(ctx);
    ctx._getWinAndPid_FromWinId = windowCommands._getWinAndPid_FromWinId.bind(ctx);
    ctx._resolveBestAvailableWindow = windowCommands._resolveBestAvailableWindow.bind(ctx);
    ctx.getWindowHandle = windowCommands.getWindowHandle.bind(ctx);
    ctx._validateOrUpdateWinInfo = findCommands._validateOrUpdateWinInfo.bind(ctx);
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
        windowType: 'normal',
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
        },
      },
    };

    const result = findCommands.findElOrEls.call(
      ctx,
      'xpath',
      "//alert[@name='Question']//push-button[@name='Log Off']",
      false,
      undefined
    );

    should.exist(result);
    handleCalls.should.eql(1);
    nativeCalls.should.eql(0);
  });
});
