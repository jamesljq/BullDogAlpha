import React, { useState, useEffect } from 'react';
import { BacktestControlPanel, BacktestConfig } from './BacktestControlPanel';
import { BacktestKPICards, BacktestResultsData } from './BacktestKPICards';
import { EquityCurveCanvas } from './EquityCurveCanvas';
import { MonthlyReturnsHeatmap } from './MonthlyReturnsHeatmap';
import { TradeLogAuditTable } from './TradeLogAuditTable';
import { StrategyExplainabilityCard, StrategyExplainabilityMeta } from './StrategyExplainabilityCard';

const DEFAULT_STRATEGY_METAS: Record<string, StrategyExplainabilityMeta> = {
  trend: {
    id: 'trend',
    name: 'Dual EMA Momentum Trend Follower',
    category: 'Trend Following',
    description: 'Captures medium-term cross-asset momentum trends with adaptive ATR trailing stops.',
    philosophy_en: 'Asset prices exhibit serial autocorrelation and momentum clustering. By following medium-term exponential moving averages and letting profits run, this strategy captures large unilateral price trends.',
    philosophy_zh: '资产价格呈现序列自相关性与动量聚集效应。通过顺应中期均线趋势并让利润奔跑，捕捉资产价格的大级别单边运动波段。',
    mechanics_en: 'Goes 100% long when Fast EMA crosses above Slow EMA; liquidates or shorts on death cross. Dynamic ATR trailing stops protect against severe drawdowns.',
    mechanics_zh: '当快速均线金叉慢速均线时全仓做多；快线死叉慢线时平仓或反手做空，结合 ATR 波动率自适应追踪止损控制单笔最大回撤。',
    suitable_regime_en: 'Unilateral trending bull markets, major breakout cycles, and expanding volatility regimes.',
    suitable_regime_zh: '单边上升牛市、大级别突破行情、高动量波动扩张周期。',
    risk_profile_en: 'Suffers whipsaw losses and capital attrition during low-volatility rangebound or oscillating markets.',
    risk_profile_zh: '在窄幅横盘无趋势震荡市容易反复遭遇“双重打脸”（Whipsaw）导致连续小幅止损磨损本金。',
    default_params: { fast_period: 10, slow_period: 30, atr_mult: 2.5 },
    param_schemas: {
      fast_period: {
        name: 'Fast EMA Period',
        default_value: 10,
        valid_range: '[2, 50] bars',
        description_en: 'Lookback period for the short-term exponential moving average.',
        description_zh: '短期指数移动平均线周期（K线根数/天数），对最新价格变动更为敏感。',
      },
      slow_period: {
        name: 'Slow EMA Period',
        default_value: 30,
        valid_range: '[10, 200] bars',
        description_en: 'Lookback period for the long-term baseline moving average to filter market noise.',
        description_zh: '长期基准均线周期，用于过滤短期市场高频噪音并确立主趋势。',
      },
      atr_mult: {
        name: 'ATR Stop Multiplier',
        default_value: 2.5,
        valid_range: '[1.0, 5.0]',
        description_en: 'Average True Range multiplier determining dynamic trailing stop buffer.',
        description_zh: '真实波幅 ATR 倍数，动态决定追踪止损与止盈缓冲带宽度。',
      },
    },
  },
  mean_reversion: {
    id: 'mean_reversion',
    name: 'Bollinger & RSI Mean Reversion',
    category: 'Mean Reversion',
    description: 'Exploits statistical price overextension using Bollinger Bands and RSI exhaustion.',
    philosophy_en: 'Asset prices oscillate around their statistical equilibrium intrinsic mean. Short-term extreme deviations driven by fear or greed represent transient overreactions that revert back to central moving averages.',
    philosophy_zh: '资产价格围绕内在公允均值波动，短期的恐慌性超卖或贪婪性超买属于非理性过度反应，必然在统计规律下向移动平均线回归。',
    mechanics_en: 'Takes long positions when price drops below Lower Bollinger Band and RSI < 30. Exits on Upper Band and RSI > 70, or upon returning to Middle SMA.',
    mechanics_zh: '价格跌穿布林带下轨且 RSI < 30 时左侧建多仓；冲破布林带上轨且 RSI > 70 时建空仓或平多仓；价格回归至中轨 SMA 时平仓锁定利润。',
    suitable_regime_en: 'Mean-reverting rangebound markets, broad consolidation channels, and contracting volatility regimes.',
    suitable_regime_zh: '均值回归型震荡市、宽幅箱体整理行情、波动率收敛区间。',
    risk_profile_en: 'Severe left-tail risk during strong unilateral breakdowns where prices plunge without reversion.',
    risk_profile_zh: '在遭遇极端黑天鹅或强单边暴跌行情时，可能出现“越跌越买/扛单破止损”风险，需严格设定 ATR 止损保护。',
    default_params: { window: 20, num_std: 2.0, rsi_len: 14, rsi_over: 30.0 },
    param_schemas: {
      window: {
        name: 'Bollinger Band Window',
        default_value: 20,
        valid_range: '[10, 100] bars',
        description_en: 'Lookback window for the moving average and rolling standard deviation.',
        description_zh: '布林带移动平均基准周期，通常设置为 20 日。',
      },
      num_std: {
        name: 'Standard Deviation Multiplier',
        default_value: 2.0,
        valid_range: '[1.0, 3.5]',
        description_en: 'Band width multiplier; 2.0 corresponds to a 95.4% normal distribution confidence interval.',
        description_zh: '标准差倍数通道宽度，2.0 对应 95.4% 的正态置信区间。',
      },
      rsi_len: {
        name: 'RSI Period',
        default_value: 14,
        valid_range: '[5, 30] bars',
        description_en: 'Relative Strength Index momentum evaluation window.',
        description_zh: '相对强弱指标 RSI 统计周期。',
      },
      rsi_over: {
        name: 'RSI Oversold Level',
        default_value: 30.0,
        valid_range: '[10.0, 45.0]',
        description_en: 'Exhaustion threshold below which asset is considered deeply oversold.',
        description_zh: '超卖阈值线（低于该值视为情绪恐慌超跌）。',
      },
    },
  },
  stat_arb: {
    id: 'stat_arb',
    name: 'Cointegrated Pairs Statistical Arbitrage',
    category: 'Statistical Arbitrage',
    description: 'Exploits cointegrated equity pairs with dynamic OLS hedge ratio and Z-score spread bounds.',
    philosophy_en: 'Economically interconnected asset pairs (e.g. MSFT vs AAPL) exhibit stationary long-term cointegration. Short-term spread discrepancies inevitably mean-revert toward statistical equilibrium.',
    philosophy_zh: '具有共同经济驱动因子的高关联资产对（如 MSFT vs AAPL）具有长期协整关系，短期价差偏离会向统计均衡中枢靠拢。',
    mechanics_en: 'Computes rolling OLS hedge ratio Beta to construct stationary spread. Buys spread when Z-Score <= -2.0; shorts spread when Z-Score >= 2.0; exits on zero cross, with |Z| >= 3.5 hard stop.',
    mechanics_zh: '通过滚动 OLS 回归实时计算动态对冲比率 Beta 构建平稳价差。当 Z-Score <= -2.0 时做多价差；Z-Score >= 2.0 时做空价差；回归至 0 轴时平仓，偏离 > 3.5 触发结构性断裂硬止损。',
    suitable_regime_en: 'Market-neutral environments, equity long/short hedging, and high sector-internal correlation regimes.',
    suitable_regime_zh: '市场中性环境、两融配对对冲、大盘剧烈震荡但板块内部相对稳定的阶段。',
    risk_profile_en: 'Structural cointegration breakdown due to idiosyncratic fundamental events (e.g. earnings shocks, M&A restructuring).',
    risk_profile_zh: '协整关系可能因为企业基本面突变（如重大财报暴雷、并购重组）而彻底瓦解（Structural Break）。',
    default_params: { window: 30, entry_z: 2.0, exit_z: 0.5, stop_z: 3.5 },
    param_schemas: {
      window: {
        name: 'OLS Estimation Window',
        default_value: 30,
        valid_range: '[15, 120] bars',
        description_en: 'Rolling lookback window for dynamic hedge ratio Beta and spread Z-score computation.',
        description_zh: '协整对冲系数 Beta 与价差均值/方差的滚动计算窗口长度。',
      },
      entry_z: {
        name: 'Entry Z-Score Threshold',
        default_value: 2.0,
        valid_range: '[1.0, 3.0]',
        description_en: 'Statistical standard deviation threshold to trigger pairs divergence entry.',
        description_zh: '建仓开仓的 Z-score 标准差偏离阈值（通常为 1.5 ~ 2.5）。',
      },
      exit_z: {
        name: 'Mean-Reversion Exit Threshold',
        default_value: 0.5,
        valid_range: '[0.0, 1.0]',
        description_en: 'Convergence threshold to close spread trade and lock in mean-reverting alpha.',
        description_zh: '均值回归目标平仓阈值（接近 0.0 时平仓止盈）。',
      },
      stop_z: {
        name: 'Structural Break Stop Loss',
        default_value: 3.5,
        valid_range: '[2.5, 6.0]',
        description_en: 'Emergency exit threshold to truncate losses if pair permanently diverges.',
        description_zh: '极端脱节硬止损阈值（防止单边脱节导致无限亏损）。',
      },
    },
  },
  momentum: {
    id: 'momentum',
    name: 'Cross-Sectional Factor Momentum',
    category: 'Factor Momentum',
    description: 'Periodically ranks universe by trailing return, long top winners with inverse-volatility weighting.',
    philosophy_en: 'Cross-sectional momentum anomaly (Jegadeesh & Titman): within a multi-asset universe, top trailing performers (Winners) systematically outperform laggards (Losers) over intermediate investment horizons.',
    philosophy_zh: '截面多资产动量效应（Jegadeesh & Titman 经典理论）：在资产池内部，过去表现最强的资产（Winners）在未来一段周期内会继续跑赢表现最差的资产（Losers）。',
    mechanics_en: 'Ranks full universe by cumulative trailing returns every N bars, allocating to Top-K winners with inverse-volatility risk parity weighting, and underweighting/shorting bottom laggards.',
    mechanics_zh: '每隔 N 个周期对资产池全量标的按过去 Lookback 周期累积收益打分排序，按反波动率风险平价权重做多 Top 领头羊，做空/减持 Bottom 滞涨股。',
    suitable_regime_en: 'Broad macro bull expansions, sector rotation trends, and structural growth leadership phases.',
    suitable_regime_zh: '板块轮动加速行情、结构性分化牛市、科技成长龙头主升浪。',
    risk_profile_en: 'Vulnerable to sharp factor reversals and "Momentum Crashes" when defensive value abruptly outperforms high-beta growth.',
    risk_profile_zh: '在遭遇市场风格剧烈切换（如高低切换、价值防御突发跑赢成长动量）时，可能发生“动量崩溃（Momentum Crash）”。',
    default_params: { lookback: 20, top_k: 2, rebalance_interval: 5 },
    param_schemas: {
      lookback: {
        name: 'Lookback Period',
        default_value: 20,
        valid_range: '[5, 60] bars',
        description_en: 'Trailing window used to calculate asset performance return ranking scores.',
        description_zh: '动量回溯收益率统计周期（天数/K线根数）。',
      },
      top_k: {
        name: 'Top Selected Assets',
        default_value: 2,
        valid_range: '[1, 10]',
        description_en: 'Number of top-ranked winner assets to include in the long portfolio basket.',
        description_zh: '多头组合选取的头部最强资产数量。',
      },
      rebalance_interval: {
        name: 'Rebalance Frequency',
        default_value: 5,
        valid_range: '[1, 20] bars',
        description_en: 'Periodic interval for recalculating factor weights and portfolio rebalancing.',
        description_zh: '组合再平衡调仓频率（K线根数）。',
      },
    },
  },
  multi_asset_limit: {
    id: 'multi_asset_limit',
    name: 'Multi-Asset Spread Liquidity Maker',
    category: 'Market Making',
    description: 'Provides liquidity on equity pairs with dynamic inventory balancing and asymmetric quoting.',
    philosophy_en: 'High-frequency bid-ask spreads compensate liquidity providers for inventory holding risk and order flow imbalances (Avellaneda-Stoikov model).',
    philosophy_zh: '高流动性标的由于做市商存货管理与瞬时买卖不平衡存在买卖价差（Bid-Ask Spread），双向挂单可赚取微观流动性溢价。',
    mechanics_en: 'Quotes limit buy/sell orders asymmetrically around mid-price based on current inventory skew to attract offsetting order flow.',
    mechanics_zh: '实时依据盘口价差与存货偏斜度非对称向买一/卖一挂限价单，在持仓偏大时向对向倾斜报价以诱导平仓。',
    suitable_regime_en: 'High-volume liquid markets, rangebound micro-oscillations, and tight spread environments without gap shocks.',
    suitable_regime_zh: '高成交量活跃市场、震荡微波市、流动性充裕无突发跳空阶段。',
    risk_profile_en: 'Adverse selection risk when informed toxic order flows blow through quotes, leaving toxic inventory.',
    risk_profile_zh: '逆向选择风险（Adverse Selection）：被知情交易者（Informed Traders）巨量砸穿单边导致存货严重被动套牢。',
    default_params: { spread_bps: 15, max_position: 500 },
    param_schemas: {
      spread_bps: {
        name: 'Bid-Ask Spread Margin',
        default_value: 15,
        valid_range: '[2, 100] bps',
        description_en: 'Spread distance in basis points away from the fair mid-market price.',
        description_zh: '做市报价与公允中间价的基点偏离间距。',
      },
      max_position: {
        name: 'Inventory Safety Cap',
        default_value: 500,
        valid_range: '[50, 5000] shares',
        description_en: 'Maximum allowable inventory risk allocation per symbol.',
        description_zh: '单标的允许被动累积的最大安全持仓阈值。',
      },
    },
  },
  rl_strategy: {
    id: 'rl_strategy',
    name: 'Deep RL Microstructure Policy',
    category: 'Machine Learning / RL',
    description: 'Deep Reinforcement Learning agent policy using feature vector embeddings.',
    philosophy_en: 'Financial microstructure features exhibit nonlinear, non-Gaussian latent dynamics. Deep Reinforcement Learning (PPO/DQN) trains end-to-end continuous policies mapping order flow states directly into target asset allocations.',
    philosophy_zh: '市场微观结构包含非线性非高斯的潜空间特征。通过深度强化学习（PPO/DQN）直接学习从微观订单流状态到最优仓位权重的端到端映射策略。',
    mechanics_en: 'Extracts log returns, rolling volatility, price Z-scores, normalized inventory, and cash ratio into state embeddings; an ONNX neural policy network infers target weights throttled by risk adapters.',
    mechanics_zh: '提取对数收益率、滚动均值/方差、Z-Score、当前归一化持仓与现金比例构成连续状态向量，通过 ONNX 神经网络实时推理输出目标仓位权重，经由动作适配器约束下单。',
    suitable_regime_en: 'High-frequency order-flow imbalances, intraday volatility bursts, and rapid liquidity regime shifts.',
    suitable_regime_zh: '高频微观结构波动、订单流失衡突发事件、流动性快速变动的日内行情。',
    risk_profile_en: 'Black-box interpretability risks, policy distribution shifts, and potential overfitting to historical training regimes during macro shocks.',
    risk_profile_zh: '神经网络策略存在“黑盒/不可解释风险”以及在未见过的极端宏观突发事件下的模型过拟合（Overfitting）与分布漂移风险。',
    default_params: { confidence_threshold: 0.70 },
    param_schemas: {
      confidence_threshold: {
        name: 'Policy Confidence Threshold',
        default_value: 0.70,
        valid_range: '[0.50, 0.95]',
        description_en: 'Minimum action probability cutoff required before order execution.',
        description_zh: '模型输出动作置信度过滤门槛。',
      },
    },
  },
};


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

  const [strategiesMeta, setStrategiesMeta] = useState<Record<string, StrategyExplainabilityMeta>>(DEFAULT_STRATEGY_METAS);
  const [results, setResults] = useState<BacktestResultsData | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'equity' | 'heatmap' | 'trades'>('equity');

  // Fetch strategies metadata
  useEffect(() => {
    const fetchStrategies = async () => {
      try {
        if (typeof fetch === 'undefined') return;
        const res = await fetch('/api/backtest/strategies');
        if (res && res.ok) {
          const list: StrategyExplainabilityMeta[] = await res.json();
          if (Array.isArray(list)) {
            const mapped = { ...DEFAULT_STRATEGY_METAS };
            list.forEach((s) => {
              mapped[s.id] = { ...mapped[s.id], ...s };
            });
            setStrategiesMeta(mapped);
          }
        }
      } catch (err) {
        // Silently keep default metas
      }
    };
    fetchStrategies();
  }, []);

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

  const currentStrategyMeta = strategiesMeta[config.strategy] || DEFAULT_STRATEGY_METAS[config.strategy] || null;



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
          {/* Strategy Granular Explainability & Philosophy Breakdown */}
          <StrategyExplainabilityCard strategy={currentStrategyMeta} />

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
