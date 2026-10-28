import VirtualList, { ListRef } from 'rc-virtual-list';
import { CSSProperties, Key, ReactElement, Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

export interface AutoFitVirtualListProps<T> {
  data: T[];
  itemHeight: number;
  itemKey: Key | ((item: T) => Key);
  children: (item: T, index: number) => ReactElement;
  listRef?: Ref<ListRef>;
  /**
   * Smallest measured height at which the list still virtualizes. Below it
   * the rows render inline instead, so the enclosing scroll container scrolls
   * them and a scrolling list is never nested inside an overflowing parent.
   * Defaults to one row.
   */
  minVirtualHeight?: number;
  style?: CSSProperties;
}

const ROW_CONTAINER_SELECTOR = '.rc-virtual-list-holder-inner';

/**
 * An rc-virtual-list sized to the space its flex parent actually gives it,
 * measured with a ResizeObserver instead of window.innerHeight math, so the
 * list never overflows its parent and stays the screen's only scroll surface.
 *
 * When that space is too small to show even one row (a popup crowded by
 * warnings, or an environment without layout such as jsdom) the rows render
 * inline and overflow into the parent, which then becomes the single scroll
 * surface instead of scrolling around a second, nested one.
 */
export function AutoFitVirtualList<T>({
  data,
  itemHeight,
  itemKey,
  children,
  listRef,
  minVirtualHeight,
  style
}: AutoFitVirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerListRef = useRef<ListRef>(null);
  const [height, setHeight] = useState(0);
  const virtual = height > 0 && height >= (minVirtualHeight ?? itemHeight);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    // With `flex: 1 1 auto` and `minHeight: 0` the wrapper's own height is
    // exactly the space the parent has left for it, in both modes: inline rows
    // overflow it visibly without growing it, and the virtualized holder is
    // sized from this same measurement.
    const update = () => setHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(
    listRef,
    () => ({
      get nativeElement() {
        return innerListRef.current?.nativeElement as HTMLDivElement;
      },
      getScrollInfo: () => innerListRef.current?.getScrollInfo() ?? { x: 0, y: 0 },
      scrollTo: ((target) => {
        if (virtual || typeof target === 'number' || !('key' in target || 'index' in target)) {
          innerListRef.current?.scrollTo(target);
          return;
        }
        // Inline rows live in the parent's scroll surface, so scroll that.
        const getKey = typeof itemKey === 'function' ? itemKey : () => itemKey;
        const index = 'key' in target ? data.findIndex((item) => getKey(item) === target.key) : target.index;
        const row = containerRef.current?.querySelector(ROW_CONTAINER_SELECTOR)?.children[index];
        (row as HTMLElement | undefined)?.scrollIntoView?.({ block: target.align === 'bottom' ? 'end' : 'start' });
      }) as ListRef['scrollTo']
    }),
    [virtual, data, itemKey]
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: '1 1 auto',
        alignSelf: 'stretch',
        minHeight: 0,
        overflow: virtual ? 'hidden' : 'visible',
        ...style
      }}
    >
      <VirtualList
        data={data}
        height={virtual ? height : undefined}
        itemHeight={itemHeight}
        itemKey={itemKey}
        ref={innerListRef}
        virtual={virtual}
      >
        {children}
      </VirtualList>
    </div>
  );
}
