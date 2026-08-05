#!/usr/bin/env python3
"""iOS 시뮬레이터 조작. 좌표는 `simctl io screenshot` 픽셀(1206x2622).
  python3 sim.py tap 603 2112
  python3 sim.py type 보고싶어
  python3 sim.py shot out.png
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

def type_text(s):
    # 한글은 키코드로 못 친다 — 유니코드 문자열을 그대로 키이벤트에 실어 보낸다.
    focus()
    for ch in s:
        for down in (True, False):
            e = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
            Quartz.CGEventKeyboardSetUnicodeString(e, len(ch), ch)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
            time.sleep(0.02)
        time.sleep(0.06)
    print(f"type({s})")

def shot(path):
    subprocess.run(["xcrun", "simctl", "io", "booted", "screenshot", path],
                   capture_output=True)
    print(path)

if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    {"tap": lambda: tap(float(a[0]), float(a[1])),
     "type": lambda: type_text(" ".join(a)),
     "shot": lambda: shot(a[0])}[cmd]()
