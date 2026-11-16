export type Mood = 'idle' | 'thinking' | 'happy' | 'oops';

const FACE = '#0c1a4b';

/**
 * Gutter, the mascot: a small round fellow with a curl on his head who peeks
 * over the edge of the question box. Original character; the one playful
 * thing in an otherwise quiet panel.
 */
export function Gutter({ mood = 'idle', size = 48, className = '' }: { mood?: Mood; size?: number; className?: string }) {
  const line = { fill: 'none', stroke: FACE, strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  const look = mood === 'thinking' ? { dx: 1.5, dy: -3.5 } : { dx: 0, dy: 0 };

  return (
    <svg
      className={`gutter gutter-${mood} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`Gutter, ${mood === 'oops' ? 'puzzled' : mood}`}
    >
      <g className="g-body">
        {/* curl */}
        <path d="M31 12c-2-6 1-9.5 6-9" fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
        {/* body */}
        <path d="M10 37C10 21.5 19.5 10 32 10s22 11.5 22 27v7c0 7-5 12-12 12H22c-7 0-12-5-12-12z" fill="var(--accent)" />

        {mood === 'happy' ? (
          <g fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round">
            <path d="M18 34q6-8 12 0" />
            <path d="M34 34q6-8 12 0" />
          </g>
        ) : (
          <g className="g-eyes">
            <ellipse cx="24" cy="32" rx="6.5" ry="7.5" fill="#fff" />
            <ellipse cx="40" cy="32" rx="6.5" ry={mood === 'oops' ? 5.5 : 7.5} fill="#fff" />
            <circle cx={25 + look.dx} cy={33 + look.dy} r="3.2" fill={FACE} />
            <circle cx={41 + look.dx} cy={33 + look.dy} r={mood === 'oops' ? 2.2 : 3.2} fill={FACE} />
          </g>
        )}

        {mood === 'idle' && <path d="M28 45q4 3.5 8 0" {...line} />}
        {mood === 'happy' && <path d="M26 43q6 8 12 0z" fill={FACE} />}
        {mood === 'thinking' && <ellipse cx="33" cy="46" rx="2.6" ry="2.2" fill={FACE} />}
        {mood === 'oops' && <path d="M27 47q2.5-3 5 0t5 0" {...line} />}
      </g>
    </svg>
  );
}
