// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Browse page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for any row to appear — confirms the fetch completed.
    await page.locator('.row').first().waitFor({ timeout: 5000 }).catch(() => {});
  });

  test('renders project groups and memory rows', async ({ page }) => {
    await expect(page).toHaveTitle(/Browse/);
    const rows = page.locator('.row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('clicking a row toggles its drawer', async ({ page }) => {
    const firstRow = page.locator('.row').first();
    const drawerId = await firstRow.getAttribute('aria-controls');
    expect(drawerId).toBeTruthy();
    const drawer = page.locator(`#${drawerId}`);

    await expect(drawer).not.toHaveClass(/open/);
    await firstRow.click();
    await expect(drawer).toHaveClass(/open/);
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');

    await firstRow.click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(firstRow).toHaveAttribute('aria-expanded', 'false');
  });

  test('keyboard / focuses the search input', async ({ page }) => {
    await page.locator('body').click(); // ensure body has focus
    await page.keyboard.press('/');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focused).toBe('search');
  });

  test('search filters rows', async ({ page }) => {
    const beforeCount = await page.locator('.row').count();
    await page.locator('#search').fill('zzzznoresultsxxxx');
    // With no matches, the empty state message appears OR rows reduce to 0.
    await expect(page.locator('.row')).toHaveCount(0);
    await page.locator('#search').fill('');
    await expect(page.locator('.row').first()).toBeVisible();
  });

  test('Open-in-workspace link navigates to /dashboard with path hash', async ({ page }) => {
    const firstRow = page.locator('.row').first();
    await firstRow.click();
    const drawerId = await firstRow.getAttribute('aria-controls');
    const link = page.locator(`#${drawerId} .d-open`);
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/dashboard#path=/);
  });

  test('rows are keyboard-activatable with Enter', async ({ page }) => {
    const firstRow = page.locator('.row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
  });
});
