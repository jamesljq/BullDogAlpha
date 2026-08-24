import React, { useState } from 'react';

export interface MetricHelpInfo {
  title: string;
  definition_en: string;
  definition_zh: string;
  benchmarks: { label: string; range: string; color: string }[];
  direction: 'higher' | 'lower';
  directionText: string;
}

export const METRIC_DICTIONARY: Record<string, MetricHelpInfo> = {
  sharpe: {
    title: 'Sharpe Ratio (夏普比率)',
    definition_en: 'Measures excess return earned per unit of total annualized volatility relative to the risk-free rate (~4.5%).',
    definition_zh: '衡量每承受一单位总风险所获得的超额年化收益。无风险利率基准通常为 4.5%。',
    benchmarks: [
      { label: 'Suboptimal (偏低)', range: '< 1.0', color: '#ff453a' },
      { label: 'Good (良好)', range: '1.0 ~ 2.0', color: '#ffd60a' },
      { label: 'Exceptional (卓越/机构级)', range: '> 2.0', color: '#30d158' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  sortino: {
    title: 'Sortino Ratio (索提诺比率)',
    definition_en: 'Measures excess return penalized only by downside standard deviation (negative volatility), ignoring upside gains.',
    definition_zh: '仅考量资产发生下行波动（亏损波动）时的超额收益率，不惩罚向上爆发式波动。',
    benchmarks: [
      { label: 'Moderate (中等)', range: '< 1.5', color: '#ffd60a' },
      { label: 'Strong (强劲)', range: '1.5 ~ 3.0', color: '#30d158' },
      { label: 'Elite (顶级策略)', range: '> 3.0', color: '#00e5ff' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  calmar: {
    title: 'Calmar Ratio (卡玛比率)',
    definition_en: 'Ratio of Compound Annual Growth Rate (CAGR) to historical Maximum Drawdown. Quantifies return per unit of tail risk.',
    definition_zh: '年化复合增长率 (CAGR) 与历史最大回撤 (Max Drawdown) 的比值，直观体现“收益/回撤比”。',
    benchmarks: [
      { label: 'Cautious (偏弱)', range: '< 1.0', color: '#ff453a' },
      { label: 'Solid (稳健)', range: '1.0 ~ 2.5', color: '#ffd60a' },
      { label: 'Outstanding (极其优异)', range: '> 2.5', color: '#30d158' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  cagr: {
    title: 'CAGR (年化复合收益率)',
    definition_en: 'Geometric annualized compounding growth rate of portfolio capital over the backtest duration.',
    definition_zh: '多年度按复利计算的几何平均年化收益率，平滑了单年收益波动。',
    benchmarks: [
      { label: 'Market Average (市场基准 S&P)', range: '8% ~ 12%', color: '#64d2ff' },
      { label: 'Alpha Outperform (显著跑赢)', range: '15% ~ 25%', color: '#30d158' },
      { label: 'Aggressive Alpha (高成长)', range: '> 25%', color: '#00e5ff' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  maxDrawdown: {
    title: 'Max Drawdown (最大历史回撤)',
    definition_en: 'The largest percentage drop in equity peak-to-trough before a new all-time high is established.',
    definition_zh: '在选定历史周期内，账户净值从历史最高峰值到最低谷底的最大跌幅百分比。',
    benchmarks: [
      { label: 'Low Risk (极低风险)', range: '< 10%', color: '#30d158' },
      { label: 'Moderate Risk (可控中等)', range: '10% ~ 25%', color: '#ffd60a' },
      { label: 'Severe Risk (高风险/危险)', range: '> 25%', color: '#ff453a' },
    ],
    direction: 'lower',
    directionText: 'Lower is Better (越低越好)',
  },
  winRate: {
    title: 'Win Rate (交易胜率)',
    definition_en: 'Percentage of closed trades that resulted in positive realized net profit.',
    definition_zh: '盈利交易笔数占所有已平仓交易总笔数的比例。高胜率需结合盈亏比综合判断。',
    benchmarks: [
      { label: 'Trend Seeking (趋势跟踪型)', range: '40% ~ 50%', color: '#ffd60a' },
      { label: 'Balanced (均衡策略)', range: '50% ~ 65%', color: '#30d158' },
      { label: 'High Precision (高胜率均值回归)', range: '> 65%', color: '#00e5ff' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  profitFactor: {
    title: 'Profit Factor (总盈亏比)',
    definition_en: 'Ratio of total gross trading profits divided by total gross trading losses. Values above 1.0 indicate net profitability.',
    definition_zh: '所有盈利交易毛利总和与所有亏损交易毛亏总和的比值。> 1.0 表示整体盈利。',
    benchmarks: [
      { label: 'Unprofitable (亏损边缘)', range: '< 1.0', color: '#ff453a' },
      { label: 'Profitable (可盈利策略)', range: '1.2 ~ 1.8', color: '#ffd60a' },
      { label: 'Robust (高鲁棒性优质策略)', range: '> 2.0', color: '#30d158' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  beta: {
    title: 'Beta (市场贝塔系数)',
    definition_en: 'Sensitivity of strategy returns relative to systematic market benchmark (SPY). Beta = 1.0 moves in parity with the market.',
    definition_zh: '相对于标普500基准 (SPY) 的系统性波动敏感度。Beta = 1 表示与大盘同步波动。',
    benchmarks: [
      { label: 'Market Neutral (市场中性)', range: '< 0.5', color: '#00e5ff' },
      { label: 'Market Aligned (与大盘相似)', range: '0.8 ~ 1.2', color: '#64d2ff' },
      { label: 'High Volatility (高放大波动)', range: '> 1.3', color: '#ffd60a' },
    ],
    direction: 'lower',
    directionText: 'Lower = More Defensive (越低越防御)',
  },
  alpha: {
    title: "Jensen's Alpha (詹森阿尔法超额)",
    definition_en: 'Pure active annual excess return above the expected CAPM risk-adjusted benchmark baseline.',
    definition_zh: '超越标普500/纳指基准预期的纯粹主动超额年化收益率。正阿尔法代表策略具备真实超越大盘的选时选股能力。',
    benchmarks: [
      { label: 'Negative (跑输大盘)', range: '< 0%', color: '#ff453a' },
      { label: 'Solid Alpha (稳健超额)', range: '0% ~ 4%', color: '#ffd60a' },
      { label: 'Super Alpha (顶尖超额)', range: '> 4%', color: '#30d158' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  infoRatio: {
    title: 'Information Ratio (信息比率 IR)',
    definition_en: 'Ratio of active excess return divided by the Tracking Error. Quantifies consistency and stability in beating the benchmark.',
    definition_zh: '主动超额收益与跟踪误差 (Tracking Error) 的比值，衡量战胜基准的稳定性和一致性。',
    benchmarks: [
      { label: 'Weak (不稳定)', range: '< 0.5', color: '#ffd60a' },
      { label: 'Good (优良)', range: '0.5 ~ 1.0', color: '#30d158' },
      { label: 'Exceptional (卓越机构级)', range: '> 1.0', color: '#00e5ff' },
    ],
    direction: 'higher',
    directionText: 'Higher is Better (越高越好)',
  },
  trackingError: {
    title: 'Tracking Error (跟踪误差)',
    definition_en: 'Annualized standard deviation of excess return differences between the portfolio and its market benchmark.',
    definition_zh: '策略超额收益序列的标准差，衡量与基准大盘的分离波动度。',
    benchmarks: [
      { label: 'Close to Index (贴近大盘)', range: '< 3%', color: '#64d2ff' },
      { label: 'Active (主动策略)', range: '3% ~ 8%', color: '#ffd60a' },
      { label: 'High Divergence (高离散)', range: '> 8%', color: '#bf5af2' },
    ],
    direction: 'lower',
    directionText: 'Lower = Closer to Index (越低越贴近基准)',
  },
  benchmarkCagr: {
    title: 'Benchmark Baseline (大盘基准年化)',
    definition_en: 'Compound annual growth rate of the S&P 500 (SPY) or Nasdaq-100 (QQQ) benchmark index over the identical evaluation horizon.',
    definition_zh: '标普500 (SPY) / 纳斯达克 (QQQ) 在同期的复合年化收益率。跑输大盘的量化策略不具备配置意义。',
    benchmarks: [
      { label: 'S&P 500 Baseline', range: '~ 10% / yr', color: '#64d2ff' },
      { label: 'Nasdaq-100 Baseline', range: '~ 15% / yr', color: '#00e5ff' },
    ],
    direction: 'higher',
    directionText: 'Baseline (基线对照)',
  },
};

interface MetricTooltipProps {
  metricKey: keyof typeof METRIC_DICTIONARY;
  size?: number;
}

export const MetricTooltip: React.FC<MetricTooltipProps> = ({ metricKey, size = 16 }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [popoverPlacement, setPopoverPlacement] = useState<{
    vertical: 'top' | 'bottom';
    horizontal: 'center' | 'left' | 'right';
  }>({ vertical: 'bottom', horizontal: 'center' });
  const containerRef = React.useRef<HTMLDivElement>(null);
  const info = METRIC_DICTIONARY[metricKey];

  const isOpen = isPinned || isHovered;

  // Dynamic collision-aware positioning to keep tooltip 100% inside viewport
  React.useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const POPOVER_HEIGHT = 290;
    const POPOVER_WIDTH = 330;

    // If space above is less than popover height + 20px, render below icon
    const showBelow = rect.top < POPOVER_HEIGHT + 20;

    let horiz: 'center' | 'left' | 'right' = 'center';
    if (rect.left + POPOVER_WIDTH / 2 > (window.innerWidth || 1200) - 20) {
      horiz = 'right';
    } else if (rect.left - POPOVER_WIDTH / 2 < 20) {
      horiz = 'left';
    }

    setPopoverPlacement({
      vertical: showBelow ? 'bottom' : 'top',
      horizontal: horiz,
    });
  }, [isOpen]);

  // Outside click listener to dismiss pinned tooltip
  React.useEffect(() => {
    if (!isPinned) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsPinned(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [isPinned]);

  if (!info) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPinned((prev) => !prev);
  };

  const getPlacementStyles = (): React.CSSProperties => {
    const styles: React.CSSProperties = {};

    if (popoverPlacement.vertical === 'bottom') {
      styles.top = 'calc(100% + 10px)';
      styles.bottom = 'auto';
    } else {
      styles.bottom = 'calc(100% + 10px)';
      styles.top = 'auto';
    }

    if (popoverPlacement.horizontal === 'right') {
      styles.right = '0';
      styles.left = 'auto';
      styles.transform = 'none';
    } else if (popoverPlacement.horizontal === 'left') {
      styles.left = '0';
      styles.right = 'auto';
      styles.transform = 'none';
    } else {
      styles.left = '50%';
      styles.right = 'auto';
      styles.transform = 'translateX(-50%)';
    }

    return styles;
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '6px', cursor: 'pointer' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      data-testid={`metric-tooltip-${metricKey}`}
      title={isPinned ? 'Click outside to dismiss / 点击页面空白处关闭' : 'Click to pin / Hover to preview (点击固定卡片 / 悬停预览)'}
    >
      <span
        style={{
          display: 'inline-flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '50%',
          backgroundColor: isPinned ? '#0a84ff' : isHovered ? 'rgba(10, 132, 255, 0.8)' : 'rgba(255, 255, 255, 0.18)',
          color: isPinned || isHovered ? '#ffffff' : '#a1a1aa',
          fontSize: '11px',
          fontWeight: 800,
          boxShadow: isPinned ? '0 0 10px rgba(10, 132, 255, 0.7)' : 'none',
          border: isPinned ? '1px solid #64d2ff' : '1px solid rgba(255, 255, 255, 0.1)',
          transition: 'all 0.15s ease',
          userSelect: 'none',
        }}
      >
        ?
      </span>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            ...getPlacementStyles(),
            backgroundColor: '#181a24',
            border: isPinned ? '1px solid #0a84ff' : '1px solid rgba(255, 255, 255, 0.22)',
            borderRadius: '10px',
            padding: '14px 16px',
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.85)',
            zIndex: 9999,
            width: '330px',
            maxWidth: 'calc(100vw - 32px)',
            backdropFilter: 'blur(20px)',
            pointerEvents: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
          data-testid={`tooltip-popover-${metricKey}`}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.2px' }}>
              {info.title}
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: info.direction === 'higher' ? '#30d158' : '#64d2ff',
                backgroundColor: 'rgba(255, 255, 255, 0.09)',
                padding: '3px 8px',
                borderRadius: '5px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              {info.directionText}
            </span>
          </div>

          {/* Bilingual Definition: English first, then Chinese */}
          <p style={{ fontSize: '12.5px', color: '#ffffff', margin: '0 0 6px 0', lineHeight: 1.45, fontWeight: 500 }}>
            {info.definition_en}
          </p>
          <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 10px 0', lineHeight: 1.45 }}>
            {info.definition_zh}
          </p>

          {/* Benchmarks List */}
          <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', paddingTop: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: '#9ca3af', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Reference Benchmarks (参考基准):
            </div>
            {info.benchmarks.map((b, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '12px',
                  marginBottom: '4px',
                  padding: '2px 0',
                }}
              >
                <span style={{ color: b.color, fontWeight: 700 }}>• {b.label}</span>
                <span style={{ color: '#f3f4f6', fontFamily: 'monospace', fontWeight: 600, fontSize: '12px' }}>
                  {b.range}
                </span>
              </div>
            ))}
          </div>

          {/* Footer Pin Hint */}
          <div style={{ marginTop: '10px', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10.5px', color: isPinned ? '#64d2ff' : '#71717a' }}>
              {isPinned ? '📌 Pinned (Click outside to dismiss) / 已固定卡片' : '💡 Click to pin / 点击固定'}
            </span>
            {isPinned && (
              <button
                type="button"
                onClick={() => setIsPinned(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 6px',
                }}
              >
                Close ✕
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
