// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for the bug where event.stopPropagation on the inner
// modal container swallowed clicks before the document-level delegated
// handler (which processes data-action="close-modal") could see them.

test.describe('New memory modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: '+ New memory' }).click();
    await expect(page.locator('.modal')).toBeVisible();
  });

  test('X button closes the modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('Cancel button closes the modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('Escape key closes the modal', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('clicking the backdrop closes the modal', async ({ page }) => {
    // Click on the overlay but outside the modal content.
    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('clicking inside the modal does NOT close it', async ({ page }) => {
    // Click on the modal header (inside the dialog content).
    await page.locator('#modal-title').click();
    await expect(page.locator('.modal')).toBeVisible();
  });

  test('dialog has correct ARIA role and labelling', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'modal-title');
  });

  test('focus is trapped within the modal on Tab', async ({ page }) => {
    // Press Tab a dozen times; focus should never leave the modal.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const insideModal = await page.evaluate(() =>
        !!document.activeElement && !!document.activeElement.closest('.modal'));
      expect(insideModal).toBe(true);
    }
  });
});
