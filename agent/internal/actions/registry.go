package actions

import "fmt"

type Registry struct {
	actions map[string]Action
}

func NewRegistry(actions ...Action) *Registry {
	m := make(map[string]Action, len(actions))
	for _, a := range actions {
		m[a.Name()] = a
	}
	return &Registry{actions: m}
}

func (r *Registry) Get(name string) (Action, error) {
	a, ok := r.actions[name]
	if !ok {
		return nil, fmt.Errorf("unknown action: %q", name)
	}
	return a, nil
}

func (r *Registry) List() []string {
	names := make([]string, 0, len(r.actions))
	for name := range r.actions {
		names = append(names, name)
	}
	return names
}
