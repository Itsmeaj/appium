#!/usr/bin/env python3
"""Manual Appium Linux driver smoke test for calculator XML dump."""

import argparse
import json
import sys
import urllib.error
import urllib.request


def call(base_url, method, path, payload=None, timeout=120):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(
        description="Create Appium session, dump page XML, and close session."
    )
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:4723/wd/hub",
        help="Appium server base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--app-name",
        default="galculator",
        help="App name passed as appium:appName (default: %(default)s)",
    )
    parser.add_argument(
        "--automation-name",
        default="AtSpi2",
        help="Automation name (default: %(default)s)",
    )
    parser.add_argument(
        "--platform-name",
        default="Linux",
        help="Platform name (default: %(default)s)",
    )
    parser.add_argument(
        "--linux-backend",
        default=None,
        choices=["auto", "x11", "wayland"],
        help="Optional appium:linuxBackend capability value",
    )
    parser.add_argument(
        "--wayland-auto-share",
        default=None,
        choices=["true", "false"],
        help="Optional appium:waylandAutoShare capability value",
    )
    parser.add_argument(
        "--xml-out",
        default="/tmp/galculator-source.xml",
        help="Output path for page source XML (default: %(default)s)",
    )
    args = parser.parse_args()

    caps = {
        "platformName": args.platform_name,
        "appium:automationName": args.automation_name,
        "appium:appName": args.app_name,
    }
    if args.linux_backend:
        caps["appium:linuxBackend"] = args.linux_backend
    if args.wayland_auto_share is not None:
        caps["appium:waylandAutoShare"] = args.wayland_auto_share == "true"

    session_id = None
    try:
        create_res = call(
            args.server,
            "POST",
            "/session",
            {"capabilities": {"alwaysMatch": caps}},
        )
        session_id = create_res.get("sessionId") or create_res.get("value", {}).get(
            "sessionId"
        )
        if not session_id:
            print("FAILED: createSession did not return sessionId")
            print(json.dumps(create_res, indent=2))
            return 1

        print(f"SESSION_ID: {session_id}")
        source_res = call(args.server, "GET", f"/session/{session_id}/source")
        source = source_res.get("value", "")

        with open(args.xml_out, "w", encoding="utf-8") as f:
            f.write(source)

        print(f"XML_OUT: {args.xml_out}")
        print(f"SOURCE_LEN: {len(source)}")
        print("XML_PREVIEW_START")
        print(source[:2000])
        print("XML_PREVIEW_END")
        return 0
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP_ERROR: {e.code}")
        print(body)
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}")
        return 3
    finally:
        if session_id:
            try:
                call(args.server, "DELETE", f"/session/{session_id}")
                print("Session closed")
            except Exception as e:  # noqa: BLE001
                print(f"WARN: failed to close session {session_id}: {e}")


if __name__ == "__main__":
    sys.exit(main())
