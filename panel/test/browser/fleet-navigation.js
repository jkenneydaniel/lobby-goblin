export async function openFleetMenu(page) {
  const menu = page.locator('.fleet-menu-toggle[aria-expanded="false"]');
  if (await menu.isVisible()) await menu.click();
}

export async function followPanelLink(page, name) {
  await openFleetMenu(page);
  await page.getByRole('navigation', {name: /navigation/})
    .getByRole('link', {name, exact: true}).click();
}

export async function signOutOfPanel(page) {
  await openFleetMenu(page);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
}
