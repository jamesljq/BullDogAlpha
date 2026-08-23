"""Institutional-grade quantitative performance analytics and metrics engine."""

from dataclasses import asdict, dataclass
import datetime
import math
from typing import Any, Dict, List, Optional, Union
import numpy as np


@dataclass(frozen=True)
class TradeRecord:
  """Detailed audit record of an executed trade fill."""
  timestamp: int
  order_id: str
  symbol: str
  side: str
  qty: int
  order_price: float
  exec_price: float
  slippage_cost: float
  commission: float
  realized_pnl: float
  cash_after: float
  position_after: int

  def to_dict(self) -> Dict[str, Any]:
    return asdict(self)


@dataclass(frozen=True)
class PerformanceReport:
  """Institutional quant performance evaluation report."""
  initial_capital: float
  final_nav: float
  final_pnl: float
  total_return_pct: float
  cagr_pct: float
  annualized_volatility: float
  downside_volatility: float
  sharpe_ratio: float
  sortino_ratio: float
  calmar_ratio: float
  max_drawdown: float
  max_drawdown_duration_bars: int
  peak_timestamp: Optional[int]
  trough_timestamp: Optional[int]
  recovery_timestamp: Optional[int]
  total_trades: int
  winning_trades: int
  losing_trades: int
  win_rate_pct: float
  profit_factor: float
  avg_trade_pnl: float
  max_consecutive_wins: int
  max_consecutive_losses: int
  monthly_returns_matrix: Dict[int, Dict[Union[int, str], float]]
  equity_curve: List[Dict[str, Any]]
  beta: Optional[float] = None
  alpha: Optional[float] = None
  information_ratio: Optional[float] = None

  def to_dict(self) -> Dict[str, Any]:
    return asdict(self)


class PerformanceAnalytics:
  """Computes CFA-grade quantitative statistics, drawdowns, and monthly return matrices."""

  @classmethod
  def compute_drawdown_details(
      cls,
      timestamps: List[int],
      nav_history: List[float],
  ) -> Dict[str, Any]:
    """Computes max drawdown, duration, peak, trough, and recovery timestamps."""
    if not nav_history or len(nav_history) < 2:
      return {
          "max_drawdown": 0.0,
          "max_duration_bars": 0,
          "peak_ts": None,
          "trough_ts": None,
          "recovery_ts": None,
          "drawdown_series": [0.0] * len(nav_history),
      }

    peak_nav = nav_history[0]
    peak_idx = 0
    max_dd = 0.0
    max_dd_peak_idx = 0
    max_dd_trough_idx = 0
    max_dd_recovery_idx = None

    drawdown_series: List[float] = [0.0]
    current_duration = 0
    max_duration_bars = 0

    for i in range(1, len(nav_history)):
      nav = nav_history[i]
      if nav >= peak_nav:
        peak_nav = nav
        peak_idx = i
        current_duration = 0
        dd = 0.0
      else:
        current_duration += 1
        if current_duration > max_duration_bars:
          max_duration_bars = current_duration
        dd = (peak_nav - nav) / peak_nav
        if dd > max_dd:
          max_dd = dd
          max_dd_peak_idx = peak_idx
          max_dd_trough_idx = i

      drawdown_series.append(dd)

    # Check if/when max drawdown was recovered
    max_peak_val = nav_history[max_dd_peak_idx]
    for i in range(max_dd_trough_idx + 1, len(nav_history)):
      if nav_history[i] >= max_peak_val:
        max_dd_recovery_idx = i
        break

    peak_ts = timestamps[max_dd_peak_idx] if timestamps and max_dd_peak_idx < len(timestamps) else None
    trough_ts = timestamps[max_dd_trough_idx] if timestamps and max_dd_trough_idx < len(timestamps) else None
    recovery_ts = (
        timestamps[max_dd_recovery_idx]
        if timestamps and max_dd_recovery_idx is not None and max_dd_recovery_idx < len(timestamps)
        else None
    )

    return {
        "max_drawdown": max_dd,
        "max_duration_bars": max_duration_bars,
        "peak_ts": peak_ts,
        "trough_ts": trough_ts,
        "recovery_ts": recovery_ts,
        "drawdown_series": drawdown_series,
    }

  @classmethod
  def compute_monthly_returns_matrix(
      cls,
      timestamps: List[int],
      nav_history: List[float],
  ) -> Dict[int, Dict[Union[int, str], float]]:
    """Generates a year-by-month returns heatmap matrix from timestamped NAV series."""
    if not timestamps or not nav_history or len(timestamps) != len(nav_history):
      return {}

    # Group NAV by (year, month) keeping first and last NAV of each period
    # To compute accurate monthly return: R_m = NAV_end / NAV_start - 1
    monthly_data: Dict[int, Dict[int, List[float]]] = {}
    yearly_data: Dict[int, List[float]] = {}

    for ts, nav in zip(timestamps, nav_history):
      dt = datetime.datetime.fromtimestamp(ts / 1000.0, tz=datetime.timezone.utc)
      yr = dt.year
      mo = dt.month

      if yr not in monthly_data:
        monthly_data[yr] = {}
      if mo not in monthly_data[yr]:
        monthly_data[yr][mo] = []
      monthly_data[yr][mo].append(nav)

      if yr not in yearly_data:
        yearly_data[yr] = []
      yearly_data[yr].append(nav)

    matrix: Dict[int, Dict[Union[int, str], float]] = {}

    sorted_years = sorted(monthly_data.keys())
    prev_year_end_nav = None

    for yr in sorted_years:
      matrix[yr] = {}
      prev_month_end_nav = prev_year_end_nav

      for mo in range(1, 13):
        if mo in monthly_data[yr] and monthly_data[yr][mo]:
          month_navs = monthly_data[yr][mo]
          start_nav = prev_month_end_nav if prev_month_end_nav is not None else month_navs[0]
          end_nav = month_navs[-1]
          if start_nav > 0.0:
            month_ret = (end_nav - start_nav) / start_nav
          else:
            month_ret = 0.0
          matrix[yr][mo] = round(month_ret * 100.0, 2)
          prev_month_end_nav = end_nav

      # Annual return for the year
      yr_navs = yearly_data[yr]
      yr_start = prev_year_end_nav if prev_year_end_nav is not None else yr_navs[0]
      yr_end = yr_navs[-1]
      annual_ret = (yr_end - yr_start) / yr_start if yr_start > 0.0 else 0.0
      matrix[yr]["annual"] = round(annual_ret * 100.0, 2)
      prev_year_end_nav = yr_end

    return matrix

  @classmethod
  def compute_trade_statistics(
      cls,
      trades: List[TradeRecord],
  ) -> Dict[str, Any]:
    """Computes trade-level performance, win rate, profit factor, and streaks."""
    if not trades:
      return {
          "total_trades": 0,
          "winning_trades": 0,
          "losing_trades": 0,
          "win_rate_pct": 0.0,
          "profit_factor": 0.0,
          "avg_trade_pnl": 0.0,
          "max_consecutive_wins": 0,
          "max_consecutive_losses": 0,
      }

    # Only closed trades generate non-zero or evaluated realized P&L
    closed_trades = [t for t in trades if abs(t.realized_pnl) > 1e-9]
    if not closed_trades:
      # If no closed trades had realized pnl recorded, fallback to all trades
      closed_trades = trades

    total_trades = len(closed_trades)
    winning_trades = sum(1 for t in closed_trades if t.realized_pnl > 0.0)
    losing_trades = sum(1 for t in closed_trades if t.realized_pnl < 0.0)

    win_rate_pct = (winning_trades / total_trades * 100.0) if total_trades > 0 else 0.0

    gross_profit = sum(t.realized_pnl for t in closed_trades if t.realized_pnl > 0.0)
    gross_loss = abs(sum(t.realized_pnl for t in closed_trades if t.realized_pnl < 0.0))

    if gross_loss > 0.0:
      profit_factor = gross_profit / gross_loss
    elif gross_profit > 0.0:
      profit_factor = 999.0
    else:
      profit_factor = 0.0

    total_pnl = sum(t.realized_pnl for t in closed_trades)
    avg_trade_pnl = total_pnl / total_trades if total_trades > 0 else 0.0

    # Streaks
    curr_wins, max_wins = 0, 0
    curr_losses, max_losses = 0, 0

    for t in closed_trades:
      if t.realized_pnl > 0.0:
        curr_wins += 1
        curr_losses = 0
        max_wins = max(max_wins, curr_wins)
      elif t.realized_pnl < 0.0:
        curr_losses += 1
        curr_wins = 0
        max_losses = max(max_losses, curr_losses)

    return {
        "total_trades": total_trades,
        "winning_trades": winning_trades,
        "losing_trades": losing_trades,
        "win_rate_pct": win_rate_pct,
        "profit_factor": profit_factor,
        "avg_trade_pnl": avg_trade_pnl,
        "max_consecutive_wins": max_wins,
        "max_consecutive_losses": max_losses,
    }

  @classmethod
  def generate_report(
      cls,
      nav_history: List[float],
      initial_capital: float,
      timestamps: Optional[List[int]] = None,
      trades: Optional[List[TradeRecord]] = None,
      benchmark_nav: Optional[List[float]] = None,
      annualization_factor: Optional[float] = None,
  ) -> PerformanceReport:
    """Generates a complete institutional quant performance report."""
    if not nav_history:
      nav_history = [initial_capital]

    final_nav = nav_history[-1]
    final_pnl = final_nav - initial_capital
    total_return_pct = (final_pnl / initial_capital * 100.0) if initial_capital > 0 else 0.0

    # Auto-detect annualization factor if not provided:
    # If timestamps provided and span multi-year, estimate bars per year
    n_bars = len(nav_history)
    if timestamps and len(timestamps) >= 2:
      time_span_ms = max(1, timestamps[-1] - timestamps[0])
      time_span_years = time_span_ms / (365.25 * 86400000.0)
      if annualization_factor is None:
        if time_span_years > 0:
          bars_per_year = (n_bars - 1) / time_span_years
          af = math.sqrt(max(1.0, bars_per_year))
        else:
          af = math.sqrt(252.0)
    else:
      time_span_years = (n_bars - 1) / 252.0 if n_bars > 1 else 1.0
      af = annualization_factor if annualization_factor is not None else math.sqrt(252.0 * 390.0)

    # CAGR calculation (annualized compounded growth rate)
    if time_span_years >= 0.05 and final_nav > 0.0 and initial_capital > 0.0:
      try:
        ratio = final_nav / initial_capital
        exponent = 1.0 / time_span_years
        if exponent * math.log(max(1e-9, ratio)) < 500:
          cagr_pct = ((ratio ** exponent) - 1.0) * 100.0
        else:
          cagr_pct = total_return_pct
      except (OverflowError, ValueError):
        cagr_pct = total_return_pct
    else:
      cagr_pct = total_return_pct


    # Returns series
    returns = []
    for i in range(1, len(nav_history)):
      prev = nav_history[i - 1]
      returns.append((nav_history[i] - prev) / prev if prev > 0 else 0.0)

    n = len(returns)
    if n > 1:
      mean_ret = float(np.mean(returns))
      std_ret = float(np.std(returns, ddof=1))
      ann_vol = std_ret * af
      downside_diffs = [min(r, 0.0) for r in returns]
      downside_std = float(np.std(downside_diffs, ddof=1)) if len(downside_diffs) > 1 else 0.0
      down_vol = downside_std * af
    else:
      mean_ret = 0.0
      std_ret = 0.0
      ann_vol = 0.0
      downside_std = 0.0
      down_vol = 0.0

    sharpe = (mean_ret / std_ret * af) if std_ret > 0 else 0.0
    sortino = (mean_ret / downside_std * af) if downside_std > 0 else 0.0

    # Drawdown
    ts_list = timestamps or list(range(len(nav_history)))
    dd_details = cls.compute_drawdown_details(ts_list, nav_history)
    max_dd = dd_details["max_drawdown"]

    # Calmar Ratio: CAGR / Max Drawdown
    calmar = (cagr_pct / (max_dd * 100.0)) if max_dd > 0 else 0.0

    # Trade stats
    trade_stats = cls.compute_trade_statistics(trades or [])

    # Monthly Returns Matrix
    matrix = cls.compute_monthly_returns_matrix(ts_list, nav_history) if timestamps else {}

    # Equity Curve
    equity_curve = []
    for i, nav in enumerate(nav_history):
      equity_curve.append({
          "timestamp": ts_list[i] if i < len(ts_list) else i,
          "nav": round(nav, 2),
          "drawdown_pct": round(dd_details["drawdown_series"][i] * 100.0, 4)
          if i < len(dd_details["drawdown_series"])
          else 0.0,
      })

    # Benchmark analytics (Beta, Alpha, Information Ratio)
    beta, alpha, info_ratio = None, None, None
    if benchmark_nav and len(benchmark_nav) == len(nav_history) and n > 1:
      bench_returns = []
      for i in range(1, len(benchmark_nav)):
        b_prev = benchmark_nav[i - 1]
        bench_returns.append((benchmark_nav[i] - b_prev) / b_prev if b_prev > 0 else 0.0)

      b_mean = float(np.mean(bench_returns))
      b_var = float(np.var(bench_returns, ddof=1))
      if b_var > 0:
        cov = float(np.cov(returns, bench_returns)[0, 1])
        beta = cov / b_var
        alpha = (mean_ret - beta * b_mean) * (af ** 2)

        # Tracking Error & Information Ratio
        excess_returns = np.array(returns) - np.array(bench_returns)
        tracking_error = float(np.std(excess_returns, ddof=1)) * af
        if tracking_error > 0:
          info_ratio = (float(np.mean(excess_returns)) * (af ** 2)) / tracking_error

    return PerformanceReport(
        initial_capital=initial_capital,
        final_nav=final_nav,
        final_pnl=final_pnl,
        total_return_pct=total_return_pct,
        cagr_pct=cagr_pct,
        annualized_volatility=ann_vol,
        downside_volatility=down_vol,
        sharpe_ratio=sharpe,
        sortino_ratio=sortino,
        calmar_ratio=calmar,
        max_drawdown=max_dd,
        max_drawdown_duration_bars=dd_details["max_duration_bars"],
        peak_timestamp=dd_details["peak_ts"],
        trough_timestamp=dd_details["trough_ts"],
        recovery_timestamp=dd_details["recovery_ts"],
        total_trades=trade_stats["total_trades"],
        winning_trades=trade_stats["winning_trades"],
        losing_trades=trade_stats["losing_trades"],
        win_rate_pct=trade_stats["win_rate_pct"],
        profit_factor=trade_stats["profit_factor"],
        avg_trade_pnl=trade_stats["avg_trade_pnl"],
        max_consecutive_wins=trade_stats["max_consecutive_wins"],
        max_consecutive_losses=trade_stats["max_consecutive_losses"],
        monthly_returns_matrix=matrix,
        equity_curve=equity_curve,
        beta=beta,
        alpha=alpha,
        information_ratio=info_ratio,
    )
