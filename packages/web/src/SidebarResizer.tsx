import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const STORAGE_KEY = 'wif-viz:sidebar-width';
export const DEFAULT_SIDEBAR_WIDTH = 360;
const MIN_WIDTH = 240;
/** グラフの表示領域を残すため、ウィンドウ幅に対する上限 */
const MAX_RATIO = 0.7;
const KEYBOARD_STEP = 16;

export function clampSidebarWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, windowWidth * MAX_RATIO)));
}

function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** サイドバーの幅。ブラウザに保存し、次回も同じ幅で開く */
export function useSidebarWidth() {
  const [width, setWidthState] = useState(() => clampSidebarWidth(readStoredWidth(), window.innerWidth));
  const setWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next, window.innerWidth);
    setWidthState(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // 保存できなくても、このページの表示中は幅を変えられる
    }
  }, []);
  useEffect(() => {
    const onResize = () => setWidthState((current) => clampSidebarWidth(current, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return [width, setWidth] as const;
}

interface Props {
  width: number;
  onResize: (width: number) => void;
}

/**
 * サイドバーとグラフの境界。ドラッグ（またはフォーカスして左右キー）で幅を変える。ダブルクリックで既定の幅に戻す。
 * ドラッグ中は画面全体を再描画しないよう、親要素の CSS 変数だけを書き換え、離したときに幅を確定する。
 */
export function SidebarResizer({ width, onResize }: Props) {
  const [dragging, setDragging] = useState(false);
  const dragWidth = useRef(width);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragWidth.current = width;
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    dragWidth.current = clampSidebarWidth(e.clientX, window.innerWidth);
    e.currentTarget.parentElement?.style.setProperty('--sidebar-width', `${dragWidth.current}px`);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    onResize(dragWidth.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onResize(width - KEYBOARD_STEP);
    else if (e.key === 'ArrowRight') onResize(width + KEYBOARD_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`sidebar-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="サイドバーの幅"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(DEFAULT_SIDEBAR_WIDTH)}
      title="ドラッグで幅を変更（ダブルクリックで元に戻す）"
    />
  );
}
