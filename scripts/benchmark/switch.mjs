#!/usr/bin/env node
/**
 * Measurement 2: p95 local representation switch time (architecture §15).
 *
 * Drives the real reference app in Chromium: for N cycles, accepts a grid
 * candidate through the editor and measures the time from the Accept click
 * to the grid renderer being live in the DOM (next paint after mutation).
 * Reports p50/p95/max. Budget: p95 < 100 ms after assets are ready.
 *
 * Usage: node scripts/benchmark/switch.mjs [url] [cycles]
 */
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const cycles = Number(process.argv[3] ?? 20);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

// Boot: open editor, select the chooser, generate candidates.
await page.click('[data-testid="editor-open"]');
await page.click('[data-testid="select-mode"]');
await page.click("text=Aurora Lamp");
await page.waitForSelector('[data-testid="generate"]');
await page.click('[data-testid="generate"]');
await page.waitForSelector('[data-testid="candidate"]');

const durations = [];
for (let i = 0; i < cycles; i++) {
  // Measure: Accept click -> grid present (apply cycle), then Undo -> grid gone.
  const acceptMs = await page.evaluate(() => {
    return new Promise((resolve) => {
      const guard = setTimeout(() => resolve(-1), 5000);
      const items = [...document.querySelectorAll('[data-testid="candidate"]')];
      const grid = items.find((c) => c.textContent.includes("grid@1"));
      const accept = grid?.querySelector('[data-testid="accept"]');
      if (!accept) { clearTimeout(guard); return resolve(-2); }
      const start = performance.now();
      accept.click();
      const check = () => {
        if (document.querySelector(".ui-product-grid")) {
          // Next frame after the switch = visible result.
          requestAnimationFrame(() => { clearTimeout(guard); resolve(performance.now() - start); });
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  });
  if (acceptMs === -1) {
    const status = await page.evaluate(() => document.querySelector('[data-testid="editor-status"]')?.textContent ?? "none");
    throw new Error(`accept did not produce a grid within 5s; editor status: ${status}`);
  }
  if (acceptMs === -2) throw new Error("grid candidate not found");
  durations.push(acceptMs);

  const undoMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const guard = setTimeout(() => resolve(-1), 5000);
        const undo = document.querySelector('[data-testid="undo"]');
        const start = performance.now();
        undo?.click();
        const check = () => {
          if (!document.querySelector(".ui-product-grid")) {
            requestAnimationFrame(() => { clearTimeout(guard); resolve(performance.now() - start); });
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      })
  );
  if (undoMs === -1) {
    const status = await page.evaluate(() => document.querySelector('[data-testid="editor-status"]')?.textContent ?? "none");
    throw new Error(`undo did not restore the carousel within 5s; editor status: ${status}`);
  }
  durations.push(undoMs);
  // Re-generate candidates for the next cycle (list clears after accept).
  await page.evaluate(() => {
    const g = document.querySelector('[data-testid="generate"]');
    if (g) g.click();
  });
  await page.waitForSelector('[data-testid="candidate"]', { timeout: 5000 });
  void undoMs;
}

const sorted = [...durations].sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))];
const result = {
  measurement: "local representation switch (accept + undo), click-to-visible-DOM",
  cycles,
  samples: durations.length,
  p50Ms: Math.round(p(50) * 100) / 100,
  p95Ms: Math.round(p(95) * 100) / 100,
  maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
  budgetP95Ms: 100,
  withinBudget: p(95) < 100,
  raw: durations.map((d) => Math.round(d * 100) / 100),
};
console.log(JSON.stringify(result, null, 2));

import { writeFile } from "node:fs/promises";
await writeFile(new URL("../../docs/benchmark-switch.json", import.meta.url).pathname, JSON.stringify(result, null, 2) + "\n");
await browser.close();
