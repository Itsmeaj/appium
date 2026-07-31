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
var _baseDriver = require("@appium/base-driver");
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
    throw new _baseDriver.errors.InvalidArgumentError('appium:appArguments must be an array of strings');
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
class AtSpi2Driver extends _baseDriver.BaseDriver {
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
      throw new _baseDriver.errors.UnknownError('application should be specified');
    }
    this.appName = caps.appName;
    this.appArguments = normalizeAppArguments(caps.appArguments);
    this.attachToRunningApp = caps.attachToRunningApp === true;
    this._ownsApplication = !this.attachToRunningApp;
    if (this.attachToRunningApp && this.appArguments.length > 0) {
      throw new _baseDriver.errors.InvalidArgumentError('appium:appArguments cannot be used with appium:attachToRunningApp');
    }
    try {
      this._backendController = await (0, _backends.createBackendController)({
        caps,
        appName: this.appName,
        logger: _logger.default
      });
    } catch (error) {
      throw new _baseDriver.errors.UnknownError(`Failed to initialize linux backend: ${error.message}`);
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
        throw new _baseDriver.errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
      }
    } else {
      _logger.default.info(`Lauching app ${this.appName}`);
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
          throw new _baseDriver.errors.UnknownError('application is running while trying to start it');
        case 1001:
          throw new _baseDriver.errors.UnknownError('the specified appName is wrong');
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
                throw new _baseDriver.errors.UnknownError(`Failed to launch app: ${spawnErr.message}`);
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
              throw new _baseDriver.errors.UnknownError('timeout while lauching app');
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
        throw new _baseDriver.errors.UnknownError(`timeout while ${action} app ${this.appName}`);
      }
    }
    if (this.attachToRunningApp) {
      _logger.default.info(`App ${this.appName} attached successfully`);
    } else if (this.appArguments.length > 0) {
      _logger.default.info(`App ${this.appName} launched successfully`);
    } else {
      _logger.default.info(`App ${this.appName} lauched successful`);
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
          if (!(error instanceof _baseDriver.errors.NoSuchWindowError)) {
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
      throw new _baseDriver.errors.UnknownError(`App ${this.appName} has no window`);
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
      throw new _baseDriver.errors.UnknownError(`Failed to select a window for app ${this.appName}`);
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2RyaXZlci5qcyIsIm5hbWVzIjpbIl9sb2Rhc2giLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9iYXNlRHJpdmVyIiwiX2Rlc2lyZWRDYXBzIiwiX2luZGV4IiwiX2xvZ2dlciIsIl91dGlscyIsIl9scnVDYWNoZSIsIl9iYWNrZW5kcyIsIl9jaGlsZF9wcm9jZXNzIiwiX2JsdWViaXJkIiwiTk9fUFJPWFkiLCJub3JtYWxpemVBcHBBcmd1bWVudHMiLCJ2YWx1ZSIsInVuZGVmaW5lZCIsIkFycmF5IiwiaXNBcnJheSIsInNvbWUiLCJpdGVtIiwiZXJyb3JzIiwiSW52YWxpZEFyZ3VtZW50RXJyb3IiLCJzcGF3bkFwcGxpY2F0aW9uIiwiYXBwTmFtZSIsImFwcEFyZ3VtZW50cyIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwiY2hpbGQiLCJzcGF3biIsImRldGFjaGVkIiwic3RkaW8iLCJlbnYiLCJwcm9jZXNzIiwic2hlbGwiLCJvbmNlIiwidW5yZWYiLCJwaWQiLCJlbnN1cmVXYXlsYW5kQWNjZXNzaWJpbGl0eUxhdW5jaEVudiIsImRlZmF1bHRzIiwiUVRfQUNDRVNTSUJJTElUWSIsIlFUX0xJTlVYX0FDQ0VTU0lCSUxJVFlfQUxXQVlTX09OIiwiYXBwbGllZCIsImtleSIsIk9iamVjdCIsImVudHJpZXMiLCJwdXNoIiwiQXRTcGkyRHJpdmVyIiwiQmFzZURyaXZlciIsImNvbnN0cnVjdG9yIiwib3B0cyIsImRlc2lyZWRDYXBDb25zdHJhaW50cyIsImxvY2F0b3JTdHJhdGVnaWVzIiwiY21kIiwiZm4iLCJfIiwidG9QYWlycyIsImNvbW1hbmRzIiwicHJvdG90eXBlIiwicHJveHlBY3RpdmUiLCJnZXRQcm94eUF2b2lkTGlzdCIsImNhblByb3h5IiwiX3NwYXduQXBwbGljYXRpb24iLCJfc3Bhd25TeW5jIiwiYXJncyIsInNwYXduU3luYyIsImNyZWF0ZVNlc3Npb24iLCJzZXNzaW9uSWQiLCJjYXBzIiwiX2luaXRpYWxpemVBcHBsaWNhdGlvblNlc3Npb24iLCJlcnJvciIsImRlbGV0ZVNlc3Npb24iLCJjbGVhbnVwRXJyb3IiLCJsb2ciLCJ3YXJuIiwibWVzc2FnZSIsIlVua25vd25FcnJvciIsImF0dGFjaFRvUnVubmluZ0FwcCIsIl9vd25zQXBwbGljYXRpb24iLCJsZW5ndGgiLCJfYmFja2VuZENvbnRyb2xsZXIiLCJjcmVhdGVCYWNrZW5kQ29udHJvbGxlciIsImxvZ2dlciIsIl9iYWNrZW5kQXBpcyIsImFwaXMiLCJsaW51eEJhY2tlbmQiLCJuYW1lIiwiaW5mbyIsImFwcGxpZWRFbnYiLCJqb2luIiwidXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUiLCJhcHBCYXNlTmFtZSIsInNwbGl0IiwicG9wIiwiYXBwX2tpbGwiLCJ0aW1lb3V0Iiwid2FpdDRzZWMiLCJsYXVuY2hSZXN1bHQiLCJvayIsImNoaWxkUGlkIiwic3Bhd25FcnIiLCJhcHBfbGF1bmNoIiwiaXNBcHBSdW5uaW5nIiwicGlkcyIsImFwcF9ydW5uaW5nIiwicmVzIiwiZW5jb2RpbmciLCJzdGF0dXMiLCJzdGRvdXQiLCJ0cmltIiwiZXJyQ29kZSIsInJ1bm5pbmciLCJtYXhXYWl0IiwicG9sbE1zIiwiZWxhcHNlZCIsImFjdGlvbiIsIl93aW4iLCJpc1dheWxhbmQiLCJ0aW1lcyIsInBvbGxJbnRlcnZhbCIsIndpZHMiLCJnZXRXaW5kb3dIYW5kbGVzIiwiTm9TdWNoV2luZG93RXJyb3IiLCJzZWxlY3RlZFdpbmRvdyIsImxhc3RXaW5kb3dFcnJvciIsInNlbGVjdEF0dGVtcHRzIiwiYXR0ZW1wdCIsImhhbmRsZXMiLCJ3aWQiLCJzZXRXaW5kb3ciLCJfY2FjaGUiLCJMUlUiLCJtYXgiLCJ0dGwiLCJ1cGRhdGVBZ2VPbkdldCIsInVwZGF0ZUFnZU9uSGFzIiwiX3RoaXMkX2JhY2tlbmRDb250cm9sIiwiYmFzZU5hbWUiLCJjbGVhciIsImRlc3Ryb3kiLCJfZGVmYXVsdCIsImV4cG9ydHMiLCJkZWZhdWx0Il0sInNvdXJjZVJvb3QiOiIuLi8uLiIsInNvdXJjZXMiOlsibGliL2RyaXZlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHsgQmFzZURyaXZlciwgZXJyb3JzIH0gZnJvbSAnQGFwcGl1bS9iYXNlLWRyaXZlcic7XG5pbXBvcnQgeyBkZXNpcmVkQ2FwQ29uc3RyYWludHMgfSBmcm9tICcuL2Rlc2lyZWQtY2Fwcyc7XG5pbXBvcnQgY29tbWFuZHMgZnJvbSAnLi9jb21tYW5kcy9pbmRleCc7XG5pbXBvcnQgbG9nIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IHdhaXQ0c2VjIH0gZnJvbSAnLi91dGlscyc7XG5pbXBvcnQgTFJVIGZyb20gJ2xydS1jYWNoZSc7XG5pbXBvcnQgeyBjcmVhdGVCYWNrZW5kQ29udHJvbGxlciB9IGZyb20gJy4vYmFja2VuZHMnO1xuaW1wb3J0IHsgc3Bhd24sIHNwYXduU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHtQcm9taXNlfSBmcm9tICdibHVlYmlyZCc7XG5cbmNvbnN0IE5PX1BST1hZID0gW107XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFwcEFyZ3VtZW50cyAodmFsdWUpIHtcbiAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSB8fCB2YWx1ZS5zb21lKChpdGVtKSA9PiB0eXBlb2YgaXRlbSAhPT0gJ3N0cmluZycpKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICdhcHBpdW06YXBwQXJndW1lbnRzIG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5ncydcbiAgICApO1xuICB9XG4gIHJldHVybiBbLi4udmFsdWVdO1xufVxuXG5mdW5jdGlvbiBzcGF3bkFwcGxpY2F0aW9uIChhcHBOYW1lLCBhcHBBcmd1bWVudHMpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKGFwcE5hbWUsIGFwcEFyZ3VtZW50cywge1xuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXG4gICAgICBlbnY6IHsuLi5wcm9jZXNzLmVudn0sXG4gICAgICBzaGVsbDogZmFsc2UsXG4gICAgfSk7XG4gICAgY2hpbGQub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIGNoaWxkLm9uY2UoJ3NwYXduJywgKCkgPT4ge1xuICAgICAgY2hpbGQudW5yZWYoKTtcbiAgICAgIHJlc29sdmUoY2hpbGQucGlkKTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVdheWxhbmRBY2Nlc3NpYmlsaXR5TGF1bmNoRW52ICgpIHtcbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgUVRfQUNDRVNTSUJJTElUWTogJzEnLFxuICAgIFFUX0xJTlVYX0FDQ0VTU0lCSUxJVFlfQUxXQVlTX09OOiAnMScsXG4gIH07XG4gIGNvbnN0IGFwcGxpZWQgPSBbXTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoZGVmYXVsdHMpKSB7XG4gICAgaWYgKCFwcm9jZXNzLmVudltrZXldKSB7XG4gICAgICBwcm9jZXNzLmVudltrZXldID0gdmFsdWU7XG4gICAgICBhcHBsaWVkLnB1c2goa2V5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFwcGxpZWQ7XG59XG5cbmNsYXNzIEF0U3BpMkRyaXZlciBleHRlbmRzIEJhc2VEcml2ZXIge1xuICBjb25zdHJ1Y3RvciAob3B0cyA9IHt9KSB7XG4gICAgc3VwZXIob3B0cyk7XG4gICAgdGhpcy5kZXNpcmVkQ2FwQ29uc3RyYWludHMgPSBkZXNpcmVkQ2FwQ29uc3RyYWludHM7XG4gICAgdGhpcy5sb2NhdG9yU3RyYXRlZ2llcyA9IFtcbiAgICAgICd4cGF0aCcsXG4gICAgICAnbmFtZScsXG4gICAgICAnY2xhc3MgbmFtZScsXG4gICAgICAnaWQnLFxuICAgICAgJ2FjY2Vzc2liaWxpdHkgaWQnLFxuICAgICAgJ3RhZyBuYW1lJyxcbiAgICAgICdsaW5rIHRleHQnLFxuICAgICAgJ3BhcnRpYWwgbGluayB0ZXh0JyxcbiAgICAgICdjc3Mgc2VsZWN0b3InLFxuICAgIF07XG4gICAgZm9yIChjb25zdCBbY21kLCBmbl0gb2YgXy50b1BhaXJzKGNvbW1hbmRzKSkge1xuICAgICAgQXRTcGkyRHJpdmVyLnByb3RvdHlwZVtjbWRdID0gZm47XG4gICAgfVxuICB9XG5cbiAgcHJveHlBY3RpdmUgKCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGdldFByb3h5QXZvaWRMaXN0ICgpIHtcbiAgICByZXR1cm4gTk9fUFJPWFk7XG4gIH1cblxuICBjYW5Qcm94eSAoKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgX3NwYXduQXBwbGljYXRpb24gKGFwcE5hbWUsIGFwcEFyZ3VtZW50cykge1xuICAgIHJldHVybiBzcGF3bkFwcGxpY2F0aW9uKGFwcE5hbWUsIGFwcEFyZ3VtZW50cyk7XG4gIH1cblxuICBfc3Bhd25TeW5jICguLi5hcmdzKSB7XG4gICAgcmV0dXJuIHNwYXduU3luYyguLi5hcmdzKTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZVNlc3Npb24gKC4uLmFyZ3MpIHtcbiAgICBjb25zdCBbc2Vzc2lvbklkLCBjYXBzXSA9IGF3YWl0IHN1cGVyLmNyZWF0ZVNlc3Npb24oLi4uYXJncyk7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLl9pbml0aWFsaXplQXBwbGljYXRpb25TZXNzaW9uKHNlc3Npb25JZCwgY2Fwcyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZGVsZXRlU2Vzc2lvbigpO1xuICAgICAgfSBjYXRjaCAoY2xlYW51cEVycm9yKSB7XG4gICAgICAgIGxvZy53YXJuKGBGYWlsZWQgdG8gY2xlYW4gdXAgaW5jb21wbGV0ZSBzZXNzaW9uOiAke2NsZWFudXBFcnJvci5tZXNzYWdlfWApO1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX2luaXRpYWxpemVBcHBsaWNhdGlvblNlc3Npb24gKHNlc3Npb25JZCwgY2Fwcykge1xuICAgIGlmICghY2Fwcy5hcHBOYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcignYXBwbGljYXRpb24gc2hvdWxkIGJlIHNwZWNpZmllZCcpO1xuICAgIH1cbiAgICB0aGlzLmFwcE5hbWUgPSBjYXBzLmFwcE5hbWU7XG4gICAgdGhpcy5hcHBBcmd1bWVudHMgPSBub3JtYWxpemVBcHBBcmd1bWVudHMoY2Fwcy5hcHBBcmd1bWVudHMpO1xuICAgIHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwID0gY2Fwcy5hdHRhY2hUb1J1bm5pbmdBcHAgPT09IHRydWU7XG4gICAgdGhpcy5fb3duc0FwcGxpY2F0aW9uID0gIXRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwO1xuXG4gICAgaWYgKHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwICYmIHRoaXMuYXBwQXJndW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgICdhcHBpdW06YXBwQXJndW1lbnRzIGNhbm5vdCBiZSB1c2VkIHdpdGggYXBwaXVtOmF0dGFjaFRvUnVubmluZ0FwcCdcbiAgICAgICk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICB0aGlzLl9iYWNrZW5kQ29udHJvbGxlciA9IGF3YWl0IGNyZWF0ZUJhY2tlbmRDb250cm9sbGVyKHtcbiAgICAgICAgY2FwcyxcbiAgICAgICAgYXBwTmFtZTogdGhpcy5hcHBOYW1lLFxuICAgICAgICBsb2dnZXI6IGxvZyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgRmFpbGVkIHRvIGluaXRpYWxpemUgbGludXggYmFja2VuZDogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgIH1cblxuICAgIHRoaXMuX2JhY2tlbmRBcGlzID0gdGhpcy5fYmFja2VuZENvbnRyb2xsZXIuYXBpcztcbiAgICB0aGlzLmxpbnV4QmFja2VuZCA9IHRoaXMuX2JhY2tlbmRDb250cm9sbGVyLm5hbWU7XG4gICAgbG9nLmluZm8oYFVzaW5nIGxpbnV4IGJhY2tlbmQgJyR7dGhpcy5saW51eEJhY2tlbmR9J2ApO1xuICAgIGlmICh0aGlzLmxpbnV4QmFja2VuZCA9PT0gJ3dheWxhbmQnKSB7XG4gICAgICBjb25zdCBhcHBsaWVkRW52ID0gZW5zdXJlV2F5bGFuZEFjY2Vzc2liaWxpdHlMYXVuY2hFbnYoKTtcbiAgICAgIGlmIChhcHBsaWVkRW52Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgbG9nLmluZm8oYEFwcGxpZWQgV2F5bGFuZCBhY2Nlc3NpYmlsaXR5IGxhdW5jaCBlbnY6ICR7YXBwbGllZEVudi5qb2luKCcsICcpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHVzZXNFeHRlbmRlZEFwcGxpY2F0aW9uTGlmZWN5Y2xlID1cbiAgICAgIHRoaXMuYXBwQXJndW1lbnRzLmxlbmd0aCA+IDAgfHwgdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHA7XG5cbiAgICBpZiAodGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICAgIGxvZy5pbmZvKGBBdHRhY2hpbmcgdG8gcnVubmluZyBhcHAgJHt0aGlzLmFwcE5hbWV9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy5pbmZvKGBLaWxsaW5nIHRoZSBhcHAgJHt0aGlzLmFwcE5hbWV9IGlmIGl0J3MgYWxyZWFkeSBydW5uaW5nYCk7XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSBiYXNlbmFtZSBmb3Igd3JhcHBlci1zY3JpcHQgZGV0ZWN0aW9uIChlLmcuIC91c3IvYmluL2hvcml6b24tY2xpZW50XG4gICAgLy8gaXMgYSBiYXNoIHNjcmlwdCB0aGF0IGV4ZWNzIC91c3IvbGliL29tbmlzc2EvaG9yaXpvbi9iaW4vaG9yaXpvbi1jbGllbnQpLlxuICAgIC8vIFRoZSBuYXRpdmUgbW9kdWxlIHVzZXMgYHBncmVwIDxhcHBOYW1lPmAgd2hpY2ggb25seSBtYXRjaGVzIHRoZSB3cmFwcGVyXG4gICAgLy8gc2NyaXB0IHBhdGgsIG5vdCB0aGUgYWN0dWFsIGV4ZWMnZCBiaW5hcnkuXG4gICAgY29uc3QgYXBwQmFzZU5hbWUgPSB0aGlzLmFwcE5hbWUuc3BsaXQoJy8nKS5wb3AoKTtcblxuICAgIGlmICghdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICAgIGF3YWl0IHRoaXMuX2JhY2tlbmRBcGlzLmFwcF9raWxsKHRoaXMuYXBwTmFtZSk7XG4gICAgICAvLyBBbHNvIGtpbGwgYnkgYmFzZW5hbWUgaW4gY2FzZSB0aGUgbmF0aXZlIGtpbGwgbWlzc2VkIHdyYXBwZXItc2NyaXB0IHByb2Nlc3Nlc1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fc3Bhd25TeW5jKCdwa2lsbCcsIFsnLWYnLCBhcHBCYXNlTmFtZV0sIHt0aW1lb3V0OiAzMDAwfSk7XG4gICAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICAgIGF3YWl0IHdhaXQ0c2VjKDAuNSk7XG4gICAgfVxuXG4gICAgbGV0IGxhdW5jaFJlc3VsdCA9IHtvazogdHJ1ZX07XG4gICAgaWYgKHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwKSB7XG4gICAgICAvLyBUaGUgZXhpc3RpbmcgcHJvY2VzcyBpcyBjaGVja2VkIGJlbG93IHVzaW5nIHRoZSBlc3RhYmxpc2hlZCBkZXRlY3Rpb24uXG4gICAgfSBlbHNlIGlmICh0aGlzLmFwcEFyZ3VtZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICBsb2cuaW5mbyhgTGF1bmNoaW5nIGFwcCAke3RoaXMuYXBwTmFtZX0gd2l0aCAke3RoaXMuYXBwQXJndW1lbnRzLmxlbmd0aH0gYXJndW1lbnQocylgKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNoaWxkUGlkID0gYXdhaXQgdGhpcy5fc3Bhd25BcHBsaWNhdGlvbih0aGlzLmFwcE5hbWUsIHRoaXMuYXBwQXJndW1lbnRzKTtcbiAgICAgICAgbG9nLmluZm8oYExhdW5jaGVkIGFwcCAke3RoaXMuYXBwTmFtZX0gcGlkPSR7Y2hpbGRQaWR9YCk7XG4gICAgICB9IGNhdGNoIChzcGF3bkVycikge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgRmFpbGVkIHRvIGxhdW5jaCBhcHA6ICR7c3Bhd25FcnIubWVzc2FnZX1gKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLmluZm8oYExhdWNoaW5nIGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICAgIGxhdW5jaFJlc3VsdCA9IGF3YWl0IHRoaXMuX2JhY2tlbmRBcGlzLmFwcF9sYXVuY2godGhpcy5hcHBOYW1lKTtcbiAgICB9XG5cbiAgICAvLyBIZWxwZXI6IGNoZWNrIGlmIHRoZSBhcHAgaXMgcnVubmluZyBieSB0cnlpbmcgbXVsdGlwbGUgZGV0ZWN0aW9uXG4gICAgLy8gc3RyYXRlZ2llcyDigJQgbmF0aXZlIGFwcF9ydW5uaW5nLCBwZ3JlcCBieSBiYXNlbmFtZSwgYW5kIC9wcm9jIGNtZGxpbmUuXG4gICAgY29uc3QgaXNBcHBSdW5uaW5nID0gKCkgPT4ge1xuICAgICAgLy8gU3RyYXRlZ3kgMTogbmF0aXZlIEFULVNQSS1iYXNlZCBjaGVja1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGlkcyA9IHRoaXMuX2JhY2tlbmRBcGlzLmFwcF9ydW5uaW5nKHRoaXMuYXBwTmFtZSk7XG4gICAgICAgIGlmIChwaWRzICYmIHBpZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cblxuICAgICAgLy8gU3RyYXRlZ3kgMjogcGdyZXAgYnkgYmFzZW5hbWUgKGNhdGNoZXMgZXhlYydkIGJpbmFyaWVzKVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzID0gdGhpcy5fc3Bhd25TeW5jKFxuICAgICAgICAgICdwZ3JlcCcsXG4gICAgICAgICAgWyctZicsIGFwcEJhc2VOYW1lXSxcbiAgICAgICAgICB7ZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogMzAwMH1cbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDAgJiYgcmVzLnN0ZG91dCAmJiByZXMuc3Rkb3V0LnRyaW0oKSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogbm90IGZvdW5kICovIH1cblxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH07XG5cbiAgICBpZiAoIWxhdW5jaFJlc3VsdC5vaykge1xuICAgICAgc3dpdGNoIChsYXVuY2hSZXN1bHQuZXJyQ29kZSkge1xuICAgICAgICBjYXNlIDEwMDA6XG4gICAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoJ2FwcGxpY2F0aW9uIGlzIHJ1bm5pbmcgd2hpbGUgdHJ5aW5nIHRvIHN0YXJ0IGl0Jyk7XG4gICAgICAgIGNhc2UgMTAwMTpcbiAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcigndGhlIHNwZWNpZmllZCBhcHBOYW1lIGlzIHdyb25nJyk7XG4gICAgICAgIGNhc2UgMTAwMjoge1xuICAgICAgICAgIC8vIE5hdGl2ZSBhcHBfbGF1bmNoIGhhcyBhIHZlcnkgc2hvcnQgNXMgdGltZW91dCBhbmQgdXNlcyBwZ3JlcCB3aXRoXG4gICAgICAgICAgLy8gdGhlIGV4YWN0IHBhdGgsIHdoaWNoIGZhaWxzIGZvciB3cmFwcGVyIHNjcmlwdHMgKHRoZSBleGVjJ2QgYmluYXJ5XG4gICAgICAgICAgLy8gaGFzIGEgZGlmZmVyZW50IC9wcm9jL3NlbGYvZXhlKS5cbiAgICAgICAgICBsb2cud2FybignTmF0aXZlIGFwcF9sYXVuY2ggdGltZWQgb3V0OyBjaGVja2luZyBpZiBhcHAgaXMgcnVubmluZyB2aWEgbXVsdGlwbGUgc3RyYXRlZ2llcycpO1xuICAgICAgICAgIGxldCBydW5uaW5nID0gaXNBcHBSdW5uaW5nKCk7XG5cbiAgICAgICAgICBpZiAoIXJ1bm5pbmcpIHtcbiAgICAgICAgICAgIC8vIFRyeSBKUy1sZXZlbCBzcGF3bi4gIFVzZSAvYmluL2Jhc2ggLWMgdG8gaGFuZGxlIHNoZWxsIHNjcmlwdHMuXG4gICAgICAgICAgICBsb2cuaW5mbygnQXBwIG5vdCB5ZXQgcnVubmluZzsgYXR0ZW1wdGluZyBKUy1sZXZlbCBzcGF3biBmYWxsYmFjaycpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgY2hpbGQgPSBzcGF3bignL2Jpbi9iYXNoJywgWyctYycsIGBleGVjICR7dGhpcy5hcHBOYW1lfWBdLCB7XG4gICAgICAgICAgICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgc3RkaW86ICdpZ25vcmUnLFxuICAgICAgICAgICAgICAgIGVudjogey4uLnByb2Nlc3MuZW52fSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIGNoaWxkLnVucmVmKCk7XG4gICAgICAgICAgICAgIGxvZy5pbmZvKGBKUy1zcGF3bmVkIGFwcCBQSUQ9JHtjaGlsZC5waWR9OyBwb2xsaW5nIGZvciBwcm9jZXNzYCk7XG4gICAgICAgICAgICB9IGNhdGNoIChzcGF3bkVycikge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgRmFpbGVkIHRvIGxhdW5jaCBhcHA6ICR7c3Bhd25FcnIubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9nLmluZm8oJ0FwcCBpcyBhbHJlYWR5IHJ1bm5pbmcgKGRldGVjdGVkIHZpYSBiYXNlbmFtZS9wZ3JlcCk7IGNvbnRpbnVpbmcnKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBQb2xsIHVudGlsIHdlIGNhbiBkZXRlY3QgdGhlIGFwcCAodXAgdG8gNjBzIOKAlCBIb3Jpem9uIG9uIFJIRUxcbiAgICAgICAgICAvLyBjYW4gdGFrZSAxNS0yMHMgYWZ0ZXIgbGF1bmNoIHRvIHJlZ2lzdGVyIGluIEFULVNQSSkuXG4gICAgICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgICAgICBjb25zdCBtYXhXYWl0ID0gNjA7XG4gICAgICAgICAgICBjb25zdCBwb2xsTXMgPSAxLjA7XG4gICAgICAgICAgICBmb3IgKGxldCBlbGFwc2VkID0gMDsgZWxhcHNlZCA8IG1heFdhaXQ7IGVsYXBzZWQgKz0gcG9sbE1zKSB7XG4gICAgICAgICAgICAgIGF3YWl0IHdhaXQ0c2VjKHBvbGxNcyk7XG4gICAgICAgICAgICAgIGlmIChpc0FwcFJ1bm5pbmcoKSkge1xuICAgICAgICAgICAgICAgIHJ1bm5pbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGxvZy5pbmZvKGBBcHAgZGV0ZWN0ZWQgYWZ0ZXIgfiR7ZWxhcHNlZCArIHBvbGxNc31zYCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKGVsYXBzZWQgJSAxMCA9PT0gOSkge1xuICAgICAgICAgICAgICAgIGxvZy5pbmZvKGBTdGlsbCB3YWl0aW5nIGZvciBhcHAuLi4gJHtlbGFwc2VkICsgcG9sbE1zfXMgZWxhcHNlZGApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcigndGltZW91dCB3aGlsZSBsYXVjaGluZyBhcHAnKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUpIHtcbiAgICAgIGxldCBydW5uaW5nID0gaXNBcHBSdW5uaW5nKCk7XG4gICAgICBpZiAoIXJ1bm5pbmcpIHtcbiAgICAgICAgY29uc3QgbWF4V2FpdCA9IDYwO1xuICAgICAgICBjb25zdCBwb2xsTXMgPSAxLjA7XG4gICAgICAgIGZvciAobGV0IGVsYXBzZWQgPSAwOyBlbGFwc2VkIDwgbWF4V2FpdDsgZWxhcHNlZCArPSBwb2xsTXMpIHtcbiAgICAgICAgICBhd2FpdCB3YWl0NHNlYyhwb2xsTXMpO1xuICAgICAgICAgIGlmIChpc0FwcFJ1bm5pbmcoKSkge1xuICAgICAgICAgICAgcnVubmluZyA9IHRydWU7XG4gICAgICAgICAgICBsb2cuaW5mbyhgQXBwIGRldGVjdGVkIGFmdGVyIH4ke2VsYXBzZWQgKyBwb2xsTXN9c2ApO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlbGFwc2VkICUgMTAgPT09IDkpIHtcbiAgICAgICAgICAgIGxvZy5pbmZvKGBTdGlsbCB3YWl0aW5nIGZvciBhcHAuLi4gJHtlbGFwc2VkICsgcG9sbE1zfXMgZWxhcHNlZGApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCFydW5uaW5nKSB7XG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwID8gJ2F0dGFjaGluZyB0bycgOiAnbGF1bmNoaW5nJztcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoYHRpbWVvdXQgd2hpbGUgJHthY3Rpb259IGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICAgIGxvZy5pbmZvKGBBcHAgJHt0aGlzLmFwcE5hbWV9IGF0dGFjaGVkIHN1Y2Nlc3NmdWxseWApO1xuICAgIH0gZWxzZSBpZiAodGhpcy5hcHBBcmd1bWVudHMubGVuZ3RoID4gMCkge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gbGF1bmNoZWQgc3VjY2Vzc2Z1bGx5YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy5pbmZvKGBBcHAgJHt0aGlzLmFwcE5hbWV9IGxhdWNoZWQgc3VjY2Vzc2Z1bGApO1xuICAgIH1cblxuICAgIGF3YWl0IHdhaXQ0c2VjKDAuNSk7XG4gICAgdGhpcy5fd2luID0gbnVsbDtcblxuICAgIGNvbnN0IGlzV2F5bGFuZCA9IHRoaXMubGludXhCYWNrZW5kID09PSAnd2F5bGFuZCc7XG4gICAgbGV0IHRpbWVzID0gdXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUgPyAyMCA6IChpc1dheWxhbmQgPyAyMCA6IDUpO1xuICAgIGNvbnN0IHBvbGxJbnRlcnZhbCA9IHVzZXNFeHRlbmRlZEFwcGxpY2F0aW9uTGlmZWN5Y2xlID8gMS4wIDogKGlzV2F5bGFuZCA/IDEuMCA6IDAuNSk7XG4gICAgbGV0IHdpZHMgPSBbXTtcbiAgICB3aGlsZSAodGltZXMgPiAwKSB7XG4gICAgICBpZiAodXNlc0V4dGVuZGVkQXBwbGljYXRpb25MaWZlY3ljbGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB3aWRzID0gYXdhaXQgdGhpcy5nZXRXaW5kb3dIYW5kbGVzKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IpKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgd2lkcyA9IFtdO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB3aWRzID0gYXdhaXQgdGhpcy5nZXRXaW5kb3dIYW5kbGVzKCk7XG4gICAgICB9XG4gICAgICBpZiAod2lkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgYXdhaXQgd2FpdDRzZWMocG9sbEludGVydmFsKTtcbiAgICAgIHRpbWVzLS07XG4gICAgfVxuXG4gICAgaWYgKHdpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcihgQXBwICR7dGhpcy5hcHBOYW1lfSBoYXMgbm8gd2luZG93YCk7XG4gICAgfVxuXG4gICAgaWYgKHdpZHMubGVuZ3RoID4gMSkge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gaGFzIG1vcmUgdGhhbiAxIHdpbmRvd2ApO1xuICAgIH1cblxuICAgIGxldCBzZWxlY3RlZFdpbmRvdyA9IGZhbHNlO1xuICAgIGxldCBsYXN0V2luZG93RXJyb3IgPSBudWxsO1xuICAgIGNvbnN0IHNlbGVjdEF0dGVtcHRzID0gaXNXYXlsYW5kID8gNSA6IDM7XG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCBzZWxlY3RBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgICBjb25zdCBoYW5kbGVzID0gYXR0ZW1wdCA9PT0gMCA/IHdpZHMgOiBhd2FpdCB0aGlzLmdldFdpbmRvd0hhbmRsZXMoKTtcbiAgICAgIGlmIChoYW5kbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBhd2FpdCB3YWl0NHNlYygwLjMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3Qgd2lkIG9mIGhhbmRsZXMpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFdpbmRvdyhudWxsLCB3aWQpO1xuICAgICAgICAgIHNlbGVjdGVkV2luZG93ID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBsYXN0V2luZG93RXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBsb2cud2FybihgRmFpbGVkIHRvIHNlbGVjdCB3aW5kb3cgJyR7d2lkfScgb24gYXR0ZW1wdCAke2F0dGVtcHQgKyAxfTogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc2VsZWN0ZWRXaW5kb3cpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBhd2FpdCB3YWl0NHNlYygwLjMpO1xuICAgIH1cblxuICAgIGlmICghc2VsZWN0ZWRXaW5kb3cpIHtcbiAgICAgIGlmIChsYXN0V2luZG93RXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbGFzdFdpbmRvd0Vycm9yO1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoYEZhaWxlZCB0byBzZWxlY3QgYSB3aW5kb3cgZm9yIGFwcCAke3RoaXMuYXBwTmFtZX1gKTtcbiAgICB9XG4gICAgbG9nLmluZm8oYHByZS1zZWxlY3RlZCB3aW5kb3cgJHt0aGlzLl93aW4ubmFtZX1gKTtcblxuICAgIHRoaXMuX2NhY2hlID0gbmV3IExSVSh7XG4gICAgICBtYXg6IDUwMCxcbiAgICAgIHR0bDogMTAwMCAqIDYwICogNSxcbiAgICAgIHVwZGF0ZUFnZU9uR2V0OiB0cnVlLFxuICAgICAgdXBkYXRlQWdlT25IYXM6IHRydWVcbiAgICB9KTtcbiAgICByZXR1cm4gW3Nlc3Npb25JZCwgY2Fwc107XG4gIH1cblxuICBhc3luYyBkZWxldGVTZXNzaW9uICgpIHtcbiAgICBpZiAodGhpcy5hcHBOYW1lICYmIHRoaXMuX2JhY2tlbmRBcGlzICYmIHRoaXMuX293bnNBcHBsaWNhdGlvbikge1xuICAgICAgbG9nLmluZm8oYEFwcCAke3RoaXMuYXBwTmFtZX0gaXMga2lsbGVkIGJlZm9yZSBjbG9zaW5nIHNlc3Npb25gKTtcbiAgICAgIGNvbnN0IGJhc2VOYW1lID0gdGhpcy5hcHBOYW1lLnNwbGl0KCcvJykucG9wKCk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLl9iYWNrZW5kQXBpcy5hcHBfa2lsbCh0aGlzLmFwcE5hbWUpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIElnbm9yZSBzaHV0ZG93biBlcnJvcnNcbiAgICAgIH1cbiAgICAgIC8vIEFsc28ga2lsbCBieSBiYXNlbmFtZSBmb3Igd3JhcHBlci1zY3JpcHQgcHJvY2Vzc2VzXG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9zcGF3blN5bmMoJ3BraWxsJywgWyctZicsIGJhc2VOYW1lXSwge3RpbWVvdXQ6IDMwMDB9KTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIH0gZWxzZSBpZiAodGhpcy5hcHBOYW1lICYmIHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwKSB7XG4gICAgICBsb2cuaW5mbyhgTGVhdmluZyBhdHRhY2hlZCBhcHAgJHt0aGlzLmFwcE5hbWV9IHJ1bm5pbmcgd2hpbGUgY2xvc2luZyBzZXNzaW9uYCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2NhY2hlKSB7XG4gICAgICB0aGlzLl9jYWNoZS5jbGVhcigpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9iYWNrZW5kQ29udHJvbGxlcj8uZGVzdHJveSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fYmFja2VuZENvbnRyb2xsZXIuZGVzdHJveSgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIElnbm9yZSBiYWNrZW5kIGNsZWFudXAgZXJyb3JzXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYmFja2VuZEFwaXMgPSBudWxsO1xuICAgIHRoaXMuX2JhY2tlbmRDb250cm9sbGVyID0gbnVsbDtcblxuICAgIGF3YWl0IHN1cGVyLmRlbGV0ZVNlc3Npb24oKTtcbiAgfVxufVxuXG5leHBvcnQge1xuICBub3JtYWxpemVBcHBBcmd1bWVudHMsXG4gIHNwYXduQXBwbGljYXRpb24sXG59O1xuZXhwb3J0IGRlZmF1bHQgQXRTcGkyRHJpdmVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7O0FBQUEsSUFBQUEsT0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsV0FBQSxHQUFBRCxPQUFBO0FBQ0EsSUFBQUUsWUFBQSxHQUFBRixPQUFBO0FBQ0Es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
