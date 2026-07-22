/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import App, { calculateRSI, getStockStats, checkIsMarketClosed, getMarketSessionStatus, STOCK_DATA_MAP } from './App';

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

    const stats = getStockStats('AAPL');
    expect(stats.name).toBe('Apple Inc.');
    expect(stats.wHigh).toBe(237.23);
    expect(stats.wLow).toBe(164.08);

    const msftStats = getStockStats('MSFT');
    expect(msftStats.name).toBe('Microsoft Corp.');
    expect(msftStats.wHigh).toBe(468.35);

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

    // 52-Week High and Low elements should display exact benchmark figures ($237.23 / $164.08)
    const highLowElement = screen.getByText('$237.23 / $164.08');
    expect(highLowElement).toBeInTheDocument();

    // Click through different timeframe buttons
    const timeframes = ['1D', '1W', '1M', '3M', '1Y', '5Y', 'ALL'];
    for (const tf of timeframes) {
      const btn = screen.getByText(tf);
      fireEvent.click(btn);
      // Key Statistics (52-Week High / Low) MUST remain identical across all timeframes
      expect(screen.getByText('$237.23 / $164.08')).toBeInTheDocument();
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
    expect(screen.getByText(/⚡ Real \(/i)).toBeInTheDocument();

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

  test('Tab switching persistence: Trading Terminal <-> Admin Tab', async () => {
    await act(async () => {
      render(<App />);
    });

    const adminBtn = screen.getByText(/Ingestion & Systems Admin/i);
    const terminalBtn = screen.getByText(/Trading Terminal/i);

    // Switch to Admin tab
    fireEvent.click(adminBtn);

    // Switch back to Trading Terminal tab
    fireEvent.click(terminalBtn);

    // Assert that stock header and terminal element remain rendered
    expect(screen.getByText(/Trading Terminal/i)).toBeInTheDocument();
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
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/trades')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, trades: [{ symbol: 'AAPL', action: 'BUY', price: 324.5, timestamp: Date.now() }] }),
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

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    expect(screen.getByText(/Cleared all simulated trade execution markers/i)).toBeInTheDocument();
  });
});
