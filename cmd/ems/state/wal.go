package state

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"bulldog_alpha/proto/order"
)

type OrderEvent struct {
	OrderID       string            `json:"order_id"`
	State         order.OrderStatus `json:"state"`
	DeltaQty      int32             `json:"delta_qty,omitempty"`
	Timestamp     time.Time         `json:"timestamp"`
	CorrelationID string            `json:"correlation_id,omitempty"`
	Symbol        string            `json:"symbol,omitempty"`
	Price         float64           `json:"price,omitempty"`
	TotalQty      int32             `json:"total_qty,omitempty"`
}

type WAL interface {
	Append(event *OrderEvent) error
	Recover() ([]*OrderEvent, error)
	Close() error
}

type FileWAL struct {
	mu   sync.Mutex
	file *os.File
	path string
}

func NewFileWAL(path string) (*FileWAL, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0666)
	if err != nil {
		return nil, fmt.Errorf("failed to open wal file: %w", err)
	}
	return &FileWAL{
		file: file,
		path: path,
	}, nil
}

func (fw *FileWAL) Append(event *OrderEvent) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	data = append(data, '\n')
	if _, err := fw.file.Write(data); err != nil {
		return fmt.Errorf("failed to write to wal file: %w", err)
	}

	if err := fw.file.Sync(); err != nil {
		return fmt.Errorf("failed to sync wal file: %w", err)
	}

	return nil
}

func (fw *FileWAL) Recover() ([]*OrderEvent, error) {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	if _, err := fw.file.Seek(0, 0); err != nil {
		return nil, fmt.Errorf("failed to seek in wal file: %w", err)
	}

	var events []*OrderEvent
	scanner := bufio.NewScanner(fw.file)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev OrderEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			return nil, fmt.Errorf("failed to unmarshal event line: %w", err)
		}
		events = append(events, &ev)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanner error during recovery: %w", err)
	}

	return events, nil
}

func (fw *FileWAL) Close() error {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	return fw.file.Close()
}
