import assert from "node:assert/strict";
import test from "node:test";
import { fitWindowPositionToWorkArea, fitWindowSizeToWorkArea } from "../.test-dist/src/window-fit.js";

test("小さい画面ではウィンドウを作業領域内へ縮める", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 1180, height: 760 }, { width: 840, height: 700 }),
    { width: 808, height: 668 },
  );
});

test("十分な作業領域では既定サイズを維持する", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 1180, height: 760 }, { width: 1600, height: 1000 }),
    { width: 1180, height: 760 },
  );
});

test("最小サイズ以上なら作業領域を優先して余白を確保する", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 1180, height: 760 }, { width: 600, height: 440 }),
    { width: 568, height: 408 },
  );
});

test("作業領域が最小サイズより小さければネイティブ最小サイズを下回らない", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 1180, height: 760 }, { width: 300, height: 220 }),
    { width: 320, height: 240 },
  );
});

test("最小サイズ以上で画面に収まる場合は現在サイズを維持する", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 500, height: 400 }, { width: 1000, height: 800 }),
    { width: 500, height: 400 },
  );
});

test("小さい画面でもネイティブ最小サイズまで広げる", () => {
  assert.deepEqual(
    fitWindowSizeToWorkArea({ width: 200, height: 160 }, { width: 1000, height: 800 }),
    { width: 320, height: 240 },
  );
});

test("画面の作業領域より右下にはみ出した位置を内側へ戻す", () => {
  assert.deepEqual(
    fitWindowPositionToWorkArea({ x: 1200, y: 900 }, { width: 800, height: 600 }, { position: { x: 100, y: 50 }, size: { width: 840, height: 700 } }),
    { x: 140, y: 150 },
  );
});

test("画面の作業領域より左上にはみ出した位置を内側へ戻す", () => {
  assert.deepEqual(
    fitWindowPositionToWorkArea({ x: -900, y: -700 }, { width: 600, height: 400 }, { position: { x: 80, y: 40 }, size: { width: 840, height: 700 } }),
    { x: 80, y: 40 },
  );
});
