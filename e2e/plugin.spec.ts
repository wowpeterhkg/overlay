import { test, expect } from '@playwright/test'

test('vite plugin injects overlay in dev', async ({ page }) => {
  await page.goto('http://localhost:5199/')
  await expect(page.locator('#overlay-root .ovl-fab')).toBeVisible()
})

test('tag capture via test hook persists and pins', async ({ page }) => {
  await page.goto('http://localhost:5199/')
  await page.evaluate(() => localStorage.setItem('demo_tags', '[]'))
  await page.reload()
  await expect(page.locator('.ovl-fab')).toBeVisible()
  // arm + click the CTA — the real user path
  await page.keyboard.press('Alt+a')
  await page.locator('[data-testid="cta-button"]').hover()
  await page.keyboard.press('Enter')
  await page.locator('.ovl-ta').fill('make it blue')
  await page.locator('.ovl-float .ovl-act-primary').click()
  await expect(page.locator('.ovl-pin')).toBeVisible()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('demo_tags')!))
  expect(stored[0].selector).toBe('[data-testid="cta-button"]')
  expect(stored[0].note).toBe('make it blue')
})
