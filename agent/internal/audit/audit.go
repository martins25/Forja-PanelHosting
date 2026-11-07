package audit

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Result string

const (
	ResultOK    Result = "ok"
	ResultError Result = "error"
)

type Event struct {
	Timestamp  time.Time       `json:"at"`
	Actor      string          `json:"actor"`
	ActorKind  string          `json:"actor_kind"`
	Action     string          `json:"action"`
	TargetType string          `json:"target_type,omitempty"`
	TargetID   string          `json:"target_id,omitempty"`
	Params     json.RawMessage `json:"params,omitempty"`
	Result     Result          `json:"result"`
	ErrorCode  string          `json:"error_code,omitempty"`
}

type Logger struct {
	mu     sync.Mutex
	writer io.Writer
	enc    *json.Encoder
}

func New(w io.Writer) *Logger {
	return &Logger{
		writer: w,
		enc:    json.NewEncoder(w),
	}
}

func NewFile(path string) (*Logger, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return nil, fmt.Errorf("audit: open %s: %w", path, err)
	}
	return New(f), nil
}

func (l *Logger) Log(e Event) error {
	if e.Timestamp.IsZero() {
		e.Timestamp = time.Now().UTC()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.enc.Encode(e)
}
