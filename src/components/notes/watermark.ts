export interface WatermarkIdentity {
  email: string;
  sessionRef: string;
  dateLabel: string;
}

/**
 * Paints the licensee's identity across a rendered page.
 *
 * The watermark is drawn *into the page canvas itself*, not layered over it in
 * the DOM, so it cannot be removed with developer tools and it is present in any
 * screenshot or screen recording of the page. It is tiled diagonally and repeated
 * so cropping one instance out still leaves several behind.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  identity: WatermarkIdentity,
  scale = 1,
): void {
  const lines = [
    `Licensed to ${identity.email}`,
    `Session ${identity.sessionRef} · ${identity.dateLabel}`,
  ];

  const fontSize = Math.max(11, Math.round(13 * scale));
  const stepX = Math.max(260, Math.round(340 * scale));
  const stepY = Math.max(150, Math.round(190 * scale));

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Diagonal tiling across a rotated plane that comfortably covers the page.
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-28 * Math.PI) / 180);

  const reach = Math.hypot(width, height);

  for (let y = -reach; y < reach; y += stepY) {
    for (let x = -reach; x < reach; x += stepX) {
      const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
      ctx.fillStyle = 'rgba(88, 88, 110, 0.11)';
      lines.forEach((line, index) => {
        ctx.fillText(line, x + offset, y + index * (fontSize + 3));
      });
    }
  }

  ctx.restore();
}

/** The small, always-visible footer line under the page. */
export function watermarkCaption(identity: WatermarkIdentity): string {
  return `Licensed to ${identity.email} · Session ${identity.sessionRef} · ${identity.dateLabel}`;
}
