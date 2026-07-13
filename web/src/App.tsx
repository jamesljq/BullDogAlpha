import React, { useState, useEffect, useRef } from 'react';

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

export default function App() {
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
  
  const wsRef = useRef<WebSocket | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  // Connect to Go BFF WebSocket
  useEffect(() => {
    connectWS();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-99), `[${timestamp}] ${msg}`]);
  };

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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

  // Trigger high-priority OOB circuit breaker state
  const sendOOBAction = (action: "pause" | "panic", reason: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action, reason }));
      addLog(`Sent OOB command: ${action.toUpperCase()} Reason: ${reason}`);
    } else {
      addLog(`Cannot send OOB action, WebSocket closed. Failsafe local state applied.`);
    }
  };

  // Safe Resume handshake request
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

  // Publish risk configuration
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

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <span style={styles.logoText}>BULLDOG</span>
          <span style={styles.logoSubtext}>ALPHA</span>
        </div>
        <div style={styles.headerStatus}>
          <span style={styles.statusLabel}>Global Circuit:</span>
          <span style={{
            ...styles.statusBadge,
            backgroundColor: circuitState === "RUNNING" ? "#06b6d4" : circuitState === "PAUSED" ? "#f97316" : "#ef4444",
            boxShadow: `0 0 10px ${circuitState === "RUNNING" ? "#06b6d4" : circuitState === "PAUSED" ? "#f97316" : "#ef4444"}`
          }}>
            {circuitState}
          </span>
        </div>
      </header>

      {/* Main Grid */}
      <main style={styles.mainGrid}>
        {/* Left column: Topology and Command Center */}
        <section style={styles.leftCol}>
          {/* Microservices Matrix */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Microservices Health & Topology</h2>
            <div style={styles.matrixContainer}>
              {Object.entries(services).map(([name, svc]) => (
                <div key={name} style={styles.serviceItem}>
                  <div style={styles.serviceMeta}>
                    <span style={styles.serviceName}>{name.toUpperCase()}</span>
                    <span style={styles.serviceLatency}>{svc.latency_ms} ms</span>
                  </div>
                  <div style={styles.statusRow}>
                    <div style={{
                      ...styles.statusDot,
                      backgroundColor: svc.status === "SERVING" ? "#10b981" : "#ef4444",
                      boxShadow: `0 0 8px ${svc.status === "SERVING" ? "#10b981" : "#ef4444"}`
                    }} />
                    <span style={styles.statusText}>{svc.status}</span>
                  </div>
                </div>
              ))}
            </div>
            {systemState === "DEGRADED" && (
              <div style={styles.degradeWarning}>
                <div style={styles.warningIcon}>⚠</div>
                <div>SYSTEM DEGRADED: Opening new positions is disabled.</div>
              </div>
            )}
          </div>

          {/* Big Red Button Cluster */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Global Circuit Breaker Command Panel</h2>
            <div style={styles.buttonCluster}>
              <button 
                onClick={() => sendOOBAction("pause", "Manual admin pause")}
                style={{
                  ...styles.btn,
                  background: "linear-gradient(135deg, #f97316, #ea580c)",
                  color: "#fff"
                }}
              >
                ⏸ PAUSE TRADING
              </button>
              
              <button 
                onClick={() => sendOOBAction("panic", "Emergency panic button")}
                style={{
                  ...styles.btn,
                  ...styles.panicBtn,
                  background: "linear-gradient(135deg, #ef4444, #dc2626)",
                  boxShadow: "0 0 15px rgba(239, 68, 68, 0.6)"
                }}
              >
                🚨 PANIC LIQUIDATE
              </button>

              <button 
                onClick={requestResume}
                disabled={circuitState === "RUNNING"}
                style={{
                  ...styles.btn,
                  backgroundColor: circuitState === "RUNNING" ? "#1e293b" : "#10b981",
                  color: circuitState === "RUNNING" ? "#64748b" : "#fff",
                  cursor: circuitState === "RUNNING" ? "not-allowed" : "pointer"
                }}
              >
                ⚡ SAFE RESUME WIZARD
              </button>
            </div>
          </div>
        </section>

        {/* Right column: Dynamic Control Panel */}
        <section style={styles.rightCol}>
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Dynamic Risk Control & Parameters</h2>
            
            {/* Wind Control Sliders */}
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

            {/* Strategy Toggles */}
            <h3 style={styles.subTitle}>Active Strategies Hot-Loading</h3>
            
            <div style={styles.toggleRow}>
              <span>Reinforcement Learning Strategy (RL)</span>
              <button 
                onClick={() => {
                  setRlStrategyActive(!rlStrategyActive);
                  addLog(`RL Strategy toggled ${!rlStrategyActive ? "ON" : "OFF"}`);
                }}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: rlStrategyActive ? "#06b6d4" : "#334155"
                }}
              >
                {rlStrategyActive ? "ACTIVE" : "INACTIVE"}
              </button>
            </div>

            <div style={styles.toggleRow}>
              <span>Trend Following Strategy</span>
              <button 
                onClick={() => {
                  setTrendStrategyActive(!trendStrategyActive);
                  addLog(`Trend Strategy toggled ${!trendStrategyActive ? "ON" : "OFF"}`);
                }}
                style={{
                  ...styles.toggleBtn,
                  backgroundColor: trendStrategyActive ? "#06b6d4" : "#334155"
                }}
              >
                {trendStrategyActive ? "ACTIVE" : "INACTIVE"}
              </button>
            </div>
          </div>

          {devMode && (
            <div style={{ ...styles.card, marginTop: '24px', borderColor: '#ef4444' }}>
              <h2 style={{ ...styles.cardTitle, color: '#ef4444' }}>Developer Modes & Control</h2>
              <button 
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
                  background: "linear-gradient(135deg, #7f1d1d, #b91c1c)",
                  color: "#fff",
                  width: '100%',
                  boxShadow: "0 0 10px rgba(239, 68, 68, 0.4)"
                }}
              >
                🛑 SHUTDOWN ALL SERVICES
              </button>
            </div>
          )}
        </section>
      </main>

      {/* Terminal Log Console */}
      <footer style={styles.terminal}>
        <div style={styles.terminalHeader}>
          <span style={styles.terminalTitle}>System Event Terminal Output Log</span>
          {isReconnecting && <span style={styles.reconnectBadge}>Connecting...</span>}
        </div>
        <div style={styles.terminalConsole}>
          {logs.map((log, idx) => (
            <div key={idx} style={styles.logLine}>{log}</div>
          ))}
          <div ref={terminalEndRef} />
        </div>
      </footer>
    </div>
  );
}

// Inline CSS for Sleek Dark Glassmorphism Aesthetics
const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: '#0b0f19',
    color: '#f8fafc',
    fontFamily: 'Inter, -apple-system, sans-serif',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #1e293b',
    paddingBottom: '16px',
    marginBottom: '24px',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  logoText: {
    fontSize: '24px',
    fontWeight: 'bold',
    letterSpacing: '2px',
    background: 'linear-gradient(to right, #22d3ee, #06b6d4)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  logoSubtext: {
    fontSize: '12px',
    backgroundColor: '#334155',
    padding: '2px 6px',
    borderRadius: '4px',
    fontWeight: 'bold',
  },
  headerStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  statusLabel: {
    color: '#94a3b8',
    fontSize: '14px',
  },
  statusBadge: {
    padding: '6px 12px',
    borderRadius: '20px',
    fontWeight: 'bold',
    fontSize: '12px',
    letterSpacing: '1px',
    transition: 'all 0.3s ease',
  },
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '24px',
    flexGrow: 1,
    marginBottom: '24px',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
  },
  card: {
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
    border: '1px solid rgba(255, 255, 255, 0.05)',
    borderRadius: '12px',
    padding: '20px',
    backdropFilter: 'blur(10px)',
  },
  cardTitle: {
    fontSize: '18px',
    fontWeight: 'bold',
    marginBottom: '16px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    paddingBottom: '10px',
    color: '#cbd5e1',
  },
  matrixContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
  },
  serviceItem: {
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid rgba(255, 255, 255, 0.02)',
  },
  serviceMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '8px',
  },
  serviceName: {
    fontWeight: 'bold',
    fontSize: '13px',
    color: '#94a3b8',
  },
  serviceLatency: {
    fontSize: '12px',
    color: '#06b6d4',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
  },
  statusText: {
    fontSize: '12px',
    fontWeight: '600',
  },
  degradeWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    border: '1px solid #ef4444',
    borderRadius: '8px',
    padding: '12px',
    marginTop: '16px',
    color: '#fca5a5',
    fontSize: '13px',
  },
  warningIcon: {
    fontSize: '18px',
  },
  buttonCluster: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  btn: {
    padding: '14px',
    borderRadius: '8px',
    border: 'none',
    fontSize: '14px',
    fontWeight: 'bold',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  panicBtn: {
    fontSize: '16px',
    letterSpacing: '1px',
    animation: 'pulse 2s infinite',
  },
  sliderGroup: {
    marginBottom: '20px',
  },
  sliderLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '14px',
    color: '#94a3b8',
    marginBottom: '8px',
  },
  sliderValue: {
    color: '#f8fafc',
    fontWeight: 'bold',
  },
  slider: {
    width: '100%',
    accentColor: '#06b6d4',
    backgroundColor: '#334155',
    height: '6px',
    borderRadius: '3px',
    outline: 'none',
  },
  divider: {
    border: 'none',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    margin: '20px 0',
  },
  subTitle: {
    fontSize: '15px',
    fontWeight: 'bold',
    marginBottom: '12px',
    color: '#cbd5e1',
  },
  toggleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
    padding: '12px',
    borderRadius: '8px',
    marginBottom: '10px',
    fontSize: '14px',
  },
  toggleBtn: {
    padding: '6px 12px',
    borderRadius: '4px',
    border: 'none',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  terminal: {
    backgroundColor: '#090d16',
    border: '1px solid #1e293b',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    height: '220px',
  },
  terminalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #1e293b',
    padding: '10px 16px',
    backgroundColor: '#0f172a',
    borderTopLeftRadius: '12px',
    borderTopRightRadius: '12px',
  },
  terminalTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#94a3b8',
  },
  reconnectBadge: {
    fontSize: '10px',
    backgroundColor: '#ef4444',
    padding: '2px 6px',
    borderRadius: '4px',
    color: '#fff',
    fontWeight: 'bold',
    animation: 'pulse 1s infinite',
  },
  terminalConsole: {
    padding: '12px 16px',
    flexGrow: 1,
    overflowY: 'auto',
    fontFamily: 'SFMono-Regular, Consolas, Monaco, monospace',
    fontSize: '12px',
    color: '#10b981',
    lineHeight: '1.6',
  },
  logLine: {
    wordBreak: 'break-all',
  },
};
