import { describe, expect, it } from 'vitest';
import { clampSidebarWidth } from '../src/SidebarResizer.tsx';

describe('clampSidebarWidth', () => {
  it('下限より狭い幅を指定した場合、下限の幅にする', () => {
    expect(clampSidebarWidth(100, 1600)).toBe(240);
  });

  it('ウィンドウ幅の 7 割を超える幅を指定した場合、7 割に収める', () => {
    expect(clampSidebarWidth(1500, 1000)).toBe(700);
  });

  it('ウィンドウが狭く上限が下限を下回る場合でも、下限の幅は確保する', () => {
    expect(clampSidebarWidth(500, 300)).toBe(240);
  });

  it('範囲内の幅はそのまま（整数に丸めて）返す', () => {
    expect(clampSidebarWidth(420.4, 1600)).toBe(420);
  });
});
