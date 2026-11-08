/** Small inline glyphs; artwork uses currentColor so it follows the theme. */

import { h } from "./react.js";
import type { IconProps } from "./types.js";

export function IconRss({ size }: IconProps) {
  return h("svg", {
    viewBox: "0 0 16 16",
    width: size || 16,
    height: size || 16,
    "aria-hidden": true,
    style: { display: "block", flex: "none" }
  },
  h("path", {
    d: "M3.25 3.25h4.5A5 5 0 0 1 12.75 8.25v4.5h-2v-4.5a3 3 0 0 0-3-3h-4.5z",
    fill: "currentColor"
  }),
  h("circle", { cx: 4.6, cy: 11.4, r: 1.45, fill: "currentColor" }));
}

export function Chevron({ open }: { open: boolean }) {
  return h("span", {
    className: "gf-chevron" + (open ? " open" : ""),
    "aria-hidden": true
  }, h("svg", { viewBox: "0 0 12 12", width: 10, height: 10 },
    h("path", {
      d: "M4 2.5 7.5 6 4 9.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    })));
}
