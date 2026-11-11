import React from 'react';

/**
 * Renders tooltip copy written as an intro line followed by "• " bullet
 * lines, spacing the intro from the list and the bullets from each other.
 */
export function BulletedTip({ text }: { text: string }) {
  const [intro, ...lines] = text.split('\n');
  const bullets = lines.filter((line) => line.trim()).map((line) => line.replace(/^\s*•\s*/, ''));
  return (
    <div>
      <div>{intro}</div>
      {bullets.length > 0 ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
