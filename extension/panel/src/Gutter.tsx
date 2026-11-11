import { useId } from 'react';

export type Mood = 'idle' | 'thinking' | 'happy' | 'oops';

const INK = '#1f1b16';
const YELLOW = '#ffd23f';
const CORAL = '#ff6b6b';

/**
 * Gutter, the mascot: a little strip of notebook margin (punch holes, red
 * margin line) who lives at the edge of the page. Original character.
 */
export function Gutter({ mood = 'idle', size = 72 }: { mood?: Mood; size?: number }) {
  const clip = useId();
  const stroke = { stroke: INK, strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

  return (
    <svg
      className={`gutter gutter-${mood}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={`Gutter is ${mood === 'oops' ? 'confused' : mood}`}
    >
      <ellipse cx="62" cy="114" rx="32" ry="4.5" fill={INK} opacity="0.14" />
      <g className="g-body">
        {/* bookmark-ribbon tuft */}
        <path d="M74 18 V3 l7 6 l7 -6 V18 Z" fill={CORAL} {...stroke} strokeWidth={3.5} />
        {/* arms */}
        <path className="g-arm-l" d="M21 68 q-9 3 -10 13" fill="none" {...stroke} />
        <path className="g-arm-r" d={mood === 'happy' ? 'M103 64 q10 -3 11 -15' : 'M103 68 q9 3 10 13'} fill="none" {...stroke} />
        {/* feet */}
        <rect x="40" y="99" width="17" height="13" rx="6.5" fill={YELLOW} {...stroke} />
        <rect x="67" y="99" width="17" height="13" rx="6.5" fill={YELLOW} {...stroke} />
        {/* body: a strip of notebook margin */}
        <clipPath id={clip}>
          <rect x="20" y="14" width="84" height="92" rx="24" />
        </clipPath>
        <rect x="20" y="14" width="84" height="92" rx="24" fill={YELLOW} />
        <g clipPath={`url(#${clip})`}>
          <rect x="20" y="14" width="24" height="92" fill="#fff1b3" />
          <line x1="44" y1="14" x2="44" y2="106" stroke={CORAL} strokeWidth="3" />
        </g>
        <rect x="20" y="14" width="84" height="92" rx="24" fill="none" {...stroke} />
        <circle cx="32" cy="38" r="4.5" fill={INK} />
        <circle cx="32" cy="60" r="4.5" fill={INK} />
        <circle cx="32" cy="82" r="4.5" fill={INK} />

        {/* cheeks */}
        <ellipse cx="55" cy="71" rx="5" ry="3.5" fill={CORAL} opacity="0.55" />
        <ellipse cx="93" cy="71" rx="5" ry="3.5" fill={CORAL} opacity="0.55" />

        {/* eyes */}
        {mood === 'happy' ? (
          <g fill="none" {...stroke}>
            <path d="M55 57 Q63 46 71 57" />
            <path d="M77 57 Q85 46 93 57" />
          </g>
        ) : (
          <g className="g-eyes">
            <circle cx="63" cy="54" r="9" fill="#fff" stroke={INK} strokeWidth="3.5" />
            <circle cx="85" cy="54" r="9" fill="#fff" stroke={INK} strokeWidth="3.5" />
            <g className="g-pupils">
              <circle cx={mood === 'thinking' ? 66 : 64} cy={mood === 'thinking' ? 50 : 55} r={mood === 'oops' ? 2.6 : 4} fill={INK} />
              <circle cx={mood === 'thinking' ? 88 : 86} cy={mood === 'thinking' ? 50 : 55} r={mood === 'oops' ? 2.6 : 4} fill={INK} />
            </g>
          </g>
        )}

        {mood === 'oops' && (
          <g fill="none" {...stroke} strokeWidth={3.5}>
            <path d="M54 45 L68 41" />
            <path d="M94 45 L80 41" />
          </g>
        )}

        {/* mouth */}
        {mood === 'idle' && <path d="M67 71 Q74 79 81 71" fill="none" {...stroke} strokeWidth={3.5} />}
        {mood === 'happy' && <path d="M65 68 Q74 85 83 68 Z" fill={INK} {...stroke} strokeWidth={3} />}
        {mood === 'thinking' && <circle cx="74" cy="75" r="3.6" fill={INK} />}
        {mood === 'oops' && <path d="M66 76 q4 -6 8 0 t8 0" fill="none" {...stroke} strokeWidth={3.5} />}
      </g>
    </svg>
  );
}
