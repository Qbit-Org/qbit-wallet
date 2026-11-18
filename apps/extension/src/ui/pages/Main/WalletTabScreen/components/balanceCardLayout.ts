/**
 * The balance card's line heights, shared by each number's line and the
 * loader that stands in for it, so that nothing moves when a number arrives
 * or goes to a loader: each line is exactly this tall in every state.
 */

/** The total's line: 28 px heading digits (`QbitDisplay`'s `main` preset), and its loader. */
export const BALANCE_TOTAL_LINE_HEIGHT = 34;

/** Available's and Unavailable's lines: 12 px digits (`QbitDisplay`'s `sub` preset), and their loaders. */
export const BALANCE_SPLIT_LINE_HEIGHT = 16;

/**
 * The opacity of the total while it is out of date (refreshed, or under a
 * failure). The card's text (#101412) sits on the brand green (#1ab453) in
 * both themes: 6.81:1 at full opacity, 3.30:1 at 0.6, which the 28 px total
 * needs (3:1 for text of 24 px and more), and plainly lower, as the owner
 * asked. The indicator beside the refresh control says why.
 */
export const BALANCE_TOTAL_DIMMED_OPACITY = 0.6;

/**
 * The opacity of Available and Unavailable while they are out of date. They
 * sit on the detail box, `rgba(0, 0, 0, 0.08)` over the green, #18a64c once
 * composited (8-bit): 5.83:1 at full opacity. Their 12 px digits need 4.5:1,
 * which 0.82 gives (4.61:1 with the dimmed text rounded to 8 bits, 4.59:1
 * without); 0.81 reaches it only before that rounding (4.52:1, then
 * 4.4997:1), so 0.82 is the least that does in both.
 */
export const BALANCE_SPLIT_DIMMED_OPACITY = 0.82;

/** Read by a screen reader, taking no room on screen. */
export const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0
} as const;
