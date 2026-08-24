import React, { useState } from 'react';

export interface StrategyParamSchemaMeta {
  name: string;
  default_value: any;
  valid_range: string;
  description_en: string;
  description_zh: string;
}

export interface StrategyExplainabilityMeta {
  id: string;
  name: string;
  category: string;
  description: string;
  philosophy_en?: string;
  philosophy_zh?: string;
  mechanics_en?: string;
  mechanics_zh?: string;
  suitable_regime_en?: string;
  suitable_regime_zh?: string;
  risk_profile_en?: string;
  risk_profile_zh?: string;
  default_params?: Record<string, any>;
  param_schemas?: Record<string, StrategyParamSchemaMeta>;
}

interface StrategyExplainabilityCardProps {
  strategy: StrategyExplainabilityMeta | null;
  currentParams?: Record<string, any>;
}

export const StrategyExplainabilityCard: React.FC<StrategyExplainabilityCardProps> = ({
  strategy,
  currentParams = {},
}) => {
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
        title="Toggle Strategy Deep Breakdown"
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
              Strategy Whitebox Breakdown & Quantitative Rationale
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
          {isExpanded ? 'Collapse ▲' : 'Expand Details ▼'}
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
          {/* Section 1: Philosophy */}
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
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#ffd60a', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                Philosophy
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#ffffff', margin: '0 0 6px 0', lineHeight: 1.5, fontWeight: 500 }}>
              {strategy.philosophy_en || strategy.description}
            </p>
            {strategy.philosophy_zh && (
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0, lineHeight: 1.5 }}>
                {strategy.philosophy_zh}
              </p>
            )}
          </div>

          {/* Section 2: Mechanics */}
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
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#30d158', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                Mechanics
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#ffffff', margin: '0 0 6px 0', lineHeight: 1.5, fontWeight: 500 }}>
              {strategy.mechanics_en || 'Evaluates real-time price signals to generate execution orders.'}
            </p>
            {strategy.mechanics_zh && (
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0, lineHeight: 1.5 }}>
                {strategy.mechanics_zh}
              </p>
            )}
          </div>

          {/* Section 3: Suitable Regime */}
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
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#64d2ff', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                Suitable Regime
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#ffffff', margin: '0 0 6px 0', lineHeight: 1.5, fontWeight: 500 }}>
              {strategy.suitable_regime_en || 'Standard active market liquidity.'}
            </p>
            {strategy.suitable_regime_zh && (
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0, lineHeight: 1.5 }}>
                {strategy.suitable_regime_zh}
              </p>
            )}
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
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#ff453a', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                Risk Profile
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#ffffff', margin: '0 0 6px 0', lineHeight: 1.5, fontWeight: 500 }}>
              {strategy.risk_profile_en || 'Subject to underlying asset volatility.'}
            </p>
            {strategy.risk_profile_zh && (
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: 0, lineHeight: 1.5 }}>
                {strategy.risk_profile_zh}
              </p>
            )}
          </div>

          {/* Section 5: Configurable Parameters */}
          {strategy.param_schemas && Object.keys(strategy.param_schemas).length > 0 && (
            <div
              style={{
                gridColumn: '1 / -1',
                backgroundColor: 'rgba(10, 132, 255, 0.04)',
                border: '1px solid rgba(10, 132, 255, 0.2)',
                borderRadius: '8px',
                padding: '12px 14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                <span style={{ fontSize: '13px' }}>⚙️</span>
                <span style={{ fontSize: '12px', fontWeight: 800, color: '#64d2ff', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                  Configurable Parameters
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
                {Object.entries(strategy.param_schemas).map(([paramKey, schema]) => {
                  const currentValue = currentParams[paramKey] !== undefined ? currentParams[paramKey] : schema.default_value;

                  return (
                    <div
                      key={paramKey}
                      style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: '6px',
                        padding: '10px 12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap', gap: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ color: '#00e5ff', fontFamily: 'monospace', fontWeight: 800, fontSize: '12.5px' }}>
                            {paramKey}
                          </span>
                          <span style={{ color: '#8e8e93', fontSize: '11px', fontWeight: 600 }}>
                            ({schema.name})
                          </span>
                        </div>

                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <span
                            style={{
                              backgroundColor: 'rgba(48, 209, 88, 0.15)',
                              color: '#30d158',
                              border: '1px solid rgba(48, 209, 88, 0.3)',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                            }}
                            title="Active value used in backtest"
                          >
                            Value: {String(currentValue)}
                          </span>
                          <span
                            style={{
                              backgroundColor: 'rgba(255, 255, 255, 0.08)',
                              color: '#aeaeb2',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              fontSize: '10.5px',
                              fontFamily: 'monospace',
                            }}
                            title="Valid parameter range"
                          >
                            Range: {schema.valid_range}
                          </span>
                        </div>
                      </div>

                      <p style={{ fontSize: '11.5px', color: '#e5e5ea', margin: '0 0 3px 0', lineHeight: 1.4 }}>
                        {schema.description_en}
                      </p>
                      <p style={{ fontSize: '11px', color: '#9ca3af', margin: 0, lineHeight: 1.4 }}>
                        {schema.description_zh}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
