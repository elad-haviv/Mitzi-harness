// Mitzi in voice conversations: an animated cat drawn with gradients. Its ears, eyes, mouth and tail show what's
// happening: perked up while listening, wide-eyed while you talk, looking around while it thinks, talking (with the
// sound, when it's measured) while it answers, and asleep when paused.
export type CatState = 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'paused' | 'error';

export function VoiceCat({ state, level = 0, voice }: { state: CatState; /** Your voice, 0–1. */ level?: number; /** Mitzi's voice, 0–1, when measured. */ voice?: number }) {
  const asleep = state === 'paused';
  // The mouth opens with Mitzi's voice; without a measure, CSS animates it while speaking.
  const mouth = state === 'speaking' ? (voice !== undefined ? Math.min(1, voice * 1.6) : 0.7) : 0;
  const pupil = state === 'hearing' || state === 'listening' ? 0.75 + Math.min(1, level * 1.4) * 0.25 : state === 'thinking' ? 0.55 : 0.7;
  const glow = 1 + (state === 'hearing' || state === 'listening' ? level * 0.25 : state === 'speaking' ? (voice ?? 0.4) * 0.2 : 0);

  return (
    <div className={`voice-cat ${state}${voice === undefined ? ' unmeasured' : ''}`} aria-hidden>
      <svg viewBox="0 0 240 240" width="220" height="220">
        <defs>
          <radialGradient id="vc-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
            <stop offset="70%" stopColor="var(--accent)" stopOpacity="0.08" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="vc-fur" cx="45%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#ffd29a" />
            <stop offset="45%" stopColor="#f6a04d" />
            <stop offset="100%" stopColor="#d4672a" />
          </radialGradient>
          <linearGradient id="vc-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f39a49" />
            <stop offset="100%" stopColor="#c85a22" />
          </linearGradient>
          <radialGradient id="vc-chest" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fff6ea" />
            <stop offset="100%" stopColor="#ffe0bd" />
          </radialGradient>
          <linearGradient id="vc-ear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff9fb2" />
            <stop offset="100%" stopColor="#ffd4dc" />
          </linearGradient>
          <radialGradient id="vc-iris" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#c8f59a" />
            <stop offset="55%" stopColor="#5fc46b" />
            <stop offset="100%" stopColor="#2a8a52" />
          </radialGradient>
          <linearGradient id="vc-nose" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff9aac" />
            <stop offset="100%" stopColor="#e25d78" />
          </linearGradient>
          <radialGradient id="vc-blush" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ff7f9a" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ff7f9a" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle className="vc-glow" cx="120" cy="128" r="112" fill="url(#vc-glow)" style={{ transform: `scale(${glow})` }} />

        {/* The tail, behind the body. */}
        <g className="vc-tail">
          <path d="M168 196 C 214 190, 222 146, 200 122 C 192 113, 180 118, 186 128 C 200 150, 190 176, 160 180 Z" fill="url(#vc-body)" />
          <path d="M200 122 C 192 113, 180 118, 186 128 C 189 133, 193 131, 196 127 Z" fill="#fff1df" opacity="0.9" />
        </g>

        {/* Body and chest. */}
        <path d="M62 226 C 58 178, 80 150, 120 150 C 160 150, 182 178, 178 226 Z" fill="url(#vc-body)" />
        <path d="M94 226 C 92 192, 104 170, 120 170 C 136 170, 148 192, 146 226 Z" fill="url(#vc-chest)" />
        <ellipse cx="96" cy="224" rx="18" ry="9" fill="#ffe9d2" />
        <ellipse cx="144" cy="224" rx="18" ry="9" fill="#ffe9d2" />

        <g className="vc-head">
          {/* Ears. */}
          <g className="vc-ear left">
            <path d="M64 92 L 58 30 L 104 64 Z" fill="url(#vc-fur)" />
            <path d="M68 82 L 65 44 L 94 66 Z" fill="url(#vc-ear)" />
          </g>
          <g className="vc-ear right">
            <path d="M176 92 L 182 30 L 136 64 Z" fill="url(#vc-fur)" />
            <path d="M172 82 L 175 44 L 146 66 Z" fill="url(#vc-ear)" />
          </g>

          {/* Head, with stripes. */}
          <path d="M120 56 C 168 56, 196 82, 196 118 C 196 156, 164 178, 120 178 C 76 178, 44 156, 44 118 C 44 82, 72 56, 120 56 Z" fill="url(#vc-fur)" />
          <path d="M120 60 L 116 76 M 106 62 L 104 74 M 134 62 L 136 74" stroke="#c45c22" strokeWidth="4" strokeLinecap="round" opacity="0.55" />
          <path d="M48 118 C 56 116, 62 118, 66 122 M 192 118 C 184 116, 178 118, 174 122" stroke="#c45c22" strokeWidth="3.5" strokeLinecap="round" fill="none" opacity="0.45" />
          <ellipse cx="120" cy="148" rx="34" ry="24" fill="url(#vc-chest)" />

          <ellipse cx="74" cy="138" rx="16" ry="11" fill="url(#vc-blush)" />
          <ellipse cx="166" cy="138" rx="16" ry="11" fill="url(#vc-blush)" />

          {/* Eyes: open, or closed while asleep. */}
          {asleep ? (
            <g stroke="#5a2d12" strokeWidth="4" strokeLinecap="round" fill="none">
              <path d="M78 114 Q 90 122, 102 114" />
              <path d="M138 114 Q 150 122, 162 114" />
            </g>
          ) : (
            <g className="vc-eyes">
              {[90, 150].map((cx) => (
                <g key={cx} className="vc-eye" style={{ transformOrigin: `${cx}px 112px` }}>
                  <ellipse cx={cx} cy="112" rx="15" ry={state === 'error' ? 11 : 16} fill="#fffaf2" />
                  <ellipse cx={cx} cy="112" rx="12" ry={state === 'error' ? 9 : 13} fill="url(#vc-iris)" />
                  <g className="vc-pupil">
                    <ellipse cx={cx} cy="112" rx={5.5 * pupil} ry={11 * pupil} fill="#1d1410" />
                    <circle cx={cx - 4} cy="106" r="3.2" fill="#fff" />
                    <circle cx={cx + 3} cy="117" r="1.6" fill="#fff" opacity="0.8" />
                  </g>
                </g>
              ))}
            </g>
          )}

          {/* Nose, mouth and whiskers. */}
          <path d="M112 134 Q 120 128, 128 134 Q 124 141, 120 142 Q 116 141, 112 134 Z" fill="url(#vc-nose)" />
          <g className="vc-mouth">
            <ellipse className="vc-mouth-open" cx="120" cy="153" rx={7 + mouth * 3} ry={0.5 + mouth * 9} fill="#7a2335" />
            <path d="M120 142 L 120 148 M 120 148 Q 113 155, 106 150 M 120 148 Q 127 155, 134 150" stroke="#5a2d12" strokeWidth="3" strokeLinecap="round" fill="none" />
          </g>
          <g className="vc-whiskers left" stroke="#7a4a2a" strokeWidth="2" strokeLinecap="round" opacity="0.7">
            <path d="M92 142 L 50 134" />
            <path d="M92 148 L 48 150" />
            <path d="M94 154 L 56 166" />
          </g>
          <g className="vc-whiskers right" stroke="#7a4a2a" strokeWidth="2" strokeLinecap="round" opacity="0.7">
            <path d="M148 142 L 190 134" />
            <path d="M148 148 L 192 150" />
            <path d="M146 154 L 184 166" />
          </g>
        </g>

        {state === 'paused' && (
          <g className="vc-zzz" fill="var(--text-2)" fontWeight="700" fontFamily="inherit">
            <text x="182" y="62" fontSize="20">z</text>
            <text x="198" y="42" fontSize="15">z</text>
            <text x="210" y="26" fontSize="11">z</text>
          </g>
        )}
      </svg>
    </div>
  );
}
