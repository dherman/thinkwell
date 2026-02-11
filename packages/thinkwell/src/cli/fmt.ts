/**
 * Shared ANSI formatting helpers for CLI help screens.
 *
 * Uses node:util styleText for consistent coloring across all
 * `thinkwell` subcommand help output.
 */

import { styleText } from "node:util";

export const cyan = (t: string) => styleText("cyan", t);
export const cyanBold = (t: string) => styleText(["cyan", "bold"], t);
export const greenBold = (t: string) => styleText(["green", "bold"], t);
export const whiteBold = (t: string) => styleText(["white", "bold"], t);
export const dim = (t: string) => styleText("dim", t);
export const redBold = (t: string) => styleText(["red", "bold"], t);
