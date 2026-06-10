# Native Runtime (RHEL Enablement)

This subtree owns runtime artifacts used by RHEL unified RPM packaging.

## Layout

- `native/libstdspalinux/`:
  Runtime source import location (not committed yet in this repo copy).
- `native/dist/el8/libstdspalinux.so`
- `native/dist/el9/libstdspalinux.so`
- `native/dist/el10/libstdspalinux.so`
- `native/scripts/build-runtime.sh`:
  Build/stage helper for EL-targeted runtime artifacts.
- `native/scripts/verify-no-legacy-cli-deps.sh`:
  Guardrail script to ensure no `xdotool` / `xclip` / `xsel` shell dependency remains.

## Build Runtime Artifact

Run this inside a matching EL environment (VM/container) for ABI correctness.

```bash
native/scripts/build-runtime.sh --el-major 9
```

If you already have a prebuilt runtime library:

```bash
native/scripts/build-runtime.sh \
  --el-major 9 \
  --prebuilt-lib /tmp/libstdspalinux.so
```

## Validate Runtime Artifact

```bash
native/scripts/verify-no-legacy-cli-deps.sh \
  --lib native/dist/el9/libstdspalinux.so
```

This check is required for supported RHEL packaging path.

## Build Unified RPM

After runtime artifact exists:

```bash
./packaging/rpm/build-unified-installer.sh --el-major 9
```
