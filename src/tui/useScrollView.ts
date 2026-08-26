import { useCallback, useRef, useState, type RefObject } from 'react';
import { useBoxMetrics, type DOMElement } from 'ink';

export interface ScrollView {
  /** Goes on the clipping box — the window the transcript is seen through. */
  viewportRef: RefObject<DOMElement | null>;
  /** Goes on the box holding the transcript itself, which may be taller than the viewport. */
  contentRef: RefObject<DOMElement | null>;
  /** Rows hidden above the viewport. Apply as `marginTop={-offset}` on the content box. */
  offset: number;
  /** Rows hidden below the viewport — 0 while pinned to the newest output. */
  hiddenBelow: number;
  /** True while the newest output is on screen, so new items should keep it there. */
  atBottom: boolean;
  scrollBy: (rows: number) => void;
  scrollPage: (direction: -1 | 1) => void;
  scrollToBottom: () => void;
}

/**
 * A scrollback window for a fixed-height layout: the transcript keeps its full
 * height and is slid under a clipping box, the way a browser scrolls a div.
 *
 * The scroll position is stored as an anchor rather than a row count, and `null`
 * means "pinned to the bottom" — so output arriving while you sit at the bottom
 * scrolls itself into view, while output arriving after you scrolled up leaves
 * your position alone.
 */
export function useScrollView(): ScrollView {
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [anchor, setAnchor] = useState<number | null>(null);

  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const offset = anchor === null ? maxScroll : Math.min(anchor, maxScroll);
  const hiddenBelow = maxScroll - offset;

  const scrollBy = useCallback(
    (rows: number) => {
      // Read the live offset rather than the closed-over one so a burst of key
      // presses in a single frame each move the view.
      setAnchor((current) => {
        const from = current === null ? maxScroll : Math.min(current, maxScroll);
        const next = Math.min(Math.max(from + rows, 0), maxScroll);
        return next >= maxScroll ? null : next;
      });
    },
    [maxScroll],
  );

  const scrollPage = useCallback(
    (direction: -1 | 1) => {
      // One row of overlap keeps a line of context across the jump.
      scrollBy(direction * Math.max(1, viewportHeight - 1));
    },
    [scrollBy, viewportHeight],
  );

  const scrollToBottom = useCallback(() => setAnchor(null), []);

  return {
    viewportRef,
    contentRef,
    offset,
    hiddenBelow,
    atBottom: hiddenBelow === 0,
    scrollBy,
    scrollPage,
    scrollToBottom,
  };
}
