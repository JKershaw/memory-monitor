// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 5588;

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 5000,
    navigationTimeout: 10000,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `PORT=${PORT} node server.js`,
    url: `http://localhost:${PORT}/api/memories`,
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
