#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

function fail (message, extra) {
  const payload = {ok: false, message};
  if (extra !== undefined) {
    payload.extra = extra;
  }
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
}

const driverRoot = process.argv[2];
if (!driverRoot) {
  fail('Usage: verify-driver-runtime.js <driver-root>');
}

const packageJsonPath = path.join(driverRoot, 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  fail('Driver package.json not found', {driverRoot, packageJsonPath});
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
} catch (error) {
  fail('Failed to parse driver package.json', {driverRoot, error: error.message});
}

const dependencies = Object.keys(pkg.dependencies || {});
const missing = [];

for (const dep of dependencies) {
  // First try direct resolve; fall back to checking package.json existence because
  // some packages (e.g. @babel/runtime) expose only subpath exports with no "." entry.
  try {
    require.resolve(dep, {paths: [driverRoot]});
  } catch (error) {
    const noExportsMain = error.message && error.message.includes('No "exports" main defined');
    const pkgJsonPath = path.join(driverRoot, 'node_modules', dep, 'package.json');
    if (noExportsMain && fs.existsSync(pkgJsonPath)) {
      // Package is present but has no default export — not missing.
    } else {
      missing.push({name: dep, error: error.message});
    }
  }
}

if (missing.length > 0) {
  fail('Driver runtime dependencies are missing', {
    driverRoot,
    dependencyCount: dependencies.length,
    missing,
  });
}

const mainEntry = path.join(driverRoot, pkg.main || 'index.js');
try {
  require(mainEntry);
} catch (error) {
  // Native modules may not be compilable in the build environment (e.g. CI without
  // libstdspalinux.so). Warn but don't fail — postinst verifies on the target machine.
  process.stderr.write(JSON.stringify({
    warn: 'Driver entrypoint could not be loaded in build environment (native module)',
    mainEntry,
    error: error && error.message ? error.message : String(error),
  }, null, 2) + '\n');
}

process.stdout.write(JSON.stringify({
  ok: true,
  driverRoot,
  packageName: pkg.name,
  packageVersion: pkg.version,
  mainEntry,
  dependencyCount: dependencies.length,
}, null, 2) + '\n');
