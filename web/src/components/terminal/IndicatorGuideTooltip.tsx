import React, { useState, useRef, useEffect } from 'react';

export type IndicatorKey = 'volume' | 'ema' | 'sma' | 'macd';

export interface IndicatorMeta {
  key: IndicatorKey;
  title: string;
  subtitle: string;
  philosophy_en: string;
  philosophy_zh: string;
  mechanics_en: string;
  mechanics_zh: string;
  desired_range_en: string;
  desired_range_zh: string;
  interpretation_en: string;
  interpretation_zh: string;
}

export const INDICATOR_METAS: Record<IndicatorKey, IndicatorMeta> = {
  volume: {
    key: 'volume',
    title: 'Trading Volume (成交量)',
    subtitle: 'Institutional Market Liquidity & Order Flow Velocity',
    philosophy_en: 'Volume represents the total number of shares transacted over a given interval. In quantitative microstructure, price movement without volume is statistically prone to false breakouts, whereas high volume confirms institutional conviction.',
    philosophy_zh: '成交量代表在选定时间周期内撮合成交的总股数。在量化微观结构中，无量上涨或下跌容易发生假突破，而放量突破则确认了机构主力资金的真实建仓与买卖意图。',
    mechanics_en: 'Volume is aggregated directly from exchange trade execution ticks (Alpaca / Polygon feeds). Bullish bars (Close >= Open) are shaded in green, while Bearish bars (Close < Open) are shaded in red.',
    mechanics_zh: '成交量直接通过交易所逐笔成交流（Alpaca / Polygon）聚合计算。阳线（收盘价 ≥ 开盘价）标记为绿色柱，阴线（收盘价 < 开盘价）标记为红色柱。',
    desired_range_en: 'Breakout Volume Ratio: > 2.0x of the 20-period Volume Moving Average (VMA). Pullback Volume: < 0.6x of 20VMA indicates healthy low-selling absorption.',
    desired_range_zh: '有效突破放量区间：成交量 > 20周期均量的2.0倍以上；缩量回调区间：成交量 < 20周期均量的0.6倍，表明抛压衰竭、属于良性洗盘。',
    interpretation_en: 'High Volume + Price Breakout = High Probability Trend Continuation. Low Volume + Price Push = Divergence Warning / Fake Breakout.',
    interpretation_zh: '放量大阳突破 = 高概率趋势延续；缩量拉升 = 量价背离预警，容易见顶回落。',
  },
  ema: {
    key: 'ema',
    title: 'Exponential Moving Average (EMA 9, 21)',
    subtitle: 'High-Responsiveness Momentum & Dynamic Trend Channels',
    philosophy_en: 'EMA applies exponentially decreasing weights to historical prices, giving the highest priority to recent market actions. This significantly reduces lag compared to simple moving averages (SMA) and reacts faster to rapid trend inflections.',
    philosophy_zh: '指数移动平均线（EMA）为越近期的价格赋予越高的指数级权重，相比传统简单均线（SMA）大幅降低了时间滞后性，能更快捕捉价格动量拐点。',
    mechanics_en: 'EMA_t = Price_t * (2 / (N + 1)) + EMA_{t-1} * (1 - 2 / (N + 1)). The terminal overlays EMA 9 (Cyan #00e5ff) as the fast momentum line and EMA 21 (Gold #ff9f0a) as the medium trend guide.',
    mechanics_zh: '计算公式：EMA_t = Price_t * [2 / (N + 1)] + EMA_{t-1} * [1 - 2 / (N + 1)]。终端主图叠加 EMA 9（青色，快速动量线）与 EMA 21（金色，中期趋势通道）。',
    desired_range_en: 'Golden Cross (EMA 9 crosses above EMA 21): Bullish momentum trigger. Price trading above both EMA 9 & 21 indicates an active structural uptrend.',
    desired_range_zh: '金叉买点：EMA 9 向上穿越 EMA 21，多头动能爆发；死亡交叉：EMA 9 向下击穿 EMA 21，空头动量确立。价格位于 EMA 9 与 21 上方代表强势多头主升。',
    interpretation_en: 'Dynamic Support: EMA 9 acts as the first pull-back support in steep trends; EMA 21 serves as the baseline trend defense.',
    interpretation_zh: '动态支撑与阻力：急升行情中 EMA 9 提供第一回踩支撑，EMA 21 提供趋势多空分界底线。',
  },
  sma: {
    key: 'sma',
    title: 'Simple Moving Average (SMA 50)',
    subtitle: 'Institutional Benchmark & Macro Bull/Bear Baseline',
    philosophy_en: 'SMA calculates the unweighted arithmetic mean of prices over a lookback window. Institutional asset managers and macro mutual funds universally track the SMA 50 as the primary quarterly bull/bear baseline.',
    philosophy_zh: '简单移动平均线（SMA）对时间窗口内的所有价格赋予均等权重。全球华尔街共同基金与机构资金公认将 50 日均线（SMA 50）视为主力中长线多空牛熊分水岭。',
    mechanics_en: 'SMA_n = (P_1 + P_2 + ... + P_n) / n. The terminal overlays SMA 50 in royal purple (#bf5af2).',
    mechanics_zh: '计算公式：SMA_n = (P_1 + P_2 + ... + P_n) / n。终端在主图以紫色实线呈现 SMA 50。',
    desired_range_en: 'Price > SMA 50: Long-term institutional accumulation regime. Price < SMA 50: Defensive or risk-off regime.',
    desired_range_zh: '价格 > SMA 50：处于机构大资金中期多头主导区间；价格 < SMA 50：处于防御与中长期避险下行区间。',
    interpretation_en: 'Bounce off SMA 50 with expanding volume is one of the highest conviction institutional re-entry patterns in equities.',
    interpretation_zh: '当股价在 SMA 50 附近获得放量支撑企稳时，属于高确定性的机构二次加仓形态。',
  },
  macd: {
    key: 'macd',
    title: 'MACD (12, 26, 9) - Oscillator Momentum',
    subtitle: 'Moving Average Convergence Divergence',
    philosophy_en: 'Invented by Gerald Appel, MACD is the gold standard indicator for trend-following momentum and trend reversal detection. It reveals changes in the strength, direction, momentum, and duration of a trend.',
    philosophy_zh: '由 Gerald Appel 发明，MACD 是技术分析中被誉为“指标之王”的经典动量指标，专门用于研判市场动能强弱变化、趋势反转拐点以及背离预警。',
    mechanics_en: 'DIF = EMA(12) - EMA(26) (Cyan Line). DEA = EMA(9) of DIF (Amber Line). MACD Histogram = (DIF - DEA) * 2 (Green bars > 0, Red bars < 0).',
    mechanics_zh: 'DIF（快线）= EMA(12) - EMA(26)；DEA（慢线）= DIF 的 9 周期 EMA；MACD 红绿柱 = (DIF - DEA) * 2（正值为绿柱放量，负值为红柱放量）。',
    desired_range_en: 'Zero Line Cross (DIF > 0): Multi-week bull regime. DIF/DEA Golden Cross below 0-axis + Bullish Divergence (底背离): Prime bottom reversal signal.',
    desired_range_zh: '0 轴多空分水岭：DIF > 0 处于多头主升浪；0 轴下方 DIF 上穿 DEA 且价格底背离（底背离）是极高胜率的抄底反转信号；顶背离则预警严重动能衰竭。',
    interpretation_en: 'Histogram Expansion: Momentum accelerating. Histogram Shrinking: Momentum exhausting, preparation for reversal or consolidation.',
    interpretation_zh: '红绿柱拉长代表动能正在加速扩张；红绿柱缩短代表动能衰竭，即将发生方向反转或变盘整理。',
  },
};

interface IndicatorGuideTooltipProps {
  indicator: IndicatorKey;
}

export const IndicatorGuideTooltip: React.FC<IndicatorGuideTooltipProps> = ({ indicator }) => {
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [isPinned, setIsPinned] = useState<boolean>(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [positionStyle, setPositionStyle] = useState<React.CSSProperties>({
    top: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
  });

  const meta = INDICATOR_METAS[indicator] || INDICATOR_METAS.volume;
  const isVisible = isHovered || isPinned;

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        isPinned &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsPinned(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPinned(false);
        setIsHovered(false);
      }
    };

    if (isPinned) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPinned]);

  // Viewport boundary clamping so popover never gets clipped by screen edges
  useEffect(() => {
    if (isVisible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 340;
      const windowWidth = window.innerWidth;
      
      let leftOffset = '50%';
      let transform = 'translateX(-50%)';

      if (rect.left - popoverWidth / 2 < 16) {
        leftOffset = '0px';
        transform = 'translateX(0)';
      } else if (rect.right + popoverWidth / 2 > windowWidth - 16) {
        leftOffset = 'auto';
        transform = 'none';
        setPositionStyle({
          top: 'calc(100% + 8px)',
          right: '0px',
          left: 'auto',
          transform: 'none',
        });
        return;
      }

      setPositionStyle({
        top: 'calc(100% + 8px)',
        left: leftOffset,
        transform,
      });
    }
  }, [isVisible]);

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          setIsPinned(prev => !prev);
        }}
        data-testid={`indicator-guide-btn-${indicator}`}
        style={{
          background: isPinned ? 'rgba(10, 132, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)',
          border: `1px solid ${isPinned ? 'rgba(10, 132, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)'}`,
          color: isPinned ? '#0a84ff' : '#aeaeb2',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 700,
          cursor: 'pointer',
          padding: 0,
          marginLeft: '4px',
          transition: 'all 0.2s',
          lineHeight: 1,
        }}
        title={`Click to pin ${meta.title} Guide`}
      >
        ?
      </button>

      {isVisible && (
        <div
          ref={popoverRef}
          data-testid={`indicator-guide-popover-${indicator}`}
          style={{
            position: 'absolute',
            ...positionStyle,
            width: '340px',
            backgroundColor: 'rgba(20, 20, 24, 0.97)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: `1px solid ${isPinned ? 'rgba(10, 132, 255, 0.5)' : 'rgba(255, 255, 255, 0.16)'}`,
            borderRadius: '12px',
            padding: '14px 16px',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.75)',
            zIndex: 100,
            color: '#f5f5f7',
            fontSize: '12px',
            lineHeight: 1.45,
            textAlign: 'left',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '8px', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.2px' }}>
                {meta.title}
              </div>
              <div style={{ fontSize: '11px', color: '#8e8e93', marginTop: '2px', fontWeight: 500 }}>
                {meta.subtitle}
              </div>
            </div>
            {isPinned && (
              <button
                onClick={() => setIsPinned(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#8e8e93',
                  fontSize: '13px',
                  cursor: 'pointer',
                  padding: '2px',
                  lineHeight: 1,
                }}
                title="Unpin / Close"
              >
                ✕
              </button>
            )}
          </div>

          {/* Section 1: Philosophy & Definition */}
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#0a84ff', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>
              Philosophy & Core Concept
            </div>
            <div style={{ color: '#e5e5ea', marginBottom: '4px' }}>
              {meta.philosophy_en}
            </div>
            <div style={{ color: '#aeaeb2', fontSize: '11.5px', lineHeight: 1.4 }}>
              {meta.philosophy_zh}
            </div>
          </div>

          {/* Section 2: Mechanics & Formula */}
          <div style={{ marginBottom: '10px', backgroundColor: 'rgba(255, 255, 255, 0.03)', padding: '6px 8px', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#ff9f0a', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>
              Mechanics & Formula
            </div>
            <div style={{ color: '#e5e5ea', fontFamily: 'monospace', fontSize: '11px', marginBottom: '4px' }}>
              {meta.mechanics_en}
            </div>
            <div style={{ color: '#aeaeb2', fontSize: '11px' }}>
              {meta.mechanics_zh}
            </div>
          </div>

          {/* Section 3: Desired Range & Interpretation */}
          <div style={{ marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#30d158', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>
              Institutional Value Ranges & Signals
            </div>
            <div style={{ color: '#e5e5ea', marginBottom: '4px' }}>
              {meta.desired_range_en}
            </div>
            <div style={{ color: '#aeaeb2', fontSize: '11.5px' }}>
              {meta.desired_range_zh}
            </div>
          </div>

          {/* Pin Footer Status */}
          <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '6px', marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px', color: '#636366' }}>
            <span>{isPinned ? '📌 Card pinned (Click outside to dismiss)' : '💡 Click (?) to pin card'}</span>
            <span style={{ color: '#0a84ff', fontWeight: 600 }}>Bulldog Alpha Quant</span>
          </div>
        </div>
      )}
    </div>
  );
};
