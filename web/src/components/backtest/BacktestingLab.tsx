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
    philosophy: '价格呈现序列自相关性与动量聚集效应。通过顺应中期均线趋势并让利润奔跑，捕捉资产价格的大级别单边运动波段。',
    mechanics: '当快速均线金叉慢速均线时全仓做多；快线死叉慢线时平仓或反手做空，结合 ATR 波动率自适应追踪止损控制单笔最大回撤。',
    suitable_regime: '单边上升牛市、大级别突破行情、高动量波动扩张周期。',
    risk_profile: '在窄幅横盘无趋势震荡市容易反复遭遇“双重打脸”（Whipsaw）导致连续小幅止损磨损本金。',
    param_descriptions: {
      fast_period: '短期均线周期（天数），对最新价格变动更敏感',
      slow_period: '长期基准均线周期，用于过滤短期市场噪音',
      atr_mult: '真实波幅 ATR 倍数，动态决定追踪止损缓冲带',
    },
  },
  mean_reversion: {
    id: 'mean_reversion',
    name: 'Bollinger & RSI Mean Reversion',
    category: 'Mean Reversion',
    description: 'Exploits statistical price overextension using Bollinger Bands and RSI exhaustion.',
    philosophy: '价格围绕内在公允均值波动，短期的恐慌性超卖或贪婪性超买属于非理性过度反应，必然在统计规律下向移动平均线回归。',
    mechanics: '价格跌穿布林带下轨且 RSI < 30 时左侧建多仓；冲破布林带上轨且 RSI > 70 时建空仓或平多仓；价格回归至中轨 SMA 时平仓锁定利润。',
    suitable_regime: '均值回归型震荡市、宽幅箱体整理行情、波动率收敛区间。',
    risk_profile: '在遭遇极端黑天鹅或强单边暴跌行情时，可能出现“越跌越买/扛单破止损”风险，需严格设定 ATR 止损保护。',
    param_descriptions: {
      window: '布林带移动平均基准周期，通常为 20 日',
      num_std: '标准差倍数通道宽度，2.0 对应 95.4% 正态置信区间',
      rsi_len: '相对强弱指标 RSI 统计周期',
      rsi_over: '超卖阈值线（低于该值视为情绪恐慌超跌）',
    },
  },
  stat_arb: {
    id: 'stat_arb',
    name: 'Cointegrated Pairs Statistical Arbitrage',
    category: 'Statistical Arbitrage',
    description: 'Exploits cointegrated equity pairs with dynamic OLS hedge ratio and Z-score spread bounds.',
    philosophy: '具有共同经济驱动因子的高关联资产对（如 MSFT vs AAPL）具有长期协整关系，短期价差偏离会向统计均衡中枢靠拢。',
    mechanics: '通过滚动 OLS 回归实时计算动态对冲比率 Beta，构建平稳价差序列。当 Z-Score <= -2.0 时做多价差（买A卖B）；Z-Score >= 2.0 时做空价差（卖A买B）；回归至 0 轴时平仓，偏离 > 3.5 触发结构性断裂硬止损。',
    suitable_regime: '市场中性环境、两融配对对冲、大盘剧烈震荡但板块内部相对稳定的阶段。',
    risk_profile: '协整关系可能因为企业基本面突变（如重大财报暴雷、并购重组）而彻底瓦解（Structural Break）。',
    param_descriptions: {
      window: '协整对冲系数 Beta 与价差均值/方差的滚动计算窗口长度',
      entry_z: '建仓开仓的 Z-score 标准差偏离阈值（通常为 1.5 ~ 2.5）',
      exit_z: '均值回归目标平仓阈值（接近 0.0 时平仓止盈）',
      stop_z: '极端脱节硬止损阈值（防止单边脱节导致无限亏损）',
    },
  },
  momentum: {
    id: 'momentum',
    name: 'Cross-Sectional Factor Momentum',
    category: 'Factor Momentum',
    description: 'Periodically ranks universe by trailing return, long top winners with inverse-volatility weighting.',
    philosophy: '截面多资产动量效应（Jegadeesh & Titman 经典理论）：在资产池内部，过去表现最强的资产（Winners）在未来一段周期内会继续跑赢表现最差的资产（Losers）。',
    mechanics: '每隔 N 个周期对资产池全量标的按过去 Lookback 周期累积收益打分排序，按反波动率风险平价权重做多 Top 领头羊，做空/减持 Bottom 滞涨股。',
    suitable_regime: '板块轮动加速行情、结构性分化牛市、科技成长龙头主升浪。',
    risk_profile: '在遭遇市场风格剧烈切换（如高低切换、价值防御突发跑赢成长动量）时，可能发生“动量崩溃（Momentum Crash）”。',
    param_descriptions: {
      lookback: '动量回溯收益率统计周期（天数）',
      top_k: '多头组合选取的头部最强资产数量',
      rebalance_interval: '组合再平衡调仓频率（K线根数）',
    },
  },
  multi_asset_limit: {
    id: 'multi_asset_limit',
    name: 'Multi-Asset Spread Liquidity Maker',
    category: 'Market Making',
    description: 'Provides liquidity on equity pairs with dynamic inventory balancing and asymmetric quoting.',
    philosophy: '高流动性标的由于微观做市商存货管理与瞬时买卖不平衡存在买卖价差（Bid-Ask Spread），双向挂单可赚取微观流动性溢价。',
    mechanics: '实时依据盘口价差与存货偏斜度（Avellaneda-Stoikov 模型）非对称向买一/卖一挂限价单，在持仓偏大时向对向倾斜报价以诱导平仓。',
    suitable_regime: '高成交量活跃市场、震荡微波市、流动性充裕无突发跳空阶段。',
    risk_profile: '逆向选择风险（Adverse Selection）：被知情交易者（Informed Traders）巨量砸穿单边导致存货严重被动套牢。',
    param_descriptions: {
      spread_bps: '做市报价与公允中间价的基点偏离间距',
      max_position: '单标的允许被动累积的最大安全持仓阈值',
    },
  },
  rl_strategy: {
    id: 'rl_strategy',
    name: 'Deep RL Microstructure Policy',
    category: 'Machine Learning / RL',
    description: 'Deep Reinforcement Learning agent policy using feature vector embeddings.',
    philosophy: '市场微观结构包含非线性非高斯的潜空间特征。通过深度强化学习（PPO/DQN）直接学习从微观订单流状态到最优仓位权重的端到端映射策略。',
    mechanics: '提取对数收益率、滚动均值/方差、Z-Score、当前归一化持仓与现金比例构成连续状态向量，通过 ONNX 神经网络实时推理输出目标仓位权重，经由动作适配器约束下单。',
    suitable_regime: '高频微观结构波动、订单流失衡突发事件、流动性快速变动的日内行情。',
    risk_profile: '神经网络策略存在“黑盒/不可解释风险”以及在未见过的极端宏观突发事件下的模型过拟合（Overfitting）与分布漂移风险。',
    param_descriptions: {
      window_size: '微观特征提取器状态滑动窗口长度',
      confidence_threshold: '模型输出动作置信度过滤门槛',
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
