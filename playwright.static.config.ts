import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
 testDir: './test/live', outputDir: 'artifacts/static-live', workers: 1, fullyParallel: false, timeout: 120000, expect: { timeout: 20000 }, reporter: 'line',
 use: { baseURL: process.env.BIRDBOX_STATIC_URL, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
 projects: [{ name: 'desktop', use: devices['Desktop Chrome'] }, { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }],
});
