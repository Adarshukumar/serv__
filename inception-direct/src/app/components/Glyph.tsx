/** The astronomical sign for Mercury (☿), drawn so it looks the same everywhere. */
export function MercuryGlyph({ size = 24, accent = 'currentColor', stroke = 1.6 }: { size?: number; accent?: string; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8.6 2.6a3.4 3.4 0 0 0 6.8 0" stroke={accent} strokeWidth={stroke} />
      <circle cx="12" cy="10.3" r="4" stroke="currentColor" strokeWidth={stroke} />
      <path d="M12 14.3v7.2M8.8 18h6.4" stroke="currentColor" strokeWidth={stroke} />
    </svg>
  );
}
