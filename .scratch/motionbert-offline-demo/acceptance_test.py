#!/usr/bin/env python3
# ruff: noqa: E501
"""Automated acceptance test for the local MotionBERT split-screen demo."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8765/prototype/motionbert"
CHROMIUM = Path(
    "/home/akira/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
)
POSES = Path("/tmp/reme-motionbert-output/poses3d.json")
REPORT = Path("/tmp/reme-motionbert-acceptance.json")
SCREENSHOT = Path("/tmp/reme-motionbert-acceptance.png")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def mark(message: str) -> None:
    print(f"[acceptance] {message}", flush=True)


def validate_pose_data() -> dict[str, object]:
    mark("validating 3D pose data")
    payload = json.loads(POSES.read_text(encoding="utf-8"))
    frames = np.asarray(payload["frames"], dtype=np.float64)
    require(frames.shape == (2370, 17, 3), f"Unexpected pose shape: {frames.shape}")
    require(bool(np.isfinite(frames).all()), "3D output contains non-finite values")

    heights = np.ptp(frames[:, :, 1], axis=1)
    displacements = np.linalg.norm(np.diff(frames, axis=0), axis=2)
    require(int((heights < 0.5).sum()) == 0, "Collapsed skeleton frame detected")
    require(float(np.percentile(displacements, 95)) < 0.1, "Temporal motion is too discontinuous")

    return {
        "shape": list(frames.shape),
        "finite": True,
        "collapsed_frames": int((heights < 0.5).sum()),
        "height_min": round(float(heights.min()), 5),
        "height_median": round(float(np.median(heights)), 5),
        "joint_displacement_p95": round(float(np.percentile(displacements, 95)), 5),
        "joint_displacement_max": round(float(displacements.max()), 5),
    }


def run_browser_checks() -> dict[str, object]:
    console_errors: list[str] = []
    page_errors: list[str] = []
    request_failures: list[str] = []
    request_urls: list[str] = []

    mark("launching Chromium")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(CHROMIUM),
            headless=True,
            args=[
                "--use-angle=swiftshader-webgl",
                "--enable-unsafe-swiftshader",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(10_000)
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("request", lambda request: request_urls.append(request.url))
        page.on(
            "requestfailed",
            lambda request: request_failures.append(
                f"{request.url}: {request.failure or 'unknown failure'}"
            ),
        )

        mark("loading page and local assets")
        response = page.goto(URL, wait_until="domcontentloaded", timeout=30_000)
        require(response is not None and response.ok, "Demo page did not load successfully")
        page.wait_for_function(
            "document.querySelector('#loading').classList.contains('hidden')",
            timeout=30_000,
        )
        page.wait_for_function(
            "document.querySelector('#source-video').readyState >= 1",
            timeout=30_000,
        )

        mark("checking loaded metadata and layout")
        status = page.locator("#pose-status").inner_text()
        require("2370" in status, f"Pose frame count missing from status: {status}")

        meta = page.evaluate("fetch('/api/meta').then(response => response.json())")
        require(meta["video"]["frame_count"] == 2370, "Metadata frame count mismatch")
        require(math.isclose(meta["video"]["duration_seconds"], 79.0, abs_tol=0.1), "Metadata duration mismatch")

        video_state = page.locator("#source-video").evaluate(
            "video => ({duration: video.duration, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight})"
        )
        require(math.isclose(video_state["duration"], 79.0, abs_tol=0.1), f"Video duration mismatch: {video_state}")
        require(video_state["readyState"] >= 1, f"Video metadata unavailable: {video_state}")
        require(video_state["width"] == 1280 and video_state["height"] == 720, f"Video dimensions mismatch: {video_state}")

        panels = page.locator(".viewer-panel")
        require(panels.count() == 2, "Expected two viewer panels")
        left_box = panels.nth(0).bounding_box()
        right_box = panels.nth(1).bounding_box()
        require(left_box is not None and right_box is not None, "Viewer panel layout unavailable")
        require(left_box["x"] < right_box["x"], "Video is not positioned left of the 3D viewer")
        require(left_box["width"] > 500 and right_box["width"] > 500, "Viewer panels are too narrow at desktop size")
        require(abs(left_box["y"] - right_box["y"]) < 2, "Viewer panels are not aligned")

        canvas_box = page.locator("#pose-canvas").bounding_box()
        require(canvas_box is not None and canvas_box["width"] > 500 and canvas_box["height"] > 250, "3D canvas has invalid size")

        mark("checking 3D view controls")
        scene = page.locator("#scene-wrap")
        initial_scene = scene.screenshot()
        page.locator('[data-view="side"]').click()
        page.wait_for_timeout(250)
        side_scene = scene.screenshot()
        require(digest(initial_scene) != digest(side_scene), "Side-view control did not change the 3D scene")

        page.locator('[data-view="top"]').click()
        page.wait_for_timeout(250)
        top_scene = scene.screenshot()
        require(digest(side_scene) != digest(top_scene), "Top-view control did not change the 3D scene")

        grid = page.locator("#grid-toggle")
        grid.uncheck()
        page.wait_for_timeout(150)
        no_grid_scene = scene.screenshot()
        require(digest(top_scene) != digest(no_grid_scene), "Grid toggle did not change the 3D scene")
        grid.check()

        mark("checking video-to-pose timeline synchronization")
        page.locator("#timeline").evaluate(
            "element => { element.value = '500'; element.dispatchEvent(new Event('input', {bubbles: true})); }"
        )
        page.wait_for_function(
            "Math.abs(document.querySelector('#source-video').currentTime - 39.5) < 0.25",
            timeout=10_000,
        )
        frame_text = page.locator("#frame-text").inner_text()
        match = re.search(r"Frame\s+(\d+)", frame_text)
        require(match is not None, f"Frame text is malformed: {frame_text}")
        frame_number = int(match.group(1))
        require(1180 <= frame_number <= 1190, f"Timeline and 3D frame are not synchronized: {frame_text}")

        mark("checking playback speed and play/pause")
        page.locator("#speed").select_option("1.5")
        playback_rate = page.locator("#source-video").evaluate("video => video.playbackRate")
        require(math.isclose(playback_rate, 1.5), f"Playback-rate control failed: {playback_rate}")

        before_play = page.locator("#source-video").evaluate("video => video.currentTime")
        page.locator("#play-toggle").click()
        page.wait_for_timeout(700)
        after_play = page.locator("#source-video").evaluate("video => video.currentTime")
        require(after_play > before_play + 0.35, "Play control did not advance the video")
        page.locator("#play-toggle").click()
        page.wait_for_function("document.querySelector('#source-video').paused")

        mark("checking offline request boundary and browser errors")
        external_requests = [
            url
            for url in request_urls
            if not url.startswith("http://127.0.0.1:8765")
            and not url.startswith("data:")
            and not url.startswith("blob:")
        ]
        require(not external_requests, f"External network dependency detected: {external_requests}")
        require(not console_errors, f"Browser console errors: {console_errors}")
        require(not page_errors, f"Page JavaScript errors: {page_errors}")

        mark("capturing final acceptance screenshot")
        page.screenshot(path=str(SCREENSHOT), full_page=True, timeout=20_000)
        screenshot_size = SCREENSHOT.stat().st_size
        require(screenshot_size > 100_000, f"Acceptance screenshot appears blank: {screenshot_size} bytes")

        mark("closing Chromium")
        browser.close()

    benign_failures = [failure for failure in request_failures if "ERR_ABORTED" in failure]
    serious_failures = [failure for failure in request_failures if failure not in benign_failures]
    require(not serious_failures, f"Resource request failures: {serious_failures}")

    return {
        "url": URL,
        "status_text": status,
        "video": video_state,
        "layout": {"left": left_box, "right": right_box, "canvas": canvas_box},
        "timeline_frame_at_50_percent": frame_number,
        "playback_advanced_seconds": round(after_play - before_play, 3),
        "view_hashes_distinct": len({digest(initial_scene), digest(side_scene), digest(top_scene), digest(no_grid_scene)}) == 4,
        "external_requests": external_requests,
        "console_errors": console_errors,
        "page_errors": page_errors,
        "benign_request_failures": benign_failures,
        "acceptance_screenshot": str(SCREENSHOT),
        "acceptance_screenshot_bytes": screenshot_size,
    }


def main() -> int:
    report = {
        "status": "passed",
        "pose_data": validate_pose_data(),
        "browser": run_browser_checks(),
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
