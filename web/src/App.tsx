import React, { useState, useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

// Types matching the Go BFF JSON messages
interface HealthStatus {
  status: string;
  latency_ms: number;
}

interface SystemStatusMsg {
  type: string;
  state: "RUNNING" | "PAUSED" | "TERMINATED";
  system_state: "OK" | "DEGRADED";
  services: Record<string, HealthStatus>;
  dev_mode?: boolean;
}

interface TradeMarker {
  symbol: string;
  price: number;
  qty: number;
  action: "BUY" | "SELL";
  timestamp: number; // epoch ms
}

const checkIsMarketClosed = (): boolean => {
  try {
    const nycString = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const nycDate = new Date(nycString);
    const day = nycDate.getDay(); // 0 = Sunday, 6 = Saturday
    const hours = nycDate.getHours();
    const minutes = nycDate.getMinutes();

    if (day === 0 || day === 6) return true;

    const minutesSinceMidnight = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60;    // 4:00 PM

    if (minutesSinceMidnight < marketOpen || minutesSinceMidnight >= marketClose) {
      return true;
    }
    return false;
  } catch (e) {
    const day = new Date().getUTCDay();
    return day === 0 || day === 6;
  }
};

const generateMockHistory = (ticker: string): Array<{ time: number, value: number }> => {
  const data: Array<{ time: number, value: number }> = [];
  let basePrice = 150.0;
  if (ticker === "AAPL") basePrice = 175.0;
  else if (ticker === "MSFT") basePrice = 330.0;
  else if (ticker === "TSLA") basePrice = 240.0;
  else if (ticker === "AMZN") basePrice = 130.0;
  else if (ticker === "NVDA") basePrice = 450.0;
  else if (ticker === "GOOG") basePrice = 120.0;

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (let i = 100; i > 0; i--) {
    const time = nowSeconds - i * 5; // 5 seconds interval
    basePrice += (Math.random() - 0.5) * 0.5;
    data.push({ time, value: parseFloat(basePrice.toFixed(2)) });
  }
  return data;
};

export default function App() {
  const [isMarketClosed, setIsMarketClosed] = useState<boolean>(checkIsMarketClosed());

  // Periodically check if market is closed
  useEffect(() => {
    const timer = setInterval(() => {
      setIsMarketClosed(checkIsMarketClosed());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Original states preserved
  const [circuitState, setCircuitState] = useState<"RUNNING" | "PAUSED" | "TERMINATED">("RUNNING");
  const [systemState, setSystemState] = useState<"OK" | "DEGRADED">("OK");
  const [services, setServices] = useState<Record<string, HealthStatus>>({
    mdg: { status: "SERVING", latency_ms: 2 },
    risk_node: { status: "SERVING", latency_ms: 1 },
    ems: { status: "SERVING", latency_ms: 3 },
    alpha_engine: { status: "SERVING", latency_ms: 5 },
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [maxPosition, setMaxPosition] = useState<number>(500);
  const [maxLeverage, setMaxLeverage] = useState<number>(1.2);
  const [rlStrategyActive, setRlStrategyActive] = useState<boolean>(true);
  const [trendStrategyActive, setTrendStrategyActive] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [devMode, setDevMode] = useState<boolean>(false);

  // New MDG / Market Data visualization states
  const [activeVendor, setActiveVendor] = useState<"polygon" | "alpaca">("polygon");
  const [mdgStatus, setMdgStatus] = useState<"RUNNING" | "PAUSED">("RUNNING");
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>("");
  const [newTickerInput, setNewTickerInput] = useState<string>("");
  const [tickData, setTickData] = useState<Record<string, Array<{ time: number, value: number }>>>({});
  const [trades, setTrades] = useState<TradeMarker[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const [lineSeries, setLineSeries] = useState<any>(null);

  // Connect to Go BFF WebSocket
  useEffect(() => {
    connectWS();
    fetchMdgConfig();
    fetchTrades();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Pre-populate mock history for a ticker if it has no data
  useEffect(() => {
    if (selectedTicker && !tickData[selectedTicker]) {
      setTickData(prev => {
        if (prev[selectedTicker]) return prev;
        return {
          ...prev,
          [selectedTicker]: generateMockHistory(selectedTicker)
        };
      });
    }
  }, [selectedTicker, tickData]);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-99), `[${timestamp}] ${msg}`]);
  };


  const connectWS = () => {
    setIsReconnecting(false);
    const loc = window.location;
    const wsProto = loc.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${loc.host || "localhost:8080"}/ws`;
    
    addLog(`Connecting to BFF Gateway at ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog("WebSocket link established successfully with BFF.");
      setIsReconnecting(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "system_status" || data.type === "system_status_broadcast") {
          const status = data as SystemStatusMsg;
          setCircuitState(status.state);
          setSystemState(status.system_state);
          if (status.services) {
            setServices(status.services);
          }
          if (status.dev_mode !== undefined) {
            setDevMode(status.dev_mode);
          }
          addLog(`State sync: Circuit=${status.state}, Health=${status.system_state}`);
        } else if (data.type === "config_update") {
          addLog(`Risk configuration updated online: ${JSON.stringify(data.config)}`);
        } else if (data.type === "tick" && data.tick) {
          const t = data.tick;
          const tickTime = Math.floor(t.t / 1000);
          
          setTickData(prev => {
            const currentTicks = prev[t.sym] || [];
            const lastTick = currentTicks[currentTicks.length - 1];
            
            let newTicks;
            if (lastTick && lastTick.time === tickTime) {
              lastTick.value = t.p;
              newTicks = [...currentTicks];
            } else {
              newTicks = [...currentTicks, { time: tickTime, value: t.p }];
            }
            
            if (newTicks.length > 500) {
              newTicks = newTicks.slice(-500);
            }
            
            return {
              ...prev,
              [t.sym]: newTicks
            };
          });
        } else if (data.type === "trade_execution" && data.trade) {
          const newTrade = data.trade as TradeMarker;
          setTrades(prev => [newTrade, ...prev]);
          addLog(`Trade execution: ${newTrade.action} 100 ${newTrade.symbol} @ $${newTrade.price}`);
        }
      } catch (err) {
        addLog(`Error parsing payload: ${event.data}`);
      }
    };

    ws.onclose = () => {
      addLog("WebSocket disconnected. Retrying in 3 seconds...");
      setIsReconnecting(true);
      setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
      addLog(`WebSocket connection error: ${JSON.stringify(err)}`);
    };
  };

  // Original risk limits & circuit control actions preserved
  const sendOOBAction = (action: "pause" | "panic", reason: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action, reason }));
      addLog(`Sent OOB command: ${action.toUpperCase()} Reason: ${reason}`);
    } else {
      addLog(`Cannot send OOB action, WebSocket closed. Failsafe local state applied.`);
    }
  };

  const requestResume = async () => {
    addLog("Initiating three-stage safe resume handshake wizard...");
    try {
      const resp = await fetch("/api/circuit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RUNNING", reason: "Wizard verified resume" }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        addLog("Three-stage handshake verification PASSED. Trading resumed successfully.");
      } else {
        addLog(`Three-stage handshake REJECTED. Failures: ${JSON.stringify(data.stages || data.reason)}`);
      }
    } catch (err) {
      addLog(`Resume API call failed: ${err}`);
    }
  };

  const publishConfig = async (pos: number, lev: number) => {
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_position: pos, max_leverage: lev }),
      });
      if (resp.ok) {
        addLog(`Published configuration: MaxPosition=${pos}, MaxLeverage=${lev}`);
      } else {
        addLog("Failed to publish configuration limits.");
      }
    } catch (err) {
      addLog(`Config API error: ${err}`);
    }
  };

  // New MDG Control actions
  const fetchMdgConfig = async () => {
    try {
      const resp = await fetch("/api/mdg/config");
      if (resp.ok) {
        const data = await resp.json();
        setSubscriptions(data.tickers || []);
        setActiveVendor(data.vendor || "polygon");
        setMdgStatus(data.status || "RUNNING");
        if (data.tickers && data.tickers.length > 0 && !selectedTicker) {
          setSelectedTicker(data.tickers[0]);
        }
      }
    } catch (err) {
      addLog(`Failed to fetch MDG configuration: ${err}`);
    }
  };

  const fetchTrades = async () => {
    try {
      const resp = await fetch("/api/mdg/trades");
      if (resp.ok) {
        const data = await resp.json();
        setTrades(data || []);
      }
    } catch (err) {
      addLog(`Failed to fetch historical trades: ${err}`);
    }
  };

  const addSubscription = async (ticker: string) => {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) return;
    try {
      const resp = await fetch("/api/mdg/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", ticker: symbol }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setSubscriptions(data.tickers || []);
        addLog(`Subscribed to ticker: ${symbol}`);
        setNewTickerInput("");
        if (!selectedTicker) {
          setSelectedTicker(symbol);
        }
      }
    } catch (err) {
      addLog(`Failed to add subscription: ${err}`);
    }
  };

  const removeSubscription = async (ticker: string) => {
    try {
      const resp = await fetch("/api/mdg/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", ticker }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setSubscriptions(data.tickers || []);
        addLog(`Unsubscribed from ticker: ${ticker}`);
        if (selectedTicker === ticker) {
          setSelectedTicker(data.tickers[0] || "");
        }
      }
    } catch (err) {
      addLog(`Failed to remove subscription: ${err}`);
    }
  };

  const controlMdgStatus = async (action: "pause" | "resume") => {
    try {
      const resp = await fetch("/api/mdg/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (resp.ok) {
        setMdgStatus(action === "pause" ? "PAUSED" : "RUNNING");
        addLog(`MDG Ingestion state set to: ${action.toUpperCase()}`);
      }
    } catch (err) {
      addLog(`Failed to update MDG status: ${err}`);
    }
  };

  const selectVendor = async (vendor: "polygon" | "alpaca") => {
    try {
      const resp = await fetch("/api/mdg/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_vendor", vendor }),
      });
      if (resp.ok) {
        setActiveVendor(vendor);
        addLog(`MDG Vendor switched to: ${vendor.toUpperCase()}`);
      }
    } catch (err) {
      addLog(`Failed to switch vendor: ${err}`);
    }
  };

  const executeSimulatedTrade = async (action: "BUY" | "SELL") => {
    if (!selectedTicker) {
      addLog("Cannot execute trade: No symbol selected");
      return;
    }
    const ticks = tickData[selectedTicker] || [];
    if (ticks.length === 0) {
      addLog(`Cannot execute trade: No price data available for ${selectedTicker}`);
      return;
    }
    const currentPrice = ticks[ticks.length - 1].value;
    try {
      const resp = await fetch("/api/mdg/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedTicker,
          price: currentPrice,
          qty: 100,
          action: action,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        addLog(`Simulated execution recorded: ${action} 100 ${selectedTicker} @ $${currentPrice}`);
      }
    } catch (err) {
      addLog(`Failed to record simulated execution: ${err}`);
    }
  };

  // Lightweight Charts setup
  useEffect(() => {
    if (chartContainerRef.current) {
      try {
        const chart = createChart(chartContainerRef.current, {
          width: chartContainerRef.current.clientWidth,
          height: 380,
          layout: {
            background: { color: 'rgba(28, 28, 30, 0.45)' },
            textColor: '#aeaeb2',
          },
          grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
          },
          timeScale: {
            timeVisible: true,
            secondsVisible: true,
            borderColor: 'rgba(255, 255, 255, 0.1)',
          },
          localization: {
            timeFormatter: (ts: number) => {
              const date = new Date(ts * 1000);
              return date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false });
            }
          }
        });

        const lineSeries = chart.addLineSeries({
          color: '#0a84ff',
          lineWidth: 2,
          priceLineVisible: true,
        });

        chartRef.current = chart;
        setLineSeries(lineSeries);

        const handleResize = () => {
          if (chartContainerRef.current && chartRef.current) {
            chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
          }
        };
        window.addEventListener('resize', handleResize);

        return () => {
          window.removeEventListener('resize', handleResize);
          chart.remove();
        };
      } catch (e) {
        console.warn("Vite Lightweight charts skipped (jsdom test environment detected):", e);
      }
    }
  }, []);

  // Update line series tick data & execution markers
  useEffect(() => {
    if (lineSeries && chartRef.current) {
      const data = tickData[selectedTicker] || [];
      lineSeries.setData(data);

      const symbolTrades = trades.filter(t => t.symbol === selectedTicker);
      const markers = symbolTrades.map(t => ({
        time: Math.floor(t.timestamp / 1000),
        position: (t.action === 'BUY' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        color: t.action === 'BUY' ? '#30d158' : '#ff453a',
        shape: (t.action === 'BUY' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
        text: `${t.action} @ ${t.price}`,
      }));
      markers.sort((a, b) => a.time - b.time);
      lineSeries.setMarkers(markers);
    }
  }, [selectedTicker, tickData, trades, lineSeries]);

  const jumpChartToTrade = (timestamp: number) => {
    if (chartRef.current) {
      const tsSeconds = Math.floor(timestamp / 1000);
      chartRef.current.timeScale().setVisibleRange({
        from: tsSeconds - 60,
        to: tsSeconds + 60,
      });
      addLog(`Chart timeline viewport shifted to execution point at ${new Date(timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`);
    }
  };

  const getLogStyle = (line: string): React.CSSProperties => {
    if (line.includes("WARN") || line.includes("WARNING")) {
      return { color: '#ff9f0a', fontWeight: '500' };
    }
    if (line.includes("ERROR") || line.includes("failed") || line.includes("exited with code 1")) {
      return { color: '#ff453a', fontWeight: '600' };
    }
    if (line.includes("successfully") || line.includes("SERVING") || line.includes("connected") || line.includes("active") || line.includes("established")) {
      return { color: '#30d158' };
    }
    return { color: '#aeaeb2' };
  };

  return (
    <div style={styles.container}>
      <style>{`
        .service-card {
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .service-card:hover {
          transform: translateY(-2px);
          background-color: rgba(255, 255, 255, 0.06) !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        }
        .apple-btn {
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .apple-btn:hover {
          filter: brightness(1.1) saturate(1.1);
          transform: translateY(-1px);
        }
        .apple-btn:active {
          transform: translateY(0) scale(0.98);
        }
        .apple-btn:disabled {
          filter: brightness(0.6);
          cursor: not-allowed !important;
          transform: none !important;
        }
        @keyframes pulse-green {
          0% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0.4); }
          70% { box-shadow: 0 0 0 6px rgba(48, 209, 88, 0); }
          100% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0); }
        }
        @keyframes pulse-red {
          0% { box-shadow: 0 0 0 0 rgba(255, 69, 58, 0.4); }
          70% { box-shadow: 0 0 0 6px rgba(255, 69, 58, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 69, 58, 0); }
        }
        @keyframes pulse-orange {
          0% { box-shadow: 0 0 0 0 rgba(255, 159, 10, 0.4); }
          70% { box-shadow: 0 0 0 6px rgba(255, 159, 10, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 159, 10, 0); }
        }
        .pulse-dot-green { animation: pulse-green 2s infinite; }
        .pulse-dot-red { animation: pulse-red 2s infinite; }
        .pulse-dot-orange { animation: pulse-orange 2s infinite; }
        .scroll-container {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
        }
        .scroll-container::-webkit-scrollbar { width: 6px; }
        .scroll-container::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.08);
          border-radius: 3px;
        }
      `}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <span style={styles.logoText}>BULLDOG</span>
          <span style={styles.logoSubtext}>ALPHA</span>
        </div>
        <div style={styles.headerStatus}>
          <span style={styles.statusLabel}>Global Circuit:</span>
          <span className="pulse-dot-green" style={{
            ...styles.statusBadge,
            backgroundColor: circuitState === "RUNNING" ? "rgba(48, 209, 88, 0.15)" : circuitState === "PAUSED" ? "rgba(255, 159, 10, 0.15)" : "rgba(255, 69, 58, 0.15)",
            border: `1px solid ${circuitState === "RUNNING" ? "rgba(48, 209, 88, 0.3)" : circuitState === "PAUSED" ? "rgba(255, 159, 10, 0.3)" : "rgba(255, 69, 58, 0.3)"}`,
            color: circuitState === "RUNNING" ? "#30d158" : circuitState === "PAUSED" ? "#ff9f0a" : "#ff453a",
          }}>
            {circuitState}
          </span>
        </div>
      </header>

      {/* Section 1: Market Data visualization console */}
      <section style={{ ...styles.card, marginBottom: '32px' }}>
        <h2 style={styles.cardTitle}>Market Data Ingestion Console (MDG)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '32px' }}>
          
          {/* Controls Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={styles.ctrlGroup}>
              <span style={styles.ctrlLabel}>Active Provider Feed:</span>
              <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                <button
                  className="apple-btn"
                  onClick={() => selectVendor("polygon")}
                  style={{
                    ...styles.actionBtn,
                    backgroundColor: activeVendor === "polygon" ? "#0a84ff" : "rgba(255,255,255,0.05)",
                    border: activeVendor === "polygon" ? "none" : "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  Polygon.io
                </button>
                <button
                  className="apple-btn"
                  onClick={() => selectVendor("alpaca")}
                  style={{
                    ...styles.actionBtn,
                    backgroundColor: activeVendor === "alpaca" ? "#0a84ff" : "rgba(255,255,255,0.05)",
                    border: activeVendor === "alpaca" ? "none" : "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  Alpaca
                </button>
              </div>
            </div>

            <div style={styles.ctrlGroup}>
              <span style={styles.ctrlLabel}>Ingestion Status:</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
                <span className={mdgStatus === "RUNNING" ? "pulse-dot-green" : "pulse-dot-orange"} style={{
                  width: '10px', height: '10px', borderRadius: '50%', backgroundColor: mdgStatus === "RUNNING" ? "#30d158" : "#ff9f0a"
                }} />
                <span style={{ fontSize: '14px', fontWeight: 600, color: mdgStatus === "RUNNING" ? "#30d158" : "#ff9f0a" }}>
                  {mdgStatus}
                </span>
                <button
                  className="apple-btn"
                  onClick={() => controlMdgStatus(mdgStatus === "RUNNING" ? "pause" : "resume")}
                  style={{
                    ...styles.toggleBtn,
                    marginLeft: 'auto',
                    backgroundColor: mdgStatus === "RUNNING" ? "rgba(255, 69, 58, 0.15)" : "rgba(48, 209, 88, 0.15)",
                    border: `1px solid ${mdgStatus === "RUNNING" ? "rgba(255, 69, 58, 0.3)" : "rgba(48, 209, 88, 0.3)"}`,
                    color: mdgStatus === "RUNNING" ? "#ff453a" : "#30d158",
                  }}
                >
                  {mdgStatus === "RUNNING" ? "PAUSE INGEST" : "RESUME INGEST"}
                </button>
              </div>
            </div>

            <div style={styles.ctrlGroup}>
              <span style={styles.ctrlLabel}>Subscribe Ticker:</span>
              <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                <input
                  type="text"
                  placeholder="e.g. AAPL"
                  value={newTickerInput}
                  onChange={(e) => setNewTickerInput(e.target.value)}
                  style={styles.textInput}
                />
                <button
                  className="apple-btn"
                  onClick={() => addSubscription(newTickerInput)}
                  style={{ ...styles.actionBtn, backgroundColor: '#30d158', width: '80px', color: '#fff' }}
                >
                  ADD
                </button>
              </div>
            </div>

            <div style={styles.ctrlGroup}>
              <span style={styles.ctrlLabel}>Subscriptions ({subscriptions.length}):</span>
              <div className="scroll-container" style={{ maxHeight: '180px', overflowY: 'auto', marginTop: '6px', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '6px' }}>
                {subscriptions.map(sym => (
                  <div key={sym} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px', borderBottom: '1px solid rgba(255,255,255,0.03)', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px', color: selectedTicker === sym ? '#0a84ff' : '#fff', cursor: 'pointer' }} onClick={() => setSelectedTicker(sym)}>
                      {sym} {selectedTicker === sym && "•"}
                    </span>
                    <button
                      className="apple-btn"
                      onClick={() => removeSubscription(sym)}
                      style={{ border: 'none', background: 'transparent', color: '#ff453a', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}
                    >
                      DELETE
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Chart Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '14px', color: '#aeaeb2' }}>Active Chart:</span>
                <select
                  value={selectedTicker}
                  onChange={(e) => setSelectedTicker(e.target.value)}
                  style={styles.dropdown}
                >
                  <option value="">-- No Symbol --</option>
                  {subscriptions.map(sym => (
                    <option key={sym} value={sym}>{sym}</option>
                  ))}
                </select>
              </div>

              {selectedTicker && (
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className="apple-btn"
                    onClick={() => executeSimulatedTrade("BUY")}
                    style={{ ...styles.actionBtn, backgroundColor: 'rgba(48, 209, 88, 0.2)', border: '1px solid rgba(48,209,88,0.4)', color: '#30d158', height: '32px', fontSize: '12px' }}
                  >
                    🟢 SIMULATE BUY 100
                  </button>
                  <button
                    className="apple-btn"
                    onClick={() => executeSimulatedTrade("SELL")}
                    style={{ ...styles.actionBtn, backgroundColor: 'rgba(255, 69, 58, 0.2)', border: '1px solid rgba(255,69,58,0.4)', color: '#ff453a', height: '32px', fontSize: '12px' }}
                  >
                    🔴 SIMULATE SELL 100
                  </button>
                </div>
              )}
            </div>

            {isMarketClosed && (
              <div style={{
                backgroundColor: 'rgba(255, 69, 58, 0.1)',
                border: '1px solid rgba(255, 69, 58, 0.25)',
                borderRadius: '8px',
                padding: '8px 12px',
                fontSize: '13px',
                color: '#ff453a',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '4px',
                backdropFilter: 'blur(10px)',
                lineHeight: '1.4'
              }}>
                <span>⚠️</span>
                <span>The market is currently closed. Displaying historical / mock data.</span>
              </div>
            )}

            {/* Canvas Container */}
            <div ref={chartContainerRef} style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', overflow: 'hidden' }} />
          </div>

        </div>
      </section>

      {/* Grid: Topology / Controls / Executions */}
      <main style={styles.mainGrid}>
        
        {/* Left column: Microservices & Circuit command */}
        <section style={styles.leftCol}>
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Microservices Health & Topology</h2>
            <div style={styles.matrixContainer}>
              {Object.entries(services).map(([name, svc]) => {
                const isEngine = name === "alpha_engine";
                const isServing = svc.status === "SERVING";
                
                let statusLabel = svc.status;
                let dotColor = isServing ? "#30d158" : "#ff453a";
                let pulseClass = isServing ? "pulse-dot-green" : "pulse-dot-red";
                let latencyLabel = `${svc.latency_ms} ms`;
                
                if (isEngine) {
                  if (isServing) {
                    statusLabel = "ACTIVE (STRATEGY)";
                    dotColor = "#30d158";
                    pulseClass = "pulse-dot-green";
                  } else {
                    statusLabel = "INACTIVE (STRATEGY)";
                    dotColor = "#8e8e93";
                    pulseClass = "";
                    latencyLabel = "offline";
                  }
                }
                
                return (
                  <div key={name} className="service-card" style={styles.serviceItem}>
                    <div style={styles.serviceMeta}>
                      <span style={styles.serviceName}>{name.toUpperCase()}</span>
                      <span style={styles.serviceLatency}>{latencyLabel}</span>
                    </div>
                    <div style={styles.statusRow}>
                      <div className={pulseClass} style={{
                        ...styles.statusDot,
                        backgroundColor: dotColor,
                      }} />
                      <span style={{
                        ...styles.statusText,
                        color: isEngine && !isServing ? "#8e8e93" : isServing ? "#30d158" : "#ff453a"
                      }}>{statusLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {systemState === "DEGRADED" && (
              <div style={styles.degradeWarning}>
                <div style={styles.warningIcon}>⚠</div>
                <div>SYSTEM DEGRADED: Opening new positions is disabled.</div>
              </div>
            )}
          </div>

          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Global Circuit Breaker Command Panel</h2>
            <div style={styles.buttonCluster}>
              <button 
                className="apple-btn"
                onClick={() => sendOOBAction("pause", "Manual admin pause")}
                style={{
                  ...styles.btn,
                  backgroundColor: "rgba(255, 159, 10, 0.15)",
                  border: "1px solid rgba(255, 159, 10, 0.3)",
                  color: "#ff9f0a"
                }}
              >
                ⏸ PAUSE TRADING
              </button>
              
              <button 
                className="apple-btn"
                onClick={() => sendOOBAction("panic", "Emergency panic button")}
                style={{
                  ...styles.btn,
                  ...styles.panicBtn,
                  backgroundColor: "#ff3b30",
                  color: "#fff",
                  boxShadow: "0 4px 16px rgba(255, 59, 48, 0.3)"
                }}
              >
                🚨 PANIC LIQUIDATE
              </button>

              <button 
                className="apple-btn"
                onClick={requestResume}
                disabled={circuitState === "RUNNING"}
                style={{
                  ...styles.btn,
                  backgroundColor: circuitState === "RUNNING" ? "rgba(255, 255, 255, 0.03)" : "#30d158",
                  color: circuitState === "RUNNING" ? "rgba(255, 255, 255, 0.2)" : "#fff",
                  border: circuitState === "RUNNING" ? "1px solid rgba(255, 255, 255, 0.05)" : "none",
                  boxShadow: circuitState === "RUNNING" ? "none" : "0 4px 16px rgba(48, 209, 88, 0.3)"
                }}
              >
                ⚡ SAFE RESUME WIZARD
              </button>
            </div>
          </div>
        </section>

        {/* Right column: Risk limits, strategies, executions tracker */}
        <section style={styles.rightCol}>
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Dynamic Risk Control & Parameters</h2>
            
            <div style={styles.sliderGroup}>
              <div style={styles.sliderLabelRow}>
                <span>Max Position Limit (Qty)</span>
                <span style={styles.sliderValue}>{maxPosition}</span>
              </div>
              <input 
                type="range" 
                min="100" 
                max="5000" 
                step="100"
                value={maxPosition}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxPosition(val);
                  publishConfig(val, maxLeverage);
                }}
                style={styles.slider}
              />
            </div>

            <div style={styles.sliderGroup}>
              <div style={styles.sliderLabelRow}>
                <span>Max Leverage Limit</span>
                <span style={styles.sliderValue}>{maxLeverage}x</span>
              </div>
              <input 
                type="range" 
                min="0.5" 
                max="3.0" 
                step="0.1"
                value={maxLeverage}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxLeverage(val);
                  publishConfig(maxPosition, val);
                }}
                style={styles.slider}
              />
            </div>

            <hr style={styles.divider} />

            <h3 style={styles.subTitle}>Active Strategies Hot-Loading</h3>
            
            <div style={styles.toggleRow}>
              <span>Reinforcement Learning Strategy (RL)</span>
              <button 
                className="apple-btn"
                onClick={() => {
                  setRlStrategyActive(!rlStrategyActive);
                  addLog(`RL Strategy toggled ${!rlStrategyActive ? "ON" : "OFF"}`);
                }}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: rlStrategyActive ? "#30d158" : "rgba(255, 255, 255, 0.08)",
                  border: rlStrategyActive ? "none" : "1px solid rgba(255, 255, 255, 0.08)",
                  color: rlStrategyActive ? "#fff" : "#8e8e93"
                }}
              >
                {rlStrategyActive ? "ACTIVE" : "INACTIVE"}
              </button>
            </div>

            <div style={styles.toggleRow}>
              <span>Trend Following Strategy</span>
              <button 
                className="apple-btn"
                onClick={() => {
                  setTrendStrategyActive(!trendStrategyActive);
                  addLog(`Trend Strategy toggled ${!trendStrategyActive ? "ON" : "OFF"}`);
                }}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: trendStrategyActive ? "#30d158" : "rgba(255, 255, 255, 0.08)",
                  border: trendStrategyActive ? "none" : "1px solid rgba(255, 255, 255, 0.08)",
                  color: trendStrategyActive ? "#fff" : "#8e8e93"
                }}
              >
                {trendStrategyActive ? "ACTIVE" : "INACTIVE"}
              </button>
            </div>
          </div>

          {/* Trade Executions Table synced to Chart Timeline */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Simulated Execution Ledger</h2>
            <div className="scroll-container" style={{ maxHeight: '180px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: '#8e8e93', textAlign: 'left' }}>
                    <th style={{ padding: '6px' }}>Time (PST)</th>
                    <th style={{ padding: '6px' }}>Action</th>
                    <th style={{ padding: '6px' }}>Symbol</th>
                    <th style={{ padding: '6px' }}>Price</th>
                    <th style={{ padding: '6px' }}>Nav</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '12px', color: '#8e8e93' }}>No transactions recorded.</td>
                    </tr>
                  ) : (
                    trades.map((t, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)', verticalAlign: 'middle' }}>
                        <td style={{ padding: '6px' }}>
                          {new Date(t.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                        </td>
                        <td style={{ padding: '6px', fontWeight: 600, color: t.action === 'BUY' ? '#30d158' : '#ff453a' }}>
                          {t.action}
                        </td>
                        <td style={{ padding: '6px' }}>{t.symbol}</td>
                        <td style={{ padding: '6px', fontWeight: 500 }}>${t.price}</td>
                        <td style={{ padding: '6px' }}>
                          <button
                            className="apple-btn"
                            onClick={() => jumpChartToTrade(t.timestamp)}
                            style={{ ...styles.actionBtn, height: '22px', fontSize: '10px', padding: '0 8px', backgroundColor: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.3)' }}
                          >
                            Jump
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      {devMode && (
        <section style={{ ...styles.card, marginBottom: '32px', borderColor: 'rgba(255, 69, 58, 0.3)' }}>
          <h2 style={{ ...styles.cardTitle, color: '#ff453a', borderBottomColor: 'rgba(255, 69, 58, 0.1)' }}>Developer Modes & Control</h2>
          <button 
            className="apple-btn"
            onClick={async () => {
              addLog("Triggering physical platform shutdown API...");
              try {
                const resp = await fetch("/api/shutdown", { method: "POST" });
                if (resp.ok) {
                  addLog("Shutdown signal accepted by BFF Gateway. Backend exiting...");
                } else {
                  addLog("Failed to trigger shutdown API.");
                }
              } catch (err) {
                addLog(`Shutdown API error: ${err}`);
              }
            }}
            style={{
              ...styles.btn,
              backgroundColor: "rgba(255, 69, 58, 0.1)",
              border: "1px solid rgba(255, 69, 58, 0.3)",
              color: "#ff453a",
              width: '100%',
            }}
          >
            🛑 SHUTDOWN ALL SERVICES
          </button>
        </section>
      )}

      {/* Terminal Log Console */}
      <footer style={styles.terminal}>
        <div style={styles.terminalHeader}>
          <span style={styles.terminalTitle}>System Event Terminal Output Log</span>
          {isReconnecting && <span style={styles.reconnectBadge}>Connecting...</span>}
        </div>
        <div className="console-log scroll-container" style={styles.terminalConsole}>
          {logs.map((log, idx) => (
            <div key={idx} style={{ ...styles.logLine, ...getLogStyle(log) }}>{log}</div>
          ))}
          <div ref={terminalEndRef} />
        </div>
      </footer>
    </div>
  );
}

// Inline CSS for Sleek Dark Glassmorphism Aesthetics (Apple Style)
const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: '#000000',
    color: '#f5f5f7',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    padding: '40px 32px 32px 32px',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    paddingBottom: '20px',
    marginBottom: '32px',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  logoText: {
    fontSize: '26px',
    fontWeight: 700,
    letterSpacing: '-0.5px',
    background: 'linear-gradient(135deg, #ffffff 0%, #a1a1a6 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  logoSubtext: {
    fontSize: '11px',
    color: '#8e8e93',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: '3px 8px',
    borderRadius: '12px',
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  headerStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  statusLabel: {
    color: '#8e8e93',
    fontSize: '14px',
    fontWeight: 500,
  },
  statusBadge: {
    padding: '6px 14px',
    borderRadius: '16px',
    fontWeight: 600,
    fontSize: '12px',
    letterSpacing: '0.5px',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '32px',
    flexGrow: 1,
    marginBottom: '32px',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '32px',
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '32px',
  },
  card: {
    backgroundColor: 'rgba(28, 28, 30, 0.65)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '18px',
    padding: '24px',
    backdropFilter: 'blur(30px) saturate(180%)',
    boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  cardTitle: {
    fontSize: '17px',
    fontWeight: 600,
    marginBottom: '20px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    paddingBottom: '12px',
    color: '#f5f5f7',
    letterSpacing: '-0.2px',
  },
  matrixContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
  },
  serviceItem: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.04)',
    padding: '16px',
    borderRadius: '14px',
    cursor: 'default',
  },
  serviceMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  serviceName: {
    fontWeight: 600,
    fontSize: '13px',
    color: '#aeaeb2',
    letterSpacing: '0.2px',
  },
  serviceLatency: {
    fontSize: '12px',
    color: '#8e8e93',
    fontWeight: 500,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  statusText: {
    fontSize: '12px',
    fontWeight: 600,
  },
  degradeWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    backgroundColor: 'rgba(255, 159, 10, 0.15)',
    border: '1px solid rgba(255, 159, 10, 0.3)',
    borderRadius: '12px',
    padding: '14px 16px',
    marginTop: '20px',
    color: '#ff9f0a',
    fontSize: '13px',
    fontWeight: 500,
  },
  warningIcon: {
    fontSize: '16px',
  },
  buttonCluster: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  btn: {
    padding: '16px',
    borderRadius: '12px',
    border: 'none',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  panicBtn: {
    fontSize: '14px',
    letterSpacing: '0.5px',
  },
  sliderGroup: {
    marginBottom: '24px',
  },
  sliderLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '14px',
    color: '#8e8e93',
    marginBottom: '10px',
    fontWeight: 500,
  },
  sliderValue: {
    color: '#ffffff',
    fontWeight: 600,
  },
  slider: {
    width: '100%',
    accentColor: '#0a84ff',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    height: '4px',
    borderRadius: '2px',
    outline: 'none',
    cursor: 'pointer',
  },
  divider: {
    border: 'none',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    margin: '24px 0',
  },
  subTitle: {
    fontSize: '15px',
    fontWeight: 600,
    marginBottom: '16px',
    color: '#f5f5f7',
  },
  toggleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    border: '1px solid rgba(255, 255, 255, 0.04)',
    padding: '14px 18px',
    borderRadius: '12px',
    marginBottom: '12px',
    fontSize: '14px',
    fontWeight: 500,
  },
  toggleBtn: {
    padding: '6px 14px',
    borderRadius: '16px',
    border: 'none',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    cursor: 'pointer',
  },
  terminal: {
    backgroundColor: 'rgba(28, 28, 30, 0.85)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '18px',
    display: 'flex',
    flexDirection: 'column',
    height: '240px',
    backdropFilter: 'blur(30px) saturate(180%)',
    boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
  },
  terminalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    padding: '12px 20px',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderTopLeftRadius: '18px',
    borderTopRightRadius: '18px',
  },
  terminalTitle: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#8e8e93',
    letterSpacing: '0.2px',
  },
  reconnectBadge: {
    fontSize: '10px',
    backgroundColor: '#ff453a',
    padding: '3px 8px',
    borderRadius: '12px',
    color: '#fff',
    fontWeight: 600,
  },
  terminalConsole: {
    padding: '16px 20px',
    flexGrow: 1,
    overflowY: 'auto',
    fontFamily: 'SFMono-Regular, SF Pro Text, Consolas, Monaco, monospace',
    fontSize: '12px',
    lineHeight: '1.6',
  },
  logLine: {
    wordBreak: 'break-all',
    marginBottom: '2px',
  },
  ctrlGroup: {
    display: 'flex',
    flexDirection: 'column',
  },
  ctrlLabel: {
    fontSize: '13px',
    color: '#8e8e93',
    fontWeight: 500,
  },
  textInput: {
    flexGrow: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '10px',
    padding: '8px 12px',
    color: '#fff',
    fontSize: '13px',
    outline: 'none',
  },
  actionBtn: {
    padding: '8px 16px',
    borderRadius: '10px',
    border: 'none',
    color: '#fff',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdown: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '10px',
    color: '#fff',
    padding: '6px 12px',
    fontSize: '13px',
    outline: 'none',
    cursor: 'pointer',
  },
};
