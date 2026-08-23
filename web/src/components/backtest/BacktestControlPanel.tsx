import React from 'react';

export interface BacktestConfig {
  strategy: string;
  symbols: string[];
  start_date: string;
  end_date: string;
  initial_capital: number;
  slippage_bps: number;
  commission_rate: number;
  flat_fee: number;
  benchmark_symbol: string;
}

interface BacktestControlPanelProps {
  config: BacktestConfig;
  onChange: (newConfig: BacktestConfig) => void;
  onRun: () => void;
  isRunning: boolean;
}

const AVAILABLE_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'GOOG', 'AMZN', 'SPY', 'QQQ'];

export const BacktestControlPanel: React.FC<BacktestControlPanelProps> = ({
  config,
  onChange,
  onRun,
  isRunning,
}) => {
  const toggleSymbol = (sym: string) => {
    let updated = [...config.symbols];
    if (updated.includes(sym)) {
      if (updated.length > 1) {
        updated = updated.filter((s) => s !== sym);
      }
    } else {
      updated.push(sym);
    }
    onChange({ ...config, symbols: updated });
  };

  const applyPreset = (presetType: string) => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    let startStr = '2020-01-01';
    let syms = ['AAPL', 'MSFT', 'NVDA'];
    let strat = 'trend';

    if (presetType === '5y_tech') {
      const d = new Date(today);
      d.setFullYear(d.getFullYear() - 5);
      startStr = d.toISOString().split('T')[0];
      syms = ['AAPL', 'MSFT', 'NVDA', 'GOOG'];
      strat = 'trend';
    } else if (presetType === '10y_index') {
      const d = new Date(today);
      d.setFullYear(d.getFullYear() - 10);
      startStr = d.toISOString().split('T')[0];
      syms = ['SPY', 'QQQ'];
      strat = 'mean_reversion';
    } else if (presetType === '3y_rl') {
      const d = new Date(today);
      d.setFullYear(d.getFullYear() - 3);
      startStr = d.toISOString().split('T')[0];
      syms = ['NVDA', 'TSLA'];
      strat = 'rl_strategy';
    }

    onChange({
      ...config,
      strategy: strat,
      symbols: syms,
      start_date: startStr,
      end_date: todayStr,
    });
  };

  const setDateRangePreset = (years: number) => {
    const today = new Date();
    const endStr = today.toISOString().split('T')[0];
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - years);
    const startStr = d.toISOString().split('T')[0];
    onChange({ ...config, start_date: startStr, end_date: endStr });
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#ffffff',
    borderRadius: '6px',
    padding: '8px 12px',
    fontSize: '13px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 700,
    color: '#8e8e93',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '6px',
    display: 'block',
  };

  return (
    <div
      style={{
        backgroundColor: '#161822',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
      }}
      data-testid="backtest-control-panel"
    >
      {/* Top Quick Presets */}
      <div>
        <span style={labelStyle}>⚡ Fast Portfolio Presets</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            type="button"
            onClick={() => applyPreset('5y_tech')}
            style={{
              background: 'linear-gradient(135deg, rgba(10, 132, 255, 0.15) 0%, rgba(10, 132, 255, 0.05) 100%)',
              border: '1px solid rgba(10, 132, 255, 0.4)',
              color: '#64d2ff',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            5Y Tech Growth
          </button>
          <button
            type="button"
            onClick={() => applyPreset('10y_index')}
            style={{
              background: 'linear-gradient(135deg, rgba(48, 209, 88, 0.15) 0%, rgba(48, 209, 88, 0.05) 100%)',
              border: '1px solid rgba(48, 209, 88, 0.4)',
              color: '#30d158',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            10Y Index All-Weather
          </button>
          <button
            type="button"
            onClick={() => applyPreset('3y_rl')}
            style={{
              background: 'linear-gradient(135deg, rgba(191, 90, 242, 0.15) 0%, rgba(191, 90, 242, 0.05) 100%)',
              border: '1px solid rgba(191, 90, 242, 0.4)',
              color: '#bf5af2',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            3Y RL Alpha
          </button>
        </div>
      </div>

      {/* Strategy Selection */}
      <div>
        <label style={labelStyle}>Alpha Strategy</label>
        <select
          value={config.strategy}
          onChange={(e) => onChange({ ...config, strategy: e.target.value })}
          style={{ ...inputStyle, cursor: 'pointer' }}
          data-testid="strategy-select"
        >
          <option value="trend">Dual EMA Momentum Trend Follower</option>
          <option value="mean_reversion">Bollinger & RSI Mean Reversion</option>
          <option value="multi_asset_limit">Multi-Asset Spread Liquidity Maker</option>
          <option value="rl_strategy">Deep RL Microstructure Policy</option>
        </select>
      </div>

      {/* Asset Basket Multi-Select Chips */}
      <div>
        <label style={labelStyle}>Asset Basket ({config.symbols.length} Selected)</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {AVAILABLE_SYMBOLS.map((sym) => {
            const isSelected = config.symbols.includes(sym);
            return (
              <button
                key={sym}
                type="button"
                onClick={() => toggleSymbol(sym)}
                style={{
                  backgroundColor: isSelected ? '#0a84ff' : 'rgba(255, 255, 255, 0.06)',
                  color: isSelected ? '#ffffff' : '#8e8e93',
                  border: isSelected ? '1px solid #0a84ff' : '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '16px',
                  padding: '4px 12px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                data-testid={`symbol-chip-${sym}`}
              >
                {sym}
              </button>
            );
          })}
        </div>
      </div>

      {/* Date Range Controls */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <span style={labelStyle}>Date Period</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {[1, 3, 5, 10].map((yr) => (
              <button
                key={yr}
                type="button"
                onClick={() => setDateRangePreset(yr)}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#aeaeb2',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '2px 6px',
                  fontSize: '10px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {yr}Y
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <input
              type="date"
              value={config.start_date}
              onChange={(e) => onChange({ ...config, start_date: e.target.value })}
              style={inputStyle}
              data-testid="start-date-input"
            />
          </div>
          <div>
            <input
              type="date"
              value={config.end_date}
              onChange={(e) => onChange({ ...config, end_date: e.target.value })}
              style={inputStyle}
              data-testid="end-date-input"
            />
          </div>
        </div>
      </div>

      {/* Initial Capital & Execution Parameters */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <div>
          <label style={labelStyle}>Initial Capital ($)</label>
          <input
            type="number"
            value={config.initial_capital}
            onChange={(e) => onChange({ ...config, initial_capital: parseFloat(e.target.value) || 10000 })}
            style={inputStyle}
            step="10000"
            min="1000"
            data-testid="initial-capital-input"
          />
        </div>
        <div>
          <label style={labelStyle}>Slippage (Bps)</label>
          <input
            type="number"
            value={config.slippage_bps}
            onChange={(e) => onChange({ ...config, slippage_bps: parseFloat(e.target.value) || 0 })}
            style={inputStyle}
            step="1"
            min="0"
            data-testid="slippage-bps-input"
          />
        </div>
      </div>

      {/* Run Action Button */}
      <button
        type="button"
        onClick={onRun}
        disabled={isRunning}
        style={{
          background: isRunning
            ? '#2c2c2e'
            : 'linear-gradient(135deg, #0a84ff 0%, #007aff 100%)',
          color: '#ffffff',
          border: 'none',
          borderRadius: '8px',
          padding: '12px',
          fontSize: '14px',
          fontWeight: 800,
          cursor: isRunning ? 'not-allowed' : 'pointer',
          boxShadow: isRunning ? 'none' : '0 4px 16px rgba(10, 132, 255, 0.4)',
          transition: 'all 0.15s ease',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '8px',
          marginTop: '6px',
        }}
        data-testid="run-backtest-btn"
      >
        {isRunning ? (
          <>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
            <span>Running Simulation...</span>
          </>
        ) : (
          <>
            <span>⚡</span>
            <span>Run Multi-Year Backtest</span>
          </>
        )}
      </button>
    </div>
  );
};
