package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/go-zeromq/zmq4"
	"github.com/parquet-go/parquet-go"
	"google.golang.org/protobuf/proto"
)

func TestInitSchema(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectExec("CREATE TABLE IF NOT EXISTS equity_ticks").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").
		WillReturnResult(sqlmock.NewResult(0, 0))

	dr := NewDataRecorder(db, "tcp://localhost:9999", "test_parquet")
	err = dr.InitSchema(context.Background())
	if err != nil {
		t.Errorf("InitSchema failed: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}
}

func TestFlushBatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	// Expect transaction begin
	mock.ExpectBegin()

	// Expect prepared statements
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars")

	// Expect insertions
	mock.ExpectExec("INSERT INTO equity_ticks").
		WithArgs("AAPL", 150.0, 10.0, int64(1600000000000), "corr-1").
		WillReturnResult(sqlmock.NewResult(1, 1))

	mock.ExpectExec("INSERT INTO equity_bars").
		WithArgs("AAPL", 150.0, 151.0, 149.0, 150.5, 1000.0, int64(60), int64(1600000000000)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	// Expect transaction commit
	mock.ExpectCommit()

	dr := NewDataRecorder(db, "tcp://localhost:9999", "test_parquet")

	batch := []interface{}{
		&market_data.EquityTick{
			Symbol:        "AAPL",
			Price:         150.0,
			Size:          10.0,
			Timestamp:     1600000000000,
			CorrelationId: "corr-1",
		},
		&market_data.EquityBar{
			Symbol:     "AAPL",
			Open:       150.0,
			High:       151.0,
			Low:        149.0,
			Close:      150.5,
			Volume:     1000.0,
			WindowSize: 60,
			Timestamp:  1600000000000,
		},
	}

	err = dr.flushBatch(context.Background(), batch)
	if err != nil {
		t.Errorf("flushBatch failed: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}
}

func TestFlushBatchRollbackOnError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars")
	mock.ExpectExec("INSERT INTO equity_ticks").WillReturnError(errors.New("db write error"))
	mock.ExpectRollback()

	dr := NewDataRecorder(db, "tcp://localhost:9999", "test_parquet")
	batch := []interface{}{
		&market_data.EquityTick{Symbol: "AAPL"},
	}

	err = dr.flushBatch(context.Background(), batch)
	if err == nil {
		t.Errorf("expected flushBatch to fail, but it succeeded")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}
}

func TestArchiveDay(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	tempDir := "test_parquet_archive"
	defer os.RemoveAll(tempDir)

	// Expect select query for date 2026-07-13
	// startTS = 1783900800000 (UTC 2026-07-13)
	// endTS = 1783987200000
	tVal, _ := time.Parse("20060102", "20260713")
	startTS := tVal.UnixNano() / 1e6
	endTS := tVal.Add(24 * time.Hour).UnixNano() / 1e6

	rows := sqlmock.NewRows([]string{"symbol", "timestamp", "open", "high", "low", "close", "volume"}).
		AddRow("AAPL", int64(1783900805000), 150.0, 151.0, 149.0, 150.5, 1000.0).
		AddRow("MSFT", int64(1783900806000), 300.0, 302.0, 299.0, 301.0, 500.0)

	mock.ExpectQuery("SELECT symbol, timestamp, open, high, low, close, volume FROM equity_bars").
		WithArgs(startTS, endTS).
		WillReturnRows(rows)

	dr := NewDataRecorder(db, "tcp://localhost:9999", tempDir)
	err = dr.ArchiveDay(context.Background(), "20260713")
	if err != nil {
		t.Errorf("ArchiveDay failed: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}

	// Verify Parquet files were created
	aaplParquet := filepath.Join(tempDir, "date=20260713", "symbol=AAPL.parquet")
	msftParquet := filepath.Join(tempDir, "date=20260713", "symbol=MSFT.parquet")

	if _, err := os.Stat(aaplParquet); os.IsNotExist(err) {
		t.Errorf("AAPL parquet file not found")
	}
	if _, err := os.Stat(msftParquet); os.IsNotExist(err) {
		t.Errorf("MSFT parquet file not found")
	}

	// Verify Parquet file contents
	file, err := os.Open(aaplParquet)
	if err != nil {
		t.Fatalf("failed to open parquet: %v", err)
	}
	defer file.Close()

	reader := parquet.NewGenericReader[BarParquetRecord](file)
	records := make([]BarParquetRecord, 2)
	n, err := reader.Read(records)
	if err != nil && err.Error() != "EOF" {
		t.Fatalf("failed to read parquet records: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 record in AAPL parquet, got %d", n)
	}
	if records[0].Symbol != "AAPL" || records[0].Volume != 1000.0 {
		t.Errorf("unexpected record content in AAPL parquet: %+v", records[0])
	}
}

func TestArchiveDayInvalidDate(t *testing.T) {
	dr := NewDataRecorder(nil, "", "")
	err := dr.ArchiveDay(context.Background(), "invalid-date")
	if err == nil {
		t.Errorf("expected ArchiveDay to fail on invalid date format")
	}
}

type MockZMQSocket struct {
	dialErr         error
	setOptionErr    error
	setOptionTickErr error
	recvErr         error
	dialCalled      bool
	setOptionCalled bool
	closeCalled     bool
	msgChan         chan zmq4.Msg
}

func (m *MockZMQSocket) Dial(addr string) error {
	m.dialCalled = true
	return m.dialErr
}
func (m *MockZMQSocket) Close() error {
	m.closeCalled = true
	return nil
}
func (m *MockZMQSocket) SetOption(name string, value interface{}) error {
	m.setOptionCalled = true
	valStr, ok := value.(string)
	if ok {
		if valStr == "TICK." && m.setOptionTickErr != nil {
			return m.setOptionTickErr
		}
		if valStr == "BAR." && m.setOptionErr != nil {
			return m.setOptionErr
		}
	}
	return nil
}
func (m *MockZMQSocket) Recv() (zmq4.Msg, error) {
	if m.recvErr != nil {
		time.Sleep(5 * time.Millisecond)
		return zmq4.Msg{}, m.recvErr
	}
	msg, ok := <-m.msgChan
	if !ok {
		time.Sleep(5 * time.Millisecond)
		return zmq4.Msg{}, errors.New("socket closed")
	}
	return msg, nil
}

func TestPipelineStartStopAndReceiver(t *testing.T) {
	// Mock newSubSocket
	originalNewSub := newSubSocket
	defer func() { newSubSocket = originalNewSub }()

	mockSocket := &MockZMQSocket{
		msgChan: make(chan zmq4.Msg, 10),
	}
	newSubSocket = func(ctx context.Context) ZMQSocket {
		return mockSocket
	}

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	// Expect schema table creation and TimescaleDB hypertables init
	mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))

	// Expect flush transactions on Stop
	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars")
	mock.ExpectExec("INSERT INTO equity_ticks").
		WithArgs("AAPL", 150.0, 10.0, int64(1600000000000), "corr-1").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO equity_bars").
		WithArgs("AAPL", 150.0, 151.0, 149.0, 150.5, 1000.0, int64(60), int64(1600000000000)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	dr := NewDataRecorder(db, "tcp://localhost:29999", "test_parquet")

	err = dr.InitSchema(context.Background())
	if err != nil {
		t.Fatalf("failed to init schema: %v", err)
	}

	err = dr.Start(context.Background())
	if err != nil {
		t.Fatalf("failed to start: %v", err)
	}

	// Wait for worker boot
	time.Sleep(50 * time.Millisecond)

	// Send ticks & bars via mock socket
	tickBytes, _ := proto.Marshal(&market_data.EquityTick{
		Symbol:        "AAPL",
		Price:         150.0,
		Size:          10,
		Timestamp:     1600000000000,
		CorrelationId: "corr-1",
	})
	barBytes, _ := proto.Marshal(&market_data.EquityBar{
		Symbol:     "AAPL",
		Open:       150.0,
		High:       151.0,
		Low:        149.0,
		Close:      150.5,
		Volume:     1000.0,
		WindowSize: 60,
		Timestamp:  1600000000000,
	})

	mockSocket.msgChan <- zmq4.Msg{Frames: [][]byte{[]byte("TICK.AAPL"), tickBytes}}
	mockSocket.msgChan <- zmq4.Msg{Frames: [][]byte{[]byte("BAR.AAPL"), barBytes}}

	// Wait for unmarshal and channel queue ingestion
	time.Sleep(50 * time.Millisecond)

	// Close mockSocket.msgChan to unblock Recv() first
	close(mockSocket.msgChan)

	// Stop data recorder
	dr.Stop()

	if !mockSocket.dialCalled {
		t.Errorf("expected subSocket.Dial to have been called")
	}
	if !mockSocket.setOptionCalled {
		t.Errorf("expected subSocket.SetOption to have been called")
	}
	if !mockSocket.closeCalled {
		t.Errorf("expected subSocket.Close to have been called")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}
}

func TestRunMainAppCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := runMainApp(ctx, "tcp://localhost:9999", "test_parquet", "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable")
	if err == nil {
		t.Errorf("expected runMainApp to fail with cancelled context")
	}
}

func TestRunMainAppSuccessFlow(t *testing.T) {
	// Mock newSubSocket
	originalNewSub := newSubSocket
	defer func() { newSubSocket = originalNewSub }()

	mockSocket := &MockZMQSocket{
		msgChan: make(chan zmq4.Msg, 10),
	}
	newSubSocket = func(ctx context.Context) ZMQSocket {
		return mockSocket
	}

	// Mock sqlOpen
	originalSqlOpen := sqlOpen
	defer func() { sqlOpen = originalSqlOpen }()

	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	defer db.Close()

	sqlOpen = func(driver, dsn string) (*sql.DB, error) {
		return db, nil
	}

	// Expect Ping
	mock.ExpectPing()

	// Expect schema table creation and TimescaleDB hypertables init
	mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))

	// Expect EOD Archival Query on SIGUSR1
	tVal, _ := time.Parse("20060102", time.Now().Format("20060102"))
	startTS := tVal.UnixNano() / 1e6
	endTS := tVal.Add(24 * time.Hour).UnixNano() / 1e6
	mock.ExpectQuery("SELECT symbol").
		WithArgs(startTS, endTS).
		WillReturnRows(sqlmock.NewRows([]string{"symbol", "timestamp", "open", "high", "low", "close", "volume"}))

	// Expect flush transactions on Stop
	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars")
	mock.ExpectExec("INSERT INTO equity_ticks").
		WithArgs("AAPL", 150.0, 10.0, int64(1600000000000), "corr-1").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO equity_bars").
		WithArgs("AAPL", 150.0, 151.0, 149.0, 150.5, 1000.0, int64(60), int64(1600000000000)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	ctx, cancel := context.WithCancel(context.Background())

	errChan := make(chan error, 1)
	go func() {
		errChan <- runMainApp(ctx, "tcp://localhost:29999", "test_parquet", "postgres://mock")
	}()

	// Wait for worker boot
	time.Sleep(50 * time.Millisecond)

	// Send ticks & bars via mock socket
	tickBytes, _ := proto.Marshal(&market_data.EquityTick{
		Symbol:        "AAPL",
		Price:         150.0,
		Size:          10,
		Timestamp:     1600000000000,
		CorrelationId: "corr-1",
	})
	barBytes, _ := proto.Marshal(&market_data.EquityBar{
		Symbol:     "AAPL",
		Open:       150.0,
		High:       151.0,
		Low:        149.0,
		Close:      150.5,
		Volume:     1000.0,
		WindowSize: 60,
		Timestamp:  1600000000000,
	})

	mockSocket.msgChan <- zmq4.Msg{Frames: [][]byte{[]byte("TICK.AAPL"), tickBytes}}
	mockSocket.msgChan <- zmq4.Msg{Frames: [][]byte{[]byte("BAR.AAPL"), barBytes}}

	// Wait for unmarshal and channel queue ingestion
	time.Sleep(50 * time.Millisecond)

	// Send SIGUSR1 signal to trigger EOD archival
	_ = syscall.Kill(syscall.Getpid(), syscall.SIGUSR1)
	time.Sleep(50 * time.Millisecond)

	// Close mockSocket.msgChan and cancel context
	close(mockSocket.msgChan)
	cancel()

	err = <-errChan
	if err != nil {
		t.Errorf("runMainApp failed: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations were not met: %v", err)
	}
}

func TestRunMainAppErrors(t *testing.T) {
	originalSqlOpen := sqlOpen
	defer func() { sqlOpen = originalSqlOpen }()

	// 1. sqlOpen Error
	sqlOpen = func(driver, dsn string) (*sql.DB, error) {
		return nil, errors.New("mock open error")
	}
	err := runMainApp(context.Background(), "tcp://localhost:9999", "test_parquet", "postgres://mock")
	if err == nil {
		t.Errorf("expected runMainApp to fail on sql.Open error")
	}

	// 2. PingContext Error
	db, mock, _ := sqlmock.New(sqlmock.MonitorPingsOption(true))
	sqlOpen = func(driver, dsn string) (*sql.DB, error) {
		return db, nil
	}
	mock.ExpectPing().WillReturnError(errors.New("ping failed"))
	err = runMainApp(context.Background(), "tcp://localhost:9999", "test_parquet", "postgres://mock")
	if err == nil {
		t.Errorf("expected runMainApp to fail on ping error")
	}
	db.Close()

	// 3. InitSchema Error
	db, mock, _ = sqlmock.New(sqlmock.MonitorPingsOption(true))
	mock.ExpectPing()
	mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnError(errors.New("create table failed"))
	err = runMainApp(context.Background(), "tcp://localhost:9999", "test_parquet", "postgres://mock")
	if err == nil {
		t.Errorf("expected runMainApp to fail on schema init error")
	}
	db.Close()
}

func TestArchiveDayErrors(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	dr := NewDataRecorder(db, "tcp://localhost:9999", "test_parquet")

	tVal, _ := time.Parse("20060102", "20260713")
	startTS := tVal.UnixNano() / 1e6
	endTS := tVal.Add(24 * time.Hour).UnixNano() / 1e6

	// 1. Query error
	mock.ExpectQuery("SELECT").WithArgs(startTS, endTS).WillReturnError(errors.New("db query error"))
	err := dr.ArchiveDay(context.Background(), "20260713")
	if err == nil {
		t.Errorf("expected ArchiveDay to fail on query error")
	}

	// 2. Scan error
	rows := sqlmock.NewRows([]string{"symbol", "timestamp", "open", "high", "low", "close", "volume"}).
		AddRow("AAPL", "invalid-timestamp", 150.0, 151.0, 149.0, 150.5, 1000.0) // string instead of int64 timestamp
	mock.ExpectQuery("SELECT").WithArgs(startTS, endTS).WillReturnRows(rows)
	err = dr.ArchiveDay(context.Background(), "20260713")
	if err == nil {
		t.Errorf("expected ArchiveDay to fail on scan error")
	}

	// 3. Row iteration error
	rowsErr := sqlmock.NewRows([]string{"symbol", "timestamp", "open", "high", "low", "close", "volume"}).
		AddRow("AAPL", int64(1783900805000), 150.0, 151.0, 149.0, 150.5, 1000.0).
		RowError(0, errors.New("row iteration error"))
	mock.ExpectQuery("SELECT").WithArgs(startTS, endTS).WillReturnRows(rowsErr)
	err = dr.ArchiveDay(context.Background(), "20260713")
	if err == nil {
		t.Errorf("expected ArchiveDay to fail on row iteration error")
	}

	// 4. Parquet write error (using read-only/invalid path)
	drInvalidDir := NewDataRecorder(db, "tcp://localhost:9999", "/proc/invalid/path")
	rowsOk := sqlmock.NewRows([]string{"symbol", "timestamp", "open", "high", "low", "close", "volume"}).
		AddRow("AAPL", int64(1783900805000), 150.0, 151.0, 149.0, 150.5, 1000.0)
	mock.ExpectQuery("SELECT").WithArgs(startTS, endTS).WillReturnRows(rowsOk)
	err = drInvalidDir.ArchiveDay(context.Background(), "20260713")
	if err == nil {
		t.Errorf("expected ArchiveDay to fail on parquet write error")
	}
}

func TestReceiverLoopErrors(t *testing.T) {
	originalNewSub := newSubSocket
	defer func() { newSubSocket = originalNewSub }()

	db, _, _ := sqlmock.New()
	defer db.Close()

	// 1. Dial Error
	mockSocket1 := &MockZMQSocket{dialErr: errors.New("dial failed")}
	newSubSocket = func(ctx context.Context) ZMQSocket { return mockSocket1 }
	dr := NewDataRecorder(db, "tcp://fail", "test_parquet")
	dr.ctx, dr.cancel = context.WithCancel(context.Background())
	dr.wg.Add(1)
	dr.runReceiverLoop()

	// 2. SetOption TICK Error
	mockSocket2 := &MockZMQSocket{setOptionTickErr: errors.New("setoption failed")}
	newSubSocket = func(ctx context.Context) ZMQSocket { return mockSocket2 }
	dr = NewDataRecorder(db, "tcp://ok", "test_parquet")
	dr.ctx, dr.cancel = context.WithCancel(context.Background())
	dr.wg.Add(1)
	dr.runReceiverLoop()

	mockSocket2b := &MockZMQSocket{setOptionErr: errors.New("setoption failed")}
	newSubSocket = func(ctx context.Context) ZMQSocket { return mockSocket2b }
	dr = NewDataRecorder(db, "tcp://ok", "test_parquet")
	dr.ctx, dr.cancel = context.WithCancel(context.Background())
	dr.wg.Add(1)
	dr.runReceiverLoop()

	// 3. Recv Error
	mockSocket3 := &MockZMQSocket{
		recvErr: errors.New("recv failed"),
		msgChan: make(chan zmq4.Msg),
	}
	newSubSocket = func(ctx context.Context) ZMQSocket { return mockSocket3 }
	dr = NewDataRecorder(db, "tcp://ok", "test_parquet")
	ctx, cancel := context.WithCancel(context.Background())
	dr.ctx = ctx
	dr.cancel = cancel
	dr.wg.Add(1)
	go dr.runReceiverLoop()
	time.Sleep(20 * time.Millisecond)
	cancel()
	dr.wg.Wait()
}

func TestFlushBatchPrepareErrors(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	// 1. Prepare Tick Error
	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks").WillReturnError(errors.New("prep tick failed"))
	mock.ExpectRollback()

	dr := NewDataRecorder(db, "", "")
	batch := []interface{}{&market_data.EquityTick{}}
	err := dr.flushBatch(context.Background(), batch)
	if err == nil {
		t.Errorf("expected flushBatch to fail on prepare tick error")
	}

	// 2. Prepare Bar Error
	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars").WillReturnError(errors.New("prep bar failed"))
	mock.ExpectRollback()

	batch = []interface{}{&market_data.EquityTick{}}
	err = dr.flushBatch(context.Background(), batch)
	if err == nil {
		t.Errorf("expected flushBatch to fail on prepare bar error")
	}
}

func TestPipelineFlushError(t *testing.T) {
	originalNewSub := newSubSocket
	defer func() { newSubSocket = originalNewSub }()
	mockSocket := &MockZMQSocket{msgChan: make(chan zmq4.Msg, 10)}
	newSubSocket = func(ctx context.Context) ZMQSocket { return mockSocket }

	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Expect InitSchema
	mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("SELECT create_hypertable").WillReturnResult(sqlmock.NewResult(0, 0))

	// Expect flush transactions on Stop to FAIL
	mock.ExpectBegin()
	mock.ExpectPrepare("INSERT INTO equity_ticks")
	mock.ExpectPrepare("INSERT INTO equity_bars")
	mock.ExpectExec("INSERT INTO equity_ticks").WillReturnError(errors.New("db flush fail"))
	mock.ExpectRollback()

	dr := NewDataRecorder(db, "tcp://localhost:29999", "test_parquet")
	_ = dr.InitSchema(context.Background())
	_ = dr.Start(context.Background())

	time.Sleep(50 * time.Millisecond)

	// Send tick
	tickBytes, _ := proto.Marshal(&market_data.EquityTick{Symbol: "AAPL"})
	mockSocket.msgChan <- zmq4.Msg{Frames: [][]byte{[]byte("TICK.AAPL"), tickBytes}}

	time.Sleep(50 * time.Millisecond)

	close(mockSocket.msgChan)
	dr.Stop()
}

func TestNewSubSocketReal(t *testing.T) {
	sub := newSubSocket(context.Background())
	if sub != nil {
		sub.Close()
	}
}


