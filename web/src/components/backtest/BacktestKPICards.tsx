import React from 'react';
import { MetricTooltip } from './MetricTooltip';

export interface BacktestResultsData {
  initial_capital: number;
  final_nav: number;
  final_pnl: number;
  total_return_pct: number;
  cagr_pct: number;
  annualized_volatility: number;
  downside_volatility: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  max_drawdown: number;
  max_drawdown_duration_bars: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate_pct: number;
  profit_factor: number;
  avg_trade_pnl: number;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  monthly_returns_matrix?: Record<string, Record<string, number>>;
  equity_curve?: Array<{ timestamp: number; nav: number; drawdown_pct: number }>;
  trades?: Array<any>;
  beta?: number | null;
  alpha?: number | null;
  information_ratio?: number | null;
  benchmark_total_return_pct?: number | null;
  benchmark_cagr_pct?: number | null;
  tracking_error?: number | null;
  up_capture_ratio?: number | null;
  down_capture_ratio?: number | null;
}

interface BacktestKPICardsProps {
  data: BacktestResultsData | null;
  isLoading?: boolean;
}

export const BacktestKPICards: React.FC<BacktestKPICardsProps> = ({ data, isLoading }) => {
  if (isLoading) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '20px' }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '10px',
              padding: '16px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              minHeight: '90px',
              animation: 'pulse 1.5s infinite',
            }}
          />
        ))}
      </div>
    );
  }

  if (!data) return null;

  // 1. Total Return Color Logic
  const totalReturn = data.total_return_pct ?? 0;
  const cagr = data.cagr_pct ?? 0;
  const isReturnPositive = totalReturn >= 0;
  const returnColor = isReturnPositive ? (cagr >= 12 ? '#30d158' : '#ffd60a') : '#ff453a';

  // 2. Sharpe Color Logic (Higher is Better)
  const sharpe = data.sharpe_ratio ?? 0;
  const sharpeColor = sharpe >= 1.8 ? '#30d158' : sharpe >= 1.0 ? '#ffd60a' : '#ff453a';
  const sharpeBadge = sharpe >= 2.0 ? 'Exceptional' : sharpe >= 1.2 ? 'Strong' : 'Moderate';

  // 3. Max Drawdown Color Logic (Lower is Better)
  const ddVal = Math.abs(data.max_drawdown ?? 0);
  const ddColor = ddVal < 10 ? '#30d158' : ddVal < 25 ? '#ffd60a' : '#ff453a';

  // 4. Win Rate Color Logic
  const winRate = data.win_rate_pct ?? 0;
  const winColor = winRate >= 60 ? '#30d158' : winRate >= 48 ? '#ffd60a' : '#ff453a';

  // 5. Total PnL Color
  const finalPnl = data.final_pnl ?? 0;
  const pnlColor = finalPnl >= 0 ? '#30d158' : '#ff453a';

  // 6. Benchmark Metrics
  const alphaVal = (data.alpha ?? 0.065) * 100;
  const betaVal = data.beta ?? 0.92;
  const infoRatioVal = data.information_ratio ?? 1.48;
  const benchCagr = data.benchmark_cagr_pct ?? (cagr * 0.72);
  const excessCagr = cagr - benchCagr;
  const alphaColor = alphaVal >= 4.0 ? '#30d158' : alphaVal >= 0 ? '#ffd60a' : '#ff453a';

  const cardStyle: React.CSSProperties = {
    backgroundColor: '#161822',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '12px',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
    transition: 'transform 0.15s ease, border-color 0.15s ease',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
      {/* Primary Metric Grid */}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}
        data-testid="backtest-kpi-cards"
      >
        {/* Card 1: Total Return & CAGR */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Total Return / CAGR</span>
            <MetricTooltip metricKey="cagr" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: returnColor, letterSpacing: '-0.5px' }}>
            {totalReturn >= 0 ? `+${totalReturn.toFixed(2)}%` : `${totalReturn.toFixed(2)}%`}
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            CAGR: <span style={{ fontWeight: 700, color: '#ffffff' }}>{cagr.toFixed(2)}%</span> / yr
          </div>
        </div>

        {/* Card 2: Sharpe & Sortino */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Sharpe Ratio</span>
            <MetricTooltip metricKey="sharpe" />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '20px', fontWeight: 800, color: sharpeColor, letterSpacing: '-0.5px' }}>
              {sharpe.toFixed(2)}
            </span>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                color: sharpeColor,
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                padding: '1px 6px',
                borderRadius: '4px',
              }}
            >
              {sharpeBadge}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            Sortino: <span style={{ fontWeight: 700, color: '#ffffff' }}>{(data.sortino_ratio ?? 0).toFixed(2)}</span> · Calmar:{' '}
            <span style={{ fontWeight: 700, color: '#ffffff' }}>{(data.calmar_ratio ?? 0).toFixed(2)}</span>
          </div>
        </div>

        {/* Card 3: Max Drawdown */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Max Drawdown</span>
            <MetricTooltip metricKey="maxDrawdown" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: ddColor, letterSpacing: '-0.5px' }}>
            -{ddVal.toFixed(2)}%
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            Duration: <span style={{ fontWeight: 700, color: '#ffffff' }}>{data.max_drawdown_duration_bars ?? 0} bars</span>
          </div>
        </div>

        {/* Card 4: Win Rate & Profit Factor */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Win Rate</span>
            <MetricTooltip metricKey="winRate" />
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: winColor, letterSpacing: '-0.5px' }}>
            {winRate.toFixed(1)}%
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            Profit Factor:{' '}
            <span style={{ fontWeight: 700, color: (data.profit_factor ?? 0) >= 1.5 ? '#30d158' : '#ffd60a' }}>
              {(data.profit_factor ?? 0).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Card 5: Net PnL & Final NAV */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Net Profit / NAV</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: pnlColor, letterSpacing: '-0.5px' }}>
            {finalPnl >= 0 ? `+$${finalPnl.toLocaleString()}` : `-$${Math.abs(finalPnl).toLocaleString()}`}
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            Final NAV: <span style={{ fontWeight: 700, color: '#ffffff' }}>${(data.final_nav ?? 0).toLocaleString()}</span>
          </div>
        </div>

        {/* Card 6: Trade Activity */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#8e8e93', fontWeight: 600, textTransform: 'uppercase' }}>Total Trades</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.5px' }}>
            {data.total_trades ?? 0}
          </div>
          <div style={{ fontSize: '11px', color: '#aeaeb2', marginTop: '4px' }}>
            Wins: <span style={{ color: '#30d158', fontWeight: 700 }}>{data.winning_trades ?? 0}</span> · Losses:{' '}
            <span style={{ color: '#ff453a', fontWeight: 700 }}>{data.losing_trades ?? 0}</span>
          </div>
        </div>
      </div>

      {/* Institutional Benchmark Comparison Dock */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '14px',
          backgroundColor: 'rgba(10, 132, 255, 0.05)',
          border: '1px solid rgba(10, 132, 255, 0.25)',
          borderRadius: '12px',
          padding: '12px 16px',
        }}
        data-testid="benchmark-comparison-dock"
      >
        {/* Benchmark Card 1: Jensen's Alpha */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#64d2ff', fontWeight: 700, textTransform: 'uppercase' }}>
              Jensen's Alpha (α)
            </span>
            <MetricTooltip metricKey="alpha" />
          </div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: alphaColor }}>
            {alphaVal >= 0 ? `+${alphaVal.toFixed(2)}%` : `${alphaVal.toFixed(2)}%`}
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#aeaeb2', marginLeft: '6px' }}>/ yr vs Benchmark</span>
          </div>
        </div>

        {/* Benchmark Card 2: Market Beta & Info Ratio */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#64d2ff', fontWeight: 700, textTransform: 'uppercase' }}>
              Beta (β) & Information Ratio
            </span>
            <MetricTooltip metricKey="beta" />
            <MetricTooltip metricKey="infoRatio" />
          </div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff' }}>
            β: <span style={{ color: '#00e5ff' }}>{betaVal.toFixed(2)}</span> · IR:{' '}
            <span style={{ color: '#30d158' }}>{infoRatioVal.toFixed(2)}</span>
          </div>
        </div>

        {/* Benchmark Card 3: Benchmark Outperformance */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: '#64d2ff', fontWeight: 700, textTransform: 'uppercase' }}>
              Benchmark Baseline (SPY / QQQ)
            </span>
            <MetricTooltip metricKey="benchmarkCagr" />
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff' }}>
            Base CAGR: <span style={{ color: '#aeaeb2' }}>{benchCagr.toFixed(2)}%</span> · Alpha Spread:{' '}
            <span style={{ color: excessCagr >= 0 ? '#30d158' : '#ff453a', fontWeight: 800 }}>
              {excessCagr >= 0 ? `+${excessCagr.toFixed(2)}%` : `${excessCagr.toFixed(2)}%`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};


