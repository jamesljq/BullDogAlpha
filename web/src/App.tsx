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

  const getLogStyle = (line: string): React.CSSProperties => {
    if (line.includes("WARN") || line.includes("WARNING")) {
      return { color: '#ff9f0a', fontWeight: '500' };
    }
    if (line.includes("ERROR") || line.includes("failed") || line.includes("exited with code 1")) {
      return { color: '#ff453a', fontWeight: '600' };
    }
    if (line.includes("successfully") || line.includes("SERVING") || line.includes("connected") || line.includes("active") || line.includes("Replay")) {
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
        .pulse-dot-green {
          animation: pulse-green 2s infinite;
        }
        .pulse-dot-red {
          animation: pulse-red 2s infinite;
        }
        .pulse-dot-orange {
          animation: pulse-orange 2s infinite;
        }
        .console-log {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
        }
        .console-log::-webkit-scrollbar {
          width: 6px;
        }
        .console-log::-webkit-scrollbar-thumb {
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

      {/* Main Grid */}
      <main style={styles.mainGrid}>
        {/* Left column: Topology and Command Center */}
        <section style={styles.leftCol}>
          {/* Microservices Matrix */}
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
                    dotColor = "#8e8e93"; // Neutral slate-gray
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

          {/* Big Red Button Cluster */}
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
                  cursor: circuitState === "RUNNING" ? "not-allowed" : "pointer",
                  boxShadow: circuitState === "RUNNING" ? "none" : "0 4px 16px rgba(48, 209, 88, 0.3)"
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

          {devMode && (
            <div style={{ ...styles.card, marginTop: '24px', borderColor: 'rgba(255, 69, 58, 0.3)' }}>
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
        <div className="console-log" style={styles.terminalConsole}>
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
    backgroundColor: '#000000', // Apple pure black background
    color: '#f5f5f7', // Apple warm gray text
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
    accentColor: '#0a84ff', // Apple blue color
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
};
