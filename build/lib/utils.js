"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.executeCommand = executeCommand;
exports.wait4sec = wait4sec;
require("source-map-support/register");
var _child_process = require("child_process");
var _bluebird = require("bluebird");
function wait4sec(s) {
  return new _bluebird.Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, s * 1000);
  });
}
function executeCommand(cmd) {
  return new _bluebird.Promise((resolve, reject) => {
    try {
      const msg = (0, _child_process.execSync)(cmd).toString('utf-8');
      resolve(msg);
    } catch (error) {
      reject(error);
    }
  });
}require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL3V0aWxzLmpzIiwibmFtZXMiOlsiX2NoaWxkX3Byb2Nlc3MiLCJyZXF1aXJlIiwiX2JsdWViaXJkIiwid2FpdDRzZWMiLCJzIiwiUHJvbWlzZSIsInJlc29sdmUiLCJzZXRUaW1lb3V0IiwiZXhlY3V0ZUNvbW1hbmQiLCJjbWQiLCJyZWplY3QiLCJtc2ciLCJleGVjU3luYyIsInRvU3RyaW5nIiwiZXJyb3IiXSwic291cmNlUm9vdCI6Ii4uLy4uIiwic291cmNlcyI6WyJsaWIvdXRpbHMuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IFByb21pc2UgfSBmcm9tICdibHVlYmlyZCc7XG5cbmV4cG9ydCBmdW5jdGlvbiB3YWl0NHNlYyAocykge1xuICByZXR1cm4gbmV3IFByb21pc2UgKChyZXNvbHZlKSA9PiB7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICByZXNvbHZlKCk7XG4gICAgfSwgcyAqIDEwMDApO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGV4ZWN1dGVDb21tYW5kIChjbWQpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbXNnID0gZXhlY1N5bmMoY21kKS50b1N0cmluZygndXRmLTgnKTtcbiAgICAgIHJlc29sdmUobXNnKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICB9XG4gIH0pO1xufSJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQSxJQUFBQSxjQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxTQUFBLEdBQUFELE9BQUE7QUFFTyxTQUFTRSxRQUFRQSxDQUFFQyxDQUFDLEVBQUU7RUFDM0IsT0FBTyxJQUFJQyxpQkFBTyxDQUFHQyxPQUFPLElBQUs7SUFDL0JDLFVBQVUsQ0FBQyxNQUFNO01BQ2ZELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQyxFQUFFRixDQUFDLEdBQUcsSUFBSSxDQUFDO0VBQ2QsQ0FBQyxDQUFDO0FBQ0o7QUFFTyxTQUFTSSxjQUFjQSxDQUFFQyxHQUFHLEVBQUU7RUFDbkMsT0FBTyxJQUFJSixpQkFBTyxDQUFDLENBQUNDLE9BQU8sRUFBRUksTUFBTSxLQUFLO0lBQ3RDLElBQUk7TUFDRixNQUFNQyxHQUFHLEdBQUcsSUFBQUMsdUJBQVEsRUFBQ0gsR0FBRyxDQUFDLENBQUNJLFFBQVEsQ0FBQyxPQUFPLENBQUM7TUFDM0NQLE9BQU8sQ0FBQ0ssR0FBRyxDQUFDO0lBQ2QsQ0FBQyxDQUFDLE9BQU9HLEtBQUssRUFBRTtNQUNkSixNQUFNLENBQUNJLEtBQUssQ0FBQztJQUNmO0VBQ0YsQ0FBQyxDQUFDO0FBQ0oiLCJpZ25vcmVMaXN0IjpbXX0=
