import React, { useState } from 'react';

export interface BacktestTrade {
  timestamp: number;
  order_id: string;
  symbol: string;
  side: string;
  qty: number;
  order_price: number;
  exec_price: number;
  slippage_cost: number;
  commission: number;
  realized_pnl: number;
  cash_after: number;
  position_after: number;
}

interface TradeLogAuditTableProps {
  trades?: BacktestTrade[];
}

export const TradeLogAuditTable: React.FC<TradeLogAuditTableProps> = ({ trades = [] }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const filteredTrades = trades.filter((t) => {
    const term = searchTerm.toLowerCase();
    return (
      t.symbol.toLowerCase().includes(term) ||
      t.side.toLowerCase().includes(term) ||
      t.order_id.toLowerCase().includes(term)
    );
  });

  const totalPages = Math.ceil(filteredTrades.length / pageSize) || 1;
  const paginatedTrades = filteredTrades.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const thStyle: React.CSSProperties = {
    padding: '10px 12px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: 700,
    color: '#8e8e93',
    textTransform: 'uppercase',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: '12px',
    color: '#d1d1d6',
    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
  };

  return (
    <div
      style={{
        backgroundColor: '#161822',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '18px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
      }}
      data-testid="trade-log-table-container"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff' }}>📋 Trade Execution Audit Log</span>
          <span style={{ fontSize: '11px', color: '#8e8e93' }}>({trades.length} Total Executions)</span>
        </div>

        <input
          type="text"
          placeholder="Filter by symbol, side, order ID..."
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setCurrentPage(1);
          }}
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            color: '#ffffff',
            borderRadius: '6px',
            padding: '6px 12px',
            fontSize: '12px',
            outline: 'none',
            width: '220px',
          }}
          data-testid="trade-log-search"
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Date & Time</th>
              <th style={thStyle}>Order ID</th>
              <th style={thStyle}>Symbol</th>
              <th style={thStyle}>Action</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Exec Price</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Slippage</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Fee</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Realized P&L</th>
            </tr>
          </thead>
          <tbody>
            {paginatedTrades.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '24px', textAlign: 'center', color: '#8e8e93' }}>
                  No trade records found.
                </td>
              </tr>
            ) : (
              paginatedTrades.map((t, idx) => {
                const isBuy = t.side.toUpperCase() === 'BUY';
                const hasPnl = Math.abs(t.realized_pnl) > 0.001;
                const pnlColor = t.realized_pnl >= 0 ? '#30d158' : '#ff453a';

                return (
                  <tr key={idx} style={{ transition: 'background-color 0.1s ease' }}>
                    <td style={tdStyle}>
                      {new Date(t.timestamp).toISOString().split('T')[0]}
                    </td>
                    <td style={{ ...tdStyle, color: '#8e8e93', fontSize: '11px' }}>{t.order_id}</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: '#ffffff' }}>{t.symbol}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          backgroundColor: isBuy ? 'rgba(10, 132, 255, 0.15)' : 'rgba(255, 159, 10, 0.15)',
                          color: isBuy ? '#0a84ff' : '#ff9f0a',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: 700,
                        }}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{t.qty}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>${t.exec_price.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#8e8e93' }}>${t.slippage_cost.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#8e8e93' }}>${t.commission.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: hasPnl ? pnlColor : '#8e8e93' }}>
                      {hasPnl ? `${t.realized_pnl >= 0 ? '+' : ''}$${t.realized_pnl.toFixed(2)}` : '-'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Bar */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontSize: '11px', color: '#8e8e93' }}>
            Page {currentPage} of {totalPages} ({filteredTrades.length} entries)
          </span>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              style={{
                backgroundColor: currentPage <= 1 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                color: currentPage <= 1 ? '#636366' : '#ffffff',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 10px',
                fontSize: '11px',
                cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
              }}
              data-testid="pagination-prev"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              style={{
                backgroundColor: currentPage >= totalPages ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.08)',
                color: currentPage >= totalPages ? '#636366' : '#ffffff',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 10px',
                fontSize: '11px',
                cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
              }}
              data-testid="pagination-next"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
