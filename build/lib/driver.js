"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
exports.normalizeAppArguments = normalizeAppArguments;
exports.spawnApplication = spawnApplication;
require("source-map-support/register");
var _lodash = _interopRequireDefault(require("lodash"));
var _driver = require("appium/driver");
var _desiredCaps = require("./desired-caps");
var _index = _interopRequireDefault(require("./commands/index"));
var _logger = _interopRequireDefault(require("./logger"));
var _utils = require("./utils");
var _lruCache = _interopRequireDefault(require("lru-cache"));
var _backends = require("./backends");
var _child_process = require("child_process");
var _bluebird = require("bluebird");
const NO_PROXY = [];
function normalizeAppArguments(value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new _driver.errors.InvalidArgumentError('appium:appArguments must be an array of strings');
  }
  return [...value];
}
function spawnApplication(appName, appArguments) {
  return new _bluebird.Promise((resolve, reject) => {
    const child = (0, _child_process.spawn)(appName, appArguments, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env
      },
      shell: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}
function ensureWaylandAccessibilityLaunchEnv() {
  const defaults = {
    QT_ACCESSIBILITY: '1',
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1'
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
class AtSpi2Driver extends _driver.BaseDriver {
  constructor(opts = {}) {
    super(opts);
    this.desiredCapConstraints = _desiredCaps.desiredCapConstraints;
    this.locatorStrategies = ['xpath', 'name', 'class name', 'id', 'accessibility id', 'tag name', 'link text', 'partial link text', 'css selector'];
    for (const [cmd, fn] of _lodash.default.toPairs(_index.default)) {
      AtSpi2Driver.prototype[cmd] = fn;
    }
  }
  proxyActive() {
    return false;
  }
  getProxyAvoidList() {
    return NO_PROXY;
  }
  canProxy() {
    return false;
  }
  _spawnApplication(appName, appArguments) {
    return spawnApplication(appName, appArguments);
  }
  _spawnSync(...args) {
    return (0, _child_process.spawnSync)(...args);
  }
  async createSession(...args) {
    const [sessionId, caps] = await super.createSession(...args);
    try {
      return await this._initializeApplicationSession(sessionId, caps);
    } catch (error) {
      try {
        await this.deleteSession();
      } catch (cleanupError) {
        _logger.default.warn(`Failed to clean up incomplete session: ${cleanupError.message}`);
      }
      throw error;
    }
  }
  async _initializeApplicationSession(sessionId, caps) {
    if (!caps.appName) {
      throw new _driver.errors.UnknownError('application should be specified');
    }
    this.appName = caps.appName;
    this.appArguments = normalizeAppArguments(caps.appArguments);
    this.attachToRunningApp = caps.attachToRunningApp === true;
    this._ownsApplication = !this.attachToRunningApp;
    if (this.attachToRunningApp && this.appArguments.length > 0) {
      throw new _driver.errors.InvalidArgumentError('appium:appArguments cannot be used with appium:attachToRunningApp');
    }
    try {
      this._backendController = await (0, _backends.createBackendController)({
        caps,
        appName: this.appName,
        logger: _logger.default
      });
    } catch (error) {
      throw new _driver.errors.UnknownError(`Failed to initialize linux backend: ${error.message}`);
    }
    this._backendApis = this._backendController.apis;
    this.linuxBackend = this._backendController.name;
    _logger.default.info(`Using linux backend '${this.linuxBackend}'`);
    if (this.linuxBackend === 'wayland') {
      const appliedEnv = ensureWaylandAccessibilityLaunchEnv();
      if (appliedEnv.length > 0) {
        _logger.default.info(`Applied Wayland accessibility launch env: ${appliedEnv.join(', ')}`);
      }
    }
    const usesExtendedApplicationLifecycle = this.appArguments.length > 0 || this.attachToRunningApp;
    if (this.attachToRunningApp) {
      _logger.default.info(`Attaching to running app ${this.appName}`);
    } else {
      _logger.default.info(`Killing the app ${this.appName} if it's already running`);
    }
    const appBaseName = this.appName.split('/').pop();
    if (!this.attachToRunningApp) {
      await this._backendApis.app_kill(this.appName);
      try {
        this._spawnSync('pkill', ['-f', appBaseName], {
          timeout: 3000
        });
      } catch {}
      await (0, _utils.wait4sec)(0.5);
    }
    let launchResult = {
      ok: true
    };
    if (this.attachToRunningApp) {} else if (this.appArguments.length > 0) {
      _logger.default.info(`Launching app ${this.appName} with ${this.appArguments.length} argument(s)`);
      try {
        const childPid = await this._spawnApplication(this.appName, this.appArguments);
        _logger.default.info(`Launched app ${this.appName} pid=${childPid}`);
      } catch (spawnErr) {
        throw new _driver.errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
      }
    } else {
      _logger.default.info(`Launching app ${this.appName}`);
      launchResult = await this._backendApis.app_launch(this.appName);
    }
    const isAppRunning = () => {
      try {
        const pids = this._backendApis.app_running(this.appName);
        if (pids && pids.length > 0) {
          return true;
        }
      } catch {}
      try {
        const res = this._spawnSync('pgrep', ['-f', appBaseName], {
          encoding: 'utf8',
          timeout: 3000
        });
        if (res.status === 0 && res.stdout && res.stdout.trim()) {
          return true;
        }
      } catch {}
      return false;
    };
    if (!launchResult.ok) {
      switch (launchResult.errCode) {
        case 1000:
          throw new _driver.errors.UnknownError('application is running while trying to start it');
        case 1001:
          throw new _driver.errors.UnknownError('the specified appName is wrong');
        case 1002:
          {
            _logger.default.warn('Native app_launch timed out; checking if app is running via multiple strategies');
            let running = isAppRunning();
            if (!running) {
              _logger.default.info('App not yet running; attempting JS-level spawn fallback');
              try {
                const child = (0, _child_process.spawn)('/bin/bash', ['-c', `exec ${this.appName}`], {
                  detached: true,
                  stdio: 'ignore',
                  env: {
                    ...process.env
                  }
                });
                child.unref();
                _logger.default.info(`JS-spawned app PID=${child.pid}; polling for process`);
              } catch (spawnErr) {
                throw new _driver.errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
              }
            } else {
              _logger.default.info('App is already running (detected via basename/pgrep); continuing');
            }
            if (!running) {
              const maxWait = 60;
              const pollMs = 1.0;
              for (let elapsed = 0; elapsed < maxWait; elapsed += pollMs) {
                await (0, _utils.wait4sec)(pollMs);
                if (isAppRunning()) {
                  running = true;
                  _logger.default.info(`App detected after ~${elapsed + pollMs}s`);
                  break;
                }
                if (elapsed % 10 === 9) {
                  _logger.default.info(`Still waiting for app... ${elapsed + pollMs}s elapsed`);
                }
              }
            }
            if (!running) {
              throw new _driver.errors.UnknownError('timeout while lauching app');
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
          await (0, _utils.wait4sec)(pollMs);
          if (isAppRunning()) {
            running = true;
            _logger.default.info(`App detected after ~${elapsed + pollMs}s`);
            break;
          }
          if (elapsed % 10 === 9) {
            _logger.default.info(`Still waiting for app... ${elapsed + pollMs}s elapsed`);
          }
        }
      }
      if (!running) {
        const action = this.attachToRunningApp ? 'attaching to' : 'launching';
        throw new _driver.errors.UnknownError(`timeout while ${action} app ${this.appName}`);
      }
    }
    if (this.attachToRunningApp) {
      _logger.default.info(`App ${this.appName} attached successfully`);
    } else if (this.appArguments.length > 0) {
      _logger.default.info(`App ${this.appName} launched successfully`);
    } else {
      _logger.default.info(`App ${this.appName} launched successfully`);
    }
    await (0, _utils.wait4sec)(0.5);
    this._win = null;
    const isWayland = this.linuxBackend === 'wayland';
    let times = usesExtendedApplicationLifecycle ? 20 : isWayland ? 20 : 5;
    const pollInterval = usesExtendedApplicationLifecycle ? 1.0 : isWayland ? 1.0 : 0.5;
    let wids = [];
    while (times > 0) {
      if (usesExtendedApplicationLifecycle) {
        try {
          wids = await this.getWindowHandles();
        } catch (error) {
          if (!(error instanceof _driver.errors.NoSuchWindowError)) {
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
      await (0, _utils.wait4sec)(pollInterval);
      times--;
    }
    if (wids.length === 0) {
      throw new _driver.errors.UnknownError(`App ${this.appName} has no window`);
    }
    if (wids.length > 1) {
      _logger.default.info(`App ${this.appName} has more than 1 window`);
    }
    let selectedWindow = false;
    let lastWindowError = null;
    const selectAttempts = isWayland ? 5 : 3;
    for (let attempt = 0; attempt < selectAttempts; attempt++) {
      const handles = attempt === 0 ? wids : await this.getWindowHandles();
      if (handles.length === 0) {
        await (0, _utils.wait4sec)(0.3);
        continue;
      }
      for (const wid of handles) {
        try {
          await this.setWindow(null, wid);
          selectedWindow = true;
          break;
        } catch (error) {
          lastWindowError = error;
          _logger.default.warn(`Failed to select window '${wid}' on attempt ${attempt + 1}: ${error.message}`);
        }
      }
      if (selectedWindow) {
        break;
      }
      await (0, _utils.wait4sec)(0.3);
    }
    if (!selectedWindow) {
      if (lastWindowError) {
        throw lastWindowError;
      }
      throw new _driver.errors.UnknownError(`Failed to select a window for app ${this.appName}`);
    }
    _logger.default.info(`pre-selected window ${this._win.name}`);
    this._cache = new _lruCache.default({
      max: 500,
      ttl: 1000 * 60 * 5,
      updateAgeOnGet: true,
      updateAgeOnHas: true
    });
    return [sessionId, caps];
  }
  async deleteSession() {
    var _this$_backendControl;
    if (this.appName && this._backendApis && this._ownsApplication) {
      _logger.default.info(`App ${this.appName} is killed before closing session`);
      const baseName = this.appName.split('/').pop();
      try {
        await this._backendApis.app_kill(this.appName);
      } catch {}
      try {
        this._spawnSync('pkill', ['-f', baseName], {
          timeout: 3000
        });
      } catch {}
    } else if (this.appName && this.attachToRunningApp) {
      _logger.default.info(`Leaving attached app ${this.appName} running while closing session`);
    }
    if (this._cache) {
      this._cache.clear();
    }
    if ((_this$_backendControl = this._backendController) !== null && _this$_backendControl !== void 0 && _this$_backendControl.destroy) {
      try {
        await this._backendController.destroy();
      } catch {}
    }
    this._backendApis = null;
    this._backendController = null;
    await super.deleteSession();
  }
}
var _default = exports.default = AtSpi2Driver;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2RyaXZlci5qcyIsIm5hbWVzIjpbIl9sb2Rhc2giLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9kcml2ZXIiLCJfZGVzaXJlZENhcHMiLCJfaW5kZXgiLCJfbG9nZ2VyIiwiX3V0aWxzIiwiX2xydUNhY2hlIiwiX2JhY2tlbmRzIiwiX2NoaWxkX3Byb2Nlc3MiLCJfYmx1ZWJpcmQiLCJOT19QUk9YWSIsIm5vcm1hbGl6ZUFwcEFyZ3VtZW50cyIsInZhbHVlIiwidW5kZWZpbmVkIiwiQXJyYXkiLCJpc0FycmF5Iiwic29tZSIsIml0ZW0iLCJlcnJvcnMiLCJJbnZhbGlkQXJndW1lbnRFcnJvciIsInNwYXduQXBwbGljYXRpb24iLCJhcHBOYW1lIiwiYXBwQXJndW1lbnRzIiwiUHJvbWlzZSIsInJlc29sdmUiLCJyZWplY3QiLCJjaGlsZCIsInNwYXduIiwiZGV0YWNoZWQiLCJzdGRpbyIsImVudiIsInByb2Nlc3MiLCJzaGVsbCIsIm9uY2UiLCJ1bnJlZiIsInBpZCIsImVuc3VyZVdheWxhbmRBY2Nlc3NpYmlsaXR5TGF1bmNoRW52IiwiZGVmYXVsdHMiLCJRVF9BQ0NFU1NJQklMSVRZIiwiUVRfTElOVVhfQUNDRVNTSUJJTElUWV9BTFdBWVNfT04iLCJhcHBsaWVkIiwia2V5IiwiT2JqZWN0IiwiZW50cmllcyIsInB1c2giLCJBdFNwaTJEcml2ZXIiLCJCYXNlRHJpdmVyIiwiY29uc3RydWN0b3IiLCJvcHRzIiwiZGVzaXJlZENhcENvbnN0cmFpbnRzIiwibG9jYXRvclN0cmF0ZWdpZXMiLCJjbWQiLCJmbiIsIl8iLCJ0b1BhaXJzIiwiY29tbWFuZHMiLCJwcm90b3R5cGUiLCJwcm94eUFjdGl2ZSIsImdldFByb3h5QXZvaWRMaXN0IiwiY2FuUHJveHkiLCJfc3Bhd25BcHBsaWNhdGlvbiIsIl9zcGF3blN5bmMiLCJhcmdzIiwic3Bhd25TeW5jIiwiY3JlYXRlU2Vzc2lvbiIsInNlc3Npb25JZCIsImNhcHMiLCJfaW5pdGlhbGl6ZUFwcGxpY2F0aW9uU2Vzc2lvbiIsImVycm9yIiwiZGVsZXRlU2Vzc2lvbiIsImNsZWFudXBFcnJvciIsImxvZyIsIndhcm4iLCJtZXNzYWdlIiwiVW5rbm93bkVycm9yIiwiYXR0YWNoVG9SdW5uaW5nQXBwIiwiX293bnNBcHBsaWNhdGlvbiIsImxlbmd0aCIsIl9iYWNrZW5kQ29udHJvbGxlciIsImNyZWF0ZUJhY2tlbmRDb250cm9sbGVyIiwibG9nZ2VyIiwiX2JhY2tlbmRBcGlzIiwiYXBpcyIsImxpbnV4QmFja2VuZCIsIm5hbWUiLCJpbmZvIiwiYXBwbGllZEVudiIsImpvaW4iLCJ1c2VzRXh0ZW5kZWRBcHBsaWNhdGlvbkxpZmVjeWNsZSIsImFwcEJhc2VOYW1lIiwic3BsaXQiLCJwb3AiLCJhcHBfa2lsbCIsInRpbWVvdXQiLCJ3YWl0NHNlYyIsImxhdW5jaFJlc3VsdCIsIm9rIiwiY2hpbGRQaWQiLCJzcGF3bkVyciIsImFwcF9sYXVuY2giLCJpc0FwcFJ1bm5pbmciLCJwaWRzIiwiYXBwX3J1bm5pbmciLCJyZXMiLCJlbmNvZGluZyIsInN0YXR1cyIsInN0ZG91dCIsInRyaW0iLCJlcnJDb2RlIiwicnVubmluZyIsIm1heFdhaXQiLCJwb2xsTXMiLCJlbGFwc2VkIiwiYWN0aW9uIiwiX3dpbiIsImlzV2F5bGFuZCIsInRpbWVzIiwicG9sbEludGVydmFsIiwid2lkcyIsImdldFdpbmRvd0hhbmRsZXMiLCJOb1N1Y2hXaW5kb3dFcnJvciIsInNlbGVjdGVkV2luZG93IiwibGFzdFdpbmRvd0Vycm9yIiwic2VsZWN0QXR0ZW1wdHMiLCJhdHRlbXB0IiwiaGFuZGxlcyIsIndpZCIsInNldFdpbmRvdyIsIl9jYWNoZSIsIkxSVSIsIm1heCIsInR0bCIsInVwZGF0ZUFnZU9uR2V0IiwidXBkYXRlQWdlT25IYXMiLCJfdGhpcyRfYmFja2VuZENvbnRyb2wiLCJiYXNlTmFtZSIsImNsZWFyIiwiZGVzdHJveSIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsImRlZmF1bHQiXSwic291cmNlUm9vdCI6Ii4uLy4uIiwic291cmNlcyI6WyJsaWIvZHJpdmVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgeyBCYXNlRHJpdmVyLCBlcnJvcnMgfSBmcm9tICdhcHBpdW0vZHJpdmVyJztcbmltcG9ydCB7IGRlc2lyZWRDYXBDb25zdHJhaW50cyB9IGZyb20gJy4vZGVzaXJlZC1jYXBzJztcbmltcG9ydCBjb21tYW5kcyBmcm9tICcuL2NvbW1hbmRzL2luZGV4JztcbmltcG9ydCBsb2cgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IHsgd2FpdDRzZWMgfSBmcm9tICcuL3V0aWxzJztcbmltcG9ydCBMUlUgZnJvbSAnbHJ1LWNhY2hlJztcbmltcG9ydCB7IGNyZWF0ZUJhY2tlbmRDb250cm9sbGVyIH0gZnJvbSAnLi9iYWNrZW5kcyc7XG5pbXBvcnQgeyBzcGF3biwgc3Bhd25TeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQge1Byb21pc2V9IGZyb20gJ2JsdWViaXJkJztcblxuY29uc3QgTk9fUFJPWFkgPSBbXTtcblxuZnVuY3Rpb24gbm9ybWFsaXplQXBwQXJndW1lbnRzICh2YWx1ZSkge1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpIHx8IHZhbHVlLnNvbWUoKGl0ZW0pID0+IHR5cGVvZiBpdGVtICE9PSAnc3RyaW5nJykpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgJ2FwcGl1bTphcHBBcmd1bWVudHMgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzJ1xuICAgICk7XG4gIH1cbiAgcmV0dXJuIFsuLi52YWx1ZV07XG59XG5cbmZ1bmN0aW9uIHNwYXduQXBwbGljYXRpb24gKGFwcE5hbWUsIGFwcEFyZ3VtZW50cykge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oYXBwTmFtZSwgYXBwQXJndW1lbnRzLCB7XG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcbiAgICAgIGVudjogey4uLnByb2Nlc3MuZW52fSxcbiAgICAgIHNoZWxsOiBmYWxzZSxcbiAgICB9KTtcbiAgICBjaGlsZC5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgY2hpbGQub25jZSgnc3Bhd24nLCAoKSA9PiB7XG4gICAgICBjaGlsZC51bnJlZigpO1xuICAgICAgcmVzb2x2ZShjaGlsZC5waWQpO1xuICAgIH0pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlV2F5bGFuZEFjY2Vzc2liaWxpdHlMYXVuY2hFbnYgKCkge1xuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBRVF9BQ0NFU1NJQklMSVRZOiAnMScsXG4gICAgUVRfTElOVVhfQUNDRVNTSUJJTElUWV9BTFdBWVNfT046ICcxJyxcbiAgfTtcbiAgY29uc3QgYXBwbGllZCA9IFtdO1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkZWZhdWx0cykpIHtcbiAgICBpZiAoIXByb2Nlc3MuZW52W2tleV0pIHtcbiAgICAgIHByb2Nlc3MuZW52W2tleV0gPSB2YWx1ZTtcbiAgICAgIGFwcGxpZWQucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYXBwbGllZDtcbn1cblxuY2xhc3MgQXRTcGkyRHJpdmVyIGV4dGVuZHMgQmFzZURyaXZlciB7XG4gIGNvbnN0cnVjdG9yIChvcHRzID0ge30pIHtcbiAgICBzdXBlcihvcHRzKTtcbiAgICB0aGlzLmRlc2lyZWRDYXBDb25zdHJhaW50cyA9IGRlc2lyZWRDYXBDb25zdHJhaW50cztcbiAgICB0aGlzLmxvY2F0b3JTdHJhdGVnaWVzID0gW1xuICAgICAgJ3hwYXRoJyxcbiAgICAgICduYW1lJyxcbiAgICAgICdjbGFzcyBuYW1lJyxcbiAgICAgICdpZCcsXG4gICAgICAnYWNjZXNzaWJpbGl0eSBpZCcsXG4gICAgICAndGFnIG5hbWUnLFxuICAgICAgJ2xpbmsgdGV4dCcsXG4gICAgICAncGFydGlhbCBsaW5rIHRleHQnLFxuICAgICAgJ2NzcyBzZWxlY3RvcicsXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IFtjbWQsIGZuXSBvZiBfLnRvUGFpcnMoY29tbWFuZHMpKSB7XG4gICAgICBBdFNwaTJEcml2ZXIucHJvdG90eXBlW2NtZF0gPSBmbjtcbiAgICB9XG4gIH1cblxuICBwcm94eUFjdGl2ZSAoKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgZ2V0UHJveHlBdm9pZExpc3QgKCkge1xuICAgIHJldHVybiBOT19QUk9YWTtcbiAgfVxuXG4gIGNhblByb3h5ICgpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBfc3Bhd25BcHBsaWNhdGlvbiAoYXBwTmFtZSwgYXBwQXJndW1lbnRzKSB7XG4gICAgcmV0dXJuIHNwYXduQXBwbGljYXRpb24oYXBwTmFtZSwgYXBwQXJndW1lbnRzKTtcbiAgfVxuXG4gIF9zcGF3blN5bmMgKC4uLmFyZ3MpIHtcbiAgICByZXR1cm4gc3Bhd25TeW5jKC4uLmFyZ3MpO1xuICB9XG5cbiAgYXN5bmMgY3JlYXRlU2Vzc2lvbiAoLi4uYXJncykge1xuICAgIGNvbnN0IFtzZXNzaW9uSWQsIGNhcHNdID0gYXdhaXQgc3VwZXIuY3JlYXRlU2Vzc2lvbiguLi5hcmdzKTtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuX2luaXRpYWxpemVBcHBsaWNhdGlvblNlc3Npb24oc2Vzc2lvbklkLCBjYXBzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5kZWxldGVTZXNzaW9uKCk7XG4gICAgICB9IGNhdGNoIChjbGVhbnVwRXJyb3IpIHtcbiAgICAgICAgbG9nLndhcm4oYEZhaWxlZCB0byBjbGVhbiB1cCBpbmNvbXBsZXRlIHNlc3Npb246ICR7Y2xlYW51cEVycm9yLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICBhc3luYyBfaW5pdGlhbGl6ZUFwcGxpY2F0aW9uU2Vzc2lvbiAoc2Vzc2lvbklkLCBjYXBzKSB7XG4gICAgaWYgKCFjYXBzLmFwcE5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKCdhcHBsaWNhdGlvbiBzaG91bGQgYmUgc3BlY2lmaWVkJyk7XG4gICAgfVxuICAgIHRoaXMuYXBwTmFtZSA9IGNhcHMuYXBwTmFtZTtcbiAgICB0aGlzLmFwcEFyZ3VtZW50cyA9IG5vcm1hbGl6ZUFwcEFyZ3VtZW50cyhjYXBzLmFwcEFyZ3VtZW50cyk7XG4gICAgdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHAgPSBjYXBzLmF0dGFjaFRvUnVubmluZ0FwcCA9PT0gdHJ1ZTtcbiAgICB0aGlzLl9vd25zQXBwbGljYXRpb24gPSAhdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHA7XG5cbiAgICBpZiAodGhpcy5hdHRhY2hUb1J1bm5pbmdBcHAgJiYgdGhpcy5hcHBBcmd1bWVudHMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgJ2FwcGl1bTphcHBBcmd1bWVudHMgY2Fubm90IGJlIHVzZWQgd2l0aCBhcHBpdW06YXR0YWNoVG9SdW5uaW5nQXBwJ1xuICAgICAgKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuX2JhY2tlbmRDb250cm9sbGVyID0gYXdhaXQgY3JlYXRlQmFja2VuZENvbnRyb2xsZXIoe1xuICAgICAgICBjYXBzLFxuICAgICAgICBhcHBOYW1lOiB0aGlzLmFwcE5hbWUsXG4gICAgICAgIGxvZ2dlcjogbG9nLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKGBGYWlsZWQgdG8gaW5pdGlhbGl6ZSBsaW51eCBiYWNrZW5kOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgfVxuXG4gICAgdGhpcy5fYmFja2VuZEFwaXMgPSB0aGlzLl9iYWNrZW5kQ29udHJvbGxlci5hcGlzO1xuICAgIHRoaXMubGludXhCYWNrZW5kID0gdGhpcy5fYmFja2VuZENvbnRyb2xsZXIubmFtZTtcbiAgICBsb2cuaW5mbyhgVXNpbmcgbGludXggYmFja2VuZCAnJHt0aGlzLmxpbnV4QmFja2VuZH0nYCk7XG4gICAgaWYgKHRoaXMubGludXhCYWNrZW5kID09PSAnd2F5bGFuZCcpIHtcbiAgICAgIGNvbnN0IGFwcGxpZWRFbnYgPSBlbnN1cmVXYXlsYW5kQWNjZXNzaWJpbGl0eUxhdW5jaEVudigpO1xuICAgICAgaWYgKGFwcGxpZWRFbnYubGVuZ3RoID4gMCkge1xuICAgICAgICBsb2cuaW5mbyhgQXBwbGllZCBXYXlsYW5kIGFjY2Vzc2liaWxpdHkgbGF1bmNoIGVudjogJHthcHBsaWVkRW52LmpvaW4oJywgJyl9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUgPVxuICAgICAgdGhpcy5hcHBBcmd1bWVudHMubGVuZ3RoID4gMCB8fCB0aGlzLmF0dGFjaFRvUnVubmluZ0FwcDtcblxuICAgIGlmICh0aGlzLmF0dGFjaFRvUnVubmluZ0FwcCkge1xuICAgICAgbG9nLmluZm8oYEF0dGFjaGluZyB0byBydW5uaW5nIGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLmluZm8oYEtpbGxpbmcgdGhlIGFwcCAke3RoaXMuYXBwTmFtZX0gaWYgaXQncyBhbHJlYWR5IHJ1bm5pbmdgKTtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIGJhc2VuYW1lIGZvciB3cmFwcGVyLXNjcmlwdCBkZXRlY3Rpb24gKGUuZy4gL3Vzci9iaW4vaG9yaXpvbi1jbGllbnRcbiAgICAvLyBpcyBhIGJhc2ggc2NyaXB0IHRoYXQgZXhlY3MgL3Vzci9saWIvb21uaXNzYS9ob3Jpem9uL2Jpbi9ob3Jpem9uLWNsaWVudCkuXG4gICAgLy8gVGhlIG5hdGl2ZSBtb2R1bGUgdXNlcyBgcGdyZXAgPGFwcE5hbWU+YCB3aGljaCBvbmx5IG1hdGNoZXMgdGhlIHdyYXBwZXJcbiAgICAvLyBzY3JpcHQgcGF0aCwgbm90IHRoZSBhY3R1YWwgZXhlYydkIGJpbmFyeS5cbiAgICBjb25zdCBhcHBCYXNlTmFtZSA9IHRoaXMuYXBwTmFtZS5zcGxpdCgnLycpLnBvcCgpO1xuXG4gICAgaWYgKCF0aGlzLmF0dGFjaFRvUnVubmluZ0FwcCkge1xuICAgICAgYXdhaXQgdGhpcy5fYmFja2VuZEFwaXMuYXBwX2tpbGwodGhpcy5hcHBOYW1lKTtcbiAgICAgIC8vIEFsc28ga2lsbCBieSBiYXNlbmFtZSBpbiBjYXNlIHRoZSBuYXRpdmUga2lsbCBtaXNzZWQgd3JhcHBlci1zY3JpcHQgcHJvY2Vzc2VzXG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9zcGF3blN5bmMoJ3BraWxsJywgWyctZicsIGFwcEJhc2VOYW1lXSwge3RpbWVvdXQ6IDMwMDB9KTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgICAgYXdhaXQgd2FpdDRzZWMoMC41KTtcbiAgICB9XG5cbiAgICBsZXQgbGF1bmNoUmVzdWx0ID0ge29rOiB0cnVlfTtcbiAgICBpZiAodGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICAgIC8vIFRoZSBleGlzdGluZyBwcm9jZXNzIGlzIGNoZWNrZWQgYmVsb3cgdXNpbmcgdGhlIGVzdGFibGlzaGVkIGRldGVjdGlvbi5cbiAgICB9IGVsc2UgaWYgKHRoaXMuYXBwQXJndW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxvZy5pbmZvKGBMYXVuY2hpbmcgYXBwICR7dGhpcy5hcHBOYW1lfSB3aXRoICR7dGhpcy5hcHBBcmd1bWVudHMubGVuZ3RofSBhcmd1bWVudChzKWApO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY2hpbGRQaWQgPSBhd2FpdCB0aGlzLl9zcGF3bkFwcGxpY2F0aW9uKHRoaXMuYXBwTmFtZSwgdGhpcy5hcHBBcmd1bWVudHMpO1xuICAgICAgICBsb2cuaW5mbyhgTGF1bmNoZWQgYXBwICR7dGhpcy5hcHBOYW1lfSBwaWQ9JHtjaGlsZFBpZH1gKTtcbiAgICAgIH0gY2F0Y2ggKHNwYXduRXJyKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKGBGYWlsZWQgdG8gbGF1bmNoIGFwcDogJHtzcGF3bkVyci5tZXNzYWdlfWApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBsb2cuaW5mbyhgTGF1bmNoaW5nIGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICAgIGxhdW5jaFJlc3VsdCA9IGF3YWl0IHRoaXMuX2JhY2tlbmRBcGlzLmFwcF9sYXVuY2godGhpcy5hcHBOYW1lKTtcbiAgICB9XG5cbiAgICAvLyBIZWxwZXI6IGNoZWNrIGlmIHRoZSBhcHAgaXMgcnVubmluZyBieSB0cnlpbmcgbXVsdGlwbGUgZGV0ZWN0aW9uXG4gICAgLy8gc3RyYXRlZ2llcyDigJQgbmF0aXZlIGFwcF9ydW5uaW5nLCBwZ3JlcCBieSBiYXNlbmFtZSwgYW5kIC9wcm9jIGNtZGxpbmUuXG4gICAgY29uc3QgaXNBcHBSdW5uaW5nID0gKCkgPT4ge1xuICAgICAgLy8gU3RyYXRlZ3kgMTogbmF0aXZlIEFULVNQSS1iYXNlZCBjaGVja1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGlkcyA9IHRoaXMuX2JhY2tlbmRBcGlzLmFwcF9ydW5uaW5nKHRoaXMuYXBwTmFtZSk7XG4gICAgICAgIGlmIChwaWRzICYmIHBpZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cblxuICAgICAgLy8gU3RyYXRlZ3kgMjogcGdyZXAgYnkgYmFzZW5hbWUgKGNhdGNoZXMgZXhlYydkIGJpbmFyaWVzKVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzID0gdGhpcy5fc3Bhd25TeW5jKFxuICAgICAgICAgICdwZ3JlcCcsXG4gICAgICAgICAgWyctZicsIGFwcEJhc2VOYW1lXSxcbiAgICAgICAgICB7ZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogMzAwMH1cbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDAgJiYgcmVzLnN0ZG91dCAmJiByZXMuc3Rkb3V0LnRyaW0oKSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogbm90IGZvdW5kICovIH1cblxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH07XG5cbiAgICBpZiAoIWxhdW5jaFJlc3VsdC5vaykge1xuICAgICAgc3dpdGNoIChsYXVuY2hSZXN1bHQuZXJyQ29kZSkge1xuICAgICAgICBjYXNlIDEwMDA6XG4gICAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoJ2FwcGxpY2F0aW9uIGlzIHJ1bm5pbmcgd2hpbGUgdHJ5aW5nIHRvIHN0YXJ0IGl0Jyk7XG4gICAgICAgIGNhc2UgMTAwMTpcbiAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcigndGhlIHNwZWNpZmllZCBhcHBOYW1lIGlzIHdyb25nJyk7XG4gICAgICAgIGNhc2UgMTAwMjoge1xuICAgICAgICAgIC8vIE5hdGl2ZSBhcHBfbGF1bmNoIGhhcyBhIHZlcnkgc2hvcnQgNXMgdGltZW91dCBhbmQgdXNlcyBwZ3JlcCB3aXRoXG4gICAgICAgICAgLy8gdGhlIGV4YWN0IHBhdGgsIHdoaWNoIGZhaWxzIGZvciB3cmFwcGVyIHNjcmlwdHMgKHRoZSBleGVjJ2QgYmluYXJ5XG4gICAgICAgICAgLy8gaGFzIGEgZGlmZmVyZW50IC9wcm9jL3NlbGYvZXhlKS5cbiAgICAgICAgICBsb2cud2FybignTmF0aXZlIGFwcF9sYXVuY2ggdGltZWQgb3V0OyBjaGVja2luZyBpZiBhcHAgaXMgcnVubmluZyB2aWEgbXVsdGlwbGUgc3RyYXRlZ2llcycpO1xuICAgICAgICAgIGxldCBydW5uaW5nID0gaXNBcHBSdW5uaW5nKCk7XG5cbiAgICAgICAgICBpZiAoIXJ1bm5pbmcpIHtcbiAgICAgICAgICAgIC8vIFRyeSBKUy1sZXZlbCBzcGF3bi4gIFVzZSAvYmluL2Jhc2ggLWMgdG8gaGFuZGxlIHNoZWxsIHNjcmlwdHMuXG4gICAgICAgICAgICBsb2cuaW5mbygnQXBwIG5vdCB5ZXQgcnVubmluZzsgYXR0ZW1wdGluZyBKUy1sZXZlbCBzcGF3biBmYWxsYmFjaycpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgY2hpbGQgPSBzcGF3bignL2Jpbi9iYXNoJywgWyctYycsIGBleGVjICR7dGhpcy5hcHBOYW1lfWBdLCB7XG4gICAgICAgICAgICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgc3RkaW86ICdpZ25vcmUnLFxuICAgICAgICAgICAgICAgIGVudjogey4uLnByb2Nlc3MuZW52fSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIGNoaWxkLnVucmVmKCk7XG4gICAgICAgICAgICAgIGxvZy5pbmZvKGBKUy1zcGF3bmVkIGFwcCBQSUQ9JHtjaGlsZC5waWR9OyBwb2xsaW5nIGZvciBwcm9jZXNzYCk7XG4gICAgICAgICAgICB9IGNhdGNoIChzcGF3bkVycikge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgRmFpbGVkIHRvIGxhdW5jaCBhcHA6ICR7c3Bhd25FcnIubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9nLmluZm8oJ0FwcCBpcyBhbHJlYWR5IHJ1bm5pbmcgKGRldGVjdGVkIHZpYSBiYXNlbmFtZS9wZ3JlcCk7IGNvbnRpbnVpbmcnKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBQb2xsIHVudGlsIHdlIGNhbiBkZXRlY3QgdGhlIGFwcCAodXAgdG8gNjBzIOKAlCBIb3Jpem9uIG9uIFJIRUxcbiAgICAgICAgICAvLyBjYW4gdGFrZSAxNS0yMHMgYWZ0ZXIgbGF1bmNoIHRvIHJlZ2lzdGVyIGluIEFULVNQSSkuXG4gICAgICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgICAgICBjb25zdCBtYXhXYWl0ID0gNjA7XG4gICAgICAgICAgICBjb25zdCBwb2xsTXMgPSAxLjA7XG4gICAgICAgICAgICBmb3IgKGxldCBlbGFwc2VkID0gMDsgZWxhcHNlZCA8IG1heFdhaXQ7IGVsYXBzZWQgKz0gcG9sbE1zKSB7XG4gICAgICAgICAgICAgIGF3YWl0IHdhaXQ0c2VjKHBvbGxNcyk7XG4gICAgICAgICAgICAgIGlmIChpc0FwcFJ1bm5pbmcoKSkge1xuICAgICAgICAgICAgICAgIHJ1bm5pbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGxvZy5pbmZvKGBBcHAgZGV0ZWN0ZWQgYWZ0ZXIgfiR7ZWxhcHNlZCArIHBvbGxNc31zYCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKGVsYXBzZWQgJSAxMCA9PT0gOSkge1xuICAgICAgICAgICAgICAgIGxvZy5pbmZvKGBTdGlsbCB3YWl0aW5nIGZvciBhcHAuLi4gJHtlbGFwc2VkICsgcG9sbE1zfXMgZWxhcHNlZGApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcigndGltZW91dCB3aGlsZSBsYXVjaGluZyBhcHAnKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUpIHtcbiAgICAgIGxldCBydW5uaW5nID0gaXNBcHBSdW5uaW5nKCk7XG4gICAgICBpZiAoIXJ1bm5pbmcpIHtcbiAgICAgICAgY29uc3QgbWF4V2FpdCA9IDYwO1xuICAgICAgICBjb25zdCBwb2xsTXMgPSAxLjA7XG4gICAgICAgIGZvciAobGV0IGVsYXBzZWQgPSAwOyBlbGFwc2VkIDwgbWF4V2FpdDsgZWxhcHNlZCArPSBwb2xsTXMpIHtcbiAgICAgICAgICBhd2FpdCB3YWl0NHNlYyhwb2xsTXMpO1xuICAgICAgICAgIGlmIChpc0FwcFJ1bm5pbmcoKSkge1xuICAgICAgICAgICAgcnVubmluZyA9IHRydWU7XG4gICAgICAgICAgICBsb2cuaW5mbyhgQXBwIGRldGVjdGVkIGFmdGVyIH4ke2VsYXBzZWQgKyBwb2xsTXN9c2ApO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlbGFwc2VkICUgMTAgPT09IDkpIHtcbiAgICAgICAgICAgIGxvZy5pbmZvKGBTdGlsbCB3YWl0aW5nIGZvciBhcHAuLi4gJHtlbGFwc2VkICsgcG9sbE1zfXMgZWxhcHNlZGApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwID8gJ2F0dGFjaGluZyB0bycgOiAnbGF1bmNoaW5nJztcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoYHRpbWVvdXQgd2hpbGUgJHthY3Rpb259IGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICAgIGxvZy5pbmZvKGBBcHAgJHt0aGlzLmFwcE5hbWV9IGF0dGFjaGVkIHN1Y2Nlc3NmdWxseWApO1xuICAgIH0gZWxzZSBpZiAodGhpcy5hcHBBcmd1bWVudHMubGVuZ3RoID4gMCkge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gbGF1bmNoZWQgc3VjY2Vzc2Z1bGx5YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy5pbmZvKGBBcHAgJHt0aGlzLmFwcE5hbWV9IGxhdW5jaGVkIHN1Y2Nlc3NmdWxseWApO1xuICAgIH1cblxuICAgIGF3YWl0IHdhaXQ0c2VjKDAuNSk7XG4gICAgdGhpcy5fd2luID0gbnVsbDtcblxuICAgIGNvbnN0IGlzV2F5bGFuZCA9IHRoaXMubGludXhCYWNrZW5kID09PSAnd2F5bGFuZCc7XG4gICAgbGV0IHRpbWVzID0gdXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUgPyAyMCA6IChpc1dheWxhbmQgPyAyMCA6IDUpO1xuICAgIGNvbnN0IHBvbGxJbnRlcnZhbCA9IHVzZXNFeHRlbmRlZEFwcGxpY2F0aW9uTGlmZWN5Y2xlID8gMS4wIDogKGlzV2F5bGFuZCA/IDEuMCA6IDAuNSk7XG4gICAgbGV0IHdpZHMgPSBbXTtcbiAgICB3aGlsZSAodGltZXMgPiAwKSB7XG4gICAgICBpZiAodXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB3aWRzID0gYXdhaXQgdGhpcy5nZXRXaW5kb3dIYW5kbGVzKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IpKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgd2lkcyA9IFtdO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB3aWRzID0gYXdhaXQgdGhpcy5nZXRXaW5kb3dIYW5kbGVzKCk7XG4gICAgICB9XG4gICAgICBpZiAod2lkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgYXdhaXQgd2FpdDRzZWMocG9sbEludGVydmFsKTtcbiAgICAgIHRpbWVzLS07XG4gICAgfVxuXG4gICAgaWYgKHdpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgQXBwICR7dGhpcy5hcHBOYW1lfSBoYXMgbm8gd2luZG93YCk7XG4gICAgfVxuXG4gICAgaWYgKHdpZHMubGVuZ3RoID4gMSkge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gaGFzIG1vcmUgdGhhbiAxIHdpbmRvd2ApO1xuICAgIH1cblxuICAgIGxldCBzZWxlY3RlZFdpbmRvdyA9IGZhbHNlO1xuICAgIGxldCBsYXN0V2luZG93RXJyb3IgPSBudWxsO1xuICAgIGNvbnN0IHNlbGVjdEF0dGVtcHRzID0gaXNXYXlsYW5kID8gNSA6IDM7XG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCBzZWxlY3RBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgICBjb25zdCBoYW5kbGVzID0gYXR0ZW1wdCA9PT0gMCA/IHdpZHMgOiBhd2FpdCB0aGlzLmdldFdpbmRvd0hhbmRsZXMoKTtcbiAgICAgIGlmIChoYW5kbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBhd2FpdCB3YWl0NHNlYygwLjMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3Qgd2lkIG9mIGhhbmRsZXMpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFdpbmRvdyhudWxsLCB3aWQpO1xuICAgICAgICAgIHNlbGVjdGVkV2luZG93ID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBsYXN0V2luZG93RXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBsb2cud2FybihgRmFpbGVkIHRvIHNlbGVjdCB3aW5kb3cgJyR7d2lkfScgb24gYXR0ZW1wdCAke2F0dGVtcHQgKyAxfTogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc2VsZWN0ZWRXaW5kb3cpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBhd2FpdCB3YWl0NHNlYygwLjMpO1xuICAgIH1cblxuICAgIGlmICghc2VsZWN0ZWRXaW5kb3cpIHtcbiAgICAgIGlmIChsYXN0V2luZG93RXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbGFzdFdpbmRvd0Vycm9yO1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoYEZhaWxlZCB0byBzZWxlY3QgYSB3aW5kb3cgZm9yIGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICB9XG4gICAgbG9nLmluZm8oYHByZS1zZWxlY3RlZCB3aW5kb3cgJHt0aGlzLl93aW4ubmFtZX1gKTtcblxuICAgIHRoaXMuX2NhY2hlID0gbmV3IExSVSh7XG4gICAgICBtYXg6IDUwMCxcbiAgICAgIHR0bDogMTAwMCAqIDYwICogNSxcbiAgICAgIHVwZGF0ZUFnZU9uR2V0OiB0cnVlLFxuICAgICAgdXBkYXRlQWdlT25IYXM6IHRydWVcbiAgICB9KTtcbiAgICByZXR1cm4gW3Nlc3Npb25JZCwgY2Fwc107XG4gIH1cblxuICBhc3luYyBkZWxldGVTZXNzaW9uICgpIHtcbiAgICBpZiAodGhpcy5hcHBOYW1lICYmIHRoaXMuX2JhY2tlbmRBcGlzICYmIHRoaXMuX293bnNBcHBsaWNhdGlvbikge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gaXMga2lsbGVkIGJlZm9yZSBjbG9zaW5nIHNlc3Npb25gKTtcbiAgICAgIGNvbnN0IGJhc2VOYW1lID0gdGhpcy5hcHBOYW1lLnNwbGl0KCcvJykucG9wKCk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLl9iYWNrZW5kQXBpcy5hcHBfa2lsbCh0aGlzLmFwcE5hbWUpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIElnbm9yZSBzaHV0ZG93biBlcnJvcnNcbiAgICAgIH1cbiAgICAgIC8vIEFsc28ga2lsbCBieSBiYXNlbmFtZSBmb3Igd3JhcHBlci1zY3JpcHQgcHJvY2Vzc2VzXG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9zcGF3blN5bmMoJ3BraWxsJywgWyctZicsIGJhc2VOYW1lXSwge3RpbWVvdXQ6IDMwMDB9KTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIH0gZWxzZSBpZiAodGhpcy5hcHBOYW1lICYmIHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwKSB7XG4gICAgICBsb2cuaW5mbyhgTGVhdmluZyBhdHRhY2hlZCBhcHAgJHt0aGlzLmFwcE5hbWV9IHJ1bm5pbmcgd2hpbGUgY2xvc2luZyBzZXNzaW9uYCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2NhY2hlKSB7XG4gICAgICB0aGlzLl9jYWNoZS5jbGVhcigpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9iYWNrZW5kQ29udHJvbGxlcj8uZGVzdHJveSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fYmFja2VuZENvbnRyb2xsZXIuZGVzdHJveSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIElnbm9yZSBiYWNrZW5kIGNsZWFudXAgZXJyb3JzXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYmFja2VuZEFwaXMgPSBudWxsO1xuICAgIHRoaXMuX2JhY2tlbmRDb250cm9sbGVyID0gbnVsbDtcblxuICAgIGF3YWl0IHN1cGVyLmRlbGV0ZVNlc3Npb24oKTtcbiAgfVxufVxuXG5leHBvcnQge1xuICBub3JtYWxpemVBcHBBcmd1bWVudHMsXG4gIHNwYXduQXBwbGljYXRpb24sXG59O1xuZXhwb3J0IGRlZmF1bHQgQXRTcGkyRHJpdmVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7O0FBQUEsSUFBQUEsT0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRCxPQUFBO0FBQ0EsSUFBQUUsWUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcs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
