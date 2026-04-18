// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Workspace page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('.item').first().waitFor({ timeout: 5000 }).catch(() => {});
  });

  test('renders sidebar list and empty detail pane', async ({ page }) => {
    await expect(page.locator('aside .list .item').first()).toBeVisible();
    await expect(page.locator('.detail-empty')).toBeVisible();
  });

  test('selecting an item populates the detail pane', async ({ page }) => {
    const first = page.locator('.item').first();
    await first.click();
    await expect(first).toHaveClass(/selected/);
    await expect(page.locator('.d-title')).toBeVisible();
  });

  test('Esc deselects the currently-selected item', async ({ page }) => {
    await page.locator('.item').first().click();
    await expect(page.locator('.d-title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.detail-empty')).toBeVisible();
  });

  test('j/k navigates through items via keyboard selection', async ({ page }) => {
    // Workspace's j/k navigates via state, not via element focus. Verify via
    // the .selected item changing.
    await page.keyboard.press('j');
    const first = await page.locator('.item.selected').first().getAttribute('data-path');
    expect(first).toBeTruthy();
    await page.keyboard.press('j');
    const second = await page.locator('.item.selected').first().getAttribute('data-path');
    expect(second).not.toBe(first);
  });

  test('/ focuses search', async ({ page }) => {
    await page.locator('aside').click();
    await page.keyboard.press('/');
    const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
    expect(id).toBe('search');
  });

  test('item rows expose role=button and aria-selected', async ({ page }) => {
    const item = page.locator('.item').first();
    await expect(item).toHaveAttribute('role', 'button');
    await expect(item).toHaveAttribute('tabindex', '0');
    await expect(item).toHaveAttribute('aria-selected', /true|false/);
  });
});
