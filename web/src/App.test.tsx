/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import App, { calculateRSI, getStockStats, checkIsMarketClosed } from './App';

// Mock lightweight-charts
jest.mock('lightweight-charts', () => ({
  createChart: jest.fn(() => ({
    addSeries: jest.fn(() => ({
      setData: jest.fn(),
      update: jest.fn(),
      setMarkers: jest.fn(),
    })),
    applyOptions: jest.fn(),
    timeScale: jest.fn(() => ({
      setVisibleRange: jest.fn(),
    })),
    remove: jest.fn(),
  })),
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

    (global as any).WebSocket = jest.fn().mockImplementation(() => wsInstance);

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
    const polygonBtn = screen.getByText(/Polygon.io/i);
    fireEvent.click(polygonBtn);

    const alpacaBtn = screen.getByText(/Alpaca/i);
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

    const stats = getStockStats('AAPL', [{ open: 300, high: 350, low: 290, close: 340 }]);
    expect(stats.name).toBe('Apple');

    const msftStats = getStockStats('MSFT', []);
    expect(msftStats.name).toBe('Microsoft');

    const isClosed = checkIsMarketClosed();
    expect(typeof isClosed).toBe('boolean');
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
});
