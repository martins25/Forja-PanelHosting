package health

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

type Checker interface {
	Check(ctx context.Context, url string) error
}

type RealChecker struct {
	Retries  int
	Interval time.Duration
}

func (c *RealChecker) Check(ctx context.Context, url string) error {
	retries := c.Retries
	if retries == 0 {
		retries = 10
	}
	interval := c.Interval
	if interval == 0 {
		interval = 2 * time.Second
	}

	client := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < retries; i++ {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode < 500 {
			resp.Body.Close()
			return nil
		}
		if resp != nil {
			resp.Body.Close()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
	return fmt.Errorf("healthcheck failed after %d retries on %s", retries, url)
}

type FakeChecker struct {
	Err error
}

func (f *FakeChecker) Check(_ context.Context, _ string) error {
	return f.Err
}
