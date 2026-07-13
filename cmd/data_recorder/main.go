package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/go-zeromq/zmq4"
	_ "github.com/lib/pq"
	"github.com/parquet-go/parquet-go"
	"google.golang.org/protobuf/proto"
)

var (
	subAddr    = flag.String("zmq-sub-addr", "tcp://localhost:5556", "ZeroMQ subscription address")
	dbDSN      = flag.String("db-dsn", "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable", "TimescaleDB DSN")
	parquetDir = flag.String("parquet-dir", "data_lake", "Directory path for Parquet archives")
)

type ZMQSocket interface {
	Dial(addr string) error
	Close() error
	SetOption(name string, value interface{}) error
	Recv() (zmq4.Msg, error)
}

var newSubSocket = func(ctx context.Context) ZMQSocket {
	return zmq4.NewSub(ctx)
}

var sqlOpen = sql.Open

const (
	batchSize     = 5000
	flushInterval = 10 * time.Second
)

type BarParquetRecord struct {
	Symbol    string  `parquet:"symbol,dict"`
	Timestamp int64   `parquet:"timestamp"`
	Open      float64 `parquet:"open"`
	High      float64 `parquet:"high"`
	Low       float64 `parquet:"low"`
	Close     float64 `parquet:"close"`
	Volume    float64 `parquet:"volume"`
}

type DataRecorder struct {
	db         *sql.DB
	subAddr    string
	parquetDir string
	records    chan interface{}
	wg         sync.WaitGroup
	ctx        context.Context
	cancel     context.CancelFunc
}

func NewDataRecorder(db *sql.DB, subAddr string, pDir string) *DataRecorder {
	return &DataRecorder{
		db:         db,
		subAddr:    subAddr,
		parquetDir: pDir,
		records:    make(chan interface{}, 10000), // Bounded buffer for backpressure
	}
}

func (dr *DataRecorder) InitSchema(ctx context.Context) error {
	schema := `
	CREATE TABLE IF NOT EXISTS equity_ticks (
		symbol VARCHAR(32) NOT NULL,
		price DOUBLE PRECISION NOT NULL,
		size DOUBLE PRECISION NOT NULL,
		timestamp BIGINT NOT NULL,
		correlation_id VARCHAR(64) NOT NULL
	);

	CREATE TABLE IF NOT EXISTS equity_bars (
		symbol VARCHAR(32) NOT NULL,
		open DOUBLE PRECISION NOT NULL,
		high DOUBLE PRECISION NOT NULL,
		low DOUBLE PRECISION NOT NULL,
		close DOUBLE PRECISION NOT NULL,
		volume DOUBLE PRECISION NOT NULL,
		window_size BIGINT NOT NULL,
		timestamp BIGINT NOT NULL
	);
	`
	_, err := dr.db.ExecContext(ctx, schema)
	if err != nil {
		return fmt.Errorf("failed to create database tables: %w", err)
	}

	// Try creating TimescaleDB hypertables, ignore error if TimescaleDB extension is missing
	_, _ = dr.db.ExecContext(ctx, "SELECT create_hypertable('equity_ticks', 'timestamp', if_not_exists => TRUE);")
	_, _ = dr.db.ExecContext(ctx, "SELECT create_hypertable('equity_bars', 'timestamp', if_not_exists => TRUE);")

	return nil
}

func (dr *DataRecorder) Start(ctx context.Context) error {
	dr.ctx, dr.cancel = context.WithCancel(ctx)

	// Start pipeline processing worker
	dr.wg.Add(1)
	go dr.runFlushWorker()

	// Start ZeroMQ subscription loop
	dr.wg.Add(1)
	go dr.runReceiverLoop()

	return nil
}

func (dr *DataRecorder) Stop() {
	if dr.cancel != nil {
		dr.cancel()
	}
	dr.wg.Wait()
}

func (dr *DataRecorder) runFlushWorker() {
	defer dr.wg.Done()

	var batch []interface{}
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := dr.flushBatch(flushCtx, batch); err != nil {
			slog.Error("failed_to_flush_batch", "size", len(batch), "error", err)
		} else {
			slog.Info("successfully_flushed_batch", "size", len(batch))
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-dr.ctx.Done():
			// Drain remaining in channel
			for {
				select {
				case rec := <-dr.records:
					batch = append(batch, rec)
					if len(batch) >= batchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		case rec := <-dr.records:
			batch = append(batch, rec)
			if len(batch) >= batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (dr *DataRecorder) flushBatch(ctx context.Context, batch []interface{}) error {
	tx, err := dr.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmtTick, err := tx.PrepareContext(ctx, "INSERT INTO equity_ticks (symbol, price, size, timestamp, correlation_id) VALUES ($1, $2, $3, $4, $5)")
	if err != nil {
		return fmt.Errorf("failed to prepare tick statement: %w", err)
	}
	defer stmtTick.Close()

	stmtBar, err := tx.PrepareContext(ctx, "INSERT INTO equity_bars (symbol, open, high, low, close, volume, window_size, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
	if err != nil {
		return fmt.Errorf("failed to prepare bar statement: %w", err)
	}
	defer stmtBar.Close()

	for _, item := range batch {
		switch r := item.(type) {
		case *market_data.EquityTick:
			_, err = stmtTick.ExecContext(ctx, r.Symbol, r.Price, r.Size, r.Timestamp, r.CorrelationId)
		case *market_data.EquityBar:
			_, err = stmtBar.ExecContext(ctx, r.Symbol, r.Open, r.High, r.Low, r.Close, r.Volume, r.WindowSize, r.Timestamp)
		}
		if err != nil {
			return fmt.Errorf("failed executing batch statement: %w", err)
		}
	}

	return tx.Commit()
}

func (dr *DataRecorder) runReceiverLoop() {
	defer dr.wg.Done()

	sub := newSubSocket(dr.ctx)
	if err := sub.Dial(dr.subAddr); err != nil {
		slog.Error("failed_to_dial_zmq_sub", "addr", dr.subAddr, "error", err)
		return
	}
	defer sub.Close()

	if err := sub.SetOption(zmq4.OptionSubscribe, "TICK."); err != nil {
		slog.Error("failed_to_subscribe_tick", "error", err)
		return
	}
	if err := sub.SetOption(zmq4.OptionSubscribe, "BAR."); err != nil {
		slog.Error("failed_to_subscribe_bar", "error", err)
		return
	}

	slog.Info("data_recorder_subscribed_to_zmq_topics", "addr", dr.subAddr)

	for {
		select {
		case <-dr.ctx.Done():
			return
		default:
		}

		msg, err := sub.Recv()
		if err != nil {
			select {
			case <-dr.ctx.Done():
				return
			default:
			}
			slog.Error("failed_to_recv_zmq_message", "error", err)
			continue
		}

		if len(msg.Frames) < 2 {
			continue
		}

		topic := string(msg.Frames[0])
		payload := msg.Frames[1]

		if len(topic) >= 5 && topic[:5] == "TICK." {
			var tick market_data.EquityTick
			if err := proto.Unmarshal(payload, &tick); err == nil {
				select {
				case dr.records <- &tick:
				case <-dr.ctx.Done():
					return
				}
			}
		} else if len(topic) >= 4 && topic[:4] == "BAR." {
			var bar market_data.EquityBar
			if err := proto.Unmarshal(payload, &bar); err == nil {
				select {
				case dr.records <- &bar:
				case <-dr.ctx.Done():
					return
				}
			}
		}
	}
}

func (dr *DataRecorder) ArchiveDay(ctx context.Context, dateStr string) error {
	t, err := time.Parse("20060102", dateStr)
	if err != nil {
		return fmt.Errorf("invalid date format, must be YYYYMMDD: %w", err)
	}

	startTS := t.UnixNano() / 1e6
	endTS := t.Add(24 * time.Hour).UnixNano() / 1e6

	slog.Info("starting_eod_parquet_archival", "date", dateStr, "start_ts", startTS, "end_ts", endTS)

	rows, err := dr.db.QueryContext(ctx,
		"SELECT symbol, timestamp, open, high, low, close, volume FROM equity_bars WHERE timestamp >= $1 AND timestamp < $2",
		startTS, endTS)
	if err != nil {
		return fmt.Errorf("failed to query bars for archival: %w", err)
	}
	defer rows.Close()

	symbolRecords := make(map[string][]BarParquetRecord)

	for rows.Next() {
		var rec BarParquetRecord
		if err := rows.Scan(&rec.Symbol, &rec.Timestamp, &rec.Open, &rec.High, &rec.Low, &rec.Close, &rec.Volume); err != nil {
			return fmt.Errorf("failed to scan row for archival: %w", err)
		}
		symbolRecords[rec.Symbol] = append(symbolRecords[rec.Symbol], rec)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("error during row scanning for archival: %w", err)
	}

	for symbol, records := range symbolRecords {
		dirPath := filepath.Join(dr.parquetDir, fmt.Sprintf("date=%s", dateStr))
		if err := os.MkdirAll(dirPath, 0755); err != nil {
			return fmt.Errorf("failed to create archive directory %s: %w", dirPath, err)
		}

		filePath := filepath.Join(dirPath, fmt.Sprintf("symbol=%s.parquet", symbol))
		if err := dr.writeParquetFile(filePath, records); err != nil {
			return fmt.Errorf("failed to write parquet file %s: %w", filePath, err)
		}
		slog.Info("archived_parquet_file_successfully", "path", filePath, "records_count", len(records))
	}

	return nil
}

func (dr *DataRecorder) writeParquetFile(path string, records []BarParquetRecord) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0666)
	if err != nil {
		return err
	}
	defer file.Close()

	writer := parquet.NewGenericWriter[BarParquetRecord](file)
	_, err = writer.Write(records)
	if err != nil {
		return err
	}
	return writer.Close()
}

func runMainApp(ctx context.Context, subAddr string, parquetDir string, dsn string) error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("starting_data_recorder_service", "sub_addr", subAddr, "parquet_dir", parquetDir)

	db, err := sqlOpen("postgres", dsn)
	if err != nil {
		return fmt.Errorf("failed to open database connection: %w", err)
	}
	defer db.Close()

	// Verify database connection
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("database ping failed: %w", err)
	}

	recorder := NewDataRecorder(db, subAddr, parquetDir)
	if err := recorder.InitSchema(ctx); err != nil {
		return fmt.Errorf("failed to initialize database schema: %w", err)
	}

	if err := recorder.Start(ctx); err != nil {
		return fmt.Errorf("failed to start recorder: %w", err)
	}

	// Trigger EOD archival via SIGUSR1 signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGUSR1)

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sigChan:
				today := time.Now().Format("20060102")
				slog.Info("received_sigusr1_triggering_eod_archival", "date", today)
				if err := recorder.ArchiveDay(ctx, today); err != nil {
					slog.Error("eod_archival_failed", "date", today, "error", err)
				}
			}
		}
	}()

	<-ctx.Done()
	slog.Info("shutting_down_data_recorder_gracefully")
	recorder.Stop()
	return nil
}

func main() {
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runMainApp(ctx, *subAddr, *parquetDir, *dbDSN); err != nil {
		slog.Error("application_terminated", "error", err)
		os.Exit(1)
	}
}
