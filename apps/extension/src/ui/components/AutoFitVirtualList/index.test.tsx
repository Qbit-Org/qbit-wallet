import type { ListRef } from 'rc-virtual-list';
import { createRef, Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render, screen } from '@testing-library/react';

import { AutoFitVirtualList } from './index';

const ITEM_HEIGHT = 96;
const rows = Array.from({ length: 30 }, (_, index) => ({ id: `row_${index}` }));

// jsdom has no layout, so the wrapper's measured height is driven by hand.
let measuredHeight = 0;

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) {
    ResizeObserverStub.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

function resize(target: Element, height: number) {
  measuredHeight = height;
  act(() => {
    for (const observer of ResizeObserverStub.instances) {
      if (observer.targets.has(target)) {
        observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver);
      }
    }
  });
}

function renderList(props: { listRef?: Ref<ListRef>; minVirtualHeight?: number } = {}) {
  const view = render(
    <AutoFitVirtualList data={rows} itemHeight={ITEM_HEIGHT} itemKey={(item) => item.id} {...props}>
      {(item) => <div data-testid="row">{item.id}</div>}
    </AutoFitVirtualList>
  );
  const wrapper = view.container.firstElementChild as HTMLElement;
  const holder = () => view.container.querySelector<HTMLElement>('.rc-virtual-list-holder');
  return { ...view, wrapper, holder };
}

describe('AutoFitVirtualList', () => {
  beforeEach(() => {
    measuredHeight = 0;
    ResizeObserverStub.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => measuredHeight
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  it('renders every row inline when the container has no measurable height', () => {
    const { wrapper, holder } = renderList();

    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);
    expect(wrapper.style.overflow).toBe('visible');
    expect(holder()?.style.height).toBe('');
  });

  it('virtualizes to the measured height when the parent gives it room', () => {
    measuredHeight = 300;
    const { wrapper, holder } = renderList();

    const rendered = screen.getAllByTestId('row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(rows.length);
    expect(wrapper.style.overflow).toBe('hidden');
    expect(holder()?.style.height).toBe('300px');
  });

  it('renders rows inline when the space left is under one row', () => {
    measuredHeight = ITEM_HEIGHT - 1;
    const { wrapper } = renderList();

    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);
    expect(wrapper.style.overflow).toBe('visible');
  });

  it('uses minVirtualHeight as the virtualization floor', () => {
    measuredHeight = 150;
    const { wrapper } = renderList({ minVirtualHeight: 200 });

    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);
    expect(wrapper.style.overflow).toBe('visible');
  });

  it('never virtualizes without a measurement, even with a zero floor', () => {
    const { wrapper } = renderList({ minVirtualHeight: 0 });

    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);
    expect(wrapper.style.overflow).toBe('visible');
  });

  it('switches between inline and virtual as the measured space changes', () => {
    const { wrapper, holder } = renderList();
    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);

    resize(wrapper, 300);
    expect(screen.getAllByTestId('row').length).toBeLessThan(rows.length);
    expect(holder()?.style.height).toBe('300px');

    resize(wrapper, 40);
    expect(screen.getAllByTestId('row')).toHaveLength(rows.length);
    expect(wrapper.style.overflow).toBe('visible');
  });

  it('scrolls the target row into view through the parent when rows are inline', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const listRef = createRef<ListRef>();
    renderList({ listRef });

    act(() => listRef.current?.scrollTo({ key: 'row_7', align: 'top' }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect((scrollIntoView.mock.instances[0] as HTMLElement).textContent).toBe('row_7');
  });

  it('delegates scrollTo to the virtual list when virtualized', () => {
    // rc-virtual-list keeps retrying its scroll sync until row heights are
    // collected, which never happens without layout, and then logs a warning.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    measuredHeight = 300;
    const listRef = createRef<ListRef>();
    renderList({ listRef });

    expect(() => act(() => listRef.current?.scrollTo({ key: 'row_7', align: 'top' }))).not.toThrow();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
