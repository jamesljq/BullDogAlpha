import React, { useRef, useState, useEffect } from 'react';

interface EquityPoint {
  timestamp: number;
  nav: number;
  drawdown_pct: number;
}

interface EquityCurveCanvasProps {
  equityCurve: EquityPoint[];
  initialCapital: number;
}

export const EquityCurveCanvas: React.FC<EquityCurveCanvasProps> = ({ equityCurve, initialCapital }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    if (!containerRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0] && entries[0].contentRect.width > 0) {
        setContainerWidth(entries[0].contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !equityCurve || equityCurve.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = containerWidth;
    const height = 360;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const padding = { top: 20, right: 60, bottom: 40, left: 20 };
    const navHeight = height * 0.65 - padding.top;
    const ddTop = height * 0.72;
    const ddHeight = height - ddTop - padding.bottom;
    const chartWidth = width - padding.left - padding.right;

    // Calculate NAV bounds
    const navs = equityCurve.map((p) => p.nav);
    const minNav = Math.min(initialCapital * 0.9, ...navs);
    const maxNav = Math.max(initialCapital * 1.1, ...navs);
    const navRange = maxNav - minNav || 1.0;

    // Calculate Max Drawdown bound
    const dds = equityCurve.map((p) => p.drawdown_pct);
    const maxDD = Math.max(10.0, ...dds);

    const getX = (i: number) => padding.left + (i / (equityCurve.length - 1 || 1)) * chartWidth;
    const getYNav = (nav: number) => padding.top + (1 - (nav - minNav) / navRange) * navHeight;
    const getYDd = (dd: number) => ddTop + (dd / maxDD) * ddHeight;

    // 1. Draw Grid Lines & Axes for NAV
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;

    for (let s = 0; s <= 4; s++) {
      const y = padding.top + (s / 4) * navHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const priceVal = maxNav - (s / 4) * navRange;
      ctx.fillStyle = '#8e8e93';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`$${priceVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, width - padding.right + 6, y + 3);
    }

    // 2. Draw NAV Area Gradient
    const navGradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + navHeight);
    navGradient.addColorStop(0, 'rgba(10, 132, 255, 0.35)');
    navGradient.addColorStop(1, 'rgba(10, 132, 255, 0.0)');

    ctx.beginPath();
    ctx.moveTo(getX(0), padding.top + navHeight);
    for (let i = 0; i < equityCurve.length; i++) {
      ctx.lineTo(getX(i), getYNav(equityCurve[i].nav));
    }
    ctx.lineTo(getX(equityCurve.length - 1), padding.top + navHeight);
    ctx.closePath();
    ctx.fillStyle = navGradient;
    ctx.fill();

    // 3. Draw NAV Line
    ctx.beginPath();
    for (let i = 0; i < equityCurve.length; i++) {
      const x = getX(i);
      const y = getYNav(equityCurve[i].nav);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 4. Draw Baseline Initial Capital Line
    const initY = getYNav(initialCapital);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(padding.left, initY);
    ctx.lineTo(width - padding.right, initY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 5. Draw Drawdown Sub-plot
    ctx.fillStyle = '#8e8e93';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Underwater Drawdown', padding.left, ddTop - 6);
    ctx.fillText(`-${maxDD.toFixed(1)}%`, width - padding.right + 6, ddTop + ddHeight);

    const ddGradient = ctx.createLinearGradient(0, ddTop, 0, ddTop + ddHeight);
    ddGradient.addColorStop(0, 'rgba(255, 69, 58, 0.1)');
    ddGradient.addColorStop(1, 'rgba(255, 69, 58, 0.4)');

    ctx.beginPath();
    ctx.moveTo(getX(0), ddTop);
    for (let i = 0; i < equityCurve.length; i++) {
      ctx.lineTo(getX(i), getYDd(equityCurve[i].drawdown_pct));
    }
    ctx.lineTo(getX(equityCurve.length - 1), ddTop);
    ctx.closePath();
    ctx.fillStyle = ddGradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < equityCurve.length; i++) {
      const x = getX(i);
      const y = getYDd(equityCurve[i].drawdown_pct);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff453a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 6. Draw Crosshair if Hovered
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < equityCurve.length) {
      const hx = getX(hoverIndex);
      const hy = getYNav(equityCurve[hoverIndex].nav);

      // Vertical Guide
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(hx, padding.top);
      ctx.lineTo(hx, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Glow Point
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00e5ff';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [equityCurve, initialCapital, hoverIndex, containerWidth]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!equityCurve || equityCurve.length === 0 || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const paddingLeft = 20;
    const paddingRight = 60;
    const chartWidth = containerWidth - paddingLeft - paddingRight;

    const relX = Math.max(0, Math.min(chartWidth, x - paddingLeft));
    const idx = Math.round((relX / chartWidth) * (equityCurve.length - 1));
    setHoverIndex(idx);
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  const hoveredPoint = hoverIndex !== null && equityCurve && equityCurve[hoverIndex] ? equityCurve[hoverIndex] : null;

  return (
    <div
      ref={containerRef}
      style={{
        backgroundColor: '#161822',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '16px',
        position: 'relative',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
      }}
      data-testid="equity-curve-container"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff' }}>📈 Net Asset Value (NAV) & Underwater Drawdown</span>
          <span style={{ fontSize: '11px', color: '#30d158', backgroundColor: 'rgba(48, 209, 88, 0.1)', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
            Continuous Timeline
          </span>
        </div>

        {hoveredPoint && (
          <div
            style={{
              fontSize: '12px',
              color: '#ffffff',
              display: 'flex',
              gap: '16px',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              padding: '4px 12px',
              borderRadius: '6px',
              fontFamily: 'monospace',
            }}
            data-testid="hover-info-badge"
          >
            <span>Date: <strong>{new Date(hoveredPoint.timestamp).toISOString().split('T')[0]}</strong></span>
            <span>NAV: <strong style={{ color: '#00e5ff' }}>${hoveredPoint.nav.toLocaleString()}</strong></span>
            <span>Drawdown: <strong style={{ color: hoveredPoint.drawdown_pct > 10 ? '#ff453a' : '#ffd60a' }}>-{hoveredPoint.drawdown_pct.toFixed(2)}%</strong></span>
          </div>
        )}
      </div>

      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: '100%', height: '360px', cursor: 'crosshair', display: 'block' }}
        data-testid="equity-canvas"
      />
    </div>
  );
};
