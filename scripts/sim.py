#!/usr/bin/env python3
"""iOS 시뮬레이터 조작. 좌표는 `simctl io screenshot` 픽셀(1206x2622).
  python3 sim.py tap 603 2112
  python3 sim.py shot out.png

타이핑은 없다 — CGEvent 유니코드는 시뮬레이터 HID 로 안 들어간다.
화면은 URL 로 만든다: #q=<단어> / #w=<base64url>. (CLAUDE.md 「시뮬레이터로 확인하기」)
"""
import subprocess, sys, time
import Quartz

SHOT_W, SHOT_H = 1206, 2622

def win_rect():
    out = subprocess.run(
        ["osascript", "-e",
         'tell application "System Events" to tell process "Simulator" to get {position, size} of window 1'],
        capture_output=True, text=True).stdout.strip()
    return [int(v) for v in out.split(", ")]

def focus():
    subprocess.run(["osascript", "-e", 'tell application "Simulator" to activate'])
    time.sleep(0.4)

def tap(dx, dy):
    wx, wy, ww, wh = win_rect()
    x, y = wx + dx * ww / SHOT_W, wy + dy * wh / SHOT_H
    focus()
    for kind in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
        Quartz.CGEventPost(Quartz.kCGHIDEventTap,
            Quartz.CGEventCreateMouseEvent(None, kind, (x, y), Quartz.kCGMouseButtonLeft))
        time.sleep(0.05)
    print(f"tap({dx},{dy}) -> host({x:.0f},{y:.0f})")

def shot(path):
    subprocess.run(["xcrun", "simctl", "io", "booted", "screenshot", path],
                   capture_output=True)
    print(path)

if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    {"tap": lambda: tap(float(a[0]), float(a[1])),
     "shot": lambda: shot(a[0])}[cmd]()
