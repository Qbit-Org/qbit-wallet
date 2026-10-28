import React, { CSSProperties, ReactNode } from 'react';

import { Card } from '../Card';
import { Column } from '../Column';
import { Row } from '../Row';

// Shared card for single-select option lists (appearance, language, auto-lock
// time). The default Column gap used to surround each divider, giving middle
// rows 8px of extra breathing room on both sides while the first and last
// rows sat flush against the card edges; rendering with zero gap keeps every
// row's own padding symmetric regardless of its position in the list.
export function OptionListCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const items = React.Children.toArray(children);
  return (
    <Card
      style={Object.assign(
        {
          width: '328px',
          borderRadius: 0,
          backgroundColor: 'var(--qbit-paper)',
          padding: 0
        },
        style
      )}
    >
      <div
        style={{
          width: '100%',
          overflow: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none'
        }}
      >
        <Column fullX gap="zero">
          {items.map((child, index) => (
            <React.Fragment key={index}>
              {index > 0 && <Row gap="zero" style={{ height: 1, backgroundColor: 'var(--qbit-line)' }} />}
              {child}
            </React.Fragment>
          ))}
        </Column>
      </div>
    </Card>
  );
}
