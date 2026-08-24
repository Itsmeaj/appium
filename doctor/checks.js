'use strict';

/* eslint-disable require-await */

const fs = require('fs');
const path = require('path');

const NATIVE_RUNTIME_PATH = '/usr/local/lib/libstdspalinux.so';

function result (ok, optional, message) {
  return {ok, optional, message};
}

function findCommand (command, env = process.env) {
  const pathValue = `${env.PATH || ''}`;
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

class BaseCheck {
  constructor ({optional = false} = {}) {
    this.optional = optional;
  }

  hasAutofix () {
    return false;
  }

  isOptional () {
    return this.optional;
  }
}

class LinuxPlatformCheck extends BaseCheck {
  constructor ({platform = process.platform} = {}) {
    super();
    this.platform = platform;
  }

  async diagnose () {
    if (this.platform === 'linux') {
      return result(true, false, 'The Appium server is running on Linux.');
    }
    return result(false, false, `The AtSpi2 driver requires Linux; detected '${this.platform}'.`);
  }

  async fix () {
    return 'Run Appium and the AtSpi2 driver inside the target Linux desktop session.';
  }
}

class NativeRuntimeCheck extends BaseCheck {
  constructor ({runtimePath = NATIVE_RUNTIME_PATH, existsSync = fs.existsSync} = {}) {
    super();
    this.runtimePath = runtimePath;
    this.existsSync = existsSync;
  }

  async diagnose () {
    if (this.existsSync(this.runtimePath)) {
      return result(true, false, `The native AT-SPI runtime is installed at '${this.runtimePath}'.`);
    }
    return result(false, false, `The native AT-SPI runtime is missing at '${this.runtimePath}'.`);
  }

  async fix () {
    return 'Install the matching UImate native runtime package; see docs/ARCHITECTURE.md in the driver package.';
  }
}

class DesktopSessionCheck extends BaseCheck {
  constructor ({env = process.env} = {}) {
    super();
    this.env = env;
  }

  async diagnose () {
    const hasDisplay = Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
    if (hasDisplay) {
      const sessionType = this.env.XDG_SESSION_TYPE || (this.env.WAYLAND_DISPLAY ? 'wayland' : 'x11');
      return result(true, false, `An active ${sessionType} desktop environment is available.`);
    }
    return result(false, false, 'No X11 or Wayland display is available to the Appium server process.');
  }

  async fix () {
    return 'Start Appium as the logged-in desktop user with DISPLAY/WAYLAND_DISPLAY and the desktop session environment exported.';
  }
}

class WaylandPrerequisitesCheck extends BaseCheck {
  constructor ({env = process.env, commandFinder = findCommand} = {}) {
    super();
    this.env = env;
    this.commandFinder = commandFinder;
  }

  async diagnose () {
    const isWayland = `${this.env.XDG_SESSION_TYPE || ''}`.toLowerCase() === 'wayland'
      || Boolean(this.env.WAYLAND_DISPLAY);
    if (!isWayland) {
      return result(true, false, 'Wayland prerequisites are not required for the active session.');
    }

    const missingEnvironment = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
      .filter((name) => !this.env[name]);
    const missingCommands = ['xdg-desktop-portal', 'pipewire']
      .filter((command) => !this.commandFinder(command, this.env));
    if (missingEnvironment.length === 0 && missingCommands.length === 0) {
      return result(true, false, 'The required Wayland portal environment and commands are available.');
    }

    const details = [];
    if (missingEnvironment.length > 0) {
      details.push(`environment: ${missingEnvironment.join(', ')}`);
    }
    if (missingCommands.length > 0) {
      details.push(`commands: ${missingCommands.join(', ')}`);
    }
    return result(false, false, `Wayland prerequisites are missing (${details.join('; ')}).`);
  }

  async fix () {
    return 'Install xdg-desktop-portal, the desktop portal backend, and PipeWire; then start Appium with the logged-in desktop user environment.';
  }
}

module.exports = {
  DesktopSessionCheck,
  LinuxPlatformCheck,
  NativeRuntimeCheck,
  WaylandPrerequisitesCheck,
  findCommand,
};
