/**
 * Shared layout rules for the in-chat browser panels (BrowserToolCard and
 * BrowserThreadCard).
 *
 * The browser preview image used to size itself purely from `aspectRatio`,
 * so on wide viewports it grew tall enough to swallow the whole chat and the
 * user could no longer follow the conversation. These caps keep the chat
 * visible and scrollable, and every panel gets a collapse toggle so the user
 * can shrink it to a single status row.
 */

/** Preview height never exceeds this fraction of the window height. */
export const BROWSER_PREVIEW_MAX_HEIGHT_FRACTION = 0.42;

/** Hard pixel ceiling so tall desktop windows don't get a giant preview. */
export const BROWSER_PREVIEW_MAX_HEIGHT_PX = 380;

/** Minimum useful preview height on very short viewports. */
export const BROWSER_PREVIEW_MIN_HEIGHT_PX = 120;

/**
 * Panels start expanded: the height cap alone keeps them compact, and the
 * header row always shows what the browser is doing.
 */
export const BROWSER_PREVIEW_DEFAULT_COLLAPSED = false;

/** Max preview height in px for a given window height. Never unbounded. */
export function browserPreviewMaxHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) {
    return BROWSER_PREVIEW_MAX_HEIGHT_PX;
  }
  return Math.min(
    BROWSER_PREVIEW_MAX_HEIGHT_PX,
    Math.max(
      BROWSER_PREVIEW_MIN_HEIGHT_PX,
      Math.round(windowHeight * BROWSER_PREVIEW_MAX_HEIGHT_FRACTION),
    ),
  );
}
