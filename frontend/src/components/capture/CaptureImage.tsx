import { useState } from 'react';
import { useI18n } from '../../i18n/context';
import type { LocalCapture } from '../../platform/capture';
import { captureButtonPosition } from '../../utils/captureGeometry';

export default function CaptureImage({ capture, onChoose, selected = [] }: { capture: LocalCapture; onChoose: (id: string) => void; selected?: string[] }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  if (!capture.imageUrl) return null;
  return <section aria-label={t('captureImage')} className="space-y-2">
    <label className="flex items-center gap-3 text-sm text-gray-300">{t('captureZoom')}<input type="range" min="1" max="3" step=".25" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
    <div className="max-h-[60dvh] overflow-auto rounded-xl border border-gray-700 bg-black">
      <div className="relative" style={{ width: `${zoom * 100}%` }}>
        <img src={capture.imageUrl} alt={t('captureImage')} className="block h-auto w-full" draggable={false} />
        {capture.blocks?.map((block, index) => {
          const position = captureButtonPosition(block.rects);
          return position && <button key={block.id} type="button" aria-label={`${t('captureChooseText')} ${index + 1}: ${block.text}`} aria-pressed={selected.includes(block.id)} onClick={() => onChoose(block.id)} style={position}
            className={`absolute min-h-11 min-w-11 rounded-lg border px-2 text-sm font-semibold shadow-lg ${selected.includes(block.id) ? 'border-white bg-indigo-600 text-white' : 'border-indigo-300 bg-gray-900/95 text-indigo-100'}`}>{index + 1} ↗</button>;
        })}
      </div>
    </div>
  </section>;
}
