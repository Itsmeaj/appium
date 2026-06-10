import fs from 'fs';
import {detectLinuxDistroInfo, formatDistroLabel} from './linux-platform.js';

const BACKEND_AUTO = 'auto';
const BACKEND_X11 = 'x11';
const BACKEND_WAYLAND = 'wayland';
const X11_SHARED_LIB_PATH = '/usr/local/lib/libstdspalinux.so';

function readCap (caps, name) {
  return caps?.[name] ?? caps?.[`appium:${name}`] ?? null;
}

function resolveLinuxBackend (caps = {}) {
  const rawBackend = (readCap(caps, 'linuxBackend') || BACKEND_AUTO).toString().trim().toLowerCase();
  if (![BACKEND_AUTO, BACKEND_X11, BACKEND_WAYLAND].includes(rawBackend)) {
    throw new Error(`Invalid linuxBackend '${rawBackend}'. Supported values: auto, x11, wayland.`);
  }
  if (rawBackend !== BACKEND_AUTO) {
    return rawBackend;
  }
  const envSession = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  if (envSession === BACKEND_WAYLAND || process.env.WAYLAND_DISPLAY) {
    return BACKEND_WAYLAND;
  }
  return BACKEND_X11;
}

async function createBackendController ({caps = {}, appName, logger}) {
  const backendName = resolveLinuxBackend(caps);
  const distroInfo = detectLinuxDistroInfo();
  if (backendName === BACKEND_WAYLAND) {
    let WaylandApis = null;
    try {
      ({default: WaylandApis} = await import('./wayland-apis.js'));
    } catch (error) {
      throw new Error(`Wayland backend module could not be loaded: ${error.message}`);
    }

    const waylandApis = new WaylandApis({
      appName,
      logger,
      waylandRestoreToken: readCap(caps, 'waylandRestoreToken'),
      waylandTokenStorePath: readCap(caps, 'waylandTokenStorePath'),
      waylandAutoShare: readCap(caps, 'waylandAutoShare'),
    });
    await waylandApis.initialize();
    return {
      name: BACKEND_WAYLAND,
      apis: waylandApis,
      async destroy () {
        await waylandApis.dispose();
      }
    };
  }

  if (process.platform !== 'linux') {
    throw new Error(`X11 backend requires Linux runtime. Current platform is '${process.platform}'.`);
  }
  if (!fs.existsSync(X11_SHARED_LIB_PATH)) {
    const distroLabel = formatDistroLabel(distroInfo);
    const distroHint = distroInfo.isRhelLike
      ? `Detected ${distroLabel}. Install the matching uimate-appium-linux RPM (el${distroInfo.majorVersion || 'X'}) so '${X11_SHARED_LIB_PATH}' is provisioned.`
      : `Detected ${distroLabel}. Install stdspalinux native dependencies or switch to appium:linuxBackend=wayland on a supported Wayland session.`;
    throw new Error(
      `X11 backend prerequisite is missing: '${X11_SHARED_LIB_PATH}'. ` +
      distroHint
    );
  }

  let nativeApis = null;
  try {
    ({default: nativeApis} = await import('@stdspa/stdspalinux_temp/dist/privateapis'));
  } catch (error) {
    throw new Error(`X11 backend module could not be loaded: ${error.message}`);
  }

  return {
    name: BACKEND_X11,
    apis: nativeApis,
    async destroy () {}
  };
}

export {
  BACKEND_AUTO,
  BACKEND_X11,
  BACKEND_WAYLAND,
  resolveLinuxBackend,
  createBackendController,
};
