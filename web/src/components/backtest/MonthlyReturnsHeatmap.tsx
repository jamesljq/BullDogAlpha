import React from 'react';

interface MonthlyReturnsHeatmapProps {
  matrix?: Record<string, Record<string, number>>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const MonthlyReturnsHeatmap: React.FC<MonthlyReturnsHeatmapProps> = ({ matrix }) => {
  if (!matrix || Object.keys(matrix).length === 0) {
    return (
      <div
        style={{
          backgroundColor: '#161822',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          padding: '32px',
          textAlign: 'center',
          color: '#8e8e93',
        }}
      >
        No monthly performance data available.
      </div>
    );
  }

  const years = Object.keys(matrix).sort((a, b) => parseInt(b) - parseInt(a));

  const getHeatmapColor = (val?: number) => {
    if (val === undefined || isNaN(val)) return 'transparent';
    if (val === 0) return 'rgba(255, 255, 255, 0.03)';

    if (val > 0) {
      // Scale between +0.1% to +10%
      const alpha = Math.min(0.85, Math.max(0.15, val / 10.0));
      return `rgba(48, 209, 88, ${alpha})`;
    } else {
      // Scale between -0.1% to -10%
      const alpha = Math.min(0.85, Math.max(0.15, Math.abs(val) / 10.0));
      return `rgba(255, 69, 58, ${alpha})`;
    }
  };

  const getTextColor = (val?: number) => {
    if (val === undefined || isNaN(val)) return '#636366';
    if (val > 0) return '#ffffff';
    if (val < 0) return '#ffffff';
    return '#8e8e93';
  };

  return (
    <div
      style={{
        backgroundColor: '#161822',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '18px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
        overflowX: 'auto',
      }}
      data-testid="monthly-heatmap-container"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff' }}>🗓️ Monthly & Annual Returns Heatmap Matrix</span>
        <span style={{ fontSize: '11px', color: '#8e8e93' }}>Values in Net Return %</span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'center' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', color: '#8e8e93' }}>
            <th style={{ padding: '8px', textAlign: 'left', fontWeight: 700 }}>Year</th>
            {MONTHS.map((m) => (
              <th key={m} style={{ padding: '8px', fontWeight: 600 }}>{m}</th>
            ))}
            <th style={{ padding: '8px', fontWeight: 800, color: '#64d2ff', backgroundColor: 'rgba(255, 255, 255, 0.03)' }}>
              Year (YTD)
            </th>
          </tr>
        </thead>
        <tbody>
          {years.map((yr) => {
            const yrData = matrix[yr] || {};
            const annualVal = yrData['annual'];

            return (
              <tr key={yr} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                <td style={{ padding: '10px 8px', fontWeight: 700, color: '#ffffff', textAlign: 'left' }}>
                  {yr}
                </td>
                {MONTHS.map((_, idx) => {
                  const mKey = `${idx + 1}`;
                  const val = yrData[mKey];
                  const hasVal = val !== undefined;

                  return (
                    <td
                      key={mKey}
                      style={{
                        padding: '8px 4px',
                        backgroundColor: getHeatmapColor(val),
                        color: getTextColor(val),
                        fontWeight: hasVal ? 700 : 400,
                        borderRadius: '4px',
                        transition: 'transform 0.1s ease',
                      }}
                      title={hasVal ? `${yr} ${MONTHS[idx]}: ${val >= 0 ? '+' : ''}${val.toFixed(2)}%` : 'No data'}
                    >
                      {hasVal ? `${val >= 0 ? '+' : ''}${val.toFixed(1)}%` : '-'}
                    </td>
                  );
                })}

                <td
                  style={{
                    padding: '8px',
                    fontWeight: 800,
                    backgroundColor: getHeatmapColor(annualVal),
                    color: getTextColor(annualVal),
                    borderRadius: '4px',
                  }}
                >
                  {annualVal !== undefined ? `${annualVal >= 0 ? '+' : ''}${annualVal.toFixed(1)}%` : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
