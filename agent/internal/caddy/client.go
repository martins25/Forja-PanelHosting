package caddy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
)

type Client interface {
	LoadConfig(ctx context.Context, config []byte) error
	// SetConfig sets or replaces the config object at a path under /config/
	// (for example "apps/tls") without touching the rest of the configuration.
	SetConfig(ctx context.Context, path string, config []byte) error
}

type RealClient struct {
	AdminURL string
}

func (c *RealClient) LoadConfig(ctx context.Context, config []byte) error {
	return c.post(ctx, c.AdminURL+"/load", config)
}

func (c *RealClient) SetConfig(ctx context.Context, path string, config []byte) error {
	return c.post(ctx, c.AdminURL+"/config/"+path, config)
}

func (c *RealClient) post(ctx context.Context, url string, config []byte) error {
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(config))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("caddy admin API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("caddy rejected config (status %d): %s", resp.StatusCode, body)
	}
	return nil
}

type SetCall struct {
	Path   string
	Config []byte
}

type FakeClient struct {
	Calls    [][]byte
	LoadErr  error
	SetCalls []SetCall
	SetErr   error
}

func (f *FakeClient) SetConfig(_ context.Context, path string, config []byte) error {
	f.SetCalls = append(f.SetCalls, SetCall{Path: path, Config: append([]byte{}, config...)})
	return f.SetErr
}

func (f *FakeClient) LoadConfig(_ context.Context, config []byte) error {
	f.Calls = append(f.Calls, append([]byte{}, config...))
	return f.LoadErr
}
