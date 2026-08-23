import React, { useState, useEffect } from 'react';
import { BacktestControlPanel, BacktestConfig } from './BacktestControlPanel';
import { BacktestKPICards, BacktestResultsData } from './BacktestKPICards';
import { EquityCurveCanvas } from './EquityCurveCanvas';
import { MonthlyReturnsHeatmap } from './MonthlyReturnsHeatmap';
import { TradeLogAuditTable } from './TradeLogAuditTable';

export const BacktestingLab: React.FC = () => {
  const [config, setConfig] = useState<BacktestConfig>({
    strategy: 'trend',
    symbols: ['AAPL', 'MSFT', 'NVDA'],
    start_date: '2020-01-01',
    end_date: '2024-12-31',
    initial_capital: 100000,
    slippage_bps: 5,
    commission_rate: 0.0001,
    flat_fee: 1.0,
    benchmark_symbol: 'SPY',
  });

  const [results, setResults] = useState<BacktestResultsData | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'equity' | 'heatmap' | 'trades'>('equity');

  const runBacktest = async () => {
    setIsRunning(true);
    setErrorMsg(null);
    try {
      if (typeof fetch === 'undefined') {
        setIsRunning(false);
        return;
      }
      const resp = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!resp || !resp.ok) {
        throw new Error(`Server returned HTTP ${resp ? resp.status : 500}`);
      }

      const data = await resp.json();
      if (data && typeof data === 'object') {
        setResults(data);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to execute backtest.');
    } finally {
      setIsRunning(false);
    }
  };

  // Run automatically on first mount to provide instant gratification to the user
  useEffect(() => {
    runBacktest();
  }, []);


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} data-testid="backtesting-lab">
      {/* Top Banner / Error notification */}
      {errorMsg && (
        <div
          style={{
            backgroundColor: 'rgba(255, 69, 58, 0.15)',
            border: '1px solid rgba(255, 69, 58, 0.4)',
            color: '#ff453a',
            padding: '12px 16px',
            borderRadius: '8px',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
          data-testid="backtest-error-banner"
        >
          <span>⚠️ {errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            style={{ background: 'none', border: 'none', color: '#ffffff', cursor: 'pointer', fontSize: '14px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Studio Grid: Left Controls (320px) | Right Analytics (Flex) */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', alignItems: 'start' }}>
        {/* Left: Control Dock */}
        <div>
          <BacktestControlPanel
            config={config}
            onChange={setConfig}
            onRun={runBacktest}
            isRunning={isRunning}
          />
        </div>

        {/* Right: Analytics & Interactive Visualizers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Hero KPI Scorecard */}
          <BacktestKPICards data={results} isLoading={isRunning} />

          {/* View Tab Selector Bar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#161822',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '10px',
              padding: '6px 10px',
            }}
          >
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={() => setActiveView('equity')}
                style={{
                  backgroundColor: activeView === 'equity' ? '#0a84ff' : 'transparent',
                  color: activeView === 'equity' ? '#ffffff' : '#8e8e93',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                data-testid="tab-view-equity"
              >
                📈 Equity & Drawdown
              </button>
              <button
                type="button"
                onClick={() => setActiveView('heatmap')}
                style={{
                  backgroundColor: activeView === 'heatmap' ? '#0a84ff' : 'transparent',
                  color: activeView === 'heatmap' ? '#ffffff' : '#8e8e93',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                data-testid="tab-view-heatmap"
              >
                🗓️ Monthly Heatmap
              </button>
              <button
                type="button"
                onClick={() => setActiveView('trades')}
                style={{
                  backgroundColor: activeView === 'trades' ? '#0a84ff' : 'transparent',
                  color: activeView === 'trades' ? '#ffffff' : '#8e8e93',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                data-testid="tab-view-trades"
              >
                📋 Trade Audit Log ({results?.trades?.length || 0})
              </button>
            </div>

            {results && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `backtest_${config.strategy}_${config.start_date}_${config.end_date}.json`;
                    a.click();
                  }}
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#aeaeb2',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                  data-testid="export-report-btn"
                >
                  ⬇ Export Report
                </button>
              </div>
            )}
          </div>

          {/* Active View Visualizer */}
          {results ? (
            <div>
              {activeView === 'equity' && (
                <EquityCurveCanvas
                  equityCurve={results.equity_curve || []}
                  initialCapital={results.initial_capital}
                />
              )}

              {activeView === 'heatmap' && (
                <MonthlyReturnsHeatmap matrix={results.monthly_returns_matrix} />
              )}

              {activeView === 'trades' && (
                <TradeLogAuditTable trades={results.trades || []} />
              )}
            </div>
          ) : (
            <div
              style={{
                backgroundColor: '#161822',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '12px',
                padding: '60px 20px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>📊</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff', marginBottom: '6px' }}>
                Ready to Backtest
              </div>
              <div style={{ fontSize: '13px', color: '#8e8e93', maxWidth: '400px', margin: '0 auto' }}>
                Select a strategy, asset basket, and historical timeframe on the left, then click <strong>Run Multi-Year Backtest</strong>.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
