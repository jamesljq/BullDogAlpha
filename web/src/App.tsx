import React, { useState, useEffect, useRef } from 'react';
import { createChart, LineSeries, CandlestickSeries, createSeriesMarkers } from 'lightweight-charts';

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

export interface TradeMarker {
  symbol: string;
  price: number;
  qty?: number;
  action: "BUY" | "SELL";
  timestamp: number; // epoch ms
}

export interface FormattedMarker {
  time: number;
  position: 'belowBar' | 'aboveBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown';
  size: number;
  text: string;
}

export const aggregateTradeMarkers = (
  trades: TradeMarker[],
  symbol: string,
  candles?: Array<{ time: number }>
): FormattedMarker[] => {
  const symbolTrades = (Array.isArray(trades) ? trades : []).filter(t => t && t.symbol === symbol);
  if (symbolTrades.length === 0) return [];

  const sortedCandles = Array.isArray(candles) ? [...candles].sort((a, b) => a.time - b.time) : [];
  const grouped: Record<string, TradeMarker[]> = {};

  for (const t of symbolTrades) {
    const tradeSec = Math.floor(t.timestamp / 1000);
    let mappedTime = tradeSec;

    if (sortedCandles.length > 0) {
      let matchedCandleTime = sortedCandles[0].time;
      for (let i = 0; i < sortedCandles.length; i++) {
        if (sortedCandles[i].time <= tradeSec) {
          matchedCandleTime = sortedCandles[i].time;
        } else {
          break;
        }
      }
      mappedTime = matchedCandleTime;
    }

    const key = `${mappedTime}_${t.action}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(t);
  }

  const result: FormattedMarker[] = [];

  for (const key of Object.keys(grouped)) {
    const groupTrades = grouped[key];
    if (groupTrades.length === 0) continue;

    const parts = key.split('_');
    const time = parseInt(parts[0], 10);
    const action = parts[1];
    const count = groupTrades.length;

    let totalQty = 0;
    let totalVal = 0;
    for (const gt of groupTrades) {
      const qty = gt.qty && gt.qty > 0 ? gt.qty : 100;
      totalQty += qty;
      totalVal += gt.price * qty;
    }
    const avgPrice = totalQty > 0 ? totalVal / totalQty : groupTrades[0].price;
    const isBuy = action === 'BUY';

    const text = count === 1
      ? `${isBuy ? 'B' : 'S'} ${totalQty}@${avgPrice.toFixed(2)}`
      : `${isBuy ? 'B' : 'S'} ${count}x (${totalQty}@${avgPrice.toFixed(2)})`;

    result.push({
      time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#30d158' : '#ff453a',
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      size: count > 1 ? 1.2 : 1.0,
      text,
    });
  }

  result.sort((a, b) => a.time - b.time);
  return result;
};

export interface MarketSessionInfo {
  isClosed: boolean;
  label: string;
  badgeBg: string;
  badgeBorder: string;
  badgeColor: string;
  sessionType: 'REGULAR' | 'PRE_MARKET' | 'EXTENDED' | 'NIGHT' | 'WEEKEND';
}

export const getMarketSessionStatus = (): MarketSessionInfo => {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const partMap: Record<string, string> = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    const weekday = partMap.weekday; // 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
    if (weekday === "Sat" || weekday === "Sun") {
      return {
        isClosed: true,
        label: '🏖️ WEEKEND CLOSED',
        badgeBg: 'rgba(142, 142, 147, 0.15)',
        badgeBorder: 'rgba(142, 142, 147, 0.35)',
        badgeColor: '#aeaeb2',
        sessionType: 'WEEKEND',
      };
    }

    let hours = parseInt(partMap.hour, 10);
    if (hours === 24) hours = 0;
    const minutes = parseInt(partMap.minute, 10);
    const mins = hours * 60 + minutes;

    const preMarketStart = 4 * 60;       // 4:00 AM ET
    const marketOpen = 9 * 60 + 30;      // 9:30 AM ET
    const marketClose = 16 * 60;         // 4:00 PM ET
    const extendedClose = 20 * 60;       // 8:00 PM ET

    if (mins >= marketOpen && mins < marketClose) {
      return {
        isClosed: false,
        label: '🟢 REGULAR MARKET',
        badgeBg: 'rgba(48, 209, 88, 0.15)',
        badgeBorder: 'rgba(48, 209, 88, 0.35)',
        badgeColor: '#30d158',
        sessionType: 'REGULAR',
      };
    } else if (mins >= preMarketStart && mins < marketOpen) {
      return {
        isClosed: true,
        label: '🌅 PRE-MARKET',
        badgeBg: 'rgba(10, 132, 255, 0.15)',
        badgeBorder: 'rgba(10, 132, 255, 0.35)',
        badgeColor: '#0a84ff',
        sessionType: 'PRE_MARKET',
      };
    } else if (mins >= marketClose && mins < extendedClose) {
      return {
        isClosed: true,
        label: '🌆 EXTENDED HOURS',
        badgeBg: 'rgba(255, 159, 10, 0.15)',
        badgeBorder: 'rgba(255, 159, 10, 0.35)',
        badgeColor: '#ff9f0a',
        sessionType: 'EXTENDED',
      };
    } else {
      return {
        isClosed: true,
        label: '🌙 NIGHT SESSION',
        badgeBg: 'rgba(191, 90, 242, 0.15)',
        badgeBorder: 'rgba(191, 90, 242, 0.35)',
        badgeColor: '#bf5af2',
        sessionType: 'NIGHT',
      };
    }
  } catch (e) {
    return {
      isClosed: true,
      label: '🏖️ WEEKEND CLOSED',
      badgeBg: 'rgba(142, 142, 147, 0.15)',
      badgeBorder: 'rgba(142, 142, 147, 0.35)',
      badgeColor: '#aeaeb2',
      sessionType: 'WEEKEND',
    };
  }
};

export const checkIsMarketClosed = (): boolean => {
  return getMarketSessionStatus().isClosed;
};

interface GranularityOption {
  label: string;
  value: string;
  seconds: number;
  periodLabel: string;
}

const GRANULARITIES: GranularityOption[] = [
  { label: '1D', value: '1d', seconds: 60, periodLabel: 'Today' },
  { label: '1W', value: '1w', seconds: 3600, periodLabel: 'Past Week' },
  { label: '1M', value: '1M', seconds: 86400, periodLabel: 'Past Month' },
  { label: '3M', value: '3M', seconds: 2592000, periodLabel: 'Past 3 Months' },
  { label: 'YTD', value: 'ytd', seconds: 86400, periodLabel: 'Year to Date' },
  { label: '1Y', value: '1y', seconds: 31104000, periodLabel: 'Past Year' },
  { label: '5Y', value: '5y', seconds: 155520000, periodLabel: 'Past 5 Years' },
  { label: 'ALL', value: 'all', seconds: 311040000, periodLabel: 'All Time' },
];

export const checkIsDailyOrHigher = (granularity: string, interval: string): boolean => {
  const dailyGranularities = ['1M', '3M', 'ytd', '1y', '5y', 'all'];
  const dailyIntervals = ['1d', '1w', '1m'];
  return dailyGranularities.includes(granularity) || dailyIntervals.includes(interval);
};

interface IntervalOption {
  value: string;
  label: string;
  category: "SECONDS" | "MINUTES" | "HOURS" | "DAYS / MONTHS";
}

const INTERVAL_OPTIONS: IntervalOption[] = [
  { value: "10s", label: "10 seconds", category: "SECONDS" },
  { value: "15s", label: "15 seconds", category: "SECONDS" },
  { value: "30s", label: "30 seconds", category: "SECONDS" },
  { value: "1m", label: "1 minute", category: "MINUTES" },
  { value: "2m", label: "2 minutes", category: "MINUTES" },
  { value: "3m", label: "3 minutes", category: "MINUTES" },
  { value: "5m", label: "5 minutes", category: "MINUTES" },
  { value: "10m", label: "10 minutes", category: "MINUTES" },
  { value: "15m", label: "15 minutes", category: "MINUTES" },
  { value: "30m", label: "30 minutes", category: "MINUTES" },
  { value: "1h", label: "1 hour", category: "HOURS" },
  { value: "2h", label: "2 hours", category: "HOURS" },
  { value: "4h", label: "4 hours", category: "HOURS" },
  { value: "1d", label: "1 day", category: "DAYS / MONTHS" },
  { value: "1w", label: "1 week", category: "DAYS / MONTHS" },
  { value: "1M", label: "1 month", category: "DAYS / MONTHS" },
  { value: "6M", label: "6 months", category: "DAYS / MONTHS" },
  { value: "12M", label: "12 months", category: "DAYS / MONTHS" },
];



export interface StockMetadata {
  name: string;
  currentPrice: number;
  open: number;
  high: number;
  low: number;
  wHigh: number; // 52-Week High
  wLow: number;  // 52-Week Low
  pe: number;
  volume: string;
  marketCap: string;
  avgVolume: string;
}

export const STOCK_DATA_MAP: Record<string, StockMetadata> = {
  AAPL: {
    name: 'Apple Inc.',
    currentPrice: 224.50,
    open: 223.50,
    high: 226.10,
    low: 222.80,
    wHigh: 237.23,
    wLow: 164.08,
    pe: 34.2,
    volume: '48.5M',
    marketCap: '$3.42T',
    avgVolume: '52.1M',
  },
  MSFT: {
    name: 'Microsoft Corp.',
    currentPrice: 448.37,
    open: 446.10,
    high: 450.20,
    low: 445.50,
    wHigh: 468.35,
    wLow: 309.45,
    pe: 35.8,
    volume: '21.3M',
    marketCap: '$3.33T',
    avgVolume: '22.8M',
  },
  NVDA: {
    name: 'NVIDIA Corp.',
    currentPrice: 122.50,
    open: 121.80,
    high: 124.10,
    low: 120.90,
    wHigh: 140.76,
    wLow: 45.01,
    pe: 71.5,
    volume: '195.4M',
    marketCap: '$3.01T',
    avgVolume: '210.6M',
  },
  TSLA: {
    name: 'Tesla, Inc.',
    currentPrice: 251.50,
    open: 248.30,
    high: 255.10,
    low: 246.20,
    wHigh: 271.00,
    wLow: 138.80,
    pe: 68.4,
    volume: '85.2M',
    marketCap: '$801.5B',
    avgVolume: '92.4M',
  },
  AMZN: {
    name: 'Amazon.com, Inc.',
    currentPrice: 186.40,
    open: 185.10,
    high: 188.20,
    low: 184.50,
    wHigh: 201.20,
    wLow: 118.35,
    pe: 43.6,
    volume: '38.9M',
    marketCap: '$1.94T',
    avgVolume: '41.2M',
  },
  GOOG: {
    name: 'Alphabet Inc.',
    currentPrice: 178.60,
    open: 177.20,
    high: 180.10,
    low: 176.80,
    wHigh: 191.75,
    wLow: 120.21,
    pe: 26.8,
    volume: '24.1M',
    marketCap: '$2.21T',
    avgVolume: '26.5M',
  },
  GOOGL: {
    name: 'Alphabet Inc.',
    currentPrice: 178.60,
    open: 177.20,
    high: 180.10,
    low: 176.80,
    wHigh: 191.75,
    wLow: 120.21,
    pe: 26.8,
    volume: '24.1M',
    marketCap: '$2.21T',
    avgVolume: '26.5M',
  },
};

export const getStockStats = (ticker: string, candleRaw?: any[]) => {
  const meta = STOCK_DATA_MAP[ticker];
  if (meta) return meta;
  return {
    name: ticker || 'Unknown',
    currentPrice: 150.00,
    open: 149.50,
    high: 151.20,
    low: 148.80,
    wHigh: 180.00,
    wLow: 120.00,
    pe: 25.0,
    volume: '10.0M',
    marketCap: '$100.0B',
    avgVolume: '12.0M',
  };
};

export const generateMockHistory = (ticker: string, stepSec: number = 60) => {
  const stock = getStockStats(ticker);
  const targetPrice = stock.currentPrice;
  const points = 100;
  const now = Math.floor(Date.now() / 1000);
  const data: Array<{ time: number, value: number }> = [];

  let currentVal = targetPrice;
  const values: number[] = [currentVal];

  for (let i = 1; i < points; i++) {
    const seed = (ticker.charCodeAt(0) * 17 + i * 31) % 100;
    const delta = (Math.sin(i / 4.0) * 0.8 + (seed - 50) / 100.0) * (targetPrice * 0.002);
    currentVal = Math.max(1.0, currentVal - delta);
    values.unshift(parseFloat(currentVal.toFixed(2)));
  }

  for (let i = 0; i < points; i++) {
    const time = now - (points - 1 - i) * stepSec;
    data.push({ time, value: values[i] });
  }

  return data;
};

export const generateMockCandles = (ticker: string, stepSec: number = 60) => {
  const stock = getStockStats(ticker);
  const targetPrice = stock.currentPrice;
  const points = 100;
  const now = Math.floor(Date.now() / 1000);
  const data: Array<{ time: number, open: number, high: number, low: number, close: number }> = [];

  let currentClose = targetPrice;
  const candleList: Array<{ open: number, high: number, low: number, close: number }> = [];

  for (let i = 0; i < points; i++) {
    const isLast = (i === points - 1);
    let close = isLast ? targetPrice : currentClose;
    
    const seed = (ticker.charCodeAt(0) * 13 + (points - 1 - i) * 29) % 100;
    const openOffset = (Math.cos(i / 3.0) * 0.5 + (seed - 50) / 100.0) * (targetPrice * 0.0015);
    let open = isLast ? parseFloat((close - openOffset).toFixed(2)) : parseFloat((close + openOffset).toFixed(2));
    
    const high = parseFloat((Math.max(open, close) + Math.abs(Math.sin(i)) * 0.4 + 0.1).toFixed(2));
    const low = parseFloat((Math.min(open, close) - Math.abs(Math.cos(i)) * 0.4 - 0.1).toFixed(2));

    candleList.unshift({ open, high, low, close });

    if (!isLast) {
      const stepDelta = (Math.sin(i / 5.0) * 0.6 + (seed - 50) / 100.0) * (targetPrice * 0.002);
      currentClose = Math.max(1.0, currentClose - stepDelta);
    }
  }

  for (let i = 0; i < points; i++) {
    const time = now - (points - 1 - i) * stepSec;
    data.push({
      time,
      ...candleList[i]
    });
  }

  return data;
};

export const calculateRSI = (prices: number[]): string => {
  if (prices.length < 14) return "50.00";
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < 14; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference > 0) gains += difference;
    else losses -= difference;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 14; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference > 0) {
      avgGain = (avgGain * 13 + difference) / 14;
      avgLoss = (avgLoss * 13) / 14;
    } else {
      avgGain = (avgGain * 13) / 14;
      avgLoss = (avgLoss * 13 - difference) / 14;
    }
  }
  if (avgLoss === 0) return "100.00";
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi.toFixed(2);
};


export default function App() {
  const [marketInfo, setMarketInfo] = useState<MarketSessionInfo>(getMarketSessionStatus());
  const isMarketClosed = marketInfo.isClosed;

  const fetchMarketStatus = async () => {
    try {
      const resp = await fetch("/api/market-status");
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.label) {
          let bg = 'rgba(48, 209, 88, 0.15)';
          let border = 'rgba(48, 209, 88, 0.35)';
          let color = '#30d158';
          let label = data.label;

          if (data.session_type === 'HOLIDAY') {
            bg = 'rgba(255, 69, 58, 0.15)';
            border = 'rgba(255, 69, 58, 0.35)';
            color = '#ff453a';
            if (!label.startsWith('🎉')) label = `🎉 ${label.replace('● ', '')}`;
          } else if (data.session_type === 'WEEKEND') {
            bg = 'rgba(142, 142, 147, 0.15)';
            border = 'rgba(142, 142, 147, 0.35)';
            color = '#aeaeb2';
            if (!label.startsWith('🏖️')) label = `🏖️ ${label.replace('● ', '')}`;
          } else if (data.session_type === 'PRE_MARKET' || label.includes('PRE-MARKET')) {
            bg = 'rgba(10, 132, 255, 0.15)';
            border = 'rgba(10, 132, 255, 0.35)';
            color = '#0a84ff';
            if (!label.startsWith('🌅')) label = `🌅 ${label.replace('● ', '')}`;
          } else if (data.session_type === 'EXTENDED' || label.includes('EXTENDED')) {
            bg = 'rgba(255, 159, 10, 0.15)';
            border = 'rgba(255, 159, 10, 0.35)';
            color = '#ff9f0a';
            if (!label.startsWith('🌆')) label = `🌆 ${label.replace('● ', '')}`;
          } else if (data.session_type === 'NIGHT' || label.includes('NIGHT')) {
            bg = 'rgba(191, 90, 242, 0.15)';
            border = 'rgba(191, 90, 242, 0.35)';
            color = '#bf5af2';
            if (!label.startsWith('🌙')) label = `🌙 ${label.replace('● ', '')}`;
          } else if (data.session_type === 'REGULAR' || label.includes('REGULAR')) {
            if (!label.startsWith('🟢')) label = `🟢 ${label.replace('● ', '')}`;
          }

          setMarketInfo({
            isClosed: data.is_closed,
            label: label,
            badgeBg: bg,
            badgeBorder: border,
            badgeColor: color,
            sessionType: data.session_type || 'REGULAR',
          });
          return;
        }
      }
    } catch (e) {
      // fallback
    }
    setMarketInfo(getMarketSessionStatus());
  };

  // Periodically check market status API
  useEffect(() => {
    fetchMarketStatus();
    const timer = setInterval(() => {
      fetchMarketStatus();
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
  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [devMode, setDevMode] = useState<boolean>(false);

  // New MDG / Market Data visualization states
  const [activeVendor, setActiveVendor] = useState<"polygon" | "alpaca">("polygon");
  const [mdgStatus, setMdgStatus] = useState<"RUNNING" | "PAUSED">("RUNNING");
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>("");
  const [newTickerInput, setNewTickerInput] = useState<string>("");
  const [tickData, setTickData] = useState<Record<string, Array<{ time: number, value: number }>>>({});
  const [candleData, setCandleData] = useState<Record<string, Array<{ time: number, open: number, high: number, low: number, close: number }>>>({});
  const [trades, setTrades] = useState<TradeMarker[]>([]);
  const [dataSourceInfo, setDataSourceInfo] = useState<{ isMock: boolean; source: string }>({ isMock: false, source: "polygon" });
  const [forceMockMode, setForceMockMode] = useState<boolean>(false);
  const [alpacaFeedMode, setAlpacaFeedMode] = useState<string>("auto");
  const [alpacaFeedLabel, setAlpacaFeedLabel] = useState<string>("IEX Feed (Free 2% Vol)");

  const [chartType, setChartType] = useState<"line" | "candlestick">("candlestick");
  const [showTradeMarkers, setShowTradeMarkers] = useState<boolean>(true);
  const [selectedGranularity, setSelectedGranularity] = useState<string>("1d");
  const [selectedInterval, setSelectedInterval] = useState<string>("30m");
  const [apiKeyInput, setApiKeyInput] = useState<string>("");
  const [customQty, setCustomQty] = useState<number>(100);
  const [orderToast, setOrderToast] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const [activeSeries, setActiveSeries] = useState<any>(null);
  const seriesMarkersRef = useRef<any>(null);
  const loadedKeyRef = useRef<string>("");
  const shouldFitContentRef = useRef<boolean>(true);

  const resyncData = () => {
    fetchMdgConfig();
    fetchTrades();
    if (selectedTicker) {
      fetchHistoricalData(selectedTicker, selectedGranularity, selectedInterval);
    }
    if (subscriptions.length > 0) {
      subscriptions.forEach(sym => {
        fetchHistoricalData(sym, "1d", "30m");
      });
    }
  };

  // Network online/offline listener
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      addLog("Network interface reconnected (online). Re-establishing WebSocket & resyncing data...");
      connectWS();
      resyncData();
    };

    const handleOffline = () => {
      setIsOnline(false);
      setIsWsConnected(false);
      addLog("Network interface disconnected (offline). Live market feeds paused.");
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [selectedTicker, selectedGranularity, selectedInterval, subscriptions]);

  // Connect to Go BFF WebSocket
  useEffect(() => {
    connectWS();
    fetchMdgConfig();
    fetchTrades();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);
  // Auto-select first subscription as active chart
  useEffect(() => {
    if (subscriptions.length > 0 && !selectedTicker) {
      setSelectedTicker(subscriptions[0]);
    }
  }, [subscriptions, selectedTicker]);

  const [activeTab, setActiveTab] = useState<"terminal" | "admin">("terminal");

  const getPeriodChangeInfo = () => {
    const key = `${selectedTicker}_${selectedGranularity}`;
    const rawData = tickData[key] || [];
    const candleRaw = candleData[key] || [];
    const granObj = GRANULARITIES.find(g => g.value === selectedGranularity) || GRANULARITIES[0];
    const baseStats = getStockStats(selectedTicker);

    const intradayKey = `${selectedTicker}_1d`;
    const intradayCandles = candleData[intradayKey] || [];
    const intradayTicks = tickData[intradayKey] || [];

    // Always anchor currentPrice to the latest live price of the stock
    let currentPrice = 0.0;
    if (intradayCandles.length > 0) {
      currentPrice = intradayCandles[intradayCandles.length - 1].close;
    } else if (intradayTicks.length > 0) {
      currentPrice = intradayTicks[intradayTicks.length - 1].value;
    } else if (candleRaw.length > 0) {
      currentPrice = candleRaw[candleRaw.length - 1].close;
    } else if (rawData.length > 0) {
      currentPrice = rawData[rawData.length - 1].value;
    } else if (forceMockMode || dataSourceInfo.isMock) {
      currentPrice = baseStats.currentPrice;
    }

    // Start price of the selected timeframe
    let startPrice = currentPrice;
    if (chartType === "candlestick" && candleRaw.length > 0) {
      startPrice = candleRaw[0].open;
    } else if (rawData.length > 0) {
      startPrice = rawData[0].value;
    } else if (forceMockMode || dataSourceInfo.isMock) {
      startPrice = baseStats.open;
    }

    const closePrice = baseStats.currentPrice > 0 ? baseStats.currentPrice : (currentPrice > 0 ? currentPrice : baseStats.open);
    const closeChange = closePrice - baseStats.open;
    const closePercent = baseStats.open > 0 ? (closeChange / baseStats.open) * 100 : 0;

    const offHoursChange = currentPrice - closePrice;
    const offHoursPercent = closePrice > 0 ? (offHoursChange / closePrice) * 100 : 0;

    const change = currentPrice - startPrice;
    const percent = startPrice > 0 ? (change / startPrice) * 100 : 0;
    return {
      currentPrice,
      change,
      percent,
      label: granObj.periodLabel,
      isPositive: change >= 0,
      closePrice,
      closeChange,
      closePercent,
      isClosePositive: closeChange >= 0,
      offHoursChange,
      offHoursPercent,
      isOffHoursPositive: offHoursChange >= 0,
    };
  };

  // Load real historical data from BFF
  const fetchHistoricalData = async (ticker: string, granularity: string, interval: string) => {
    try {
      const modeParam = forceMockMode ? "&mode=mock" : "";
      const resp = await fetch(`/api/mdg/history?ticker=${ticker}&granularity=${granularity}&interval=${interval}${modeParam}`);
      if (resp.ok) {
        const data = await resp.json();
          if (data.success && data.bars) {
            const key = `${ticker}_${granularity}`;
            const lineBars = data.bars.map((b: any) => ({ time: b.time, value: b.close }));
            const candleBars = data.bars.map((b: any) => ({
              time: b.time,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            }));

            setTickData(prev => ({ ...prev, [key]: lineBars }));
            setCandleData(prev => ({ ...prev, [key]: candleBars }));

            const isMock = data.is_mock ?? (data.source === "mock");
            const sourceName = data.source || (isMock ? "mock" : activeVendor);
            setDataSourceInfo({ isMock: !!isMock, source: sourceName });

            if (data.alpaca_feed) {
              setAlpacaFeedLabel(data.alpaca_feed);
            }

            if (isMock) {
              addLog(`Loaded simulated mock historical bars for ${ticker} (${granularity}, ${interval})`);
            } else {
              addLog(`Loaded REAL live market bars for ${ticker} (${data.bars.length} bars) via ${sourceName.toUpperCase()}`);
            }
            return;
          }
        }
      } catch (e) {
        console.warn("Failed to fetch historical data:", e);
      }
    
    // Strict Rule: When Real Market Feed is active (!forceMockMode), NEVER generate fallback mock bars!
    if (!forceMockMode) {
      const key = `${ticker}_${granularity}`;
      setTickData(prev => ({ ...prev, [key]: [] }));
      setCandleData(prev => ({ ...prev, [key]: [] }));
      setDataSourceInfo({ isMock: false, source: activeVendor });
      addLog(`No real-time market data returned for ${ticker} (${granularity}). Strict No-Mock Fallback policy active.`);
      return;
    }

    // Fallback to high-fidelity mock ONLY if developer explicitly requested Mock Mode
    const key = `${ticker}_${granularity}`;
    const granularitySec = GRANULARITIES.find(g => g.value === granularity)?.seconds || 60;
    
    setTickData(prev => {
      return { ...prev, [key]: generateMockHistory(ticker, granularitySec) };
    });
    setCandleData(prev => {
      return { ...prev, [key]: generateMockCandles(ticker, granularitySec) };
    });
    setDataSourceInfo({ isMock: true, source: "mock" });
  };

  useEffect(() => {
    if (selectedTicker) {
      fetchHistoricalData(selectedTicker, selectedGranularity, selectedInterval);
      if (selectedGranularity !== "1d") {
        fetchHistoricalData(selectedTicker, "1d", "30m");
      }
    }
  }, [selectedTicker, selectedGranularity, selectedInterval, forceMockMode]);

  // Pre-fetch 1d market data for all watchlist subscriptions so real prices display immediately
  useEffect(() => {
    if (subscriptions.length > 0) {
      subscriptions.forEach(sym => {
        const key = `${sym}_1d`;
        if (!candleData[key] && !tickData[key]) {
          fetchHistoricalData(sym, "1d", "30m");
        }
      });
    }
  }, [subscriptions, forceMockMode]);

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
    if (ws.readyState === 1) {
      setIsWsConnected(true);
    }

    ws.onopen = () => {
      addLog("WebSocket link established successfully with BFF.");
      setIsReconnecting(false);
      setIsWsConnected(true);
      resyncData();
      setOrderToast("🟢 NETWORK RESTORED: Connected to live market data feed");
      setTimeout(() => setOrderToast(null), 3500);
    };

    ws.onmessage = (event) => {
      setIsWsConnected(true);
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
          const key = `${t.sym}_${selectedGranularity}`;
          const granularitySec = GRANULARITIES.find(g => g.value === selectedGranularity)?.seconds || 60;
          
          setTickData(prev => {
            const currentTicks = prev[key] || [];
            const lastTick = currentTicks[currentTicks.length - 1];
            
            let newTicks;
            if (lastTick && Math.floor(lastTick.time / granularitySec) === Math.floor(tickTime / granularitySec)) {
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
              [key]: newTicks
            };
          });

          setCandleData(prev => {
            const currentCandles = prev[key] || [];
            const lastCandle = currentCandles[currentCandles.length - 1];
            
            let newCandles;
            if (lastCandle && Math.floor(lastCandle.time / granularitySec) === Math.floor(tickTime / granularitySec)) {
              lastCandle.close = t.p;
              if (t.p > lastCandle.high) lastCandle.high = t.p;
              if (t.p < lastCandle.low) lastCandle.low = t.p;
              newCandles = [...currentCandles];
            } else {
              newCandles = [...currentCandles, { time: tickTime, open: t.p, high: t.p, low: t.p, close: t.p }];
            }
            
            if (newCandles.length > 500) {
              newCandles = newCandles.slice(-500);
            }
            
            return {
              ...prev,
              [key]: newCandles
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
      setIsWsConnected(false);
      setIsReconnecting(true);
      setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
      setIsWsConnected(false);
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

  const clearSimulatedTrades = () => {
    setTrades([]);
    addLog(`Cleared all simulated trade execution markers for ${selectedTicker || 'all symbols'}`);
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
      addLog(`Failed to switch MDG Vendor: ${err}`);
    }
  };

  const saveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    try {
      const resp = await fetch("/api/mdg/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_api_key", api_key: apiKeyInput.trim() }),
      });
      if (resp.ok) {
        addLog(`Market Data Feed API Key saved to system.`);
        setApiKeyInput("");
        setForceMockMode(false);
        if (selectedTicker) {
          fetchHistoricalData(selectedTicker, selectedGranularity, selectedInterval);
        }
      }
    } catch (err) {
      addLog(`Failed to save API Key: ${err}`);
    }
  };

  const selectAlpacaFeed = async (mode: string) => {
    try {
      const resp = await fetch("/api/mdg/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_alpaca_feed", feed: mode }),
      });
      if (resp.ok) {
        setAlpacaFeedMode(mode);
        addLog(`Alpaca feed mode set to: ${mode.toUpperCase()}`);
        if (selectedTicker) {
          fetchHistoricalData(selectedTicker, selectedGranularity, selectedInterval);
        }
      }
    } catch (err) {
      addLog(`Failed to switch Alpaca feed mode: ${err}`);
    }
  };

  const executeSimulatedTrade = async (action: "BUY" | "SELL") => {
    if (!selectedTicker) {
      addLog("Cannot execute trade: No symbol selected");
      return;
    }
    const key = `${selectedTicker}_${selectedGranularity}`;
    const ticks = tickData[key] || [];
    const candles = candleData[key] || [];
    
    if (chartType === "line" && ticks.length === 0) {
      addLog(`Cannot execute trade: No price data available for ${selectedTicker}`);
      return;
    }
    if (chartType === "candlestick" && candles.length === 0) {
      addLog(`Cannot execute trade: No price data available for ${selectedTicker}`);
      return;
    }

    const currentPrice = chartType === "line" ? ticks[ticks.length - 1].value : candles[candles.length - 1].close;
    const qtyToUse = customQty > 0 ? customQty : 100;
    try {
      const resp = await fetch("/api/mdg/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedTicker,
          price: currentPrice,
          qty: qtyToUse,
          action: action,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const msg = `Simulated execution recorded: ${action} ${qtyToUse} ${selectedTicker} @ $${currentPrice.toFixed(2)}`;
        addLog(msg);
        setOrderToast(`✓ ${action} ${qtyToUse} ${selectedTicker} @ $${currentPrice.toFixed(2)}`);
        setTimeout(() => setOrderToast(null), 2500);
      }
    } catch (err) {
      addLog(`Failed to record simulated execution: ${err}`);
    }
  };

  // Lightweight Charts setup
  useEffect(() => {
    if (chartContainerRef.current) {
      try {
        const formatTickMark = (timeSec: number) => {
          const date = new Date(timeSec * 1000);
          const isDaily = checkIsDailyOrHigher(selectedGranularity, selectedInterval);
          if (isDaily) {
            return date.toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              month: "numeric",
              day: "numeric",
            });
          }
          return date.toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        };

        const formatTooltipTime = (timeSec: any) => {
          const ts = typeof timeSec === 'number' ? timeSec : (timeSec && timeSec.timestamp) ? timeSec.timestamp : 0;
          const date = new Date(ts * 1000);
          const isDaily = checkIsDailyOrHigher(selectedGranularity, selectedInterval);
          const timeET = date.toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          if (isDaily || timeET === "00:00:00" || timeET === "24:00:00") {
            return date.toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              month: "numeric",
              day: "numeric",
              year: "numeric",
            });
          }
          const dStr = date.toLocaleDateString("en-US", {
            timeZone: "America/New_York",
            month: "numeric",
            day: "numeric",
            year: "numeric",
          });
          return `${dStr}, ${timeET}`;
        };

        const isDailyInitial = checkIsDailyOrHigher(selectedGranularity, selectedInterval);
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
            timeVisible: !isDailyInitial,
            secondsVisible: false,
            borderColor: 'rgba(255, 255, 255, 0.1)',
            rightOffset: 0,
            fixLeftEdge: true,
            fixRightEdge: true,
            tickMarkFormatter: (timeSec: number) => formatTickMark(timeSec),
          },
          localization: {
            timeFormatter: (timeSec: any) => formatTooltipTime(timeSec),
          }
        });

        let series;
        if (chartType === "line") {
          series = chart.addSeries(LineSeries, {
            color: '#0a84ff',
            lineWidth: 2,
            priceLineVisible: true,
          });
        } else {
          series = chart.addSeries(CandlestickSeries, {
            upColor: '#30d158',
            downColor: '#ff453a',
            borderVisible: false,
            wickVisible: true,
          });
        }

        chartRef.current = chart;
        setActiveSeries(series);
        seriesMarkersRef.current = createSeriesMarkers(series, []);

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
  }, [chartType]);

  // When returning to Trading Terminal tab, re-apply width options without re-creating chart or resetting viewport
  useEffect(() => {
    if (activeTab === "terminal" && chartContainerRef.current && chartRef.current) {
      try {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      } catch (e) {
        // ignore
      }
    }
  }, [activeTab]);

  // Flag viewport fitting whenever ticker, granularity, bar interval, or chart type changes
  useEffect(() => {
    shouldFitContentRef.current = true;
    if (chartRef.current) {
      const isDailyOrHigher = checkIsDailyOrHigher(selectedGranularity, selectedInterval);
      try {
        chartRef.current.applyOptions({
          timeScale: {
            timeVisible: !isDailyOrHigher,
            tickMarkFormatter: (timeSec: number) => {
              const date = new Date(timeSec * 1000);
              if (isDailyOrHigher) {
                return date.toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                  month: "numeric",
                  day: "numeric",
                });
              }
              return date.toLocaleTimeString("en-US", {
                timeZone: "America/New_York",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
            },
          },
          localization: {
            timeFormatter: (timeSec: any) => {
              const ts = typeof timeSec === 'number' ? timeSec : (timeSec && timeSec.timestamp) ? timeSec.timestamp : 0;
              const date = new Date(ts * 1000);
              const timeET = date.toLocaleTimeString("en-US", {
                timeZone: "America/New_York",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              });
              if (isDailyOrHigher || timeET === "00:00:00" || timeET === "24:00:00") {
                return date.toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                  month: "numeric",
                  day: "numeric",
                  year: "numeric",
                });
              }
              const dStr = date.toLocaleDateString("en-US", {
                timeZone: "America/New_York",
                month: "numeric",
                day: "numeric",
                year: "numeric",
              });
              return `${dStr}, ${timeET}`;
            },
          }
        });
      } catch (e) {
        // ignore
      }
    }
  }, [selectedTicker, selectedGranularity, selectedInterval, chartType]);

  // Update active series tick/candle data & execution markers
  useEffect(() => {
    if (activeSeries && chartRef.current) {
      const key = `${selectedTicker}_${selectedGranularity}`;
      const currentSeriesType = typeof activeSeries.seriesType === "function" ? activeSeries.seriesType() : null;
      if (currentSeriesType) {
        if (chartType === "line" && currentSeriesType !== "Line") return;
        if (chartType === "candlestick" && currentSeriesType !== "Candlestick") return;
      }

      let hasData = false;
      if (chartType === "line") {
        const data = tickData[key] || [];
        activeSeries.setData(data);
        hasData = data.length > 0;
      } else {
        const data = candleData[key] || [];
        activeSeries.setData(data);
        hasData = data.length > 0;
      }

      // Re-fit chart viewport ONLY when user switches granularity/interval/symbol AND new data has populated
      if (shouldFitContentRef.current && hasData) {
        shouldFitContentRef.current = false;
        if (chartRef.current) {
          try {
            chartRef.current.timeScale().fitContent();
          } catch (e) {
            // ignore fitContent error on unmounted chart
          }
        }
      }

      if (!showTradeMarkers) {
        if (seriesMarkersRef.current) {
          seriesMarkersRef.current.setMarkers([]);
        }
      } else {
        const currentCandles = candleData[key] || [];
        const markers = aggregateTradeMarkers(trades, selectedTicker, currentCandles);
        if (seriesMarkersRef.current) {
          seriesMarkersRef.current.setMarkers(markers);
        }
      }
    }
  }, [selectedTicker, selectedGranularity, tickData, candleData, trades, activeSeries, chartType]);

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

  const periodInfo = getPeriodChangeInfo();
  const baseStats = getStockStats(selectedTicker);
  const intradayKey = `${selectedTicker}_1d`;
  const intradayCandles = candleData[intradayKey] || [];
  const activeKey = `${selectedTicker}_${selectedGranularity}`;
  const rawDataForStats = tickData[activeKey] || tickData[intradayKey] || [];
  const pricesForStats = rawDataForStats.map(d => d.value);
  const currentRsi = calculateRSI(pricesForStats);

  let openPrice = (forceMockMode || dataSourceInfo.isMock) ? baseStats.open : 0;
  let dailyHigh = (forceMockMode || dataSourceInfo.isMock) ? baseStats.high : 0;
  let dailyLow = (forceMockMode || dataSourceInfo.isMock) ? baseStats.low : 0;

  if (intradayCandles.length > 0) {
    openPrice = intradayCandles[0].open;
    dailyHigh = Math.max(...intradayCandles.map(b => b.high));
    dailyLow = Math.min(...intradayCandles.map(b => b.low));
  }

  const currentPrice = periodInfo.currentPrice;
  const wHigh = currentPrice > 0 ? Math.max(currentPrice, dailyHigh, baseStats.wHigh) : baseStats.wHigh;
  const wLow = (currentPrice > 0 && dailyLow > 0) ? Math.min(currentPrice, dailyLow, baseStats.wLow) : baseStats.wLow;

  const keyStats = {
    ...baseStats,
    currentPrice,
    open: openPrice,
    high: dailyHigh,
    low: dailyLow,
    wHigh,
    wLow,
  };
  const currentStockStats = keyStats;
  const cleanSessionLabel = marketInfo.label.replace(/^[\p{Emoji}\s●]+/u, '').trim();
  const currentExecCount = (Array.isArray(trades) ? trades : []).filter(t => t && t.symbol === selectedTicker).length;

  return (
    <div style={styles.container}>
      <style>{`
        .tv-lightweight-charts a,
        [class*="tv-lightweight-charts"] a,
        a[href*="tradingview"],
        div[class*="lightweight-charts"] a {
          display: none !important;
          pointer-events: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
        }
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
          {!isOnline ? (
            <span className="pulse-dot-red" style={{
              ...styles.statusBadge,
              backgroundColor: "rgba(255, 69, 58, 0.15)",
              border: "1px solid rgba(255, 69, 58, 0.3)",
              color: "#ff453a",
            }}>
              🔴 LOCAL WI-FI DISCONNECTED
            </span>
          ) : (!isWsConnected || isReconnecting) && !dataSourceInfo.isMock ? (
            <span className="pulse-dot-red" style={{
              ...styles.statusBadge,
              backgroundColor: "rgba(255, 69, 58, 0.15)",
              border: "1px solid rgba(255, 69, 58, 0.3)",
              color: "#ff453a",
            }}>
              🔴 ISP / GATEWAY UNREACHABLE
            </span>
          ) : (
            <span className="pulse-dot-green" style={{
              ...styles.statusBadge,
              backgroundColor: circuitState === "RUNNING" ? "rgba(48, 209, 88, 0.15)" : circuitState === "PAUSED" ? "rgba(255, 159, 10, 0.15)" : "rgba(255, 69, 58, 0.15)",
              border: `1px solid ${circuitState === "RUNNING" ? "rgba(48, 209, 88, 0.3)" : circuitState === "PAUSED" ? "rgba(255, 159, 10, 0.3)" : "rgba(255, 69, 58, 0.3)"}`,
              color: circuitState === "RUNNING" ? "#30d158" : circuitState === "PAUSED" ? "#ff9f0a" : "#ff453a",
            }}>
              {circuitState}
            </span>
          )}
        </div>
      </header>

      {/* Navigation Tab Bar */}
      <div style={{ display: 'flex', gap: '20px', padding: '0 8px', marginBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          onClick={() => setActiveTab("terminal")}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: activeTab === "terminal" ? '2px solid #0a84ff' : '2px solid transparent',
            color: activeTab === "terminal" ? '#0a84ff' : '#aeaeb2',
            padding: '12px 16px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          📈 Trading Terminal
        </button>
        <button
          onClick={() => setActiveTab("admin")}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: activeTab === "admin" ? '2px solid #0a84ff' : '2px solid transparent',
            color: activeTab === "admin" ? '#0a84ff' : '#aeaeb2',
            padding: '12px 16px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          ⚙️ Ingestion & Systems Admin
        </button>
      </div>

      <div data-testid="terminal-tab-panel" style={{ display: activeTab === "terminal" ? 'grid' : 'none', gridTemplateColumns: '3fr 1fr', gap: '24px', flexGrow: 1, marginBottom: '32px' }}>
          
          {/* Left Chart & Stats Area */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* Chart Card */}
            <div style={styles.card}>

              {/* Robinhood Stock Title & Price Header */}
              {selectedTicker && (
                <div style={{ marginBottom: '20px' }}>
                  {/* Status Badges Row above Stock Title */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'nowrap' }} data-testid="header-status-tags-bar">
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '3px 8px',
                      borderRadius: '12px',
                      backgroundColor: marketInfo.badgeBg,
                      color: marketInfo.badgeColor,
                      border: `1px solid ${marketInfo.badgeBorder}`,
                      whiteSpace: 'nowrap',
                      lineHeight: 1,
                    }}>
                      {marketInfo.label}
                    </span>
                    {!isOnline || (!isWsConnected && !dataSourceInfo.isMock) || isReconnecting ? (
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: '12px',
                        backgroundColor: 'rgba(255, 69, 58, 0.15)',
                        color: '#ff453a',
                        border: '1px solid rgba(255, 69, 58, 0.35)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        whiteSpace: 'nowrap',
                        lineHeight: 1,
                      }} title="Network connection is offline. Live market feeds are currently paused.">
                        <span>📡 DISCONNECTED ({!isOnline ? 'WI-FI OFFLINE' : 'ISP/SERVER DOWN'})</span>
                      </span>
                    ) : dataSourceInfo.isMock ? (
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: '12px',
                        backgroundColor: 'rgba(255, 159, 10, 0.15)',
                        color: '#ff9f0a',
                        border: '1px solid rgba(255, 159, 10, 0.35)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        whiteSpace: 'nowrap',
                        lineHeight: 1,
                      }} title="Currently displaying simulated mock bars. Configure Polygon/Alpaca API keys in Admin tab for live feeds.">
                        <span>⚠️ MOCK DATA MODE</span>
                      </span>
                    ) : (
                      <>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: '12px',
                          backgroundColor: 'rgba(48, 209, 88, 0.15)',
                          color: '#30d158',
                          border: '1px solid rgba(48, 209, 88, 0.35)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          whiteSpace: 'nowrap',
                          lineHeight: 1,
                        }} title="Currently displaying real-time market data from Polygon / Alpaca APIs.">
                          <span>⚡ REAL LIVE DATA ({dataSourceInfo.source.toUpperCase()})</span>
                        </span>
                        {dataSourceInfo.source === "alpaca" && (
                          <span style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '12px',
                            backgroundColor: 'rgba(10, 132, 255, 0.15)',
                            color: '#0a84ff',
                            border: '1px solid rgba(10, 132, 255, 0.35)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            whiteSpace: 'nowrap',
                            lineHeight: 1,
                          }} title="Alpaca Market Data Feed Mode (--alpaca-feed). Free accounts use IEX feed (~2-3% vol). Paid Unlimited accounts receive 100% NBBO SIP feed.">
                            <span>📊 {alpacaFeedLabel.replace(' (Auto-Fallback 2% Vol)', ' (Auto-Fallback)').replace(' (Free 2% Vol)', '').replace(' (Paid 100% NBBO)', '')}</span>
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h2 style={{ fontSize: '28px', fontWeight: 700, color: '#ffffff', margin: 0, letterSpacing: '-0.5px', whiteSpace: 'nowrap' }}>
                      {currentStockStats.name} ({selectedTicker})
                    </h2>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <button
                        className="apple-btn"
                        onClick={() => setShowTradeMarkers(prev => !prev)}
                        style={{
                          backgroundColor: showTradeMarkers ? 'rgba(10, 132, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                          border: `1px solid ${showTradeMarkers ? 'rgba(10, 132, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
                          color: showTradeMarkers ? '#0a84ff' : '#aeaeb2',
                          borderRadius: '10px',
                          padding: '6px 12px',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          whiteSpace: 'nowrap',
                        }}
                        title="Toggle display of Buy/Sell trade execution markers on the chart"
                      >
                        <span>{showTradeMarkers ? '👁️ Markers ON' : '🙈 Markers OFF'}</span>
                      </button>
                      {/* TradingView Bar Interval Dropdown */}
                      <select
                        value={selectedInterval}
                        onChange={(e) => setSelectedInterval(e.target.value)}
                        style={{ ...styles.dropdown, backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.12)' }}
                      >
                        <optgroup label="⏱️ SECONDS">
                          {INTERVAL_OPTIONS.filter(i => i.category === "SECONDS").map(i => (
                            <option key={i.value} value={i.value}>{i.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="⏱️ MINUTES">
                          {INTERVAL_OPTIONS.filter(i => i.category === "MINUTES").map(i => (
                            <option key={i.value} value={i.value}>{i.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="⏳ HOURS">
                          {INTERVAL_OPTIONS.filter(i => i.category === "HOURS").map(i => (
                            <option key={i.value} value={i.value}>{i.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="📅 DAYS / MONTHS">
                          {INTERVAL_OPTIONS.filter(i => i.category === "DAYS / MONTHS").map(i => (
                            <option key={i.value} value={i.value}>{i.label}</option>
                          ))}
                        </optgroup>
                      </select>

                      {/* Dropdown for Line / Candlestick */}
                      <select
                        value={chartType}
                        onChange={(e) => setChartType(e.target.value as "line" | "candlestick")}
                        style={styles.dropdown}
                      >
                        <option value="line">📈 Line</option>
                        <option value="candlestick">🕯️ Candlestick</option>
                      </select>
                    </div>
                  </div>

                  {/* Yahoo Finance Style Dual-Price Header (Regular Close vs Off-Hours Live Price) */}
                  {marketInfo.isClosed ? (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '32px', marginTop: '6px', flexWrap: 'wrap' }} data-testid="dual-price-header">
                      {/* Card 1: Regular Market Close */}
                      <div>
                        <div style={{ fontSize: '32px', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.8px' }}>
                          ${periodInfo.closePrice.toFixed(2)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                          <span style={{
                            fontSize: '14px',
                            fontWeight: 600,
                            color: periodInfo.isClosePositive ? '#30d158' : '#ff453a'
                          }}>
                            {periodInfo.isClosePositive ? '▲ +' : '▼ -'}${Math.abs(periodInfo.closeChange).toFixed(2)} ({periodInfo.isClosePositive ? '+' : ''}{periodInfo.closePercent.toFixed(2)}%)
                          </span>
                          <span style={{ fontSize: '12px', color: '#8e8e93', fontWeight: 500 }}>
                            At close: 4:00 PM EDT
                          </span>
                        </div>
                      </div>

                      {/* Card 2: Off-Hours / Night Live Price */}
                      <div style={{
                        paddingLeft: '24px',
                        borderLeft: '1px solid rgba(255, 255, 255, 0.12)',
                      }}>
                        {periodInfo.currentPrice > 0 ? (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '28px', fontWeight: 700, color: '#f5f5f7', letterSpacing: '-0.6px' }}>
                                ${periodInfo.currentPrice.toFixed(2)}
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                              <span style={{
                                fontSize: '14px',
                                fontWeight: 600,
                                color: periodInfo.isOffHoursPositive ? '#30d158' : '#ff453a'
                              }}>
                                {periodInfo.isOffHoursPositive ? '▲ +' : '▼ -'}${Math.abs(periodInfo.offHoursChange).toFixed(2)} ({periodInfo.isOffHoursPositive ? '+' : ''}{periodInfo.offHoursPercent.toFixed(2)}%)
                              </span>
                              <span style={{ fontSize: '12px', color: '#8e8e93', fontWeight: 500 }}>
                                {marketInfo.sessionType === 'NIGHT' ? 'Overnight' : 'After-Hours'}: {new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: '2-digit', minute: '2-digit', second: '2-digit' })} EDT
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: '28px', fontWeight: 700, color: '#8e8e93', letterSpacing: '-0.6px' }}>
                              --.--
                            </div>
                            <div style={{ fontSize: '12px', color: '#8e8e93', fontWeight: 500, marginTop: '2px' }}>
                              No Off-Hours Live Feed Data
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Standard Single Big Price Display for Regular Market Hours */
                    <div>
                      <div style={{ fontSize: '38px', fontWeight: 700, color: '#ffffff', marginTop: '4px', letterSpacing: '-0.8px' }}>
                        ${periodInfo.currentPrice > 0 ? periodInfo.currentPrice.toFixed(2) : currentStockStats.open.toFixed(2)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                        <span style={{
                          fontSize: '15px',
                          fontWeight: 600,
                          color: periodInfo.isPositive ? '#30d158' : '#ff453a'
                        }}>
                          {periodInfo.isPositive ? '▲ +' : '▼ -'}${Math.abs(periodInfo.change).toFixed(2)} ({periodInfo.isPositive ? '+' : ''}{periodInfo.percent.toFixed(2)}%)
                        </span>
                        <span style={{ fontSize: '13px', color: '#8e8e93', fontWeight: 500 }}>
                          {periodInfo.label}
                        </span>
                      </div>
                    </div>
                  )}
                  {dataSourceInfo.isMock && (
                    <div style={{
                      backgroundColor: 'rgba(255, 159, 10, 0.1)',
                      border: '1px solid rgba(255, 159, 10, 0.25)',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      color: '#ff9f0a',
                      fontSize: '13px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginTop: '12px',
                    }}>
                      <span>⚠️ <strong>DEV / MOCK DATA MODE ACTIVE:</strong> Currently displaying simulated pricing bars because no live market API key is set or Mock Mode is explicitly enabled. Configure your Polygon.io or Alpaca API key in the Admin tab for real-time market data.</span>
                    </div>
                  )}
                  {!dataSourceInfo.isMock && (candleData[`${selectedTicker}_${selectedGranularity}`] || []).length === 0 && (
                    <div style={{
                      backgroundColor: 'rgba(255, 69, 58, 0.1)',
                      border: '1px solid rgba(255, 69, 58, 0.25)',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      color: '#ff453a',
                      fontSize: '13px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginTop: '12px',
                    }}>
                      <span>⚠️ <strong>NO REAL-TIME MARKET FEED DATA:</strong> No market feed bars returned for {selectedTicker} ({selectedGranularity}). Strict No-Mock Fallback is active (mock data fallback disabled).</span>
                    </div>
                  )}
                </div>
              )}

              {(!isOnline || (!isWsConnected && !dataSourceInfo.isMock) || isReconnecting) && (
                <div style={{
                  backgroundColor: 'rgba(255, 69, 58, 0.12)',
                  border: '1px solid rgba(255, 69, 58, 0.3)',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  color: '#ff453a',
                  fontSize: '13px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '16px',
                }} data-testid="offline-banner">
                  <span>📡 <strong>CONNECTION LOST:</strong> {!isOnline ? 'Local Wi-Fi or network adapter is offline.' : 'ISP or server gateway is unreachable.'} Live market price ticks are paused and cached prices are marked as STALE.</span>
                </div>
              )}

              {marketInfo.isClosed && (
                <div style={{
                  backgroundColor: 'rgba(10, 132, 255, 0.08)',
                  border: '1px solid rgba(10, 132, 255, 0.2)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  color: '#0a84ff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '16px',
                }}>
                  <span>🌙</span>
                  <span>Off-hours session active ({cleanSessionLabel || marketInfo.sessionType}). {dataSourceInfo.isMock ? 'Displaying simulated off-hours session bars.' : 'Displaying real historical session bars from recent market open & night trading.'}</span>
                </div>
              )}

              {/* Canvas Container */}
              <div ref={chartContainerRef} style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', overflow: 'hidden' }} />

              {/* Robinhood Bottom Timeframe Selector Bar */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginTop: '16px',
                paddingTop: '8px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                overflowX: 'auto',
              }}>
                {GRANULARITIES.map(g => {
                  const isSelected = selectedGranularity === g.value;
                  return (
                    <button
                      key={g.value}
                      onClick={() => {
                        setSelectedGranularity(g.value);
                        const recMap: Record<string, string> = {
                          '1d': '15m',
                          '1w': '1h',
                          '1M': '1d',
                          '3M': '1d',
                          'ytd': '1d',
                          '1y': '1d',
                          '5y': '1w',
                          'all': '1w',
                        };
                        if (recMap[g.value]) {
                          setSelectedInterval(recMap[g.value]);
                        }
                      }}
                      className="apple-btn"
                      style={{
                        background: 'none',
                        border: 'none',
                        borderBottom: isSelected ? '3px solid #30d158' : '3px solid transparent',
                        color: isSelected ? '#30d158' : '#8e8e93',
                        fontSize: '14px',
                        fontWeight: isSelected ? 700 : 500,
                        padding: '6px 12px 8px 12px',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease-in-out',
                      }}
                    >
                      {g.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Key Statistics Grid */}
            <div style={styles.card}>
              <h3 style={{ ...styles.cardTitle, fontSize: '16px', marginBottom: '20px' }}>Key Statistics</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                <div style={styles.statBox}>
                  <span style={styles.statLabel}>Open Price</span>
                  <span style={styles.statValue}>${keyStats.open.toFixed(2)}</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statLabel}>Daily High / Low</span>
                  <span style={styles.statValue}>${keyStats.high.toFixed(2)} / ${keyStats.low.toFixed(2)}</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statLabel}>52-Week High / Low</span>
                  <span style={styles.statValue}>${keyStats.wHigh.toFixed(2)} / ${keyStats.wLow.toFixed(2)}</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statLabel}>P/E Ratio</span>
                  <span style={{ ...styles.statValue, color: '#0a84ff' }}>{keyStats.pe.toFixed(1)}x</span>
                </div>
                <div style={styles.statBox}>
                  <span style={styles.statLabel}>RSI (14)</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      ...styles.statValue,
                      color: parseFloat(currentRsi) > 70 ? '#ff453a' : parseFloat(currentRsi) < 30 ? '#30d158' : '#0a84ff'
                    }}>{currentRsi}</span>
                    {parseFloat(currentRsi) < 30 && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '6px', backgroundColor: 'rgba(48, 209, 88, 0.15)', color: '#30d158', border: '1px solid rgba(48, 209, 88, 0.3)' }}>Oversold</span>
                    )}
                    {parseFloat(currentRsi) > 70 && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '6px', backgroundColor: 'rgba(255, 69, 58, 0.15)', color: '#ff453a', border: '1px solid rgba(255, 69, 58, 0.3)' }}>Overbought</span>
                    )}
                    {parseFloat(currentRsi) >= 30 && parseFloat(currentRsi) <= 70 && (
                      <span style={{ fontSize: '10px', fontWeight: 500, padding: '2px 6px', borderRadius: '6px', backgroundColor: 'rgba(142, 142, 147, 0.15)', color: '#8e8e93', border: '1px solid rgba(142, 142, 147, 0.3)' }}>Neutral</span>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    ...styles.statBox,
                    cursor: currentExecCount > 0 ? 'pointer' : 'default',
                    transition: 'all 0.2s',
                  }}
                  onClick={() => {
                    if (currentExecCount > 0 && Array.isArray(trades)) {
                      const symTrades = trades.filter(t => t && t.symbol === selectedTicker);
                      if (symTrades.length > 0) {
                        jumpChartToTrade(symTrades[symTrades.length - 1].timestamp);
                      }
                    }
                  }}
                  title={currentExecCount > 0 ? "Click to jump chart viewport to latest execution" : "No executions recorded yet"}
                >
                  <span style={styles.statLabel}>Trade Executions</span>
                  <span style={{ ...styles.statValue, color: currentExecCount > 0 ? '#30d158' : '#8e8e93' }}>
                    {currentExecCount} {currentExecCount === 1 ? 'execution' : 'executions'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Watchlist & Action Form */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* Quick Trade Form */}
            {selectedTicker && (
              <div style={{ ...styles.card, position: 'relative' }}>
                {orderToast && (
                  <div style={{
                    position: 'absolute',
                    top: '-14px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    backgroundColor: '#30d158',
                    color: '#000000',
                    fontWeight: 700,
                    fontSize: '12px',
                    padding: '4px 12px',
                    borderRadius: '12px',
                    boxShadow: '0 4px 12px rgba(48, 209, 88, 0.4)',
                    whiteSpace: 'nowrap',
                    zIndex: 10,
                  }}>
                    {orderToast}
                  </div>
                )}
                <h3 style={{ ...styles.cardTitle, fontSize: '16px', marginBottom: '14px' }}>Trade {selectedTicker}</h3>
                
                {/* Quantity Input Bar */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ fontSize: '12px', color: '#8e8e93', fontWeight: 500 }}>Order Quantity</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => setCustomQty(q => q + 100)}
                        style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '4px', color: '#0a84ff', fontSize: '11px', fontWeight: 600, padding: '2px 6px', cursor: 'pointer' }}
                      >+100</button>
                      <button
                        onClick={() => setCustomQty(q => q + 500)}
                        style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '4px', color: '#0a84ff', fontSize: '11px', fontWeight: 600, padding: '2px 6px', cursor: 'pointer' }}
                      >+500</button>
                      <button
                        onClick={() => setCustomQty(100)}
                        style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '4px', color: '#8e8e93', fontSize: '11px', fontWeight: 600, padding: '2px 6px', cursor: 'pointer' }}
                      >Reset</button>
                    </div>
                  </div>
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    value={customQty}
                    onChange={(e) => setCustomQty(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      backgroundColor: 'rgba(255, 255, 255, 0.06)',
                      border: '1px solid rgba(255, 255, 255, 0.12)',
                      borderRadius: '8px',
                      color: '#ffffff',
                      padding: '8px 12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      outline: 'none',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <button
                    className="apple-btn"
                    onClick={() => executeSimulatedTrade("BUY")}
                    style={{ ...styles.actionBtn, backgroundColor: 'rgba(48, 209, 88, 0.2)', border: '1px solid rgba(48,209,88,0.4)', color: '#30d158', width: '100%', height: '40px', fontSize: '13px', fontWeight: 600 }}
                  >
                    🟢 SIMULATE BUY {customQty}
                  </button>
                  <button
                    className="apple-btn"
                    onClick={() => executeSimulatedTrade("SELL")}
                    style={{ ...styles.actionBtn, backgroundColor: 'rgba(255, 69, 58, 0.2)', border: '1px solid rgba(255,69,58,0.4)', color: '#ff453a', width: '100%', height: '40px', fontSize: '13px', fontWeight: 600 }}
                  >
                    🔴 SIMULATE SELL {customQty}
                  </button>
                  <button
                    className="apple-btn"
                    onClick={clearSimulatedTrades}
                    disabled={currentExecCount === 0}
                    style={{
                      ...styles.actionBtn,
                      backgroundColor: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      color: '#8e8e93',
                      width: '100%',
                      height: '32px',
                      fontSize: '11px',
                      fontWeight: 600,
                      marginTop: '4px',
                      opacity: currentExecCount === 0 ? 0.4 : 1,
                      cursor: currentExecCount === 0 ? 'not-allowed' : 'pointer',
                    }}
                    title={currentExecCount === 0 ? "No simulated trades to clear" : "Clear all simulated trade execution markers"}
                  >
                    🗑️ CLEAR SIMULATED TRADES
                  </button>
                </div>
              </div>
            )}

            {/* Watchlist */}
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <h3 style={{ ...styles.cardTitle, fontSize: '16px', margin: 0 }}>Watchlist</h3>
                <span style={{ fontSize: '12px', color: '#8e8e93', fontWeight: 500 }}>{subscriptions.length} tickers</span>
              </div>

              {/* Quick Add Ticker Input Bar */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                <input
                  type="text"
                  placeholder="Add stock (e.g. NVDA)"
                  value={newTickerInput}
                  onChange={(e) => setNewTickerInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newTickerInput.trim()) {
                      addSubscription(newTickerInput.trim());
                    }
                  }}
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '8px',
                    color: '#ffffff',
                    padding: '6px 10px',
                    fontSize: '12px',
                    flexGrow: 1,
                    outline: 'none',
                  }}
                />
                <button
                  className="apple-btn"
                  onClick={() => {
                    if (newTickerInput.trim()) {
                      addSubscription(newTickerInput.trim());
                    }
                  }}
                  style={{
                    backgroundColor: '#30d158',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  + Add
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {subscriptions.map(sym => {
                  let latestPrice = 0.0;
                  let openPrice = 0.0;

                  for (const gran of ['1d', '1w', '1M', '3M', 'ytd', '1y', '5y', 'all']) {
                    const key = `${sym}_${gran}`;
                    const candles = candleData[key];
                    if (candles && candles.length > 0) {
                      latestPrice = candles[candles.length - 1].close;
                      openPrice = candles[0].open;
                      break;
                    }
                    const ticks = tickData[key];
                    if (ticks && ticks.length > 0) {
                      latestPrice = ticks[ticks.length - 1].value;
                      openPrice = ticks[0].value;
                      break;
                    }
                  }

                  if (latestPrice === 0.0 && (forceMockMode || dataSourceInfo.isMock)) {
                    const stats = getStockStats(sym);
                    latestPrice = stats.currentPrice;
                    openPrice = stats.open;
                  }

                  const change = latestPrice - openPrice;
                  const changePercent = openPrice > 0 ? (change / openPrice) * 100 : 0.0;
                  const isUp = change >= 0;
                  const isOffline = !isOnline || isReconnecting || (!isWsConnected && !dataSourceInfo.isMock);
                  
                  return (
                    <div
                      key={sym}
                      onClick={() => setSelectedTicker(sym)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        backgroundColor: selectedTicker === sym ? 'rgba(10, 132, 255, 0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${selectedTicker === sym ? 'rgba(10, 132, 255, 0.3)' : 'transparent'}`,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        opacity: isOffline ? 0.8 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, color: '#ffffff' }}>{sym}</span>
                        {isOffline && (
                          <span style={{
                            fontSize: '9px',
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(255, 69, 58, 0.2)',
                            color: '#ff453a',
                            border: '1px solid rgba(255, 69, 58, 0.3)',
                          }}>
                            OFFLINE
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                          <span style={{ fontSize: '14px', fontWeight: 600, color: isOffline ? '#8e8e93' : '#ffffff' }}>
                            {latestPrice > 0 ? `$${latestPrice.toFixed(2)}` : '--.--'}
                          </span>
                          <span style={{ fontSize: '11px', color: isOffline ? '#8e8e93' : (latestPrice > 0 ? (isUp ? '#30d158' : '#ff453a') : '#8e8e93') }}>
                            {latestPrice > 0 ? `${isUp ? '+' : ''}${changePercent.toFixed(2)}%` : (isOffline ? 'Offline' : 'Loading...')}
                          </span>
                        </div>
                        <button
                          className="apple-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSubscription(sym);
                          }}
                          style={{
                            background: 'rgba(255, 255, 255, 0.06)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            color: '#8e8e93',
                            fontSize: '12px',
                            cursor: 'pointer',
                            padding: '3px 7px',
                            borderRadius: '6px',
                            lineHeight: 1,
                          }}
                          title={`Remove ${sym} from Watchlist`}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </div>

      <div data-testid="admin-tab-panel" style={{ display: activeTab === "admin" ? 'block' : 'none' }}>
          {/* Section 1: Market Data Ingestion Console (MDG) */}
          <section style={{ ...styles.card, marginBottom: '32px' }}>
            <h2 style={styles.cardTitle}>Market Data Ingestion Console (MDG)</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
              
              {/* Controls Column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={styles.ctrlGroup}>
                  <span style={styles.ctrlLabel}>Data Source Engine Mode:</span>
                  <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                    <button
                      className="apple-btn"
                      onClick={() => {
                        setForceMockMode(false);
                        addLog("Data source engine set to: REAL LIVE MARKET FEED");
                      }}
                      style={{
                        ...styles.actionBtn,
                        backgroundColor: !forceMockMode ? "#30d158" : "rgba(255,255,255,0.05)",
                        color: !forceMockMode ? "#ffffff" : "#aeaeb2",
                        border: !forceMockMode ? "none" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      ⚡ Real Market Feed
                    </button>
                    <button
                      className="apple-btn"
                      onClick={() => {
                        setForceMockMode(true);
                        addLog("Data source engine set to: SIMULATED MOCK MODE (Dev/Testing)");
                      }}
                      style={{
                        ...styles.actionBtn,
                        backgroundColor: forceMockMode ? "#ff9f0a" : "rgba(255,255,255,0.05)",
                        color: forceMockMode ? "#ffffff" : "#aeaeb2",
                        border: forceMockMode ? "none" : "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      ⚠️ Force Simulated Mock Mode
                    </button>
                  </div>
                </div>

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
                  <span style={styles.ctrlLabel}>Market Data API Key:</span>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                    <input
                      type="password"
                      placeholder={activeVendor === "alpaca" ? "KEY_ID:SECRET_KEY" : "Polygon API Key"}
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && apiKeyInput.trim()) {
                          saveApiKey();
                        }
                      }}
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        borderRadius: '8px',
                        color: '#ffffff',
                        padding: '6px 12px',
                        fontSize: '13px',
                        flexGrow: 1,
                        outline: 'none',
                      }}
                    />
                    <button
                      className="apple-btn"
                      onClick={saveApiKey}
                      style={{
                        ...styles.actionBtn,
                        backgroundColor: '#0a84ff',
                        color: '#ffffff',
                      }}
                    >
                      Save Key
                    </button>
                  </div>

                  {activeVendor === "alpaca" && (
                    <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px dashed rgba(255, 255, 255, 0.1)' }}>
                      <span style={styles.ctrlLabel}>Alpaca Market Data Feed Mode (--alpaca-feed):</span>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                        <button
                          className="apple-btn"
                          onClick={() => selectAlpacaFeed("auto")}
                          style={{
                            ...styles.actionBtn,
                            backgroundColor: alpacaFeedMode === "auto" ? "#0a84ff" : "rgba(255,255,255,0.05)",
                            border: alpacaFeedMode === "auto" ? "none" : "1px solid rgba(255,255,255,0.08)",
                            color: alpacaFeedMode === "auto" ? "#ffffff" : "#aeaeb2",
                          }}
                          title="Auto Mode: Tries SIP NBBO feed first; automatically falls back to IEX for free paper keys"
                        >
                          🔄 Auto (SIP ➔ IEX Fallback)
                        </button>
                        <button
                          className="apple-btn"
                          onClick={() => selectAlpacaFeed("sip")}
                          style={{
                            ...styles.actionBtn,
                            backgroundColor: alpacaFeedMode === "sip" ? "#30d158" : "rgba(255,255,255,0.05)",
                            border: alpacaFeedMode === "sip" ? "none" : "1px solid rgba(255,255,255,0.08)",
                            color: alpacaFeedMode === "sip" ? "#ffffff" : "#aeaeb2",
                          }}
                          title="SIP Feed: Requires Alpaca Unlimited Subscription ($99/mo). 100% US Stock Volume & Real-time NBBO."
                        >
                          ⚡ SIP Feed (Paid 100% NBBO)
                        </button>
                        <button
                          className="apple-btn"
                          onClick={() => selectAlpacaFeed("iex")}
                          style={{
                            ...styles.actionBtn,
                            backgroundColor: alpacaFeedMode === "iex" ? "#ff9f0a" : "rgba(255,255,255,0.05)",
                            border: alpacaFeedMode === "iex" ? "none" : "1px solid rgba(255,255,255,0.08)",
                            color: alpacaFeedMode === "iex" ? "#ffffff" : "#aeaeb2",
                          }}
                          title="IEX Feed: Included with all Alpaca Free / Paper accounts. ~2-3% of total US stock volume."
                        >
                          🆓 IEX Feed (Free 2% Vol)
                        </button>
                      </div>

                      {/* Educational Callout */}
                      <div style={{
                        marginTop: '12px',
                        padding: '12px',
                        borderRadius: '8px',
                        backgroundColor: 'rgba(10, 132, 255, 0.08)',
                        border: '1px solid rgba(10, 132, 255, 0.2)',
                        fontSize: '12px',
                        lineHeight: '1.6',
                        color: '#d1d1d6',
                      }}>
                        <div style={{ fontWeight: 700, color: '#0a84ff', marginBottom: '4px' }}>
                          ℹ️ Alpaca Market Data Feed Explained:
                        </div>
                        <div>• <strong>IEX Feed (Free)</strong>: Included in all Alpaca Paper/Free accounts. Captures ~2-3% of US stock volume. Ideal for dev, UI testing, and personal paper trading.</div>
                        <div>• <strong>SIP Feed (Paid)</strong>: Requires Alpaca Unlimited Plan ($99/mo). Captures 100% of US volume across all 16+ exchanges with real-time NBBO.</div>
                        <div>• <strong>Auto Mode (Default)</strong>: Automatically tries SIP first; if un-subscribed, seamlessly falls back to IEX to prevent 403 errors.</div>
                      </div>
                    </div>
                  )}
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
                  <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
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
              </div>

              {/* Subscriptions List Column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span style={styles.ctrlLabel}>Subscriptions ({subscriptions.length}):</span>
                <div className="scroll-container" style={{
                  maxHeight: '180px',
                  overflowY: 'auto',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(0,0,0,0.15)'
                }}>
                  {subscriptions.map(sym => (
                    <div
                      key={sym}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 16px',
                        borderBottom: '1px solid rgba(255,255,255,0.04)'
                      }}
                    >
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#f5f5f7' }}>
                        {sym} <span style={{ color: '#30d158', fontSize: '11px', marginLeft: '6px' }}>●</span>
                      </span>
                      <button
                        className="apple-btn"
                        onClick={() => removeSubscription(sym)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#ff453a',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        DELETE
                      </button>
                    </div>
                  ))}
                  {subscriptions.length === 0 && (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#8e8e93', fontSize: '13px' }}>
                      No active ticker subscriptions
                    </div>
                  )}
                </div>
              </div>

            </div>
          </section>

          {/* Microservices Health & Topology Matrix */}
          <main style={styles.mainGrid}>
            <section style={styles.leftCol}>
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Microservices Health & Topology</h2>
                <div style={styles.matrixContainer}>
                  {Object.entries(services).map(([name, svc]) => {
                    const isServing = svc.status === "SERVING";
                    const latencyLabel = isServing ? `${svc.latency_ms} ms` : "offline";
                    
                    return (
                      <div key={name} className="service-card" style={styles.serviceItem}>
                        <div style={styles.serviceMeta}>
                          <span style={styles.serviceName}>{name.toUpperCase()}</span>
                          <span style={styles.serviceLatency}>{latencyLabel}</span>
                        </div>
                        <div style={styles.statusRow}>
                          <span className={isServing ? "pulse-dot-green" : "pulse-dot-red"} style={{
                            ...styles.statusDot,
                            backgroundColor: isServing ? "#30d158" : "#ff453a",
                          }} />
                          <span style={{
                            ...styles.statusText,
                            color: isServing ? "#30d158" : "#ff453a",
                          }}>
                            {isServing ? "SERVING" : "INACTIVE (STRATEGY)"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {systemState === "DEGRADED" && (
                  <div style={styles.degradeWarning}>
                    <div style={styles.warningIcon}>⚠</div>
                    <div>
                      <strong>System Health Degraded:</strong> One or more critical microservices is reporting non-serving or extreme network latency. Automated risk control activated.
                    </div>
                  </div>
                )}
              </div>

              {/* Global Circuit Breaker Command Panel */}
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

            <section style={styles.rightCol}>
              {/* Dynamic Risk Control & Parameters */}
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Dynamic Risk Control & Parameters</h2>
                <div style={styles.paramGrid}>
                  <div style={styles.paramRow}>
                    <div style={styles.paramMeta}>
                      <span style={styles.paramName}>Max Position Limit (Qty)</span>
                      <span style={styles.paramVal}>{maxPosition}</span>
                    </div>
                    <input
                      type="range"
                      min="100"
                      max="2000"
                      step="50"
                      value={maxPosition}
                      onChange={(e) => publishConfig(parseInt(e.target.value), maxLeverage)}
                      style={styles.slider}
                    />
                  </div>

                  <div style={styles.paramRow}>
                    <div style={styles.paramMeta}>
                      <span style={styles.paramName}>Max Leverage Limit</span>
                      <span style={styles.paramVal}>{maxLeverage}x</span>
                    </div>
                    <input
                      type="range"
                      min="1.0"
                      max="5.0"
                      step="0.1"
                      value={maxLeverage}
                      onChange={(e) => publishConfig(maxPosition, parseFloat(e.target.value))}
                      style={styles.slider}
                    />
                  </div>
                </div>

                <div style={{ ...styles.ctrlGroup, marginTop: '24px' }}>
                  <span style={styles.ctrlLabel}>Active Strategies Hot-Loading</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 16px',
                      borderRadius: '10px',
                      backgroundColor: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.04)'
                    }}>
                      <span style={{ fontSize: '13px', fontWeight: 500 }}>Reinforcement Learning Strategy (RL)</span>
                      <span
                        onClick={() => setRlStrategyActive(!rlStrategyActive)}
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '4px 10px',
                          borderRadius: '8px',
                          backgroundColor: rlStrategyActive ? 'rgba(48, 209, 88, 0.15)' : 'rgba(255,255,255,0.05)',
                          color: rlStrategyActive ? '#30d158' : '#aeaeb2',
                          cursor: 'pointer'
                        }}
                      >
                        {rlStrategyActive ? "ACTIVE" : "INACTIVE"}
                      </span>
                    </div>

                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 16px',
                      borderRadius: '10px',
                      backgroundColor: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.04)'
                    }}>
                      <span style={{ fontSize: '13px', fontWeight: 500 }}>Trend Following Strategy</span>
                      <span
                        onClick={() => setTrendStrategyActive(!trendStrategyActive)}
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '4px 10px',
                          borderRadius: '8px',
                          backgroundColor: trendStrategyActive ? 'rgba(48, 209, 88, 0.15)' : 'rgba(255,255,255,0.05)',
                          color: trendStrategyActive ? '#30d158' : '#aeaeb2',
                          cursor: 'pointer'
                        }}
                      >
                        {trendStrategyActive ? "ACTIVE" : "INACTIVE"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Simulated Execution Ledger */}
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Simulated Execution Ledger</h2>
                <div className="scroll-container" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', color: '#8e8e93', textAlign: 'left' }}>
                        <th style={{ padding: '8px 4px' }}>Time (PST)</th>
                        <th style={{ padding: '8px 4px' }}>Action</th>
                        <th style={{ padding: '8px 4px' }}>Symbol</th>
                        <th style={{ padding: '8px 4px' }}>Price</th>
                        <th style={{ padding: '8px 4px', textAlign: 'right' }}>Nav</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Array.isArray(trades) ? trades : []).map((t, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.03)', color: '#f5f5f7' }}>
                          <td style={{ padding: '10px 4px', color: '#aeaeb2' }}>{new Date(t.timestamp).toLocaleTimeString()}</td>
                          <td style={{ padding: '10px 4px', fontWeight: 600, color: t.action === 'BUY' ? '#30d158' : '#ff453a' }}>{t.action}</td>
                          <td style={{ padding: '10px 4px', fontWeight: 500 }}>{t.symbol}</td>
                          <td style={{ padding: '10px 4px', fontFamily: 'monospace' }}>${t.price}</td>
                          <td style={{ padding: '10px 4px', textAlign: 'right' }}>
                            <button
                              className="apple-btn"
                              onClick={() => jumpChartToTrade(t.timestamp)}
                              style={{
                                backgroundColor: 'rgba(10, 132, 255, 0.15)',
                                border: '1px solid rgba(10,132,255,0.25)',
                                color: '#0a84ff',
                                fontSize: '10px',
                                padding: '2px 8px',
                                borderRadius: '6px',
                                cursor: 'pointer'
                              }}
                            >
                              Jump
                            </button>
                          </td>
                        </tr>
                      ))}
                      {trades.length === 0 && (
                        <tr>
                          <td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: '#8e8e93' }}>No trade records found</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </main>

          {/* Developer Modes & Control */}
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
        </div>

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
  statBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    transition: 'all 0.2s ease-in-out',
  },
  statLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: '#8e8e93',
    letterSpacing: '0.2px',
    textTransform: 'uppercase',
  },
  statValue: {
    fontSize: '18px',
    fontWeight: 700,
    color: '#f5f5f7',
    letterSpacing: '-0.3px',
  },
};
