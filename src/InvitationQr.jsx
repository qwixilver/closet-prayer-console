// SPDX-License-Identifier: GPL-3.0-only
import React, { useState } from 'react';
import encodeQR from 'qr';

export function InvitationQr({ value }) {
  const [open, setOpen] = useState(false);
  let matrix = [], path = '';
  if (open) {
    matrix = encodeQR(value, 'raw', { ecc: 'medium', encoding: 'byte', border: 4 });
    matrix.forEach((row, y) => row.forEach((black, x) => { if (black) path += `M${x} ${y}h1v1h-1z`; }));
  }
  return <div><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide invitation QR' : 'Show invitation QR'}</button>
    {open && <svg className="invitation-qr" viewBox={`0 0 ${matrix.length} ${matrix.length}`} role="img" aria-label="Private member invitation QR" shapeRendering="crispEdges">
      <rect width={matrix.length} height={matrix.length} fill="white" /><path d={path} fill="black" />
    </svg>}</div>;
}
