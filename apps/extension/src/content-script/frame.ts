/**
 * Whether this document is its tab's top frame. A fenced frame, such as an
 * ad, is its own window.top but not the tab's top frame.
 */
export function isTopFrame(): boolean {
  return window === window.top && !(window as Window & { fence?: unknown }).fence;
}
