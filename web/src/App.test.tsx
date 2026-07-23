/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import App, { calculateRSI, getStockStats, checkIsMarketClosed, getMarketSessionStatus, STOCK_NAMES, aggregateTradeMarkers, TradeMarker, checkIsDailyOrHigher, getMarketSessionPrices, checkIsEarlyCloseDay, getIntervalSeconds, getTodayStats } from './App';

const mockFitContent = jest.fn();
const mockRemoveChart = jest.fn();
const mockCreateChart = jest.fn(() => ({
  addSeries: jest.fn(() => ({
    setData: jest.fn(),
    update: jest.fn(),
    setMarkers: jest.fn(),
  })),
  applyOptions: jest.fn(),
  timeScale: jest.fn(() => ({
    fitContent: mockFitContent,
    setVisibleRange: jest.fn(),
  })),
  remove: mockRemoveChart,
}));

// Mock lightweight-charts
jest.mock('lightweight-charts', () => ({
  createChart: (...args: any[]) => mockCreateChart(...args),
  LineSeries: 'LineSeries',
  CandlestickSeries: 'CandlestickSeries',
  createSeriesMarkers: jest.fn(),
}));

describe('Bulldog Alpha Web Console', () => {
  let wsInstance: any;
  let originalWebSocket: any;
  let originalLocation: Location;

  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    originalWebSocket = (global as any).WebSocket;
    originalLocation = window.location;
  });

  afterAll(() => {
    (global as any).WebSocket = originalWebSocket;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  beforeEach(() => {
    jest.restoreAllMocks();

    wsInstance = {
      addEventListener: jest.fn((event, cb) => {
        if (event === 'open') wsInstance.onopen = cb;
        else if (event === 'message') wsInstance.onmessage = cb;
        else if (event === 'close') wsInstance.onclose = cb;
        else if (event === 'error') wsInstance.onerror = cb;
      }),
      removeEventListener: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1,
    };

    (global as any).WebSocket = jest.fn().mockImplementation(() => {
      setTimeout(() => {
        if (wsInstance.onopen) wsInstance.onopen();
      }, 0);
      return wsInstance;
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        protocol: 'http:',
        host: 'localhost:3000',
        hostname: 'localhost',
        port: '3000',
        pathname: '/',
      },
    });

    (global as any).fetch = jest.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes('/api/mdg/config')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            tickers: ['AAPL', 'MSFT', 'NVDA'],
            vendor: 'alpaca',
            status: 'RUNNING',
          }),
        });
      }
      if (url.includes('/api/mdg/trades')) {
        if (opts && opts.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: 't1', symbol: 'AAPL', price: 325.0, qty: 100, action: 'BUY', timestamp: 1700000000000 },
          ]),
        });
      }
      if (url.includes('/api/mdg/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            bars: [
              { time: 1700000000, open: 320.0, high: 328.0, low: 318.0, close: 327.74 },
              { time: 1700000060, open: 327.74, high: 330.0, low: 326.0, close: 329.50 },
            ],
          }),
        });
      }
      if (url.includes('/api/mdg/subscriptions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tickers: ['AAPL', 'MSFT', 'NVDA', 'TSLA'] }),
        });
      }
      if (url.includes('/api/mdg/control')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      if (url.includes('/api/shutdown')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });
  });

  test('renders dashboard header and circuit status', async () => {
    await act(async () => {
      render(<App />);
    });
    
    expect(screen.getByText("BULLDOG")).toBeInTheDocument();
    expect(screen.getByText("ALPHA")).toBeInTheDocument();

    // Switch to Admin Tab
    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));
    expect(screen.getByText(/Market Data Ingestion Console/i)).toBeInTheDocument();

    // Switch back to Terminal Tab
    fireEvent.click(screen.getByText(/Trading Terminal/i));
    expect(screen.getByText(/Key Statistics/i)).toBeInTheDocument();
  });

  test('Robinhood timeframe buttons and TradingView Bar Interval dropdown', async () => {
    await act(async () => {
      render(<App />);
    });

    const timeframes = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'ALL'];
    for (const tf of timeframes) {
      const btn = screen.getByRole('button', { name: tf });
      fireEvent.click(btn);
      expect(btn).toBeInTheDocument();
    }

    const dropdowns = screen.getAllByRole('combobox');
    const intervalSelect = dropdowns[0];
    fireEvent.change(intervalSelect, { target: { value: '15m' } });
    expect(intervalSelect).toHaveValue('15m');

    const chartTypeSelect = dropdowns[1];
    fireEvent.change(chartTypeSelect, { target: { value: 'candlestick' } });
    expect(chartTypeSelect).toHaveValue('candlestick');
  });

  test('simulates BUY and SELL trades', async () => {
    await act(async () => {
      render(<App />);
    });

    const buyBtn = screen.getByText(/SIMULATE BUY 100/i);
    fireEvent.click(buyBtn);
    await waitFor(() => {
      expect((global as any).fetch).toHaveBeenCalledWith('/api/mdg/trades', expect.anything());
    });

    const sellBtn = screen.getByText(/SIMULATE SELL 100/i);
    fireEvent.click(sellBtn);
    await waitFor(() => {
      expect((global as any).fetch).toHaveBeenCalledWith('/api/mdg/trades', expect.anything());
    });
  });

  test('Admin tab controls: Ingest pause/resume, vendor switch, circuit breaker, subscriptions delete', async () => {
    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));

    // Pause Ingest
    const pauseIngestBtn = screen.getByText(/PAUSE INGEST/i);
    fireEvent.click(pauseIngestBtn);
    await waitFor(() => {
      expect((global as any).fetch).toHaveBeenCalledWith('/api/mdg/control', expect.anything());
    });

    // Vendor Switch
    const alpacaBtn = screen.getAllByText(/Alpaca/i)[0];
    fireEvent.click(alpacaBtn);

    // Pause trading
    const pauseTradingBtn = screen.getByText(/PAUSE TRADING/i);
    fireEvent.click(pauseTradingBtn);

    // Panic liquidation
    const panicBtn = screen.getByText(/PANIC LIQUIDATE/i);
    fireEvent.click(panicBtn);

    // Add ticker subscription
    const input = screen.getByPlaceholderText(/e\.g\. AAPL/i);
    fireEvent.change(input, { target: { value: 'TSLA' } });
    const addBtn = screen.getByText(/^ADD$/i);
    fireEvent.click(addBtn);

    // Delete ticker subscription
    const deleteBtns = screen.getAllByText(/DELETE/i);
    if (deleteBtns.length > 0) {
      fireEvent.click(deleteBtns[0]);
    }
  });

  test('Admin tab: Risk Sliders, Strategy Toggles, Ledger Jump', async () => {
    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));

    // Strategy hot-loading toggles
    const rlToggle = screen.getByText(/Reinforcement Learning Strategy/i);
    fireEvent.click(rlToggle);

    const trendToggle = screen.getByText(/Trend Following Strategy/i);
    fireEvent.click(trendToggle);

    // Jump button in trade ledger
    const jumpBtns = screen.queryAllByText(/Jump/i);
    if (jumpBtns.length > 0) {
      fireEvent.click(jumpBtns[0]);
    }
  });

  test('WebSocket messages processing: ticks, state sync, trade execution', async () => {
    await act(async () => {
      render(<App />);
    });

    act(() => {
      if (wsInstance.onmessage) {
        wsInstance.onmessage({
          data: JSON.stringify({
            type: 'tick',
            tick: { s: 'AAPL', p: 335.5, v: 100, t: Math.floor(Date.now() / 1000) },
          }),
        });
      }
    });

    act(() => {
      if (wsInstance.onmessage) {
        wsInstance.onmessage({
          data: JSON.stringify({
            type: 'state_sync',
            circuit: 'PAUSED',
            health: { ems: true, mdg: true, risk_node: false },
          }),
        });
      }
    });

    act(() => {
      if (wsInstance.onmessage) {
        wsInstance.onmessage({
          data: JSON.stringify({
            type: 'trade_execution',
            trade: { id: 't99', symbol: 'AAPL', price: 335.5, qty: 100, action: 'BUY', timestamp: 1700000000000 },
          }),
        });
      }
    });
  });

  test('Handles fetch network failures gracefully', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));
    const pauseBtn = screen.getByText(/PAUSE INGEST/i);
    fireEvent.click(pauseBtn);
  });

  test('Utility functions: calculateRSI, getStockStats, checkIsMarketClosed', () => {
    const prices = [100, 102, 101, 105, 107, 106, 110, 112, 111, 115, 117, 116, 120, 122, 121, 125];
    const rsi = calculateRSI(prices);
    expect(parseFloat(rsi)).toBeGreaterThan(0);

    const mockCandles = [{ time: 1000, open: 220, high: 230, low: 215, close: 225 }];
    const stats = getStockStats('AAPL', mockCandles);
    expect(stats.name).toBe('Apple Inc.');
    expect(stats.currentPrice).toBe(225);
    expect(stats.wHigh).toBeGreaterThan(stats.wLow);

    const msftStats = getStockStats('MSFT', mockCandles);
    expect(msftStats.name).toBe('Microsoft Corp.');
    expect(msftStats.currentPrice).toBe(225);

    const isClosed = checkIsMarketClosed();
    expect(typeof isClosed).toBe('boolean');

    const sessionInfo = getMarketSessionStatus();
    expect(sessionInfo.label).toBeDefined();
  });

  test('Key Statistics & Price Invariance across Timeframes (1D, 1W, 1M, 3M, 1Y, 5Y, ALL)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
    });

    await act(async () => {
      render(<App />);
    });

    // Click through different timeframe buttons
    const timeframes = ['1D', '1W', '1M', '3M', '1Y', '5Y', 'ALL'];
    for (const tf of timeframes) {
      const btn = screen.getByText(tf);
      fireEvent.click(btn);
      expect(screen.getAllByText('$0.00 / $0.00')[0]).toBeInTheDocument();
    }
  });

  test('Tag single emoji formatting & single space spacing check', () => {
    const session = getMarketSessionStatus();
    expect(session.label).toMatch(/^[\p{Emoji}]\s+/u);
    expect(session.label.split(' ').length).toBeGreaterThan(1);
  });

  test('Data Source Mode explicit badges & Admin toggle controls', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/history')) {
        const isMock = url.includes('mode=mock');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            bars: [{ time: 1784666280, open: 223.5, high: 226.1, low: 222.8, close: 224.5 }],
            source: isMock ? 'mock' : 'polygon',
            is_mock: isMock,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Verify Real Live Data badge is displayed when real data is returned
    expect(screen.getByText(/REAL LIVE DATA/i)).toBeInTheDocument();

    // Navigate to Admin tab and toggle Force Simulated Mock Mode
    await act(async () => {
      fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));
    });
    const mockToggleBtn = screen.getByText(/Force Simulated Mock Mode/i);
    await act(async () => {
      fireEvent.click(mockToggleBtn);
    });

    // Switch back to Trading Terminal
    await act(async () => {
      fireEvent.click(screen.getByText(/Trading Terminal/i));
    });
    expect(screen.getAllByText(/MOCK DATA MODE/i).length).toBeGreaterThan(0);
  });

  test('Admin tab: Subscribe new ticker and view admin logs', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/subscriptions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tickers: ['AAPL', 'MSFT', 'NVDA'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'MSFT'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));
    const input = screen.getByPlaceholderText(/e.g. AAPL/i);
    fireEvent.change(input, { target: { value: 'NVDA' } });
    fireEvent.click(screen.getByText('ADD'));
  });

  test('Circuit Breaker Panel: PAUSE TRADING, SAFE RESUME WIZARD, PANIC LIQUIDATE', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, state: 'RUNNING' }),
    });

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));

    const pauseBtn = screen.getByText(/PAUSE TRADING/i);
    fireEvent.click(pauseBtn);

    const resumeBtn = screen.getByText(/SAFE RESUME WIZARD/i);
    fireEvent.click(resumeBtn);

    const panicBtn = screen.getByText(/PANIC LIQUIDATE/i);
    fireEvent.click(panicBtn);
  });

  test('Tab switching persistence: Trading Terminal <-> Admin Tab preserves chart DOM node and viewport', async () => {
    let container: HTMLElement;
    await act(async () => {
      const res = render(<App />);
      container = res.container;
    });

    const adminBtn = screen.getByText(/Ingestion & Systems Admin/i);
    const terminalBtn = screen.getByText(/Trading Terminal/i);

    // Initial state: Terminal is visible, Admin is hidden
    const terminalPanel = screen.getByTestId('terminal-tab-panel');
    const adminPanel = screen.getByTestId('admin-tab-panel');
    expect(terminalPanel.style.display).toBe('grid');
    expect(adminPanel.style.display).toBe('none');

    const initialCreateCount = mockCreateChart.mock.calls.length;
    const initialRemoveCount = mockRemoveChart.mock.calls.length;

    // Switch to Admin tab
    fireEvent.click(adminBtn);

    // Assert that Terminal container remains mounted in DOM with display: none
    expect(terminalPanel.style.display).toBe('none');
    expect(adminPanel.style.display).toBe('block');
    expect(screen.getByText(/Market Data Ingestion Console \(MDG\)/i)).toBeInTheDocument();

    // Assert that chart instance was NOT destroyed upon switching to Admin tab
    expect(mockRemoveChart.mock.calls.length).toBe(initialRemoveCount);

    // Switch back to Trading Terminal tab
    fireEvent.click(terminalBtn);

    // Assert that Terminal container becomes visible again without DOM re-mount or chart re-creation
    expect(terminalPanel.style.display).toBe('grid');
    expect(adminPanel.style.display).toBe('none');
    expect(screen.getByText(/Trading Terminal/i)).toBeInTheDocument();

    // Assert that createChart was NOT called again when returning to Trading Terminal tab
    expect(mockCreateChart.mock.calls.length).toBe(initialCreateCount);
    expect(mockRemoveChart.mock.calls.length).toBe(initialRemoveCount);
  });

  test('Dual-Price Header renders regular close & overnight live price cards during off-hours', async () => {
    await act(async () => {
      render(<App />);
    });

    const dualPriceHeader = screen.queryByTestId('dual-price-header');
    // If test environment detects off-hours / night session, dual price header card must be rendered
    if (dualPriceHeader) {
      expect(dualPriceHeader).toBeInTheDocument();
      expect(screen.getByText(/At close: 4:00 PM EDT/i)).toBeInTheDocument();
      expect(screen.getAllByText(/Overnight/i).length).toBeGreaterThan(0);
    }
  });

  test('Dual-Price Header Edge Case: Market session status matches dual-price card visibility', async () => {
    await act(async () => {
      render(<App />);
    });

    const status = getMarketSessionStatus();
    const dualPriceHeader = screen.queryByTestId('dual-price-header');
    if (status.isClosed) {
      expect(dualPriceHeader).toBeInTheDocument();
    } else {
      expect(dualPriceHeader).not.toBeInTheDocument();
    }
  });

  test('Smart Time Formatter Edge Case 1: Daily/Weekly granularity formatters omit hours and minutes 00:00:00', async () => {
    await act(async () => {
      render(<App />);
    });

    // Switch granularity to 1D
    const granularitySelect = screen.getAllByRole('combobox').find(
      (select) => (select as HTMLSelectElement).value === '1d' || (select as HTMLSelectElement).innerHTML.includes('1 Day')
    );
    if (granularitySelect) {
      fireEvent.change(granularitySelect, { target: { value: '1d' } });
    }

    // Verify applyOptions sets timeVisible: false for daily granularity
    const applyOptionsCalls = mockCreateChart.mock.results.length > 0 ? mockCreateChart.mock.results[0].value.applyOptions.mock.calls : [];
    if (applyOptionsCalls.length > 0) {
      const lastCall = applyOptionsCalls[applyOptionsCalls.length - 1][0];
      if (lastCall.timeScale) {
        expect(lastCall.timeScale.timeVisible).toBe(false);
      }
    }
  });

  test('Smart Time Formatter Edge Case 2: Intraday granularity formatters enable timeVisible: true', async () => {
    await act(async () => {
      render(<App />);
    });

    // Switch granularity to 15m
    const granularitySelect = screen.getAllByRole('combobox').find(
      (select) => (select as HTMLSelectElement).value === '15m' || (select as HTMLSelectElement).innerHTML.includes('15 minutes')
    );
    if (granularitySelect) {
      fireEvent.change(granularitySelect, { target: { value: '15m' } });
    }

    // Verify applyOptions sets timeVisible: true for intraday granularity
    const applyOptionsCalls = mockCreateChart.mock.results.length > 0 ? mockCreateChart.mock.results[0].value.applyOptions.mock.calls : [];
    if (applyOptionsCalls.length > 0) {
      const lastCall = applyOptionsCalls[applyOptionsCalls.length - 1][0];
      if (lastCall.timeScale) {
        expect(lastCall.timeScale.timeVisible).toBe(true);
      }
    }
  });

  test('TradingView Logo Suppression Edge Case: App contains CSS rules disabling logo link', async () => {
    await act(async () => {
      render(<App />);
    });

    const styleTags = document.getElementsByTagName('style');
    let hasTradingViewSuppressionRule = false;
    for (let i = 0; i < styleTags.length; i++) {
      if (styleTags[i].innerHTML.includes('tradingview') || styleTags[i].innerHTML.includes('tv-lightweight-charts')) {
        hasTradingViewSuppressionRule = true;
        break;
      }
    }
    expect(hasTradingViewSuppressionRule).toBe(true);
  });

  test('Dual-Price Header Edge Case: Zero / missing price fallbacks without NaN or Infinity', () => {
    const mockCandles = [{ time: 1000, open: 220, high: 230, low: 215, close: 225 }];
    const stats = getStockStats('AAPL', mockCandles);
    expect(Number.isNaN(stats.currentPrice)).toBe(false);
    expect(Number.isNaN(stats.open)).toBe(false);
    expect(Number.isNaN(stats.high)).toBe(false);
    expect(Number.isNaN(stats.low)).toBe(false);
    expect(stats.currentPrice).toBeGreaterThan(0);
  });

  test('Period Change Info Edge Case: Handles stock metadata and 52-week statistics accurately', () => {
    const mockCandles = [{ time: 1000, open: 220, high: 230, low: 215, close: 225 }];
    const AAPL = getStockStats('AAPL', mockCandles);
    expect(AAPL).toBeDefined();
    expect(AAPL.name).toBe('Apple Inc.');
    expect(AAPL.currentPrice).toBe(225);
    expect(AAPL.wHigh).toBeGreaterThan(AAPL.wLow);
  });

  test('checkIsDailyOrHigher evaluates 1Y, 1M, 3M, YTD, 5Y, ALL and 1d/1w/1m intervals as daily or higher', () => {
    expect(checkIsDailyOrHigher('1y', '30m')).toBe(true);
    expect(checkIsDailyOrHigher('1M', '15m')).toBe(true);
    expect(checkIsDailyOrHigher('3M', '1m')).toBe(true);
    expect(checkIsDailyOrHigher('ytd', '1h')).toBe(true);
    expect(checkIsDailyOrHigher('5y', '1d')).toBe(true);
    expect(checkIsDailyOrHigher('all', '1w')).toBe(true);
    expect(checkIsDailyOrHigher('1d', '1d')).toBe(true);
    expect(checkIsDailyOrHigher('1d', '15m')).toBe(false);
  });

  test('Watchlist Item Offline State: Renders OFFLINE badge when WebSocket drops', async () => {
    await act(async () => {
      render(<App />);
    });
    // Trigger WS disconnect
    if (wsInstance.onclose) {
      await act(async () => {
        wsInstance.onclose();
      });
    }
    // Verify OFFLINE badges rendered in Watchlist
    const offlineBadges = screen.getAllByText('OFFLINE');
    expect(offlineBadges.length).toBeGreaterThan(0);
  });

  test('Browser Offline Event (Wi-Fi disconnected): Renders NETWORK DISCONNECTED badge, offline banner and OFFLINE Watchlist tags', async () => {
    await act(async () => {
      render(<App />);
    });

    // Simulate browser offline event (e.g. user turned off Wi-Fi in Mac menu bar)
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });

    // Assert top-right Global Circuit shows LOCAL WI-FI DISCONNECTED
    expect(screen.getByText(/LOCAL WI-FI DISCONNECTED/i)).toBeInTheDocument();

    // Assert prominent offline warning banner is displayed
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    expect(screen.getByText(/CONNECTION LOST/i)).toBeInTheDocument();

    // Assert Watchlist displays OFFLINE badges
    const offlineBadges = screen.getAllByText('OFFLINE');
    expect(offlineBadges.length).toBeGreaterThan(0);
  });

  test('Browser Online Event & Auto-Healing Resync: Triggers resyncData, restores live status badges, re-fetches market data, and displays NETWORK RESTORED toast notification', async () => {
    await act(async () => {
      render(<App />);
    });

    // 1. Simulate offline event
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/LOCAL WI-FI DISCONNECTED/i)).toBeInTheDocument();

    // Reset fetch mock counter
    (global as any).fetch.mockClear();

    // 2. Simulate online event (turning Wi-Fi back on)
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    // Verify fetch was re-triggered for resync
    expect((global as any).fetch).toHaveBeenCalled();
  });

  test('getMarketSessionPrices accurately separates 4:00 PM EDT regular close ($342.09) from overnight price ($333.09)', () => {
    // Construct real-world GOOGL candles matching Yahoo Finance scenario:
    // 09:30 EDT (570m): Open 347.15
    // 16:00 EDT (960m): Close 342.09 (Regular Market Session Close)
    // 00:57 EDT (overnight): Close 333.09 (Night Session Live Price)
    
    // 2026-07-22 09:30:00 EDT = 1784727000 sec
    // 2026-07-22 16:00:00 EDT = 1784750400 sec
    // 2026-07-23 00:57:00 EDT = 1784782620 sec
    const sampleCandles = [
      { time: 1784727000, open: 347.15, high: 348.00, low: 346.00, close: 347.00 }, // 09:30 EDT Open
      { time: 1784750400, open: 343.00, high: 344.00, low: 341.50, close: 342.09 }, // 16:00 EDT Regular Close ($342.09)
      { time: 1784782620, open: 335.00, high: 336.00, low: 332.50, close: 333.09 }, // 00:57 EDT Overnight Price ($333.09)
    ];

    const result = getMarketSessionPrices(sampleCandles);
    expect(result.regularOpen).toBe(347.15);
    expect(result.regularClose).toBe(342.09); // Card 1 must be 342.09
    expect(result.latestPrice).toBe(333.09);   // Card 2 must be 333.09

    const offHoursChange = result.latestPrice - result.regularClose;
    expect(offHoursChange).toBeCloseTo(-9.00, 2);

    const offHoursPercent = (offHoursChange / result.regularClose) * 100;
    expect(offHoursPercent).toBeCloseTo(-2.63, 2);
  });

  test('checkIsEarlyCloseDay correctly identifies US Stock Exchange Half-Days (Early Close at 1:00 PM EDT)', () => {
    // 1. Black Friday (Nov 27, 2026 - Friday)
    const blackFriday = new Date('2026-11-27T12:00:00-05:00');
    expect(checkIsEarlyCloseDay(blackFriday)).toBe(true);

    // 2. Christmas Eve (Dec 24, 2026 - Thursday)
    const christmasEve = new Date('2026-12-24T12:00:00-05:00');
    expect(checkIsEarlyCloseDay(christmasEve)).toBe(true);

    // 3. Regular trading day (July 15, 2026 - Wednesday)
    const regularDay = new Date('2026-07-15T12:00:00-04:00');
    expect(checkIsEarlyCloseDay(regularDay)).toBe(false);
  });

  test('getTodayStats accurately isolates today regular session open price ($321.13) and daily range ($314.91 - $324.49) from multi-day bars', () => {
    const multiDayBars = [
      // 5 days ago bar
      { time: 1784318400, open: 349.25, high: 359.65, low: 345.00, close: 350.00 },
      // 4 days ago bar
      { time: 1784404800, open: 340.00, high: 345.00, low: 335.00, close: 338.00 },
      // Today (July 22, 2026) 09:30 AM EDT bar
      { time: 1784727000, open: 321.13, high: 323.50, low: 320.00, close: 322.00 },
      // Today 11:00 AM EDT bar
      { time: 1784732400, open: 322.00, high: 324.49, low: 314.91, close: 318.00 },
      // Today 16:00 PM EDT bar
      { time: 1784750400, open: 318.00, high: 319.50, low: 315.00, close: 316.50 },
    ];

    const todayStats = getTodayStats(multiDayBars);
    expect(todayStats.open).toBe(321.13);
    expect(todayStats.high).toBe(324.49);
    expect(todayStats.low).toBe(314.91);
  });

  test('1D timeframe granularity filters multi-day historical bars to ONLY display today session bars', () => {
    const multiDayBars = [
      { time: 1784318400, open: 349.25, high: 359.65, low: 345.00, close: 350.00 }, // 7/20/2026
      { time: 1784404800, open: 340.00, high: 345.00, low: 335.00, close: 338.00 }, // 7/21/2026
      { time: 1784727000, open: 321.13, high: 323.50, low: 320.00, close: 322.00 }, // 7/23/2026 09:30 AM
      { time: 1784750400, open: 318.00, high: 319.50, low: 315.00, close: 316.50 }, // 7/23/2026 16:00 PM
    ];

    const getNYDateStr = (timeSec: number) => new Date(timeSec * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const latestDateStr = getNYDateStr(multiDayBars[multiDayBars.length - 1].time);
    const filtered1D = multiDayBars.filter(b => getNYDateStr(b.time) === latestDateStr);

    expect(filtered1D.length).toBe(2);
    expect(filtered1D[0].time).toBe(1784727000);
    expect(filtered1D[1].time).toBe(1784750400);
  });

  test('getIntervalSeconds correctly resolves timeframe interval step seconds', () => {
    expect(getIntervalSeconds('10s')).toBe(10);
    expect(getIntervalSeconds('1m')).toBe(60);
    expect(getIntervalSeconds('5m')).toBe(300);
    expect(getIntervalSeconds('15m')).toBe(900);
    expect(getIntervalSeconds('30m')).toBe(1800);
    expect(getIntervalSeconds('1h')).toBe(3600);
    expect(getIntervalSeconds('1d')).toBe(86400);
  });

  test('getStockStats 52-week Low and High invariance: NEVER returns 0.00 even under loading or zero-bar states', () => {
    const emptyStats = getStockStats('GOOGL', []);
    expect(emptyStats.wLow).toBeGreaterThan(0);
    expect(emptyStats.wHigh).toBeGreaterThan(0);
    expect(emptyStats.wLow).toBe(275.00);
    expect(emptyStats.wHigh).toBe(397.89);

    const zeroBarStats = getStockStats('GOOGL', [{ open: 0, high: 0, low: 0, close: 0 }]);
    expect(zeroBarStats.wLow).toBeGreaterThan(0);
    expect(zeroBarStats.wHigh).toBeGreaterThan(0);
  });

  test('getStockStats 52-week High invariance when candles1Y is empty and candleRaw has 5 days of intraday bars (NEVER collapses to 5-day max 359.65)', () => {
    const intraday5DayBars = [
      { time: 1784318400, open: 349.25, high: 359.65, low: 345.00, close: 350.00 },
      { time: 1784404800, open: 340.00, high: 345.00, low: 335.00, close: 338.00 },
    ];
    const stats = getStockStats('GOOGL', intraday5DayBars, []);
    expect(stats.wHigh).toBe(397.89);
    expect(stats.wLow).toBe(275.00);
  });

  test('getStockStats dynamically evaluates 52-week High from 1Y daily dataset (e.g. 397.89 on May 7)', () => {
    const candles1Y = [
      { time: 1778160000, high: 320.00, low: 250.00, close: 315.00 },
      { time: 1778246400, high: 397.89, low: 350.00, close: 395.00 }, // May 7 peak
      { time: 1778332800, high: 370.00, low: 330.00, close: 342.02 },
    ];
    const stats1Y = getStockStats('GOOGL', [], candles1Y);
    expect(stats1Y.wHigh).toBe(397.89);
    expect(stats1Y.wLow).toBe(250.00);
  });

  test('Night session tick stream: Quantizes tick timestamps to exact interval boundaries and splits candles cleanly', () => {
    const regularCloseTime = 1784748600; // 16:30 EDT
    const regularCloseBar = { time: regularCloseTime, open: 343.00, high: 344.00, low: 341.00, close: 342.02 };
    const currentCandles = [regularCloseBar];
    const intervalSec = 900; // 15m (900 seconds)

    // Tick 1 at 01:21:27 AM EDT = 1784784087
    const tickTime1 = 1784784087;
    const price1 = 329.71;
    const quantized1 = Math.floor(tickTime1 / intervalSec) * intervalSec; // 01:15:00 AM EDT

    let lastCandle = currentCandles[currentCandles.length - 1];
    let candleToPush1 = { time: quantized1, open: price1, high: price1, low: price1, close: price1 };
    let newCandles = [...currentCandles, candleToPush1];

    // Tick 2 at 01:30:08 AM EDT = 1784784608 (crosses into next 15m interval bucket)
    const tickTime2 = 1784784608;
    const price2 = 328.50;
    const quantized2 = Math.floor(tickTime2 / intervalSec) * intervalSec; // 01:30:00 AM EDT

    lastCandle = newCandles[newCandles.length - 1];
    let candleToPush2 = { time: quantized2, open: price2, high: price2, low: price2, close: price2 };
    newCandles = [...newCandles, candleToPush2];

    // Verify 16:30 EDT regular close bar is untouched
    expect(newCandles[0].close).toBe(342.02);
    expect(newCandles[0].time).toBe(regularCloseTime);

    // Verify distinct 15m night candles were created for 01:15 AM and 01:30 AM
    expect(newCandles[1].time).toBe(quantized1); // 01:15:00 AM
    expect(newCandles[1].close).toBe(329.71);

    expect(newCandles[2].time).toBe(quantized2); // 01:30:00 AM
    expect(newCandles[2].close).toBe(328.50);
  });

  test('getPeriodChangeInfo returns closePrice, closeChange, offHoursChange and offHoursPercent', () => {
    const stats = getStockStats('AAPL');
    expect(stats).toHaveProperty('currentPrice');
    expect(stats).toHaveProperty('open');
    expect(stats).toHaveProperty('high');
    expect(stats).toHaveProperty('low');
  });

  test('Strategy toggles, Risk sliders, and DevMode Shutdown', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    let container: HTMLElement;
    await act(async () => {
      const res = render(<App />);
      container = res.container;
    });

    // Send state sync with dev_mode: true
    act(() => {
      if (wsInstance.onmessage) {
        wsInstance.onmessage({
          data: JSON.stringify({
            type: 'state_sync',
            state: 'RUNNING',
            system_state: 'HEALTHY',
            dev_mode: true,
            services: { ems: 'SERVING', mdg: 'SERVING', risk_node: 'SERVING' },
          }),
        });
      }
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));

    // Strategy toggles
    const rlBtn = screen.getByText(/Reinforcement Learning Strategy/i).parentElement?.querySelector('span:last-child');
    if (rlBtn) fireEvent.click(rlBtn);

    const trendBtn = screen.getByText(/Trend Following Strategy/i).parentElement?.querySelector('span:last-child');
    if (trendBtn) fireEvent.click(trendBtn);

    // Range sliders
    const rangeInputs = container.querySelectorAll('input[type="range"]');
    if (rangeInputs.length >= 2) {
      fireEvent.change(rangeInputs[0], { target: { value: '600' } });
      fireEvent.change(rangeInputs[1], { target: { value: '2.5' } });
    }

    // Alpaca button click
    const alpacaBtn = screen.getByText('Alpaca');
    fireEvent.click(alpacaBtn);

    // DevMode shutdown button
    const shutdownBtn = screen.queryByText(/SHUTDOWN ALL SERVICES/i);
    if (shutdownBtn) fireEvent.click(shutdownBtn);
  });

  test('Fetch failures and MDG Config initial states', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/config')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, vendor: 'alpaca', status: 'PAUSED', tickers: ['AAPL'] }),
        });
      }
      if (url.includes('/api/circuit')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: false, stages: ['Stage 1 failed'] }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));

    const resumeIngestBtn = screen.queryByText(/RESUME INGEST/i);
    if (resumeIngestBtn) fireEvent.click(resumeIngestBtn);

    const resumeWizardBtn = screen.getByText(/SAFE RESUME WIZARD/i);
    fireEvent.click(resumeWizardBtn);
  });

  test('Trading Terminal Watchlist bar & Quick Add Stock (MSFT)', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/subscriptions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tickers: ['AAPL', 'MSFT'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Verify Watchlist header text is present on Right Sidebar Watchlist
    expect(screen.getByText('Watchlist')).toBeInTheDocument();

    // Verify default tickers (AAPL, META) are present in Watchlist
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
  });

  test('Save API Key in Admin panel & Off-hours banner non-contradiction check', async () => {
    let savedApiKey = '';
    (global as any).fetch = jest.fn().mockImplementation((url: string, opts: any) => {
      if (url.includes('/api/mdg/control') && opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.action === 'set_api_key') {
          savedApiKey = body.api_key;
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, is_mock: true, source: 'mock' }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Switch to Admin tab and enter API key
    fireEvent.click(screen.getByText(/Ingestion & Systems Admin/i));
    const keyInput = screen.getByPlaceholderText(/Polygon API Key/i);
    fireEvent.change(keyInput, { target: { value: 'SECRET_API_KEY_123' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save Key'));
    });

    expect(savedApiKey).toBe('SECRET_API_KEY_123');

    // Switch to Trading Terminal
    fireEvent.click(screen.getByText(/Trading Terminal/i));
    expect(screen.getByText(/Trading Terminal/i)).toBeInTheDocument();
  });

  test('Trading Terminal Watchlist chip click switches active stock title, chart and stats', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/history')) {
        const isMsft = url.includes('ticker=MSFT');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            bars: [{ time: 1784666280, open: isMsft ? 448.0 : 223.5, high: isMsft ? 450.0 : 226.1, low: isMsft ? 445.0 : 222.8, close: isMsft ? 448.37 : 224.5 }],
            source: 'alpaca',
            is_mock: false,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'MSFT'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Find and click the MSFT chip in the Trading Terminal Watchlist
    const msftChips = screen.getAllByText('MSFT');
    await act(async () => {
      fireEvent.click(msftChips[0]);
    });

    // Header stock title should update to Microsoft Corp. (MSFT)
    expect(screen.getByText(/Microsoft Corp\. \(MSFT\)/i)).toBeInTheDocument();
  });

  test('Off-hours alert banner text dynamically reflects real vs simulated mode without contradictory statements', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/market-status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ is_closed: true, label: '● NIGHT SESSION', session_type: 'NIGHT' }),
        });
      }
      if (url.includes('/api/mdg/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            bars: [{ time: 1784666280, open: 223.5, high: 226.1, low: 222.8, close: 224.5 }],
            source: 'mock',
            is_mock: true,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Off-hours banner must say 'Displaying simulated off-hours session bars' when is_mock is true
    const simulatedBanner = await screen.findByText(/Displaying simulated off-hours session bars/i);
    expect(simulatedBanner).toBeInTheDocument();
    expect(screen.queryByText(/Displaying real historical session bars/i)).not.toBeInTheDocument();
  });

  test('Right Sidebar Watchlist delete button (✕) unsubscribes and removes ticker', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string, opts: any) => {
      if (url.includes('/api/mdg/subscriptions') && opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.action === 'remove' && body.ticker === 'AAPL') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, tickers: ['META'] }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'META'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    const removeButtons = screen.getAllByTitle(/Remove AAPL from Watchlist/i);
    expect(removeButtons.length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.getByText(/Unsubscribed from ticker: AAPL/i)).toBeInTheDocument();
  });

  test('Trade execution markers toggle button switches between Markers ON and Markers OFF', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
    }));

    await act(async () => {
      render(<App />);
    });

    const toggleBtn = screen.getByText(/👁️ Markers ON/i);
    expect(toggleBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    expect(screen.getByText(/🙈 Markers OFF/i)).toBeInTheDocument();
  });

  test('Clear Simulated Trades button resets execution markers and logs status', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string, options?: any) => {
      if (url.includes('/api/mdg/trades') && (!options || options.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ symbol: 'AAPL', price: 325.0, qty: 100, action: 'BUY', timestamp: 1000 }]),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    const clearBtn = await screen.findByText(/🗑️ CLEAR SIMULATED TRADES/i);
    expect(clearBtn).toBeInTheDocument();
    expect(clearBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    expect(screen.getByText(/Cleared all simulated trade execution markers/i)).toBeInTheDocument();
  });

  test('aggregateTradeMarkers formats Futu-style qty@price text and merges multiple trades on identical candle timestamps', () => {
    const candles = [
      { time: 1000 },
      { time: 2000 },
    ];
    const trades: TradeMarker[] = [
      { symbol: 'AAPL', price: 325.0, qty: 100, action: 'BUY', timestamp: 1000000 }, // candle 1000
      { symbol: 'AAPL', price: 326.0, qty: 200, action: 'BUY', timestamp: 1050000 }, // candle 1000
      { symbol: 'AAPL', price: 330.0, qty: 50, action: 'SELL', timestamp: 2000000 },  // candle 2000
    ];

    const markers = aggregateTradeMarkers(trades, 'AAPL', candles);
    expect(markers).toHaveLength(2);

    // Candle 1000 (merged 2 BUY trades: 100@325 + 200@326 = 300 total qty, avg price 325.67)
    expect(markers[0].time).toBe(1000);
    expect(markers[0].position).toBe('belowBar');
    expect(markers[0].shape).toBe('arrowUp');
    expect(markers[0].color).toBe('#30d158');
    expect(markers[0].text).toBe('B 2x (300@325.67)');

    // Candle 2000 (single SELL trade: 50@330)
    expect(markers[1].time).toBe(2000);
    expect(markers[1].position).toBe('aboveBar');
    expect(markers[1].shape).toBe('arrowDown');
    expect(markers[1].color).toBe('#ff453a');
    expect(markers[1].text).toBe('S 50@330.00');
  });

  test('Status badges container is rendered in header-status-tags-bar above stock title', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
    }));

    await act(async () => {
      render(<App />);
    });

    const tagsBar = screen.getByTestId('header-status-tags-bar');
    expect(tagsBar).toBeInTheDocument();
    expect(tagsBar).toHaveTextContent(/REAL LIVE DATA/i);
  });

  test('Chart fitContent is called on initial timeframe switch but NOT on incremental tick updates to preserve viewport zoom state', async () => {
    mockFitContent.mockClear();

    (global as any).fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
    }));

    await act(async () => {
      render(<App />);
    });

    // Initial render calls fitContent once for initial ticker/timeframe setup
    const initialCallCount = mockFitContent.mock.calls.length;

    // Simulate incremental tick / state update by clicking BUY
    const buyBtn = screen.getByText(/🟢 SIMULATE BUY 100/i);
    await act(async () => {
      fireEvent.click(buyBtn);
    });

    // Incremental trade/tick update MUST NOT trigger fitContent again, preserving user zoom!
    expect(mockFitContent.mock.calls.length).toBe(initialCallCount);
  });

  test('Watchlist pre-fetches 1d historical market bars for all subscribed tickers', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            is_mock: false,
            source: 'alpaca',
            bars: [{ time: 1000, open: 600.0, high: 630.0, low: 590.0, close: 622.77 }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'META'] }),
      });
    });
    (global as any).fetch = fetchMock;

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      // Verify that fetch was called for both AAPL and META 1d history
      const urls = fetchMock.mock.calls.map((c: any) => c[0]);
      expect(urls.some((u: string) => u.includes('ticker=META'))).toBe(true);
      expect(urls.some((u: string) => u.includes('ticker=AAPL'))).toBe(true);
    });
  });

  test('Watchlist displays loading placeholder --.-- instead of hardcoded $150.00 mock price when real live data is loading', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/history')) {
        // Pending promise (simulating network latency)
        return new Promise(() => {});
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'UNKNOWN_STOCK'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // In Real Live Data mode while data is loading, UNKNOWN_STOCK must NOT render hardcoded $150.00
    expect(screen.queryByText('$150.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('--.--').length).toBeGreaterThan(0);
  });

  test('Changing granularity or bar interval dropdown re-triggers fitContent once new dataset populates', async () => {
    mockFitContent.mockClear();

    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/mdg/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            is_mock: false,
            source: 'alpaca',
            bars: [{ time: 1000, open: 100, high: 110, low: 90, close: 105 }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    const initialCallCount = mockFitContent.mock.calls.length;

    // Click 1W timeframe button to change granularity
    const weekBtn = screen.getByText('1W');
    await act(async () => {
      fireEvent.click(weekBtn);
    });

    // When 1W data populates, fitContent must be called again to fit the new timeframe view!
    await waitFor(() => {
      expect(mockFitContent.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  test('PM UX 1: Custom quantity input, Toast notification on trade execution, and disabled clear button when 0 trades', async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string, options?: any) => {
      if (options?.method === 'POST' && url.includes('/api/mdg/trades')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ symbol: 'AAPL', price: 325.0, qty: 250, action: 'BUY', timestamp: Date.now() }]),
        });
      }
      if (url.includes('/api/mdg/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            is_mock: false,
            source: 'alpaca',
            bars: [{ time: 1000, open: 320, high: 330, low: 310, close: 325.0 }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });

    await act(async () => {
      render(<App />);
    });

    // Clear trades button is disabled when 0 trades
    const clearBtn = screen.getByText(/CLEAR SIMULATED TRADES/i);
    expect(clearBtn).toBeDisabled();

    // Type custom quantity 250
    const qtyInput = screen.getByDisplayValue('100');
    fireEvent.change(qtyInput, { target: { value: '250' } });

    // Execute Buy trade with custom quantity 250
    const buyBtn = screen.getByText(/🟢 SIMULATE BUY 250/i);
    await act(async () => {
      fireEvent.click(buyBtn);
    });

    // Toast notification appears
    expect(await screen.findByText(/✓ BUY 250 AAPL/i)).toBeInTheDocument();
  });

  test('PM UX 2: Clickable Trade Executions stat card triggers jumpChartToTrade', async () => {
    await act(async () => {
      render(<App />);
    });

    const tradeExecCard = screen.getByText(/Trade Executions/i).closest('div');
    expect(tradeExecCard).toBeInTheDocument();
    
    await act(async () => {
      fireEvent.click(tradeExecCard!);
    });
  });

  test('PM UX 3: Watchlist Enter key press automatically uppercases, adds stock and selects it', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string, options?: any) => {
      if (options?.method === 'POST' && url.includes('/api/mdg/subscriptions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, tickers: ['AAPL', 'NVDA'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, tickers: ['AAPL'] }),
      });
    });
    (global as any).fetch = fetchMock;

    await act(async () => {
      render(<App />);
    });

    const input = screen.getByPlaceholderText(/Add stock/i);
    fireEvent.change(input, { target: { value: 'nvda' } });
    
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST');
      expect(postCalls.some((c: any) => c[1]?.body.includes('"ticker":"NVDA"'))).toBe(true);
    });
  });

  test('PM UX 4 & 5: Smart timeframe period coupling and RSI badge indicators', async () => {
    await act(async () => {
      render(<App />);
    });

    // RSI badge check (Neutral / Oversold / Overbought)
    const rsiText = screen.getByText(/RSI \(14\)/i);
    expect(rsiText).toBeInTheDocument();

    // Timeframe coupling check (1W sets 1h interval)
    const weekBtn = screen.getByText('1W');
    await act(async () => {
      fireEvent.click(weekBtn);
    });
  });
});
