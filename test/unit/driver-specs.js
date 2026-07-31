import AtSpi2Driver, {
  normalizeAppArguments,
} from '../../lib/driver.js';
import { BaseDriver } from '@appium/base-driver';
import { desiredCapConstraints } from '../../lib/desired-caps.js';
import * as backends from '../../lib/backends/index.js';
import chai from 'chai';
import sinon from 'sinon';
const should = chai.should();

describe('AtSpi2Driver', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('should exist', function () {
    should.exist(AtSpi2Driver);
  });

  it('should expose direct-launch and attach capabilities', function () {
    desiredCapConstraints.appArguments.isArray.should.eql(true);
    desiredCapConstraints.attachToRunningApp.isBoolean.should.eql(true);
  });

  it('should preserve direct-launch arguments as an argv array', function () {
    normalizeAppArguments([
      '--serverURL=localhost:4443',
      '--password=ca$hc0w',
      '--desktopName=desktop1',
    ]).should.eql([
      '--serverURL=localhost:4443',
      '--password=ca$hc0w',
      '--desktopName=desktop1',
    ]);
  });

  it('should reject shell strings for direct-launch arguments', function () {
    (() => normalizeAppArguments('--desktopName=desktop1'))
      .should.throw('must be an array of strings');
  });

  it('should clean up an owned direct launch and backend when session setup fails', async function () {
    const appName = '/opt/test/direct-launch-app';
    const appKill = sinon.stub().resolves();
    const destroy = sinon.stub().resolves();
    const baseDeleteSession = sinon.stub(BaseDriver.prototype, 'deleteSession').resolves();
    sinon.stub(BaseDriver.prototype, 'createSession').resolves([
      'failed-direct-session',
      {
        appName,
        appArguments: ['--desktopName=desktop1'],
      },
    ]);
    sinon.stub(backends, 'createBackendController').resolves({
      name: 'x11',
      apis: {
        app_kill: appKill,
        app_running: sinon.stub().returns([101]),
      },
      destroy,
    });
    const driver = new AtSpi2Driver();
    const spawnApplication = sinon.stub(driver, '_spawnApplication').resolves(101);
    const spawnSync = sinon.stub(driver, '_spawnSync').returns({
      status: 1,
      stdout: '',
    });
    sinon.stub(driver, 'getWindowHandles').rejects(new Error('window discovery failed'));

    let sessionError;
    try {
      await driver.createSession({});
    } catch (error) {
      sessionError = error;
    }

    should.exist(sessionError);
    sessionError.message.should.eql('window discovery failed');
    spawnApplication.calledOnceWithExactly(
      appName,
      ['--desktopName=desktop1']
    ).should.eql(true);
    appKill.callCount.should.eql(2);
    appKill.alwaysCalledWithExactly(appName).should.eql(true);
    spawnSync.callCount.should.eql(2);
    spawnSync.alwaysCalledWithExactly(
      'pkill',
      ['-f', 'direct-launch-app'],
      {timeout: 3000}
    ).should.eql(true);
    destroy.calledOnce.should.eql(true);
    baseDeleteSession.calledOnce.should.eql(true);
  });

  it('should clean up the backend without killing an attached app when session setup fails', async function () {
    const appName = '/opt/test/attached-app';
    const appKill = sinon.stub().resolves();
    const destroy = sinon.stub().resolves();
    const baseDeleteSession = sinon.stub(BaseDriver.prototype, 'deleteSession').resolves();
    sinon.stub(BaseDriver.prototype, 'createSession').resolves([
      'failed-attach-session',
      {
        appName,
        attachToRunningApp: true,
      },
    ]);
    sinon.stub(backends, 'createBackendController').resolves({
      name: 'x11',
      apis: {
        app_kill: appKill,
        app_running: sinon.stub().returns([202]),
      },
      destroy,
    });
    const driver = new AtSpi2Driver();
    const spawnApplication = sinon.stub(driver, '_spawnApplication');
    const spawnSync = sinon.stub(driver, '_spawnSync');
    sinon.stub(driver, 'getWindowHandles').rejects(new Error('window discovery failed'));

    let sessionError;
    try {
      await driver.createSession({});
    } catch (error) {
      sessionError = error;
    }

    should.exist(sessionError);
    sessionError.message.should.eql('window discovery failed');
    appKill.notCalled.should.eql(true);
    spawnApplication.notCalled.should.eql(true);
    spawnSync.notCalled.should.eql(true);
    destroy.calledOnce.should.eql(true);
    baseDeleteSession.calledOnce.should.eql(true);
  });

});
