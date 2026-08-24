import React, { useState } from 'react';

export interface StrategyExplainabilityMeta {
  id: string;
  name: string;
  category: string;
  description: string;
  philosophy?: string;
  mechanics?: string;
  suitable_regime?: string;
  risk_profile?: string;
  default_params?: Record<string, any>;
  param_descriptions?: Record<string, string>;
}

interface StrategyExplainabilityCardProps {
  strategy: StrategyExplainabilityMeta | null;
}

export const StrategyExplainabilityCard: React.FC<StrategyExplainabilityCardProps> = ({ strategy }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!strategy) return null;

  return (
    <div
      style={{
        backgroundColor: '#161822',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '16px',
        marginBottom: '20px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
        transition: 'all 0.2s ease',
      }}
      data-testid="strategy-explainability-card"
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setIsExpanded((prev) => !prev)}
        title="点击展开/收起策略深度解析"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '18px' }}>🧠</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '15px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.2px' }}>
                {strategy.name}
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#64d2ff',
                  backgroundColor: 'rgba(10, 132, 255, 0.15)',
                  border: '1px solid rgba(10, 132, 255, 0.3)',
                  padding: '2px 8px',
                  borderRadius: '12px',
                }}
              >
                {strategy.category}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#8e8e93', marginTop: '2px' }}>
              Strategy Whitebox Breakdown & Quantitative Philosophy (策略白盒解析与量化逻辑)
            </div>
          </div>
        </div>

        <button
          type="button"
          style={{
            background: 'rgba(255, 255, 255, 0.06)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            color: '#aeaeb2',
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {isExpanded ? '收起 ▲' : '展开详情 ▼'}
        </button>
      </div>

      {/* Expanded Detailed Breakdown Grid */}
      {isExpanded && (
        <div
          style={{
            marginTop: '16px',
            paddingTop: '14px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '14px',
          }}
        >
          {/* Section 1: Quantitative Philosophy */}
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px' }}>💡</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#ffd60a', textTransform: 'uppercase' }}>
                量化核心思路 (Philosophy)
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#e5e5ea', margin: 0, lineHeight: 1.55 }}>
              {strategy.philosophy || strategy.description}
            </p>
          </div>

          {/* Section 2: Execution Mechanics */}
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px' }}>⚡</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#30d158', textTransform: 'uppercase' }}>
                执行机制与风控 (Mechanics)
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#e5e5ea', margin: 0, lineHeight: 1.55 }}>
              {strategy.mechanics || '依据实时行情计算多空目标仓位并生成委托订单。'}
            </p>
          </div>

          {/* Section 3: Suitable Market Regime */}
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px' }}>🌊</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#64d2ff', textTransform: 'uppercase' }}>
                最佳适用行情 (Suitable Regime)
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#e5e5ea', margin: 0, lineHeight: 1.55 }}>
              {strategy.suitable_regime || '常规活跃交易市场。'}
            </p>
          </div>

          {/* Section 4: Risk Profile */}
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px' }}>🛡️</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#ff453a', textTransform: 'uppercase' }}>
                潜在风险与失效场景 (Risk Profile)
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#e5e5ea', margin: 0, lineHeight: 1.55 }}>
              {strategy.risk_profile || '受底层资产系统性波动影响。'}
            </p>
          </div>

          {/* Section 5: Parameter Breakdown */}
          {strategy.param_descriptions && Object.keys(strategy.param_descriptions).length > 0 && (
            <div
              style={{
                gridColumn: '1 / -1',
                backgroundColor: 'rgba(10, 132, 255, 0.04)',
                border: '1px solid rgba(10, 132, 255, 0.2)',
                borderRadius: '8px',
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px' }}>⚙️</span>
                <span style={{ fontSize: '12px', fontWeight: 800, color: '#64d2ff', textTransform: 'uppercase' }}>
                  策略可调参数指南 (Configurable Parameters Guide)
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' }}>
                {Object.entries(strategy.param_descriptions).map(([paramName, desc]) => (
                  <div key={paramName} style={{ fontSize: '12px', color: '#d1d1d6' }}>
                    <span style={{ color: '#00e5ff', fontFamily: 'monospace', fontWeight: 700 }}>{paramName}</span>:{' '}
                    <span style={{ color: '#e5e5ea' }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
