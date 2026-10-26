import qrcode from 'qrcode-generator';
import { useMemo } from 'preact/hooks';

/** QR code as an inline SVG (no data: URLs or inline styles, CSP friendly). */
export function Qr({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    // One rectangle per horizontal run of dark modules (no hairline seams when scaled).
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; ) {
        if (!qr.isDark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && qr.isDark(r, c)) c++;
        d += `M${start + 4},${r + 4}h${c - start}v1h-${c - start}z`;
      }
    }
    return { size: n + 8, path: d };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the poll link" shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
