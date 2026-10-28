import { expect, test } from "@playwright/test";

test("math reset keeps a navigable shell without reading old textbook APIs", async ({ page }) => {
  const mathRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/math")) mathRequests.push(request.url());
  });
  await page.goto("/math/tests/removed-test");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.getByRole("link").click();
  await expect(page).toHaveURL("/");
  expect(mathRequests).toEqual([]);
});
