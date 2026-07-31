import _ from 'lodash';
import { BaseDriver, errors } from '@appium/base-driver';
import { desiredCapConstraints } from './desired-caps';
import commands from './commands/index';
import log from './logger';
import { wait4sec } from './utils';
import LRU from 'lru-cache';
import { createBackendController } from './backends';
import { spawn, spawnSync } from 'child_process';
import {Promise} from 'bluebird';

const NO_PROXY = [];

function normalizeAppArguments (value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new errors.InvalidArgumentError(
      'appium:appArguments must be an array of strings'
    );
  }
  return [...value];
}

function spawnApplication (appName, appArguments) {
  return new Promise((resolve, reject) => {
    const child = spawn(appName, appArguments, {
      detached: true,
      stdio: 'ignore',
      env: {...process.env},
      shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

function ensureWaylandAccessibilityLaunchEnv () {
  const defaults = {
    QT_ACCESSIBILITY: '1',
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
  };
  const applied = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

class AtSpi2Driver extends BaseDriver {
  constructor (opts = {}) {
    super(opts);
    this.desiredCapConstraints = desiredCapConstraints;
    this.locatorStrategies = [
      'xpath',
      'name',
      'class name',
      'id',
      'accessibility id',
      'tag name',
      'link text',
      'partial link text',
      'css selector',
    ];
    for (const [cmd, fn] of _.toPairs(commands)) {
      AtSpi2Driver.prototype[cmd] = fn;
    }
  }

  proxyActive () {
    return false;
  }

  getProxyAvoidList () {
    return NO_PROXY;
  }

  canProxy () {
    return false;
  }

  _spawnApplication (appName, appArguments) {
    return spawnApplication(appName, appArguments);
  }

  _spawnSync (...args) {
    return spawnSync(...args);
  }

  async createSession (...args) {
    const [sessionId, caps] = await super.createSession(...args);
    try {
      return await this._initializeApplicationSession(sessionId, caps);
    } catch (error) {
      try {
        await this.deleteSession();
      } catch (cleanupError) {
        log.warn(`Failed to clean up incomplete session: ${cleanupError.message}`);
      }
      throw error;
    }
  }

  async _initializeApplicationSession (sessionId, caps) {
    if (!caps.appName) {
      throw new errors.UnknownError('application should be specified');
    }
    this.appName = caps.appName;
    this.appArguments = normalizeAppArguments(caps.appArguments);
    this.attachToRunningApp = caps.attachToRunningApp === true;
    this._ownsApplication = !this.attachToRunningApp;

    if (this.attachToRunningApp && this.appArguments.length > 0) {
      throw new errors.InvalidArgumentError(
        'appium:appArguments cannot be used with appium:attachToRunningApp'
      );
    }
    try {
      this._backendController = await createBackendController({
        caps,
        appName: this.appName,
        logger: log,
      });
    } catch (error) {
      throw new errors.UnknownError(`Failed to initialize linux backend: ${error.message}`);
    }

    this._backendApis = this._backendController.apis;
    this.linuxBackend = this._backendController.name;
    log.info(`Using linux backend '${this.linuxBackend}'`);
    if (this.linuxBackend === 'wayland') {
      const appliedEnv = ensureWaylandAccessibilityLaunchEnv();
      if (appliedEnv.length > 0) {
        log.info(`Applied Wayland accessibility launch env: ${appliedEnv.join(', ')}`);
      }
    }

    const usesExtendedApplicationLifecycle =
      this.appArguments.length > 0 || this.attachToRunningApp;

    if (this.attachToRunningApp) {
      log.info(`Attaching to running app ${this.appName}`);
    } else {
      log.info(`Killing the app ${this.appName} if it's already running`);
    }

    // Resolve basename for wrapper-script detection (e.g. /usr/bin/horizon-client
    // is a bash script that execs /usr/lib/omnissa/horizon/bin/horizon-client).
    // The native module uses `pgrep <appName>` which only matches the wrapper
    // script path, not the actual exec'd binary.
    const appBaseName = this.appName.split('/').pop();

    if (!this.attachToRunningApp) {
      await this._backendApis.app_kill(this.appName);
      // Also kill by basename in case the native kill missed wrapper-script processes
      try {
        this._spawnSync('pkill', ['-f', appBaseName], {timeout: 3000});
      } catch { /* ignore */ }
      await wait4sec(0.5);
    }

    let launchResult = {ok: true};
    if (this.attachToRunningApp) {
      // The existing process is checked below using the established detection.
    } else if (this.appArguments.length > 0) {
      log.info(`Launching app ${this.appName} with ${this.appArguments.length} argument(s)`);
      try {
        const childPid = await this._spawnApplication(this.appName, this.appArguments);
        log.info(`Launched app ${this.appName} pid=${childPid}`);
      } catch (spawnErr) {
        throw new errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
      }
    } else {
      log.info(`Lauching app ${this.appName}`);
      launchResult = await this._backendApis.app_launch(this.appName);
    }

    // Helper: check if the app is running by trying multiple detection
    // strategies — native app_running, pgrep by basename, and /proc cmdline.
    const isAppRunning = () => {
      // Strategy 1: native AT-SPI-based check
      try {
        const pids = this._backendApis.app_running(this.appName);
        if (pids && pids.length > 0) {
          return true;
        }
      } catch { /* ignore */ }

      // Strategy 2: pgrep by basename (catches exec'd binaries)
      try {
        const res = this._spawnSync(
          'pgrep',
          ['-f', appBaseName],
          {encoding: 'utf8', timeout: 3000}
        );
        if (res.status === 0 && res.stdout && res.stdout.trim()) {
          return true;
        }
      } catch { /* not found */ }

      return false;
    };

    if (!launchResult.ok) {
      switch (launchResult.errCode) {
        case 1000:
          throw new errors.UnknownError('application is running while trying to start it');
        case 1001:
          throw new errors.UnknownError('the specified appName is wrong');
        case 1002: {
          // Native app_launch has a very short 5s timeout and uses pgrep with
          // the exact path, which fails for wrapper scripts (the exec'd binary
          // has a different /proc/self/exe).
          log.warn('Native app_launch timed out; checking if app is running via multiple strategies');
          let running = isAppRunning();

          if (!running) {
            // Try JS-level spawn.  Use /bin/bash -c to handle shell scripts.
            log.info('App not yet running; attempting JS-level spawn fallback');
            try {
              const child = spawn('/bin/bash', ['-c', `exec ${this.appName}`], {
                detached: true,
                stdio: 'ignore',
                env: {...process.env},
              });
              child.unref();
              log.info(`JS-spawned app PID=${child.pid}; polling for process`);
            } catch (spawnErr) {
              throw new errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
            }
          } else {
            log.info('App is already running (detected via basename/pgrep); continuing');
          }

          // Poll until we can detect the app (up to 60s — Horizon on RHEL
          // can take 15-20s after launch to register in AT-SPI).
          if (!running) {
            const maxWait = 60;
            const pollMs = 1.0;
            for (let elapsed = 0; elapsed < maxWait; elapsed += pollMs) {
              await wait4sec(pollMs);
              if (isAppRunning()) {
                running = true;
                log.info(`App detected after ~${elapsed + pollMs}s`);
                break;
              }
              if (elapsed % 10 === 9) {
                log.info(`Still waiting for app... ${elapsed + pollMs}s elapsed`);
              }
            }
          }

          if (!running) {
            throw new errors.UnknownError('timeout while lauching app');
          }
          break;
        }
      }
    }

    if (usesExtendedApplicationLifecycle) {
      let running = isAppRunning();
      if (!running) {
        const maxWait = 60;
        const pollMs = 1.0;
        for (let elapsed = 0; elapsed < maxWait; elapsed += pollMs) {
          await wait4sec(pollMs);
          if (isAppRunning()) {
            running = true;
            log.info(`App detected after ~${elapsed + pollMs}s`);
            break;
          }
          if (elapsed % 10 === 9) {
            log.info(`Still waiting for app... ${elapsed + pollMs}s elapsed`);
          }
        }
      }
      if (!running) {
        const action = this.attachToRunningApp ? 'attaching to' : 'launching';
        throw new errors.UnknownError(`timeout while ${action} app ${this.appName}`);
      }
    }

    if (this.attachToRunningApp) {
      log.info(`App ${this.appName} attached successfully`);
    } else if (this.appArguments.length > 0) {
      log.info(`App ${this.appName} launched successfully`);
    } else {
      log.info(`App ${this.appName} lauched successful`);
    }

    await wait4sec(0.5);
    this._win = null;

    const isWayland = this.linuxBackend === 'wayland';
    let times = usesExtendedApplicationLifecycle ? 20 : (isWayland ? 20 : 5);
    const pollInterval = usesExtendedApplicationLifecycle ? 1.0 : (isWayland ? 1.0 : 0.5);
    let wids = [];
    while (times > 0) {
      if (usesExtendedApplicationLifecycle) {
        try {
          wids = await this.getWindowHandles();
        } catch (error) {
          if (!(error instanceof errors.NoSuchWindowError)) {
            throw error;
          }
          wids = [];
        }
      } else {
        wids = await this.getWindowHandles();
      }
      if (wids.length > 0) {
        break;
      }
      await wait4sec(pollInterval);
      times--;
    }

    if (wids.length === 0) {
      throw new errors.UnknownError(`App ${this.appName} has no window`);
    }

    if (wids.length > 1) {
      log.info(`App ${this.appName} has more than 1 window`);
    }

    let selectedWindow = false;
    let lastWindowError = null;
    const selectAttempts = isWayland ? 5 : 3;
    for (let attempt = 0; attempt < selectAttempts; attempt++) {
      const handles = attempt === 0 ? wids : await this.getWindowHandles();
      if (handles.length === 0) {
        await wait4sec(0.3);
        continue;
      }
      for (const wid of handles) {
        try {
          await this.setWindow(null, wid);
          selectedWindow = true;
          break;
        } catch (error) {
          lastWindowError = error;
          log.warn(`Failed to select window '${wid}' on attempt ${attempt + 1}: ${error.message}`);
        }
      }
      if (selectedWindow) {
        break;
      }
      await wait4sec(0.3);
    }

    if (!selectedWindow) {
      if (lastWindowError) {
        throw lastWindowError;
      }
      throw new errors.UnknownError(`Failed to select a window for app ${this.appName}`);
    }
    log.info(`pre-selected window ${this._win.name}`);

    this._cache = new LRU({
      max: 500,
      ttl: 1000 * 60 * 5,
      updateAgeOnGet: true,
      updateAgeOnHas: true
    });
    return [sessionId, caps];
  }

  async deleteSession () {
    if (this.appName && this._backendApis && this._ownsApplication) {
      log.info(`App ${this.appName} is killed before closing session`);
      const baseName = this.appName.split('/').pop();
      try {
        await this._backendApis.app_kill(this.appName);
      } catch {
        // Ignore shutdown errors
      }
      // Also kill by basename for wrapper-script processes
      try {
        this._spawnSync('pkill', ['-f', baseName], {timeout: 3000});
      } catch { /* ignore */ }
    } else if (this.appName && this.attachToRunningApp) {
      log.info(`Leaving attached app ${this.appName} running while closing session`);
    }

    if (this._cache) {
      this._cache.clear();
    }

    if (this._backendController?.destroy) {
      try {
        await this._backendController.destroy();
      } catch {
        // Ignore backend cleanup errors
      }
    }

    this._backendApis = null;
    this._backendController = null;

    await super.deleteSession();
  }
}

export {
  normalizeAppArguments,
  spawnApplication,
};
export default AtSpi2Driver;
