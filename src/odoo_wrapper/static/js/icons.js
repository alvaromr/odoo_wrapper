/*
 * The hero's inline icons (bell, gear, QR): SVG paths drawn in the text's colour, all with the same stroke.
 */

/**
 * @param {string[]} shapes
 * @returns {SVGSVGElement}
 */
function icon(shapes) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: 15,
    height: 15,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, /** @type {string} */ (v));
  for (const d of shapes) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * @param {boolean} muted
 * @returns {SVGSVGElement}
 */
export function bellIcon(muted) {
  return icon([
    "M10.3 21a2 2 0 0 0 3.4 0",
    "M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3",
    ...(muted ? ["M3 3l18 18"] : []),
  ]);
}

/** @returns {SVGSVGElement} */
export function gearIcon() {
  return icon([
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38" +
      "a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38" +
      "a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2" +
      "v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73" +
      "l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73" +
      "l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ]);
}

/** @returns {SVGSVGElement} */
export function qrIcon() {
  return icon([
    "M3 3h5v5H3z",
    "M16 3h5v5h-5z",
    "M3 16h5v5H3z",
    "M21 16h-3a2 2 0 0 0-2 2v3",
    "M21 21v.01",
    "M12 7v3a2 2 0 0 1-2 2H7",
    "M3 12h.01",
    "M12 3h.01",
    "M12 16v.01",
    "M16 12h1",
    "M21 12v.01",
    "M12 21v-1",
  ]);
}
