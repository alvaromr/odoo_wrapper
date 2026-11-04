/*
 * The colour theme, applied before the page paints: the one classic script of every page, loaded from <head>,
 * so a page chosen dark never flashes light first (modules run only once the page is parsed). style.css turns
 * data-theme on <html> into its tokens; with none it follows the system.
 *
 * - The choice is per browser (localStorage), not in the shared state: a phone in a dark room and a laptop by a
 *   window want different ones. «Ajustes» (settings.js) changes it through window.chooseTheme, which says whether it
 *   could be kept: with storage blocked (some private modes) it lasts until the page reloads, and «Ajustes»
 *   says so. Blocked storage on load leaves the system's theme and a warning in the console.
 */
const ThemeKey = "theme";

window.chooseTheme = (choice) => {
  document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(ThemeKey, choice);
    return true;
  } catch {
    return false;
  }
};

try {
  document.documentElement.dataset.theme = localStorage.getItem(ThemeKey) || "";
} catch (e) {
  console.warn("[odoo] reading the theme failed:", e);
}
