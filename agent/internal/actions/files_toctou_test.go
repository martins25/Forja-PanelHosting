package actions

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

func TestVerifyWrittenInHome_InsideOK(t *testing.T) {
	home := t.TempDir()
	f := filepath.Join(home, "app", "a.txt")
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyWrittenInHome(context.Background(), osutil.NewFakeExecutor(), home, f); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVerifyWrittenInHome_EscapeViaSymlinkedParent(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	// Simulates the race: the parent directory was swapped for a symlink
	// pointing outside the home after SafePath validated the path.
	link := filepath.Join(home, "swapped")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "evil.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	err := verifyWrittenInHome(context.Background(), fake, home, filepath.Join(link, "evil.txt"))
	if err == nil || !errors.Is(err, validate.ErrInvalid) {
		t.Fatalf("expected ErrInvalid, got %v", err)
	}

	removed := false
	realOutside, _ := filepath.EvalSymlinks(outside)
	for _, c := range fake.CallsFor("Run") {
		all := strings.Join(c.Args, " ")
		if strings.Contains(all, "rm") && strings.Contains(all, filepath.Join(realOutside, "evil.txt")) {
			removed = true
		}
	}
	if !removed {
		t.Error("expected the escaped file to be removed")
	}
}
