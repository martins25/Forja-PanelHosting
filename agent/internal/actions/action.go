package actions

import (
	"context"
	"encoding/json"
)

type Action interface {
	Name() string
	Validate(params json.RawMessage) error
	Execute(ctx context.Context, params json.RawMessage) (any, error)
}
